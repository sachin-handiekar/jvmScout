#include "object_inspector.h"

#include "jvmti_utils.h"

#include <cstdio>
#include <string>

namespace {

constexpr size_t kMaxStringLen = 256;

void clear(JNIEnv* jni) {
    if (jni->ExceptionCheck()) jni->ExceptionClear();
}

// obj.getClass().getName() -> dotted class name. getClass/getName are JDK final
// methods, so this runs no application code.
std::string class_name(JNIEnv* jni, jobject obj) {
    jclass objc = jni->GetObjectClass(obj);
    if (!objc) { clear(jni); return "?"; }
    jmethodID get_name = jni->GetMethodID(
        jni->FindClass("java/lang/Class"), "getName", "()Ljava/lang/String;");
    if (!get_name) { clear(jni); return "?"; }
    jstring name = static_cast<jstring>(jni->CallObjectMethod(objc, get_name));
    if (jni->ExceptionCheck() || !name) { clear(jni); return "?"; }
    const char* utf = jni->GetStringUTFChars(name, nullptr);
    std::string s = utf ? utf : "?";
    if (utf) jni->ReleaseStringUTFChars(name, utf);
    return s;
}

int identity_hash(JNIEnv* jni, jobject obj) {
    jclass sys = jni->FindClass("java/lang/System");
    if (!sys) { clear(jni); return 0; }
    jmethodID mid = jni->GetStaticMethodID(sys, "identityHashCode", "(Ljava/lang/Object;)I");
    if (!mid) { clear(jni); return 0; }
    jint h = jni->CallStaticIntMethod(sys, mid, obj);
    if (jni->ExceptionCheck()) { clear(jni); return 0; }
    return h;
}

// toString() restricted to known-safe JDK value types (Number/Boolean/Character),
// whose toString is not application-overridable.
bool render_jdk_value(JNIEnv* jni, jobject obj, std::string& out) {
    const char* safe[] = {"java/lang/Number", "java/lang/Boolean", "java/lang/Character"};
    bool is_value = false;
    for (const char* cn : safe) {
        jclass c = jni->FindClass(cn);
        if (c && jni->IsInstanceOf(obj, c)) { is_value = true; break; }
        clear(jni);
    }
    if (!is_value) return false;

    jclass objc = jni->GetObjectClass(obj);
    jmethodID ts = jni->GetMethodID(objc, "toString", "()Ljava/lang/String;");
    if (!ts) { clear(jni); return false; }
    jstring s = static_cast<jstring>(jni->CallObjectMethod(obj, ts));
    if (jni->ExceptionCheck() || !s) { clear(jni); return false; }
    const char* utf = jni->GetStringUTFChars(s, nullptr);
    out = utf ? utf : "";
    if (utf) jni->ReleaseStringUTFChars(s, utf);
    return true;
}

}  // namespace

std::string ObjectInspector::render(JNIEnv* jni, jobject obj) const {
    return render_rec(jni, obj, 0);
}

std::string ObjectInspector::render_rec(JNIEnv* jni, jobject obj, int depth) const {
    if (obj == nullptr) return "null";
    JniLocalFrame frame(jni, 16);

    // String -> quoted, truncated content.
    jclass strc = jni->FindClass("java/lang/String");
    if (strc && jni->IsInstanceOf(obj, strc)) {
        const char* utf = jni->GetStringUTFChars(static_cast<jstring>(obj), nullptr);
        std::string s = utf ? utf : "";
        if (utf) jni->ReleaseStringUTFChars(static_cast<jstring>(obj), utf);
        if (s.size() > kMaxStringLen) { s.resize(kMaxStringLen); s += "..."; }
        return "\"" + s + "\"";
    }
    clear(jni);

    // Numbers / booleans / chars.
    std::string val;
    if (render_jdk_value(jni, obj, val)) return val;

    // Fallback: type@identityHash. Object-graph field expansion is bounded by
    // max_depth and left as a future enhancement (see PLAN.md Phase 9).
    std::string cls = class_name(jni, obj);
    char buf[24];
    std::snprintf(buf, sizeof(buf), "@%x", identity_hash(jni, obj));
    (void)depth;
    return cls + buf;
}
