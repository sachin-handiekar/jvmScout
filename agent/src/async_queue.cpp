#include "async_queue.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <utility>

AsyncQueue::AsyncQueue(ITransport* transport, std::string endpoint_label)
    : transport_(transport), label_(std::move(endpoint_label)) {}

AsyncQueue::~AsyncQueue() {
    stop();
}

void AsyncQueue::start() {
    bool expected = false;
    if (!running_.compare_exchange_strong(expected, true)) return;
    worker_ = std::thread([this] { run(); });
}

void AsyncQueue::stop() {
    // Publish the drain deadline before flipping running_: the release store of
    // running_=false makes stop_deadline_ visible to the worker's acquire load.
    stop_deadline_ = std::chrono::steady_clock::now() +
                     std::chrono::milliseconds(kShutdownDrainMs);
    if (!running_.exchange(false)) return;
    cv_.notify_all();
    if (worker_.joinable()) worker_.join();
}

bool AsyncQueue::enqueue(std::string event_json) {
    {
        std::lock_guard<std::mutex> lock(mu_);
        if (queue_.size() >= kMaxQueue) {
            dropped_.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        queue_.push_back(std::move(event_json));
    }
    cv_.notify_one();
    return true;
}

std::string AsyncQueue::build_batch(std::deque<std::string>& batch) {
    // Wire format: a JSON array of event objects.
    std::string body = "[";
    bool first = true;
    for (auto& ev : batch) {
        if (!first) body += ',';
        body += ev;
        first = false;
    }
    body += "]";
    return body;
}

SendResult AsyncQueue::send_with_retry(const std::string& body) {
    auto backoff = std::chrono::milliseconds(kRetryBaseMs);
    for (int attempt = 0; attempt <= kSendRetries; ++attempt) {
        SendResult r = transport_->send(body);
        if (r != SendResult::kRetryable) return r;  // kOk or kPermanent
        // Shutting down: one attempt only, no backoff sleeps.
        if (!running_.load()) return SendResult::kRetryable;
        if (attempt == kSendRetries) break;
        // Interruptible backoff: wake immediately if stop() is called.
        std::unique_lock<std::mutex> lock(mu_);
        cv_.wait_for(lock, backoff, [this] { return !running_.load(); });
        backoff = std::min(backoff * 2, std::chrono::milliseconds(kRetryMaxMs));
    }
    return SendResult::kRetryable;
}

void AsyncQueue::requeue_front(std::deque<std::string>& batch) {
    std::lock_guard<std::mutex> lock(mu_);
    // Push back-to-front so the batch keeps its original ordering at the head.
    while (!batch.empty()) {
        if (queue_.size() >= kMaxQueue) {
            dropped_.fetch_add(batch.size(), std::memory_order_relaxed);
            return;
        }
        queue_.push_front(std::move(batch.back()));
        batch.pop_back();
    }
}

void AsyncQueue::drop_batch_and_queue(std::deque<std::string>& batch) {
    uint64_t n = batch.size();
    batch.clear();
    {
        std::lock_guard<std::mutex> lock(mu_);
        n += queue_.size();
        queue_.clear();
    }
    if (n > 0) dropped_.fetch_add(n, std::memory_order_relaxed);
}

void AsyncQueue::run() {
    while (true) {
        std::deque<std::string> batch;
        {
            std::unique_lock<std::mutex> lock(mu_);
            cv_.wait_for(lock, std::chrono::milliseconds(kFlushMs), [this] {
                return !running_.load() || queue_.size() >= kBatchSize;
            });

            const bool stopping = !running_.load();
            while (!queue_.empty() && batch.size() < kBatchSize) {
                batch.push_back(std::move(queue_.front()));
                queue_.pop_front();
            }
            if (batch.empty()) {
                if (stopping && queue_.empty()) break;
                continue;
            }
        }

        const bool stopping = !running_.load();
        if (stopping && std::chrono::steady_clock::now() >= stop_deadline_) {
            // Out of shutdown budget: drop what's left (counted) and exit.
            drop_batch_and_queue(batch);
            break;
        }

        if (transport_) {
            switch (send_with_retry(build_batch(batch))) {
                case SendResult::kOk:
                    break;
                case SendResult::kPermanent: {
                    // The collector definitively rejected the batch (e.g. 401
                    // from a revoked token). Retrying can't help: drop, count,
                    // and log sparsely so a dead token doesn't spam stderr.
                    uint64_t nth = permanent_rejects_.fetch_add(1) + 1;
                    dropped_.fetch_add(batch.size(), std::memory_order_relaxed);
                    if (nth == 1 || nth % 100 == 0) {
                        std::fprintf(stderr,
                            "[jvmti-agent] collector %s permanently rejected a "
                            "batch (4xx) - check api_key/endpoint (%llu batches "
                            "rejected so far)\n",
                            label_.c_str(), static_cast<unsigned long long>(nth));
                    }
                    if (stopping) { drop_batch_and_queue(batch); }
                    break;
                }
                case SendResult::kRetryable:
                    if (!stopping) {
                        // Still failing after retries and we're not shutting
                        // down: hold onto the events rather than dropping.
                        requeue_front(batch);
                    } else {
                        // Shutting down and the collector is unreachable:
                        // further attempts would each burn a full HTTP timeout
                        // on the host JVM's exit path. Drop the rest, counted.
                        drop_batch_and_queue(batch);
                    }
                    break;
            }
        }

        if (!running_.load()) {
            // On shutdown keep draining whatever remains (deadline-bounded
            // above), then exit.
            std::lock_guard<std::mutex> lock(mu_);
            if (queue_.empty()) break;
        }
    }
}
