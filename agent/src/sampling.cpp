#include "sampling.h"

#include <chrono>

namespace {
int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
constexpr int64_t kWindowMs = 60'000;        // sliding window
constexpr uint64_t kFullPerWindow = 10;      // FULL captures per window
constexpr int64_t kResampleMs = 300'000;     // force one FULL every 5 min
}  // namespace

const char* capture_mode_name(CaptureMode m) {
    switch (m) {
        case CaptureMode::FULL: return "FULL";
        case CaptureMode::REDUCED: return "REDUCED";
        case CaptureMode::COUNT_ONLY: return "COUNT_ONLY";
    }
    return "FULL";
}

Sampler::Decision Sampler::decide(const std::string& fingerprint) {
    const int64_t t = now_ms();
    std::lock_guard<std::mutex> lock(mu_);
    State& st = states_[fingerprint];
    st.total++;

    // Roll the window.
    if (st.window_start_ms == 0 || t - st.window_start_ms >= kWindowMs) {
        st.window_start_ms = t;
        st.window_hits = 0;
    }
    st.window_hits++;

    // Periodic resample: guarantee a fresh FULL snapshot for long-lived errors.
    if (st.last_full_ms == 0 || t - st.last_full_ms >= kResampleMs) {
        st.last_full_ms = t;
        return {CaptureMode::FULL, st.total};
    }

    if (st.window_hits <= kFullPerWindow) {
        st.last_full_ms = t;
        return {CaptureMode::FULL, st.total};
    }
    if (st.window_hits <= kFullPerWindow * 5) {
        return {CaptureMode::REDUCED, st.total};
    }
    return {CaptureMode::COUNT_ONLY, st.total};
}
