#ifndef JVMTI_AGENT_SAMPLING_H
#define JVMTI_AGENT_SAMPLING_H

#include <cstddef>
#include <cstdint>
#include <list>
#include <mutex>
#include <unordered_map>
#include <string>

// Capture tiers, mirrored on the wire as captureMode.
enum class CaptureMode { FULL, REDUCED, COUNT_ONLY };

const char* capture_mode_name(CaptureMode m);

// Per-fingerprint adaptive sampler. Within a 60s sliding window the first 10
// hits are FULL, then it demotes FULL -> REDUCED -> COUNT_ONLY; one FULL is
// re-allowed every 300s so long-lived errors keep refreshing their snapshot.
//
// The per-fingerprint state map is bounded with LRU eviction so an application
// that throws from a very large (or unbounded, e.g. generated-class) set of
// throw sites cannot grow the map without limit.
class Sampler {
public:
    static constexpr size_t kDefaultMaxEntries = 4096;

    struct Decision {
        CaptureMode mode;
        uint64_t hit_count;  // total hits for this fingerprint
    };

    explicit Sampler(size_t max_entries = kDefaultMaxEntries)
        : max_entries_(max_entries ? max_entries : kDefaultMaxEntries) {}

    Decision decide(const std::string& fingerprint);

    // Number of fingerprints currently tracked (for tests/diagnostics).
    size_t tracked() const;

private:
    struct State {
        uint64_t total = 0;
        uint64_t window_hits = 0;
        int64_t window_start_ms = 0;
        int64_t last_full_ms = 0;
        std::list<std::string>::iterator lru_it;  // position in lru_
    };

    mutable std::mutex mu_;
    std::unordered_map<std::string, State> states_;
    std::list<std::string> lru_;  // front = most recently used, back = eviction victim
    size_t max_entries_;
};

#endif  // JVMTI_AGENT_SAMPLING_H
