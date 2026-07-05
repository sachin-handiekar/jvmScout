#include "bci_shadow.h"

#include "object_inspector.h"

// JNI bridge to the bootstrap-injected __JvmtiShadow class. Fully wired in the
// BCI phase (PLAN.md Phase 7). When the transformer is not present these calls
// no-op so the core capture path is unaffected.

bool BciShadow::ensure_ready(JNIEnv* jni) {
    // Fast path: already initialized (acquire pairs with the release store below).
    if (ready_.load(std::memory_order_acquire)) return true;

    // Slow path: serialize first-time resolution. We use a mutex rather than
    // std::call_once because init can legitimately *fail* (the transformer jar
    // isn't loaded yet) and must be retried on a later call — a once_flag would
    // be consumed by the first unsuccessful attempt.
    std::lock_guard<std::mutex> lock(init_mu_);
    if (ready_.load(std::memory_order_relaxed)) return true;

    jclass local = jni->FindClass("__JvmtiShadow");
    if (!local) {
        if (jni->ExceptionCheck()) jni->ExceptionClear();
        return false;  // transformer/bootstrap jar not loaded yet; retry later
    }
    jclass global = static_cast<jclass>(jni->NewGlobalRef(local));
    jni->DeleteLocalRef(local);

    jmethodID get_frame = jni->GetStaticMethodID(global, "getFrame", "(I)[Ljava/lang/Object;");
    jmethodID get_metadata = jni->GetStaticMethodID(global, "getMetadata", "(I)[Ljava/lang/String;");
    jmethodID get_slot_types = jni->GetStaticMethodID(global, "getSlotTypes", "(I)[I");
    if (jni->ExceptionCheck()) jni->ExceptionClear();

    if (get_frame == nullptr) {
        jni->DeleteGlobalRef(global);  // don't leak the ref on a failed attempt
        return false;
    }

    // Populate members before publishing ready_ so any thread that sees
    // ready_==true via acquire also sees fully-initialized state.
    shadow_class_ = global;
    get_frame_ = get_frame;
    get_metadata_ = get_metadata;
    get_slot_types_ = get_slot_types;
    ready_.store(true, std::memory_order_release);
    return true;
}

bool BciShadow::read_frame(JNIEnv* jni, int depth, const ObjectInspector* inspector,
                           std::vector<LocalVariable>& out) {
    if (!ready_.load(std::memory_order_acquire) || !get_frame_ || !inspector) {
        return false;
    }

    jobjectArray values = static_cast<jobjectArray>(
        jni->CallStaticObjectMethod(shadow_class_, get_frame_, depth));
    if (jni->ExceptionCheck() || !values) {
        if (jni->ExceptionCheck()) jni->ExceptionClear();
        return false;
    }

    jobjectArray names = nullptr;
    if (get_metadata_) {
        names = static_cast<jobjectArray>(
            jni->CallStaticObjectMethod(shadow_class_, get_metadata_, depth));
        if (jni->ExceptionCheck()) { jni->ExceptionClear(); names = nullptr; }
    }

    jsize n = jni->GetArrayLength(values);
    bool added = false;
    for (jsize i = 0; i < n; ++i) {
        jobject v = jni->GetObjectArrayElement(values, i);
        if (!v) continue;
        LocalVariable lv;
        lv.slot = static_cast<int>(i);
        lv.source = "bci_shadow";
        if (names) {
            jstring nm = static_cast<jstring>(jni->GetObjectArrayElement(names, i));
            if (nm) {
                const char* utf = jni->GetStringUTFChars(nm, nullptr);
                if (utf) { lv.name = utf; jni->ReleaseStringUTFChars(nm, utf); }
                jni->DeleteLocalRef(nm);
            }
        }
        // Captured primitives arrive boxed; the inspector renders them (and
        // strings/objects) the same way JVMTI-sourced locals are rendered.
        lv.value = inspector->render(jni, v);
        out.push_back(std::move(lv));
        jni->DeleteLocalRef(v);
        added = true;
    }
    jni->DeleteLocalRef(values);
    if (names) jni->DeleteLocalRef(names);
    return added;
}
