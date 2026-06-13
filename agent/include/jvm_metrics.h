#ifndef JVMTI_AGENT_JVM_METRICS_H
#define JVMTI_AGENT_JVM_METRICS_H

#include <jvmti.h>
#include <cstdint>

// Snapshot of coarse JVM health, attached to every full event.
struct JvmMetrics {
    int64_t heap_used_bytes = -1;
    int64_t heap_max_bytes = -1;
    int64_t gc_collection_count = -1;
    int64_t gc_time_ms = -1;
    int thread_count = -1;
    int loaded_class_count = -1;
    int64_t uptime_ms = -1;
};

// Collect metrics via JMX MBeans reached through JNI (Runtime/Memory/Thread/GC
// beans). Best-effort: fields stay -1 when a bean is unavailable.
JvmMetrics collect_jvm_metrics(jvmtiEnv* jvmti, JNIEnv* jni);

#endif  // JVMTI_AGENT_JVM_METRICS_H
