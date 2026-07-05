#include "bci_engine.h"

#include "agent_context.h"
#include "platform.h"

#include <cstdio>
#include <cstring>
#include <string>

// CLASS_FILE_LOAD_HOOK driving + JAR injection. The Java-side transformer
// (bci-classfile) does the actual bytecode work; this is the native plumbing.

namespace {

// Prevents recursive transformation: loading the java.lang.classfile classes
// (the first time BciTransformer.transform runs) itself triggers load hooks.
thread_local bool t_in_transform = false;

std::string default_jar_path() {
    std::string lib = platform::this_library_path();
    if (lib.empty()) return "";
    size_t slash = lib.find_last_of("/\\");
    std::string dir = (slash == std::string::npos) ? "" : lib.substr(0, slash + 1);
    return dir + "bci-transform.jar";
}

// Normalize a user-supplied package pattern to the internal '/' form used for
// class names in the load hook, so "com.example" and "com/example" both work.
std::string to_slash(std::string s) {
    for (char& c : s) {
        if (c == '.') c = '/';
    }
    return s;
}

bool starts_with(const std::string& s, const std::string& prefix) {
    return !prefix.empty() && s.rfind(prefix, 0) == 0;
}

// Apply the agent's configurable BCI scope (bci_exclude denylist + optional
// bci_packages allowlist) to a class name (internal '/' form). The Java
// transformer keeps its own JDK/framework exclude list as a safety baseline;
// this is an additional, user-controlled filter. Default config (both empty)
// instruments everything the transformer would.
bool bci_in_scope(const AgentConfig& cfg, const std::string& name_slash) {
    for (const std::string& ex : cfg.bci_exclude) {
        if (starts_with(name_slash, to_slash(ex))) return false;
    }
    if (!cfg.bci_packages.empty()) {
        for (const std::string& inc : cfg.bci_packages) {
            if (starts_with(name_slash, to_slash(inc))) return true;
        }
        return false;  // allowlist mode: not matched -> skip
    }
    return true;
}

}  // namespace

namespace bci_engine {

bool initialize(AgentContext& ctx, jvmtiEnv* jvmti, JNIEnv* jni) {
    if (!ctx.config.bci) return false;

    std::string jar = ctx.config.bci_jar.empty() ? default_jar_path()
                                                  : ctx.config.bci_jar;
    if (jar.empty()) {
        std::fprintf(stderr, "[jvmti-agent] bci=true but no bci_jar could be located\n");
        return false;
    }

    jvmtiError e1 = jvmti->AddToSystemClassLoaderSearch(jar.c_str());
    jvmtiError e2 = jvmti->AddToBootstrapClassLoaderSearch(jar.c_str());
    if (e1 != JVMTI_ERROR_NONE || e2 != JVMTI_ERROR_NONE) {
        std::fprintf(stderr, "[jvmti-agent] failed to inject bci jar '%s' (%d/%d)\n",
                     jar.c_str(), e1, e2);
        return false;
    }

    // Resolve the transformer entry point once, here, so the load hook never
    // has to call FindClass on the hot path.
    jclass cls = jni->FindClass("BciTransformer");
    if (!cls) {
        if (jni->ExceptionCheck()) jni->ExceptionClear();
        std::fprintf(stderr, "[jvmti-agent] BciTransformer not found on system classpath\n");
        return false;
    }
    ctx.bci_transformer_class = static_cast<jclass>(jni->NewGlobalRef(cls));
    jni->DeleteLocalRef(cls);
    ctx.bci_transform_method = jni->GetStaticMethodID(
        ctx.bci_transformer_class, "transform", "(Ljava/lang/String;[B)[B");
    if (!ctx.bci_transform_method) {
        if (jni->ExceptionCheck()) jni->ExceptionClear();
        std::fprintf(stderr, "[jvmti-agent] BciTransformer.transform not found\n");
        return false;
    }

    if (ctx.config.bci_verbose) {
        std::fprintf(stdout, "[jvmti-agent] bci jar injected + transformer resolved: %s\n",
                     jar.c_str());
    }
    return true;
}

void on_class_file_load(AgentContext& ctx, jvmtiEnv* jvmti, JNIEnv* jni,
                        const char* name, jint class_data_len,
                        const unsigned char* class_data,
                        jint* new_class_data_len, unsigned char** new_class_data) {
    *new_class_data_len = 0;
    *new_class_data = nullptr;

    // Acquire pairs with vm_init's release store, which also publishes the
    // transformer class/method fields read below.
    if (!ctx.started.load(std::memory_order_acquire) ||
        !ctx.bci_transformer_class || !ctx.bci_transform_method) return;
    if (t_in_transform) return;  // re-entrant load during transform: leave unchanged
    if (!name) return;

    // Honor the configured BCI scope before paying the JNI/transform cost.
    if (!bci_in_scope(ctx.config, name)) {
        if (ctx.config.bci_verbose) {
            std::fprintf(stdout, "[jvmti-agent] (bci) skipping out-of-scope %s\n", name);
        }
        return;
    }

    t_in_transform = true;
    struct Guard { ~Guard() { t_in_transform = false; } } guard;

    jstring jname = jni->NewStringUTF(name);
    jbyteArray jbytes = jni->NewByteArray(class_data_len);
    if (!jname || !jbytes) { if (jni->ExceptionCheck()) jni->ExceptionClear(); return; }
    jni->SetByteArrayRegion(jbytes, 0, class_data_len,
                            reinterpret_cast<const jbyte*>(class_data));

    jbyteArray result = static_cast<jbyteArray>(jni->CallStaticObjectMethod(
        ctx.bci_transformer_class, ctx.bci_transform_method, jname, jbytes));
    if (jni->ExceptionCheck()) {
        jni->ExceptionClear();
        jni->DeleteLocalRef(jname);
        jni->DeleteLocalRef(jbytes);
        return;
    }

    if (result != nullptr) {
        jsize len = jni->GetArrayLength(result);
        unsigned char* buf = nullptr;
        if (jvmti->Allocate(len, &buf) == JVMTI_ERROR_NONE && buf) {
            jni->GetByteArrayRegion(result, 0, len, reinterpret_cast<jbyte*>(buf));
            *new_class_data_len = len;
            *new_class_data = buf;
            if (ctx.config.bci_verbose) {
                std::fprintf(stdout, "[jvmti-agent] (bci) instrumented %s (%d -> %d bytes)\n",
                             name, class_data_len, len);
            }
        }
        jni->DeleteLocalRef(result);
    }

    jni->DeleteLocalRef(jname);
    jni->DeleteLocalRef(jbytes);
}

}  // namespace bci_engine
