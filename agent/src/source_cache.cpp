#include "source_cache.h"

namespace {
const char kB64[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
}  // namespace

std::string base64_encode(const std::string& in) {
    std::string out;
    out.reserve(((in.size() + 2) / 3) * 4);
    size_t i = 0;
    const auto* p = reinterpret_cast<const unsigned char*>(in.data());
    for (; i + 2 < in.size(); i += 3) {
        unsigned n = (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
        out.push_back(kB64[(n >> 6) & 63]);
        out.push_back(kB64[n & 63]);
    }
    if (i < in.size()) {
        unsigned n = p[i] << 16;
        bool two = (i + 1 < in.size());
        if (two) n |= p[i + 1] << 8;
        out.push_back(kB64[(n >> 18) & 63]);
        out.push_back(kB64[(n >> 12) & 63]);
        out.push_back(two ? kB64[(n >> 6) & 63] : '=');
        out.push_back('=');
    }
    return out;
}

void SourceCache::store(const std::string& name_slash, const unsigned char* data,
                        size_t len) {
    if (!data || len == 0) return;
    std::lock_guard<std::mutex> lock(mu_);
    if (bytes_.count(name_slash)) return;  // already cached
    if (bytes_.size() >= kMaxClasses) return;
    if (total_bytes_ + len > kMaxBytes) return;
    bytes_.emplace(name_slash,
                   std::string(reinterpret_cast<const char*>(data), len));
    total_bytes_ += len;
}

std::string SourceCache::take_unshipped(const std::string& name_slash) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = bytes_.find(name_slash);
    if (it == bytes_.end()) return "";
    if (shipped_[name_slash]) return "";
    shipped_[name_slash] = true;
    return base64_encode(it->second);
}
