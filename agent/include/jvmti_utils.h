#ifndef JVMTI_AGENT_JVMTI_UTILS_H
#define JVMTI_AGENT_JVMTI_UTILS_H

#include <jvmti.h>
#include <string>

// RAII wrapper for a char* allocated by JVMTI (GetMethodName, GetClassSignature,
// ...). Auto-Deallocates on scope exit so no hot-path leaks.
class JvmtiString {
public:
    JvmtiString(jvmtiEnv* jvmti, char* str) : jvmti_(jvmti), str_(str) {}
    ~JvmtiString() {
        if (str_) jvmti_->Deallocate(reinterpret_cast<unsigned char*>(str_));
    }
    JvmtiString(const JvmtiString&) = delete;
    JvmtiString& operator=(const JvmtiString&) = delete;

    const char* get() const { return str_; }
    bool valid() const { return str_ != nullptr; }
    std::string str() const { return str_ ? std::string(str_) : std::string(); }

private:
    jvmtiEnv* jvmti_;
    char* str_;
};

// RAII JNI local-reference frame: pushes a frame on construction, pops on
// destruction so transient local refs created during capture cannot leak.
class JniLocalFrame {
public:
    JniLocalFrame(JNIEnv* jni, jint capacity) : jni_(jni) {
        pushed_ = (jni_->PushLocalFrame(capacity) == 0);
    }
    ~JniLocalFrame() {
        if (pushed_) jni_->PopLocalFrame(nullptr);
    }
    JniLocalFrame(const JniLocalFrame&) = delete;
    JniLocalFrame& operator=(const JniLocalFrame&) = delete;

private:
    JNIEnv* jni_;
    bool pushed_;
};

// Resolve a bytecode location to a source line number via the method's line
// number table. Returns -1 if unavailable (e.g. native method or no -g).
int resolve_line_number(jvmtiEnv* jvmti, jmethodID method, jlocation location);

// "Lcom/foo/Bar;" -> "com.foo.Bar" (dotted) or "com/foo/Bar" (slash).
std::string signature_to_dotted(const std::string& sig);
std::string signature_to_slash(const std::string& sig);

#endif  // JVMTI_AGENT_JVMTI_UTILS_H
