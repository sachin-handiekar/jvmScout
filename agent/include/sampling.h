#ifndef JVMTI_AGENT_SAMPLING_H
#define JVMTI_AGENT_SAMPLING_H

#include <cstdint>
#include <mutex>
#include <unordered_map>
#include <string>

// Capture tiers, mirrored on the wire as captureMode.
enum class CaptureMode { FULL, REDUCED, COUNT_ONLY };

const char* capture_mode_name(CaptureMode m);

// Per-fingerprint adaptive sampler. Within a 60s sliding window the first 10
// hits are FULL, then it demotes FULL -> REDUCED -> COUNT_ONLY; one FULL is
// re-allowed every 300s so long-lived errors keep refreshing their snapshot.
class Sampler {
public:
    struct Decision {
        CaptureMode mode;
        uint64_t hit_count;  // total hits for this fingerprint
    };

    Decision decide(const std::string& fingerprint);

private:
    struct State {
        uint64_t total = 0;
        uint64_t window_hits = 0;
        int64_t window_start_ms = 0;
        int64_t last_full_ms = 0;
    };
    std::mutex mu_;
    std::unordered_map<std::string, State> states_;
};

#endif  // JVMTI_AGENT_SAMPLING_H
