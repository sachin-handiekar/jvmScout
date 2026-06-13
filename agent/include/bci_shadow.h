#ifndef JVMTI_AGENT_BCI_SHADOW_H
#define JVMTI_AGENT_BCI_SHADOW_H

#include <jvmti.h>
#include <string>

#include "event_model.h"

// JNI bridge to the bootstrap-injected __JvmtiShadow class. When bytecode
// instrumentation is active, application methods stash their locals into
// __JvmtiShadow's per-thread frame arrays; this reads them back at capture time
// for frames where the JVMTI Local Variable Table is unavailable (no -g).
class BciShadow {
public:
    // Resolve __JvmtiShadow + method IDs once the class is loaded. Safe to call
    // repeatedly; becomes ready() after the first success.
    bool ensure_ready(JNIEnv* jni);
    bool ready() const { return ready_; }

    // Append shadow-sourced locals for stack depth `depth` into `out`.
    // Returns true if any were added. No-op when not ready.
    bool read_frame(JNIEnv* jni, int depth, std::vector<LocalVariable>& out);

private:
    bool ready_ = false;
    jclass shadow_class_ = nullptr;  // global ref
    jmethodID get_frame_ = nullptr;
    jmethodID get_metadata_ = nullptr;
    jmethodID get_slot_types_ = nullptr;
};

#endif  // JVMTI_AGENT_BCI_SHADOW_H
