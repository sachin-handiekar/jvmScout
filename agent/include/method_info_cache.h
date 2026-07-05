#ifndef JVMTI_AGENT_METHOD_INFO_CACHE_H
#define JVMTI_AGENT_METHOD_INFO_CACHE_H

#include <jvmti.h>

#include <memory>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

class IFilter;

// Immutable per-method metadata resolved once and reused on every throw from
// that method. The exception callback runs for EVERY throw in the JVM before
// any sampling decision; without this cache each throw pays GetMethodName +
// GetMethodDeclaringClass + GetClassSignature + GetSourceFileName + a
// GetLineNumberTable allocation/scan/deallocation.
struct MethodInfo {
    std::string method_name;
    std::string class_slash;    // com/foo/Bar (filter input)
    std::string class_dotted;   // com.foo.Bar (display)
    std::string source_file;
    bool location_denied = false;  // precomputed location-filter verdict
    // Sorted (start_location, line) pairs; empty when no -g / native method.
    std::vector<std::pair<jlocation, int>> line_table;

    // Source line for a bytecode location (-1 when unavailable).
    int line_at(jlocation location) const;
};

// Read-mostly cache keyed by jmethodID. Lookups take a shared lock; a miss
// resolves the metadata via JVMTI outside any lock, then inserts.
//
// Known limitation (documented trade-off shared by production JVMTI agents):
// if a class is unloaded and the JVM recycles the jmethodID address for a new
// method, a stale entry could be served for it. The cache is fully cleared
// when it reaches kMaxEntries, which also bounds that staleness.
class MethodInfoCache {
public:
    static constexpr size_t kMaxEntries = 16384;

    // Never returns null; on JVMTI failure the fields degrade to empty (and
    // location_denied=false so a broken resolve can't silently drop captures).
    std::shared_ptr<const MethodInfo> lookup(jvmtiEnv* jvmti, JNIEnv* jni,
                                             jmethodID method,
                                             const IFilter* location_filter);

    size_t size() const;

private:
    mutable std::shared_mutex mu_;
    std::unordered_map<jmethodID, std::shared_ptr<const MethodInfo>> map_;
};

#endif  // JVMTI_AGENT_METHOD_INFO_CACHE_H
