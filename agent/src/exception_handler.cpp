#include "exception_handler.h"

#include "agent_context.h"
#include "event_model.h"
#include "event_serializer.h"
#include "fingerprint.h"
#include "jvm_metrics.h"
#include "jvmti_utils.h"
#include "stack_walker.h"

#include <chrono>
#include <cstdio>
#include <ctime>
#include <string>

namespace {

// Blocks recursive captures: an exception thrown while we are capturing (e.g.
// inside getMessage()) must not re-enter the pipeline.
thread_local bool t_in_capture = false;

struct ReentranceGuard {
    bool engaged;
    ReentranceGuard() : engaged(!t_in_capture) {
        if (engaged) t_in_capture = true;
    }
    ~ReentranceGuard() {
        if (engaged) t_in_capture = false;
    }
};

// Cap on captured exception/cause/suppressed message length, so a pathological
// throwable with a multi-MB message can't produce a giant event.
constexpr size_t kMaxMessageLen = 4096;

void clear_ex(JNIEnv* jni) {
    if (jni->ExceptionCheck()) jni->ExceptionClear();
}

void truncate_in_place(std::string& s, size_t max_len) {
    if (s.size() > max_len) {
        s.resize(max_len);
        s += "...(truncated)";
    }
}

std::string iso8601_now() {
    using namespace std::chrono;
    auto now = system_clock::now();
    std::time_t t = system_clock::to_time_t(now);
    auto ms = duration_cast<milliseconds>(now.time_since_epoch()).count() % 1000;
    std::tm tm{};
#if defined(PLATFORM_WINDOWS)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                  tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec, static_cast<int>(ms));
    return buf;
}

std::string class_signature_slash(jvmtiEnv* jvmti, jclass cls) {
    if (!cls) return "";
    char* sig = nullptr;
    if (jvmti->GetClassSignature(cls, &sig, nullptr) != JVMTI_ERROR_NONE) return "";
    JvmtiString freeSig(jvmti, sig);
    return signature_to_slash(sig ? sig : "");
}

// Call a no-arg ()Ljava/lang/String; method (e.g. getMessage). Returns empty on
// any failure; clears pending exceptions.
std::string call_string_method(JNIEnv* jni, jobject obj, const char* method) {
    if (!obj) return "";
    jclass cls = jni->GetObjectClass(obj);
    jmethodID mid = jni->GetMethodID(cls, method, "()Ljava/lang/String;");
    jni->DeleteLocalRef(cls);
    if (!mid) { clear_ex(jni); return ""; }
    jstring s = static_cast<jstring>(jni->CallObjectMethod(obj, mid));
    if (jni->ExceptionCheck() || !s) { clear_ex(jni); return ""; }
    const char* utf = jni->GetStringUTFChars(s, nullptr);
    std::string out = utf ? utf : "";
    if (utf) jni->ReleaseStringUTFChars(s, utf);
    truncate_in_place(out, kMaxMessageLen);
    return out;
}

jobject call_object_method(JNIEnv* jni, jobject obj, const char* method,
                           const char* sig) {
    if (!obj) return nullptr;
    jclass cls = jni->GetObjectClass(obj);
    jmethodID mid = jni->GetMethodID(cls, method, sig);
    jni->DeleteLocalRef(cls);
    if (!mid) { clear_ex(jni); return nullptr; }
    jobject r = jni->CallObjectMethod(obj, mid);
    if (jni->ExceptionCheck()) { clear_ex(jni); return nullptr; }
    return r;
}

std::string exception_type_slash(jvmtiEnv* jvmti, JNIEnv* jni, jobject ex) {
    jclass exc = jni->GetObjectClass(ex);
    std::string out = class_signature_slash(jvmti, exc);
    if (exc) jni->DeleteLocalRef(exc);
    return out;
}

void fill_cause_chain(jvmtiEnv* jvmti, JNIEnv* jni, jobject ex,
                      std::vector<CauseInfo>& out) {
    jobject cur = call_object_method(jni, ex, "getCause", "()Ljava/lang/Throwable;");
    int guard = 0;
    while (cur && guard < 10) {
        CauseInfo c;
        c.exception_type = exception_type_slash(jvmti, jni, cur);
        c.exception_message = call_string_method(jni, cur, "getMessage");
        out.push_back(std::move(c));
        jobject next = call_object_method(jni, cur, "getCause", "()Ljava/lang/Throwable;");
        jni->DeleteLocalRef(cur);
        if (next == cur) { if (next) jni->DeleteLocalRef(next); break; }
        cur = next;
        ++guard;
    }
    if (cur) jni->DeleteLocalRef(cur);
}

void fill_suppressed(jvmtiEnv* jvmti, JNIEnv* jni, jobject ex,
                     std::vector<CauseInfo>& out) {
    jobject arr = call_object_method(jni, ex, "getSuppressed",
                                     "()[Ljava/lang/Throwable;");
    if (!arr) return;
    jobjectArray oarr = static_cast<jobjectArray>(arr);
    jsize n = jni->GetArrayLength(oarr);
    for (jsize i = 0; i < n && i < 10; ++i) {
        jobject s = jni->GetObjectArrayElement(oarr, i);
        if (!s) continue;
        CauseInfo c;
        c.exception_type = exception_type_slash(jvmti, jni, s);
        c.exception_message = call_string_method(jni, s, "getMessage");
        out.push_back(std::move(c));
        jni->DeleteLocalRef(s);
    }
    jni->DeleteLocalRef(arr);
}

void fill_thread_info(jvmtiEnv* jvmti, jthread thread, ThreadDetails& td) {
    jvmtiThreadInfo info;
    if (jvmti->GetThreadInfo(thread, &info) != JVMTI_ERROR_NONE) return;
    td.name = info.name ? info.name : "";
    td.priority = info.priority;
    td.is_daemon = info.is_daemon == JNI_TRUE;
    if (info.name) jvmti->Deallocate(reinterpret_cast<unsigned char*>(info.name));
}

Location location_from_method(jvmtiEnv* jvmti, JNIEnv* jni, jmethodID method,
                              jlocation loc) {
    Location l;
    char* mname = nullptr;
    if (jvmti->GetMethodName(method, &mname, nullptr, nullptr) == JVMTI_ERROR_NONE) {
        JvmtiString freeName(jvmti, mname);
        l.method_name = mname ? mname : "";
    }
    jclass decl = nullptr;
    if (jvmti->GetMethodDeclaringClass(method, &decl) == JVMTI_ERROR_NONE && decl) {
        char* csig = nullptr;
        if (jvmti->GetClassSignature(decl, &csig, nullptr) == JVMTI_ERROR_NONE) {
            JvmtiString freeCsig(jvmti, csig);
            l.class_name = signature_to_dotted(csig ? csig : "");
        }
        char* src = nullptr;
        if (jvmti->GetSourceFileName(decl, &src) == JVMTI_ERROR_NONE) {
            JvmtiString freeSrc(jvmti, src);
            l.source_file = src ? src : "";
        }
        jni->DeleteLocalRef(decl);
    }
    l.line_number = resolve_line_number(jvmti, method, loc);
    l.valid = true;
    return l;
}

void print_console(const AgentConfig& cfg, const CapturedEvent& ev) {
    if (!cfg.console) return;
    if (ev.mode == CaptureMode::FULL) {
        std::fprintf(stdout,
            "\n[jvmti-agent] ===== EXCEPTION (%s) =====\n"
            "  type      : %s\n  message   : %s\n  at        : %s.%s(%s:%d)\n"
            "  caught    : %s\n  fingerprint: %s  hits: %llu\n"
            "  frames    : %llu\n",
            capture_mode_name(ev.mode), ev.exception_type.c_str(),
            ev.exception_message.c_str(), ev.location.class_name.c_str(),
            ev.location.method_name.c_str(), ev.location.source_file.c_str(),
            ev.location.line_number, ev.caught ? "yes" : "no",
            ev.fingerprint.c_str(), static_cast<unsigned long long>(ev.hit_count),
            static_cast<unsigned long long>(ev.stack.size()));
    } else {
        std::fprintf(stdout, "[jvmti-agent] %s %s at %s.%s:%d (hits=%llu, %s)\n",
            capture_mode_name(ev.mode), ev.exception_type.c_str(),
            ev.location.class_name.c_str(), ev.location.method_name.c_str(),
            ev.location.line_number,
            static_cast<unsigned long long>(ev.hit_count),
            ev.fingerprint.c_str());
    }
    std::fflush(stdout);
}

}  // namespace

