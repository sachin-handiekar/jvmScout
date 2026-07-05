#include <jvmti.h>

#include <cstdio>
#include <cstring>
#include <memory>

#include "agent_context.h"
#include "bci_engine.h"
#include "exception_handler.h"
#include "platform.h"
#include "system_info.h"

namespace {

AgentContext* g_ctx = nullptr;

void JNICALL vm_init(jvmtiEnv* jvmti, JNIEnv* jni, jthread /*thread*/) {
    AgentContext* ctx = agent_context();
    if (!ctx) return;

    if (ctx->config.bci) {
        bci_engine::initialize(*ctx, jvmti, jni);
    }

    // From here on the Exception callback is allowed to capture. Release store:
    // publishes the BCI transformer class/method set above to the callbacks'
    // acquire loads.
    ctx->started.store(true, std::memory_order_release);

    // One-time agent_start registration event.
    if (ctx->queue) {
        try {
            ctx->queue->enqueue(build_agent_start_event(*ctx, jvmti, jni));
        } catch (...) {
            if (jni->ExceptionCheck()) jni->ExceptionClear();
        }
    }

    std::fprintf(stdout,
                 "[jvmti-agent] VM init complete. instance=%s deployment=%s "
                 "collector=%s:%d%s transport=%s\n",
                 ctx->config.instance_id.c_str(),
                 ctx->config.deployment.c_str(),
                 ctx->config.host.c_str(), ctx->config.port,
                 ctx->config.path.c_str(),
                 ctx->transport ? ctx->transport->name() : "none");
    std::fflush(stdout);
}

void JNICALL vm_death(jvmtiEnv* /*jvmti*/, JNIEnv* /*jni*/) {
    AgentContext* ctx = agent_context();
    if (!ctx) return;
    ctx->started.store(false, std::memory_order_release);
    if (ctx->queue) {
        // Ship any buffered COUNT_ONLY summaries before the final drain.
        flush_pending_counts(*ctx, /*force=*/true);
        ctx->queue->stop();  // drains remaining events (bounded drain deadline)
        // Read after stop() so drops incurred during the final drain are counted.
        uint64_t dropped = ctx->queue->dropped();
        if (dropped > 0) {
            std::fprintf(stderr,
                         "[jvmti-agent] %llu events dropped (queue full / "
                         "undeliverable at shutdown)\n",
                         static_cast<unsigned long long>(dropped));
        }
    }
    std::fprintf(stdout, "[jvmti-agent] VM death; agent stopped.\n");
    std::fflush(stdout);
}

void JNICALL class_file_load_hook(jvmtiEnv* jvmti, JNIEnv* jni,
                                  jclass /*class_being_redefined*/,
                                  jobject /*loader*/, const char* name,
                                  jobject /*protection_domain*/,
                                  jint class_data_len,
                                  const unsigned char* class_data,
                                  jint* new_class_data_len,
                                  unsigned char** new_class_data) {
    AgentContext* ctx = agent_context();
    if (!ctx || !ctx->config.bci) return;
    bci_engine::on_class_file_load(*ctx, jvmti, jni, name, class_data_len,
                                   class_data, new_class_data_len, new_class_data);
}

bool add_capabilities(jvmtiEnv* jvmti) {
    jvmtiCapabilities caps;
    std::memset(&caps, 0, sizeof(caps));
    caps.can_generate_exception_events = 1;
    caps.can_access_local_variables = 1;
    caps.can_get_line_numbers = 1;
    caps.can_get_source_file_name = 1;
    caps.can_tag_objects = 1;
    caps.can_generate_all_class_hook_events = 1;
    caps.can_retransform_classes = 1;

    jvmtiError err = jvmti->AddCapabilities(&caps);
    if (err != JVMTI_ERROR_NONE) {
        // Retry with only the essential exception/locals capabilities.
        std::memset(&caps, 0, sizeof(caps));
        caps.can_generate_exception_events = 1;
        caps.can_access_local_variables = 1;
        caps.can_get_line_numbers = 1;
        caps.can_get_source_file_name = 1;
        err = jvmti->AddCapabilities(&caps);
        if (err != JVMTI_ERROR_NONE) {
            std::fprintf(stderr, "[jvmti-agent] AddCapabilities failed: %d\n", err);
            return false;
        }
        std::fprintf(stderr, "[jvmti-agent] running with reduced capabilities\n");
    }
    return true;
}

}  // namespace

AgentContext* agent_context() { return g_ctx; }
void set_agent_context(AgentContext* ctx) { g_ctx = ctx; }

