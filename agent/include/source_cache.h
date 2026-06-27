#ifndef JVMTI_AGENT_SOURCE_CACHE_H
#define JVMTI_AGENT_SOURCE_CACHE_H

#include <cstddef>
#include <mutex>
#include <string>
#include <unordered_map>

// Caches the ORIGINAL class-file bytes of app-code classes seen in the
// CLASS_FILE_LOAD_HOOK so the collector can decompile them on demand for the
// dashboard's source view. Bytes are shipped to the collector at most once per
// class (per JVM process); the cache is bounded so a large app can't grow it
// without limit.
class SourceCache {
public:
    // Cap total cached bytes and class count (app classes are usually hundreds).
    static constexpr size_t kMaxBytes = 32u * 1024 * 1024;  // 32 MiB
    static constexpr size_t kMaxClasses = 8192;

    // Store the original bytes for a class (slash name). No-op once the byte or
    // class budget is reached, or if already shipped/cached.
    void store(const std::string& name_slash, const unsigned char* data, size_t len);

    // If the class is cached and not yet shipped, return its base64-encoded bytes
    // and mark it shipped; otherwise return empty. Ensures one upload per class.
    std::string take_unshipped(const std::string& name_slash);

private:
    std::mutex mu_;
    std::unordered_map<std::string, std::string> bytes_;  // name -> raw bytes
    std::unordered_map<std::string, bool> shipped_;
    size_t total_bytes_ = 0;
};

std::string base64_encode(const std::string& in);

#endif  // JVMTI_AGENT_SOURCE_CACHE_H
