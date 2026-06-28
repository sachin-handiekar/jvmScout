#ifndef JVMTI_AGENT_AGENT_CONTEXT_H
#define JVMTI_AGENT_AGENT_CONTEXT_H

#include <jvmti.h>
#include <memory>

#include "config.h"
#include "ifilter.h"
#include "itransport.h"
#include "async_queue.h"
#include "sampling.h"
#include "object_inspector.h"
#include "bci_shadow.h"
#include "source_cache.h"

// Dependency-injection container: owns every long-lived collaborator and is
// reachable from the JVMTI callbacks via a single global pointer set in
// Agent_OnLoad. Owned objects are created once and freed in VM_DEATH/OnUnload.
struct AgentContext {
    AgentConfig config;
    JavaVM* jvm = nullptr;
    jvmtiEnv* jvmti = nullptr;

    std::unique_ptr<IFilter> type_filter;       // exception class signatures
    std::unique_ptr<IFilter> location_filter;   // throw-site class signatures
    std::unique_ptr<ITransport> transport;
    std::unique_ptr<AsyncQueue> queue;
    std::unique_ptr<ObjectInspector> inspector;
    Sampler sampler;
    BciShadow shadow;
    SourceCache source_cache;  // original app-class bytes for decompiled source view

    // Resolved once at VM_INIT when bci=true (global ref + static transform id).
    jclass bci_transformer_class = nullptr;
    jmethodID bci_transform_method = nullptr;

    bool started = false;  // set true after VM_INIT

    explicit AgentContext(AgentConfig cfg) : config(std::move(cfg)) {}
};

// Global accessor (set in Agent_OnLoad). May be null before load / after unload.
AgentContext* agent_context();
void set_agent_context(AgentContext* ctx);

#endif  // JVMTI_AGENT_AGENT_CONTEXT_H
