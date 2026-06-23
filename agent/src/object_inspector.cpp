#include "object_inspector.h"

#include "jvmti_utils.h"

#include <cstdio>
#include <string>

namespace {

constexpr size_t kMaxStringLen = 256;
constexpr jsize kMaxArrayElems = 16;  // elements shown per array level

const char* primitive_array_kind(char comp) {
    switch (comp) {
        case 'Z': return "boolean";
        case 'B': return "byte";
        case 'C': return "char";
        case 'S': return "short";
        case 'I': return "int";
        case 'J': return "long";
        case 'F': return "float";
        case 'D': return "double";
        default:  return "?";
    }
}

void clear(JNIEnv* jni) {
    if (jni->ExceptionCheck()) jni->ExceptionClear();
}

// Resolve a class and promote it to a global ref (valid for the agent lifetime).
jclass global_class(JNIEnv* jni, const char* name) {
    jclass local = jni->FindClass(name);
    if (!local) { clear(jni); return nullptr; }
    jclass global = static_cast<jclass>(jni->NewGlobalRef(local));
    jni->DeleteLocalRef(local);
    return global;
}

// obj.getClass().getName() -> dotted class name, using cached Class.getName.
std::string class_name(JNIEnv* jni, jobject obj, jmethodID get_name) {
    if (!get_name) return "?";
    jclass objc = jni->GetObjectClass(obj);
    if (!objc) { clear(jni); return "?"; }
    jstring name = static_cast<jstring>(jni->CallObjectMethod(objc, get_name));
    if (jni->ExceptionCheck() || !name) { clear(jni); return "?"; }
    const char* utf = jni->GetStringUTFChars(name, nullptr);
    std::string s = utf ? utf : "?";
    if (utf) jni->ReleaseStringUTFChars(name, utf);
    return s;
}

int identity_hash(JNIEnv* jni, jobject obj, jclass sys, jmethodID mid) {
    if (!sys || !mid) return 0;
    jint h = jni->CallStaticIntMethod(sys, mid, obj);
    if (jni->ExceptionCheck()) { clear(jni); return 0; }
    return h;
}

// toString() restricted to known-safe JDK value types (Number/Boolean/Character),
// whose toString is not application-overridable.
bool render_jdk_value(JNIEnv* jni, jobject obj, jclass number, jclass boolean,
                      jclass character, std::string& out) {
    const jclass safe[] = {number, boolean, character};
    bool is_value = false;
    for (jclass c : safe) {
        if (c && jni->IsInstanceOf(obj, c)) { is_value = true; break; }
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

void ObjectInspector::ensure_init(JNIEnv* jni) const {
    std::call_once(init_flag_, [&] {
        cls_string_ = global_class(jni, "java/lang/String");
        cls_number_ = global_class(jni, "java/lang/Number");
        cls_boolean_ = global_class(jni, "java/lang/Boolean");
        cls_character_ = global_class(jni, "java/lang/Character");
        cls_class_ = global_class(jni, "java/lang/Class");
        cls_system_ = global_class(jni, "java/lang/System");
        if (cls_class_) {
            mid_get_name_ = jni->GetMethodID(cls_class_, "getName",
                                             "()Ljava/lang/String;");
            if (!mid_get_name_) clear(jni);
        }
        if (cls_system_) {
            mid_identity_hash_ = jni->GetStaticMethodID(
                cls_system_, "identityHashCode", "(Ljava/lang/Object;)I");
            if (!mid_identity_hash_) clear(jni);
        }
        init_ok_ = true;
    });
}

std::string ObjectInspector::render(JNIEnv* jni, jobject obj) const {
    ensure_init(jni);
    return render_rec(jni, obj, 0);
}

std::string ObjectInspector::render_rec(JNIEnv* jni, jobject obj, int depth) const {
    if (obj == nullptr) return "null";
    JniLocalFrame frame(jni, 16);

    // String -> quoted, truncated content.
    if (cls_string_ && jni->IsInstanceOf(obj, cls_string_)) {
        const char* utf = jni->GetStringUTFChars(static_cast<jstring>(obj), nullptr);
        std::string s = utf ? utf : "";
        if (utf) jni->ReleaseStringUTFChars(static_cast<jstring>(obj), utf);
        if (s.size() > kMaxStringLen) { s.resize(kMaxStringLen); s += "..."; }
        return "\"" + s + "\"";
    }
    clear(jni);

    // Numbers / booleans / chars.
    std::string val;
    if (render_jdk_value(jni, obj, cls_number_, cls_boolean_, cls_character_, val)) {
        return val;
    }

    // Arrays: expand contents up to max_depth_ (the `depth` config knob).
    std::string cls = class_name(jni, obj, mid_get_name_);
    if (cls.size() >= 2 && cls[0] == '[') {
        return render_array(jni, obj, depth, cls);
    }

    // Fallback: type@identityHash. Object-graph *field* expansion is left as a
    // future enhancement (see PLAN.md Phase 9); only arrays are expanded today.
    char buf[24];
    std::snprintf(buf, sizeof(buf), "@%x", identity_hash(jni, obj, cls_system_, mid_identity_hash_));
    return cls + buf;
}

std::string ObjectInspector::render_array(JNIEnv* jni, jobject obj, int depth,
                                          const std::string& cls_name) const {
    const char comp = cls_name[1];
    const bool object_array = (comp == 'L' || comp == '[');

    jsize len = jni->GetArrayLength(static_cast<jarray>(obj));
    if (jni->ExceptionCheck()) { clear(jni); return cls_name; }

    if (!object_array) {
        // Primitive array: summarize as kind[length] (avoid dumping huge buffers).
        char buf[48];
        std::snprintf(buf, sizeof(buf), "%s[%d]", primitive_array_kind(comp),
                      static_cast<int>(len));
        return buf;
    }

    // Object array: recurse into elements until we hit the depth budget.
    if (depth >= max_depth_) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "[%d elems]", static_cast<int>(len));
        return buf;
    }

    const jsize show = len < kMaxArrayElems ? len : kMaxArrayElems;
    std::string out = "[";
    jobjectArray arr = static_cast<jobjectArray>(obj);
    for (jsize i = 0; i < show; ++i) {
        jobject el = jni->GetObjectArrayElement(arr, i);
        if (jni->ExceptionCheck()) { clear(jni); break; }
        if (i > 0) out += ", ";
        out += render_rec(jni, el, depth + 1);
        if (el) jni->DeleteLocalRef(el);
    }
    if (len > show) out += ", ...";
    out += "]";
    return out;
}
