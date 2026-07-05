#ifndef JVMTI_AGENT_BCI_SHADOW_H
#define JVMTI_AGENT_BCI_SHADOW_H

#include <jvmti.h>
#include <atomic>
#include <mutex>
#include <string>

#include "event_model.h"

class ObjectInspector;

// JNI bridge to the bootstrap-injected __JvmtiShadow class. When bytecode
// instrumentation is active, application methods stash their locals into
// __JvmtiShadow's per-thread frame arrays; this reads them back at capture time
// for frames where the JVMTI Local Variable Table is unavailable (no -g).
class BciShadow {
public:
    // Resolve __JvmtiShadow + method IDs once the class is loaded. Safe to call
    // repeatedly; becomes ready() after the first success.
    bool ensure_ready(JNIEnv* jni);
    bool ready() const { return ready_.load(std::memory_order_acquire); }

    // Append shadow-sourced locals for stack depth `depth` into `out`, rendering
    // values with the caller's long-lived `inspector` (its JDK class cache holds
    // agent-lifetime global refs; constructing a transient inspector here would
    // leak 6 global refs per call). Returns true if any were added. No-op when
    // not ready.
    bool read_frame(JNIEnv* jni, int depth, const ObjectInspector* inspector,
                    std::vector<LocalVariable>& out);

private:
    // ready_ is published with release semantics once initialization fully
    // succeeds; init_mu_ serializes the (retryable) first-time resolution so
    // concurrent exception callbacks can't NewGlobalRef twice or observe a
    // half-initialized state.
    std::atomic<bool> ready_{false};
    std::mutex init_mu_;
    jclass shadow_class_ = nullptr;  // global ref
    jmethodID get_frame_ = nullptr;
    jmethodID get_metadata_ = nullptr;
    jmethodID get_slot_types_ = nullptr;
};

#endif  // JVMTI_AGENT_BCI_SHADOW_H
