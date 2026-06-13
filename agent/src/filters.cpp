#include "ifilter.h"

namespace {
bool matches_any(const std::string& sig, const std::vector<std::string>& patterns) {
    for (const auto& p : patterns) {
        if (!p.empty() && sig.find(p) != std::string::npos) return true;
    }
    return false;
}
}  // namespace

DenyAllowFilter::DenyAllowFilter(std::string name,
                                 std::vector<std::string> deny,
                                 std::vector<std::string> allow)
    : name_(std::move(name)), deny_(std::move(deny)), allow_(std::move(allow)) {}

bool DenyAllowFilter::accept(const std::string& class_signature) const {
    // Allow-only mode: when an allowlist is present, the signature must match it.
    if (!allow_.empty() && !matches_any(class_signature, allow_)) {
        return false;
    }
    // Denylist always wins.
    if (matches_any(class_signature, deny_)) {
        return false;
    }
    return true;
}