extern "C" JNIEXPORT jint JNICALL
Agent_OnLoad(JavaVM* vm, char* options, void* /*reserved*/) {
    AgentConfig cfg = parse_config(options);
    if (cfg.instance_id.empty()) cfg.instance_id = platform::generate_uuid();

    auto ctx = std::make_unique<AgentContext>(std::move(cfg));
    ctx->jvm = vm;

    jvmtiEnv* jvmti = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&jvmti), JVMTI_VERSION_1_2) != JNI_OK ||
        jvmti == nullptr) {
        std::fprintf(stderr, "[jvmti-agent] could not get JVMTI 1.2 env\n");
        return JNI_ERR;
    }
    ctx->jvmti = jvmti;

    if (!add_capabilities(jvmti)) return JNI_ERR;

    // Build collaborators (DI wiring).
    ctx->type_filter = std::make_unique<DenyAllowFilter>(
        "type", ctx->config.deny, std::vector<std::string>{});
    ctx->location_filter = std::make_unique<DenyAllowFilter>(
        "location", ctx->config.location_deny, ctx->config.capture_packages);
    ctx->inspector = std::make_unique<ObjectInspector>(ctx->config.depth);
    ctx->transport = create_transport(ctx->config);
    ctx->queue = std::make_unique<AsyncQueue>(
        ctx->transport.get(),
        ctx->config.host + ":" + std::to_string(ctx->config.port) + ctx->config.path);
    ctx->queue->start();

    // Event callbacks.
    jvmtiEventCallbacks cb;
    std::memset(&cb, 0, sizeof(cb));
    cb.Exception = &exception_callback;
    cb.VMInit = &vm_init;
    cb.VMDeath = &vm_death;
    cb.ClassFileLoadHook = &class_file_load_hook;
    if (jvmti->SetEventCallbacks(&cb, sizeof(cb)) != JVMTI_ERROR_NONE) {
        std::fprintf(stderr, "[jvmti-agent] SetEventCallbacks failed\n");
        return JNI_ERR;
    }

    jvmti->SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_VM_INIT, nullptr);
    jvmti->SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_VM_DEATH, nullptr);
    jvmti->SetEventNotificationMode(JVMTI_ENABLE, JVMTI_EVENT_EXCEPTION, nullptr);
    if (ctx->config.bci) {
        jvmti->SetEventNotificationMode(JVMTI_ENABLE,
                                        JVMTI_EVENT_CLASS_FILE_LOAD_HOOK, nullptr);
    }

    set_agent_context(ctx.release());  // ownership held until OnUnload
    std::fprintf(stdout, "[jvmti-agent] loaded (Agent_OnLoad).\n");
    std::fflush(stdout);
    return JNI_OK;
}

extern "C" JNIEXPORT jint JNICALL
Agent_OnAttach(JavaVM* vm, char* options, void* reserved) {
    // Dynamic attach uses the same load path, but VM_INIT never fires (the VM
    // is already live), so the work vm_init would do must happen here: BCI
    // bring-up and the one-time agent_start registration event — without it an
    // attached JVM never appears in the dashboard's instance list.
    jint rc = Agent_OnLoad(vm, options, reserved);
    if (rc != JNI_OK) return rc;
    AgentContext* ctx = agent_context();
    if (!ctx) return rc;

    JNIEnv* jni = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&jni), JNI_VERSION_1_6) == JNI_OK &&
        jni != nullptr) {
        if (ctx->config.bci) {
            // Only classes loaded from now on are instrumented.
            bci_engine::initialize(*ctx, ctx->jvmti, jni);
        }
        ctx->started.store(true, std::memory_order_release);
        if (ctx->queue) {
            try {
                ctx->queue->enqueue(build_agent_start_event(*ctx, ctx->jvmti, jni));
            } catch (...) {
                if (jni->ExceptionCheck()) jni->ExceptionClear();
            }
        }
    } else {
        // No JNIEnv on this thread (unexpected): still enable capture.
        ctx->started.store(true, std::memory_order_release);
    }
    std::fprintf(stdout, "[jvmti-agent] attached (Agent_OnAttach). instance=%s\n",
                 ctx->config.instance_id.c_str());
    std::fflush(stdout);
    return rc;
}

extern "C" JNIEXPORT void JNICALL Agent_OnUnload(JavaVM* /*vm*/) {
    AgentContext* ctx = agent_context();
    set_agent_context(nullptr);
    delete ctx;  // queue stopped in vm_death; safe to destroy
}
