#ifndef JVMTI_AGENT_ASYNC_QUEUE_H
#define JVMTI_AGENT_ASYNC_QUEUE_H

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

#include "itransport.h"

// Bounded producer/consumer queue serviced by a single background thread.
// The throwing thread only enqueues a serialized event (never blocks on I/O);
// the worker batches events (20/batch, 2s flush) and POSTs via the transport.
// At capacity (10k) new events are silently dropped and counted.
class AsyncQueue {
public:
    static constexpr size_t kMaxQueue = 10000;
    static constexpr size_t kBatchSize = 20;
    static constexpr int kFlushMs = 2000;

    AsyncQueue(ITransport* transport, std::string endpoint_label);
    ~AsyncQueue();

    void start();
    void stop();  // drains remaining events, joins the worker

    // Enqueue one serialized event JSON object. Returns false if dropped.
    bool enqueue(std::string event_json);

    uint64_t dropped() const { return dropped_.load(); }

private:
    void run();
    std::string build_batch(std::deque<std::string>& batch);

    ITransport* transport_;
    std::string label_;
    std::deque<std::string> queue_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::atomic<uint64_t> dropped_{0};
};

#endif  // JVMTI_AGENT_ASYNC_QUEUE_H
