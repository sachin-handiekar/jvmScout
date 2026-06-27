#include "async_queue.h"

#include <algorithm>
#include <chrono>
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

bool AsyncQueue::send_with_retry(const std::string& body) {
    auto backoff = std::chrono::milliseconds(kRetryBaseMs);
    for (int attempt = 0; attempt <= kSendRetries; ++attempt) {
        if (!running_.load()) {
            // Shutting down: make one last attempt, don't sleep further.
            return transport_->send(body);
        }
        if (transport_->send(body)) return true;
        if (attempt == kSendRetries) break;
        // Interruptible backoff: wake immediately if stop() is called.
        std::unique_lock<std::mutex> lock(mu_);
        cv_.wait_for(lock, backoff, [this] { return !running_.load(); });
        backoff = std::min(backoff * 2, std::chrono::milliseconds(kRetryMaxMs));
    }
    return false;
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

        if (transport_) {
            if (!send_with_retry(build_batch(batch)) && running_.load()) {
                // Still failing after retries and we're not shutting down:
                // hold onto the events (requeue) rather than dropping silently.
                requeue_front(batch);
            }
        }

        if (!running_.load()) {
            // On shutdown keep draining whatever remains, then exit.
            std::lock_guard<std::mutex> lock(mu_);
            if (queue_.empty()) break;
        }
    }
}
