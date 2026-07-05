#include "method_info_cache.h"

#include "ifilter.h"
#include "jvmti_utils.h"

#include <algorithm>
#include <mutex>

int MethodInfo::line_at(jlocation location) const {
    if (location < 0 || line_table.empty()) return -1;
    int line = -1;
    for (const auto& [start, ln] : line_table) {
        if (start <= location) line = ln;
        else break;
    }
    return line;
}

std::shared_ptr<const MethodInfo> MethodInfoCache::lookup(
        jvmtiEnv* jvmti, JNIEnv* jni, jmethodID method,
        const IFilter* location_filter) {
    {
        std::shared_lock<std::shared_mutex> lock(mu_);
        auto it = map_.find(method);
        if (it != map_.end()) return it->second;
    }

    // Miss: resolve via JVMTI outside any lock (these calls can be slow).
    auto info = std::make_shared<MethodInfo>();

    char* mname = nullptr;
    if (jvmti->GetMethodName(method, &mname, nullptr, nullptr) == JVMTI_ERROR_NONE) {
        JvmtiString freeName(jvmti, mname);
        info->method_name = mname ? mname : "";
    }

    jclass decl = nullptr;
    if (jvmti->GetMethodDeclaringClass(method, &decl) == JVMTI_ERROR_NONE && decl) {
        char* csig = nullptr;
        if (jvmti->GetClassSignature(decl, &csig, nullptr) == JVMTI_ERROR_NONE) {
            JvmtiString freeCsig(jvmti, csig);
            std::string sig = csig ? csig : "";
            info->class_slash = signature_to_slash(sig);
            info->class_dotted = signature_to_dotted(sig);
        }
        char* src = nullptr;
        if (jvmti->GetSourceFileName(decl, &src) == JVMTI_ERROR_NONE) {
            JvmtiString freeSrc(jvmti, src);
            info->source_file = src ? src : "";
        }
        jni->DeleteLocalRef(decl);
    }

    jint count = 0;
    jvmtiLineNumberEntry* table = nullptr;
    if (jvmti->GetLineNumberTable(method, &count, &table) == JVMTI_ERROR_NONE &&
        table != nullptr) {
        info->line_table.reserve(static_cast<size_t>(count));
        for (jint i = 0; i < count; ++i) {
            info->line_table.emplace_back(table[i].start_location,
                                          table[i].line_number);
        }
        jvmti->Deallocate(reinterpret_cast<unsigned char*>(table));
        std::sort(info->line_table.begin(), info->line_table.end());
    }

    info->location_denied =
        location_filter ? !location_filter->accept(info->class_slash) : false;

    std::unique_lock<std::shared_mutex> lock(mu_);
    if (map_.size() >= kMaxEntries) map_.clear();
    auto [it, _] = map_.emplace(method, std::move(info));
    return it->second;
}

size_t MethodInfoCache::size() const {
    std::shared_lock<std::shared_mutex> lock(mu_);
    return map_.size();
}
