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

std::string AsyncQueue::build_batch(const std::deque<std::string>& batch,
                                    size_t lo, size_t hi) {
    // Wire format: a JSON array of event objects.
    std::string body = "[";
    for (size_t i = lo; i < hi; ++i) {
        if (i != lo) body += ',';
        body += batch[i];
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

void AsyncQueue::send_range(std::deque<std::string>& batch, size_t lo,
                            size_t hi, BatchOutcome& out) {
    if (!out.retry.empty()) {
        // An earlier part failed transiently: don't burn more retries on a
        // collector that is down, keep these for the next round.
        for (size_t i = lo; i < hi; ++i) out.retry.push_back(std::move(batch[i]));
        return;
    }
    switch (send_with_retry(build_batch(batch, lo, hi))) {
        case SendResult::kOk:
            return;
        case SendResult::kTooLarge:
            if (hi - lo > 1) {
                const size_t mid = lo + (hi - lo) / 2;
                send_range(batch, lo, mid, out);
                send_range(batch, mid, hi, out);
                return;
            } else {
                // A single event the collector will never accept: drop it,
                // counted, and log sparsely.
                uint64_t nth = oversized_.fetch_add(1) + 1;
                dropped_.fetch_add(1, std::memory_order_relaxed);
                if (nth == 1 || nth % 100 == 0) {
                    std::fprintf(stderr,
                        "[jvmti-agent] collector %s rejected an event as too "
                        "large (413, %zu bytes) - raise COLLECTOR_MAX_BODY_BYTES "
                        "(%llu oversized events dropped so far)\n",
                        label_.c_str(), batch[lo].size(),
                        static_cast<unsigned long long>(nth));
                }
            }
            return;
        case SendResult::kPermanent: {
            // The collector definitively rejected the batch (e.g. 401 from a
            // revoked token). Retrying can't help: drop, count, and log
            // sparsely so a dead token doesn't spam stderr.
            uint64_t nth = permanent_rejects_.fetch_add(1) + 1;
            dropped_.fetch_add(hi - lo, std::memory_order_relaxed);
            out.permanent = true;
            if (nth == 1 || nth % 100 == 0) {
                std::fprintf(stderr,
                    "[jvmti-agent] collector %s permanently rejected a "
                    "batch (4xx) - check api_key/endpoint (%llu batches "
                    "rejected so far)\n",
                    label_.c_str(), static_cast<unsigned long long>(nth));
            }
            return;
        }
        case SendResult::kRetryable:
            for (size_t i = lo; i < hi; ++i) out.retry.push_back(std::move(batch[i]));
            return;
    }
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
            // Fill up to kBatchSize events or kMaxBatchBytes, always taking at
            // least one so an oversized event still gets its own attempt.
            size_t bytes = 0;
            while (!queue_.empty() && batch.size() < kBatchSize &&
                   (batch.empty() ||
                    bytes + queue_.front().size() <= kMaxBatchBytes)) {
                bytes += queue_.front().size();
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
            BatchOutcome out;
            send_range(batch, 0, batch.size(), out);
            if (!out.retry.empty()) {
                if (!stopping) {
                    // Still failing after retries and we're not shutting
                    // down: hold onto the events rather than dropping.
                    requeue_front(out.retry);
                } else {
                    // Shutting down and the collector is unreachable: further
                    // attempts would each burn a full HTTP timeout on the host
                    // JVM's exit path. Drop the rest, counted.
                    drop_batch_and_queue(out.retry);
                }
            } else if (out.permanent && stopping) {
                // A dead token rejects everything else too: drop what's still
                // queued (the rejected part was already counted above).
                drop_batch_and_queue(out.retry);
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
