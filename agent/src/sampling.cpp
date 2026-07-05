#include "sampling.h"

#include <algorithm>
#include <chrono>
#include <functional>

namespace {
int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
constexpr int64_t kWindowMs = 60'000;        // sliding window
constexpr uint64_t kFullPerWindow = 10;      // FULL captures per window
constexpr int64_t kResampleMs = 300'000;     // force one FULL every 5 min
constexpr size_t kMaxStripes = 16;
constexpr size_t kMinEntriesPerStripe = 256; // don't over-shard tiny caps
}  // namespace

const char* capture_mode_name(CaptureMode m) {
    switch (m) {
        case CaptureMode::FULL: return "FULL";
        case CaptureMode::REDUCED: return "REDUCED";
        case CaptureMode::COUNT_ONLY: return "COUNT_ONLY";
    }
    return "FULL";
}

Sampler::Sampler(size_t max_entries) {
    if (max_entries == 0) max_entries = kDefaultMaxEntries;
    size_t stripes = std::min(kMaxStripes,
                              std::max<size_t>(1, max_entries / kMinEntriesPerStripe));
    per_stripe_max_ = std::max<size_t>(1, max_entries / stripes);
    stripes_.reserve(stripes);
    for (size_t i = 0; i < stripes; ++i) {
        stripes_.push_back(std::make_unique<Stripe>());
    }
}

Sampler::Stripe& Sampler::stripe_for(const std::string& fingerprint) const {
    return *stripes_[std::hash<std::string>{}(fingerprint) % stripes_.size()];
}

size_t Sampler::tracked() const {
    size_t n = 0;
    for (const auto& s : stripes_) {
        std::lock_guard<std::mutex> lock(s->mu);
        n += s->states.size();
    }
    return n;
}

Sampler::Decision Sampler::decide(const std::string& fingerprint) {
    const int64_t t = now_ms();
    Stripe& sp = stripe_for(fingerprint);
    std::lock_guard<std::mutex> lock(sp.mu);

    auto it = sp.states.find(fingerprint);
    if (it == sp.states.end()) {
        // New fingerprint: evict the least-recently-used entry if at capacity.
        if (sp.states.size() >= per_stripe_max_ && !sp.lru.empty()) {
            const std::string victim = sp.lru.back();
            sp.lru.pop_back();
            sp.states.erase(victim);
        }
        sp.lru.push_front(fingerprint);
        it = sp.states.emplace(fingerprint, State{}).first;
        it->second.lru_it = sp.lru.begin();
    } else {
        // Existing fingerprint: promote to most-recently-used.
        sp.lru.splice(sp.lru.begin(), sp.lru, it->second.lru_it);
        it->second.lru_it = sp.lru.begin();
    }

    State& st = it->second;
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
