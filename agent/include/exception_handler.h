#ifndef JVMTI_AGENT_EXCEPTION_HANDLER_H
#define JVMTI_AGENT_EXCEPTION_HANDLER_H

#include <jvmti.h>

// JVMTI Exception event callback. Runs the full hot-path pipeline (reentrance
// guard -> filters -> fingerprint -> sampling -> capture -> serialize ->
// enqueue). The entire body is exception-safe: no C++ exception escapes back
// into the JVM.
void JNICALL exception_callback(jvmtiEnv* jvmti, JNIEnv* jni, jthread thread,
                                jmethodID method, jlocation location,
                                jobject exception, jmethodID catch_method,
                                jlocation catch_location);

struct AgentContext;

// Flush pending aggregated COUNT_ONLY summaries into the send queue. Called
// opportunistically from the exception callback and with force=true at
// VM_DEATH (before the queue is stopped).
void flush_pending_counts(AgentContext& ctx, bool force);

#endif  // JVMTI_AGENT_EXCEPTION_HANDLER_H
