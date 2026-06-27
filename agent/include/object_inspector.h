#ifndef JVMTI_AGENT_OBJECT_INSPECTOR_H
#define JVMTI_AGENT_OBJECT_INSPECTOR_H

#include <jvmti.h>
#include <mutex>
#include <string>

// Renders a Java object reference to a short display string, recursing into
// fields up to max_depth. Primitives/strings render inline; object graphs are
// summarized (type@identity plus a few fields) to bound cost and output size.
class ObjectInspector {
public:
    explicit ObjectInspector(int max_depth) : max_depth_(max_depth) {}

    std::string render(JNIEnv* jni, jobject obj) const;

private:
    std::string render_rec(JNIEnv* jni, jobject obj, int depth) const;
    // Render an array, expanding element contents while depth < max_depth_
    // (object arrays recurse; primitive arrays show kind[length]). cls_name is
    // the array's dotted class name (e.g. "[I", "[Ljava.lang.String;").
    std::string render_array(JNIEnv* jni, jobject obj, int depth,
                             const std::string& cls_name) const;

    // Lazily resolve and cache the JDK classes/method IDs used on every render
    // (String/Number/Boolean/Character/Class/System, Class.getName,
    // System.identityHashCode) so the hot path doesn't repeat FindClass /
    // GetMethodID lookups per local variable. Classes are held as global refs
    // for the agent's lifetime.
    void ensure_init(JNIEnv* jni) const;

    int max_depth_;

    mutable std::once_flag init_flag_;
    mutable bool init_ok_ = false;
    mutable jclass cls_string_ = nullptr;
    mutable jclass cls_number_ = nullptr;
    mutable jclass cls_boolean_ = nullptr;
    mutable jclass cls_character_ = nullptr;
    mutable jclass cls_class_ = nullptr;
    mutable jclass cls_system_ = nullptr;
    mutable jmethodID mid_get_name_ = nullptr;       // Class.getName
    mutable jmethodID mid_identity_hash_ = nullptr;  // System.identityHashCode
};

#endif  // JVMTI_AGENT_OBJECT_INSPECTOR_H
