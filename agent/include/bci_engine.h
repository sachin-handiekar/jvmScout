#ifndef JVMTI_AGENT_BCI_ENGINE_H
#define JVMTI_AGENT_BCI_ENGINE_H

#include <jvmti.h>

struct AgentContext;

// Bytecode-instrumentation engine. When bci=true: injects the transformer JAR
// onto the system classpath and __JvmtiShadow onto the bootstrap classpath, and
// drives the CLASS_FILE_LOAD_HOOK to hand class bytes to the Java transformer.
namespace bci_engine {

// Add bci-transform.jar (system loader) and resolve the default path next to
// the agent library when cfg.bci_jar is empty. Called from VM_INIT.
bool initialize(AgentContext& ctx, jvmtiEnv* jvmti, JNIEnv* jni);

// CLASS_FILE_LOAD_HOOK handler: invokes BciTransformer.transform on eligible
// classes and returns rewritten bytes via JVMTI Allocate. Never throws.
void on_class_file_load(AgentContext& ctx, jvmtiEnv* jvmti, JNIEnv* jni,
                        const char* name,
                        jint class_data_len, const unsigned char* class_data,
                        jint* new_class_data_len, unsigned char** new_class_data);

}  // namespace bci_engine

#endif  // JVMTI_AGENT_BCI_ENGINE_H
