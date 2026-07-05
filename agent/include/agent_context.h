#ifndef JVMTI_AGENT_AGENT_CONTEXT_H
#define JVMTI_AGENT_AGENT_CONTEXT_H

#include <jvmti.h>
#include <atomic>
#include <memory>

#include "config.h"
#include "count_aggregator.h"
#include "ifilter.h"
#include "itransport.h"
#include "async_queue.h"
#include "method_info_cache.h"
#include "sampling.h"
#include "object_inspector.h"
#include "bci_shadow.h"

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
    MethodInfoCache method_cache;   // per-jmethodID metadata (pre-decision path)
    CountAggregator aggregator;     // COUNT_ONLY occurrence batching

    // Resolved once at VM_INIT when bci=true (global ref + static transform id).
    jclass bci_transformer_class = nullptr;
    jmethodID bci_transform_method = nullptr;

    // Set true after VM_INIT (or immediately on dynamic attach) by the init
    // thread and read concurrently by the Exception / ClassFileLoadHook
    // callbacks on arbitrary application threads. The release store in vm_init
    // also publishes the BCI fields written just before it (transformer class
    // + method id), which the load hook reads only after seeing started==true.
    std::atomic<bool> started{false};

    explicit AgentContext(AgentConfig cfg) : config(std::move(cfg)) {}
};

// Global accessor (set in Agent_OnLoad). May be null before load / after unload.
AgentContext* agent_context();
void set_agent_context(AgentContext* ctx);

#endif  // JVMTI_AGENT_AGENT_CONTEXT_H
