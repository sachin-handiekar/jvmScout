#include "jvm_metrics.h"

#include "jvmti_utils.h"

namespace {

// Clear any pending JNI exception so a failed metric never poisons later calls.
void clear(JNIEnv* jni) {
    if (jni->ExceptionCheck()) jni->ExceptionClear();
}

// Call a no-arg static method on ManagementFactory returning an MXBean object.
jobject get_mxbean(JNIEnv* jni, jclass mf, const char* name, const char* sig) {
    jmethodID mid = jni->GetStaticMethodID(mf, name, sig);
    if (!mid) { clear(jni); return nullptr; }
    jobject bean = jni->CallStaticObjectMethod(mf, mid);
    if (jni->ExceptionCheck()) { clear(jni); return nullptr; }
    return bean;
}

int64_t call_long(JNIEnv* jni, jobject obj, const char* method, const char* sig) {
    if (!obj) return -1;
    jclass cls = jni->GetObjectClass(obj);
    jmethodID mid = jni->GetMethodID(cls, method, sig);
    if (!mid) { clear(jni); return -1; }
    int64_t v = jni->CallLongMethod(obj, mid);
    if (jni->ExceptionCheck()) { clear(jni); return -1; }
    return v;
}

int call_int(JNIEnv* jni, jobject obj, const char* method, const char* sig) {
    if (!obj) return -1;
    jclass cls = jni->GetObjectClass(obj);
    jmethodID mid = jni->GetMethodID(cls, method, sig);
    if (!mid) { clear(jni); return -1; }
    jint v = jni->CallIntMethod(obj, mid);
    if (jni->ExceptionCheck()) { clear(jni); return -1; }
    return v;
}

}  // namespace

JvmMetrics collect_jvm_metrics(jvmtiEnv* /*jvmti*/, JNIEnv* jni) {
    JvmMetrics m;
    JniLocalFrame frame(jni, 64);

    jclass mf = jni->FindClass("java/lang/management/ManagementFactory");
    if (!mf) { clear(jni); return m; }

    // Uptime.
    if (jobject rt = get_mxbean(jni, mf, "getRuntimeMXBean",
                                "()Ljava/lang/management/RuntimeMXBean;")) {
        m.uptime_ms = call_long(jni, rt, "getUptime", "()J");
    }

    // Heap usage.
    if (jobject mem = get_mxbean(jni, mf, "getMemoryMXBean",
                                 "()Ljava/lang/management/MemoryMXBean;")) {
        jclass memc = jni->GetObjectClass(mem);
        jmethodID heap = jni->GetMethodID(memc, "getHeapMemoryUsage",
                                          "()Ljava/lang/management/MemoryUsage;");
        if (heap) {
            jobject usage = jni->CallObjectMethod(mem, heap);
            if (!jni->ExceptionCheck() && usage) {
                m.heap_used_bytes = call_long(jni, usage, "getUsed", "()J");
                m.heap_max_bytes = call_long(jni, usage, "getMax", "()J");
            } else {
                clear(jni);
            }
        } else {
            clear(jni);
        }
    }

    // Thread count.
    if (jobject th = get_mxbean(jni, mf, "getThreadMXBean",
                                "()Ljava/lang/management/ThreadMXBean;")) {
        m.thread_count = call_int(jni, th, "getThreadCount", "()I");
    }

    // Loaded class count.
    if (jobject cl = get_mxbean(jni, mf, "getClassLoadingMXBean",
                                "()Ljava/lang/management/ClassLoadingMXBean;")) {
        m.loaded_class_count = call_int(jni, cl, "getLoadedClassCount", "()I");
    }

    // GC totals (sum across all collector beans).
    jmethodID gc_list = jni->GetStaticMethodID(
        mf, "getGarbageCollectorMXBeans", "()Ljava/util/List;");
    if (gc_list) {
        jobject list = jni->CallStaticObjectMethod(mf, gc_list);
        if (!jni->ExceptionCheck() && list) {
            jclass listc = jni->GetObjectClass(list);
            jmethodID size = jni->GetMethodID(listc, "size", "()I");
            jmethodID get = jni->GetMethodID(listc, "get", "(I)Ljava/lang/Object;");
            if (size && get) {
                jint n = jni->CallIntMethod(list, size);
                if (!jni->ExceptionCheck() && n > 0) {
                    int64_t count = 0, time = 0;
                    for (jint i = 0; i < n; ++i) {
                        jobject bean = jni->CallObjectMethod(list, get, i);
                        if (jni->ExceptionCheck() || !bean) { clear(jni); continue; }
                        int64_t c = call_long(jni, bean, "getCollectionCount", "()J");
                        int64_t t = call_long(jni, bean, "getCollectionTime", "()J");
                        if (c > 0) count += c;
                        if (t > 0) time += t;
                        jni->DeleteLocalRef(bean);
                    }
                    m.gc_collection_count = count;
                    m.gc_time_ms = time;
                }
            } else {
                clear(jni);
            }
        } else {
            clear(jni);
        }
    } else {
        clear(jni);
    }

    return m;
}