void JNICALL exception_callback(jvmtiEnv* jvmti, JNIEnv* jni, jthread thread,
                                jmethodID method, jlocation location,
                                jobject exception, jmethodID catch_method,
                                jlocation catch_location) {
    ReentranceGuard guard;
    if (!guard.engaged) return;

    AgentContext* ctx = agent_context();
    if (!ctx || !ctx->started.load(std::memory_order_acquire)) return;

    try {
        JniLocalFrame frame(jni, 128);

        // Exception type + type filter.
        const std::string ex_type = exception_type_slash(jvmti, jni, exception);
        if (ctx->type_filter && !ctx->type_filter->accept(ex_type)) return;

        // Throw-site class + location filter.
        jclass decl = nullptr;
        std::string throw_class_slash;
        if (jvmti->GetMethodDeclaringClass(method, &decl) == JVMTI_ERROR_NONE) {
            throw_class_slash = class_signature_slash(jvmti, decl);
            if (decl) jni->DeleteLocalRef(decl);
        }
        if (ctx->location_filter && !ctx->location_filter->accept(throw_class_slash)) {
            return;
        }

        // Method name + line for fingerprint.
        std::string method_name;
        char* mname = nullptr;
        if (jvmti->GetMethodName(method, &mname, nullptr, nullptr) == JVMTI_ERROR_NONE) {
            JvmtiString freeName(jvmti, mname);
            method_name = mname ? mname : "";
        }
        int line = resolve_line_number(jvmti, method, location);

        const std::string fp =
            compute_fingerprint(ex_type, throw_class_slash, method_name, line);

        Sampler::Decision d = ctx->sampler.decide(fp);

        CapturedEvent ev;
        ev.fingerprint = fp;
        ev.mode = d.mode;
        ev.hit_count = d.hit_count;
        ev.timestamp = iso8601_now();
        ev.deployment_id = ctx->config.deployment;
        ev.environment = ctx->config.environment;
        ev.instance_id = ctx->config.instance_id;
        ev.exception_type = ex_type;
        ev.exception_message = call_string_method(jni, exception, "getMessage");
        ev.caught = (catch_method != nullptr);
        ev.location = location_from_method(jvmti, jni, method, location);
        if (catch_method) {
            ev.caught_at = location_from_method(jvmti, jni, catch_method, catch_location);
        }
        fill_thread_info(jvmti, thread, ev.thread);

        if (d.mode != CaptureMode::COUNT_ONLY) {
            fill_cause_chain(jvmti, jni, exception, ev.cause_chain);
            fill_suppressed(jvmti, jni, exception, ev.suppressed);
        }

        BciShadow* shadow = nullptr;
        if (ctx->config.bci) {
            ctx->shadow.ensure_ready(jni);
            shadow = &ctx->shadow;
        }

        if (d.mode == CaptureMode::FULL) {
            ev.metrics = collect_jvm_metrics_cached(jvmti, jni);
            ev.metrics_valid = true;
            StackWalker walker(jvmti, ctx->inspector.get(),
                               ctx->location_filter.get(), shadow,
                               &ctx->config.redact_props);
            ev.stack = walker.walk(jni, thread, /*capture_locals=*/true);
        } else if (d.mode == CaptureMode::REDUCED) {
            StackWalker walker(jvmti, ctx->inspector.get(),
                               ctx->location_filter.get(), shadow,
                               &ctx->config.redact_props);
            ev.stack = walker.walk(jni, thread, /*capture_locals=*/false,
                                   StackWalker::kReducedFrames);
        }

        print_console(ctx->config, ev);

        if (ctx->queue) {
            ctx->queue->enqueue(serialize_event(ev));
        }
    } catch (const std::exception&) {
        clear_ex(jni);
    } catch (...) {
        clear_ex(jni);
    }
}
