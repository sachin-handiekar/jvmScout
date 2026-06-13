#ifndef JVMTI_AGENT_OBJECT_INSPECTOR_H
#define JVMTI_AGENT_OBJECT_INSPECTOR_H

#include <jvmti.h>
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
    int max_depth_;
};

#endif  // JVMTI_AGENT_OBJECT_INSPECTOR_H
