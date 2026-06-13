#include "bci_shadow.h"

#include "object_inspector.h"

// JNI bridge to the bootstrap-injected __JvmtiShadow class. Fully wired in the
// BCI phase (PLAN.md Phase 7). When the transformer is not present these calls
// no-op so the core capture path is unaffected.

bool BciShadow::ensure_ready(JNIEnv* jni) {
    if (ready_) return true;
    jclass local = jni->FindClass("__JvmtiShadow");
    if (!local) {
        if (jni->ExceptionCheck()) jni->ExceptionClear();
        return false;  // transformer/bootstrap jar not loaded
    }
    shadow_class_ = static_cast<jclass>(jni->NewGlobalRef(local));
    jni->DeleteLocalRef(local);

    get_frame_ = jni->GetStaticMethodID(shadow_class_, "getFrame", "(I)[Ljava/lang/Object;");
    get_metadata_ = jni->GetStaticMethodID(shadow_class_, "getMetadata", "(I)[Ljava/lang/String;");
    get_slot_types_ = jni->GetStaticMethodID(shadow_class_, "getSlotTypes", "(I)[I");
    if (jni->ExceptionCheck()) jni->ExceptionClear();

    ready_ = (get_frame_ != nullptr);
    return ready_;
}

bool BciShadow::read_frame(JNIEnv* jni, int depth, std::vector<LocalVariable>& out) {
    if (!ready_ || !get_frame_) return false;

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
    ObjectInspector inspector(2);
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
        lv.value = inspector.render(jni, v);
        out.push_back(std::move(lv));
        jni->DeleteLocalRef(v);
        added = true;
    }
    jni->DeleteLocalRef(values);
    if (names) jni->DeleteLocalRef(names);
    return added;
}
