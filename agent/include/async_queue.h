#ifndef JVMTI_AGENT_ASYNC_QUEUE_H
#define JVMTI_AGENT_ASYNC_QUEUE_H

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

#include "itransport.h"

// Bounded producer/consumer queue serviced by a single background thread.
// The throwing thread only enqueues a serialized event (never blocks on I/O);
// the worker batches events (20/batch or 1 MiB, 2s flush) and POSTs via the
// transport. At capacity (10k) new events are silently dropped and counted.
class AsyncQueue {
public:
    static constexpr size_t kMaxQueue = 10000;
    static constexpr size_t kBatchSize = 20;
    // Byte budget per POST body, well under the collector's default 5 MiB
    // ingest limit (COLLECTOR_MAX_BODY_BYTES). A single event larger than this
    // is still sent on its own; if the collector answers 413 the batch is
    // split in half and resent, down to a lone event, which is then dropped
    // (counted) since it can never fit.
    static constexpr size_t kMaxBatchBytes = 1024u * 1024;
    static constexpr int kFlushMs = 2000;
    // On a transient POST failure: retry up to kSendRetries times with
    // exponential backoff (kRetryBaseMs, doubling, capped at kRetryMaxMs), then
    // requeue the batch to the front (up to kMaxQueue) before counting it as
    // dropped. A permanent rejection (4xx, e.g. a revoked token) is never
    // retried: the batch is dropped and counted immediately.
    static constexpr int kSendRetries = 3;
    static constexpr int kRetryBaseMs = 200;
    static constexpr int kRetryMaxMs = 5000;
    // Hard ceiling on how long stop() may spend draining. VM_DEATH runs on the
    // application's shutdown path; an unreachable collector must never stall
    // the host JVM's exit beyond this budget (see also send_with_retry, which
    // makes at most one attempt per batch while stopping).
    static constexpr int kShutdownDrainMs = 3000;

    AsyncQueue(ITransport* transport, std::string endpoint_label);
    ~AsyncQueue();

    void start();
    void stop();  // drains remaining events (bounded by kShutdownDrainMs), joins

    // Enqueue one serialized event JSON object. Returns false if dropped.
    bool enqueue(std::string event_json);

    uint64_t dropped() const { return dropped_.load(); }

private:
    void run();
    std::string build_batch(const std::deque<std::string>& batch, size_t lo,
                            size_t hi);
    // Outcome of sending one batch, possibly as several split sub-batches.
    struct BatchOutcome {
        std::deque<std::string> retry;  // transiently failed, in original order
        bool permanent = false;         // collector definitively rejected a part
    };
    // POST batch[lo, hi). On 413 the range is halved and each half sent on its
    // own. Once a part fails transiently, the rest of the range is not
    // attempted and goes straight to out.retry (the collector is down).
    void send_range(std::deque<std::string>& batch, size_t lo, size_t hi,
                    BatchOutcome& out);
    // Try to POST a batch with bounded retry/backoff. kOk on success;
    // kPermanent on a definitive rejection (no retries); kRetryable after
    // exhausting retries on transient failures.
    SendResult send_with_retry(const std::string& body);
    // Put an unsent batch back at the front of the queue (preserving order),
    // dropping (and counting) any overflow beyond kMaxQueue.
    void requeue_front(std::deque<std::string>& batch);
    // Count a batch plus everything still queued as dropped, clear the queue.
    // Used on shutdown-drain failure/deadline and on permanent rejection during
    // shutdown, so losses are always visible in dropped().
    void drop_batch_and_queue(std::deque<std::string>& batch);

    ITransport* transport_;
    std::string label_;
    std::deque<std::string> queue_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::atomic<uint64_t> dropped_{0};
    std::atomic<uint64_t> permanent_rejects_{0};  // batches rejected with 4xx
    std::atomic<uint64_t> oversized_{0};          // lone events rejected with 413
    // Drain deadline, valid once running_ goes false (published by the
    // running_ store in stop(), read by the worker after observing it).
    std::chrono::steady_clock::time_point stop_deadline_{};
};

#endif  // JVMTI_AGENT_ASYNC_QUEUE_H
