#include "count_aggregator.h"

#include "event_serializer.h"

#include <chrono>
#include <utility>

namespace {
int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
}  // namespace

void CountAggregator::record(const std::string& fingerprint, CapturedEvent proto) {
    std::lock_guard<std::mutex> lock(mu_);
    if (last_flush_ms_ == 0) last_flush_ms_ = now_ms();

    auto it = pending_.find(fingerprint);
    if (it == pending_.end()) {
        if (pending_.size() >= kMaxEntries) {
            // Pathological fingerprint cardinality: drop (counted) rather than
            // grow without bound. FULL/REDUCED tiers still capture new sites.
            ++overflow_dropped_;
            return;
        }
        it = pending_.emplace(fingerprint, Entry{}).first;
    }
    Entry& e = it->second;
    ++e.count;
    // Keep the freshest snapshot of the cumulative counter and timestamp.
    e.proto = std::move(proto);
}

void CountAggregator::drain(std::vector<std::string>& out, bool force) {
    std::unordered_map<std::string, Entry> ready;
    {
        std::lock_guard<std::mutex> lock(mu_);
        const int64_t t = now_ms();
        if (!force && last_flush_ms_ != 0 && t - last_flush_ms_ < kFlushIntervalMs) {
            return;
        }
        if (pending_.empty()) {
            last_flush_ms_ = t;
            return;
        }
        ready.swap(pending_);
        last_flush_ms_ = t;
    }
    // Serialize outside the lock: throwing threads must never wait on this.
    for (auto& [fp, entry] : ready) {
        entry.proto.occurrences = entry.count;
        out.push_back(serialize_event(entry.proto));
    }
}

uint64_t CountAggregator::pending() const {
    std::lock_guard<std::mutex> lock(mu_);
    return pending_.size();
}

uint64_t CountAggregator::overflow_dropped() const {
    std::lock_guard<std::mutex> lock(mu_);
    return overflow_dropped_;
}
