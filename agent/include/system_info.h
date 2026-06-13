#ifndef JVMTI_AGENT_SYSTEM_INFO_H
#define JVMTI_AGENT_SYSTEM_INFO_H

#include <jvmti.h>
#include <string>

struct AgentContext;

// Build the one-time agent_start event (type:"agent_start") sent on VM_INIT:
// instance/deployment identity, host info (with k8s detection), JVM args,
// classpath, captured env vars, system properties (redacted), agent config.
std::string build_agent_start_event(AgentContext& ctx, jvmtiEnv* jvmti, JNIEnv* jni);

#endif  // JVMTI_AGENT_SYSTEM_INFO_H
