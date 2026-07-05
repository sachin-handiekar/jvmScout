#ifndef JVMTI_AGENT_COUNT_AGGREGATOR_H
#define JVMTI_AGENT_COUNT_AGGREGATOR_H

#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "event_model.h"

// Client-side aggregation for COUNT_ONLY captures. A hot fingerprint can throw
// thousands of times per second; shipping one event per throw would flood the
// send queue, the network, and the collector's database with near-identical
// rows. Instead, COUNT_ONLY occurrences accumulate here and are flushed as ONE
// summary event per fingerprint every kFlushIntervalMs, carrying the window's
// occurrence count in the `occurrences` wire field (which the collector SUMs
// for volume alerts / series).
//
// Flushing is driven opportunistically from the exception callback (any
// capture, any tier) and forced at VM_DEATH, so counts are at most one flush
// interval (or one quiet period) stale.
class CountAggregator {
public:
    static constexpr int64_t kFlushIntervalMs = 5000;
    static constexpr size_t kMaxEntries = 4096;

    // Fold one suppressed COUNT_ONLY occurrence into the pending summary for
    // its fingerprint. `proto` carries the cheap identity fields (type,
    // location, caught, cumulative hit_count); message/thread/stack are
    // intentionally absent from summaries.
    void record(const std::string& fingerprint, CapturedEvent proto);

    // If the flush interval elapsed (or force), serialize every pending
    // summary into `out` and clear the pending set.
    void drain(std::vector<std::string>& out, bool force);

    uint64_t pending() const;           // fingerprints currently buffered
    uint64_t overflow_dropped() const;  // occurrences lost to the entry cap

private:
    struct Entry {
        CapturedEvent proto;
        uint64_t count = 0;
    };

    mutable std::mutex mu_;
    std::unordered_map<std::string, Entry> pending_;
    int64_t last_flush_ms_ = 0;
    uint64_t overflow_dropped_ = 0;
};

#endif  // JVMTI_AGENT_COUNT_AGGREGATOR_H
