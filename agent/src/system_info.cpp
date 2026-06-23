#include "system_info.h"

#include "agent_context.h"
#include "json_utils.h"
#include "platform.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <ctime>

namespace {

void clear_ex(JNIEnv* jni) {
    if (jni->ExceptionCheck()) jni->ExceptionClear();
}

std::string iso_now() {
    using namespace std::chrono;
    auto now = system_clock::now();
    std::time_t t = system_clock::to_time_t(now);
    std::tm tm{};
#if defined(PLATFORM_WINDOWS)
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    char buf[32];
    std::strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &tm);
    return buf;
}

std::string get_property(JNIEnv* jni, const char* key) {
    jclass sys = jni->FindClass("java/lang/System");
    if (!sys) { clear_ex(jni); return ""; }
    jmethodID mid = jni->GetStaticMethodID(
        sys, "getProperty", "(Ljava/lang/String;)Ljava/lang/String;");
    if (!mid) { clear_ex(jni); return ""; }
    jstring jkey = jni->NewStringUTF(key);
    jstring val = static_cast<jstring>(jni->CallStaticObjectMethod(sys, mid, jkey));
    jni->DeleteLocalRef(jkey);
    if (jni->ExceptionCheck() || !val) { clear_ex(jni); return ""; }
    const char* utf = jni->GetStringUTFChars(val, nullptr);
    std::string out = utf ? utf : "";
    if (utf) jni->ReleaseStringUTFChars(val, utf);
    return out;
}

// Simple '*' glob match (case-insensitive).
bool glob_match(const std::string& pat, const std::string& s) {
    // Convert to lower for case-insensitive compare.
    auto lower = [](std::string x) {
        std::transform(x.begin(), x.end(), x.begin(), ::tolower);
        return x;
    };
    std::string p = lower(pat), v = lower(s);
    size_t pi = 0, vi = 0, star = std::string::npos, mark = 0;
    while (vi < v.size()) {
        if (pi < p.size() && (p[pi] == '?' || p[pi] == v[vi])) { ++pi; ++vi; }
        else if (pi < p.size() && p[pi] == '*') { star = pi++; mark = vi; }
        else if (star != std::string::npos) { pi = star + 1; vi = ++mark; }
        else return false;
    }
    while (pi < p.size() && p[pi] == '*') ++pi;
    return pi == p.size();
}

bool is_redacted(const AgentConfig& cfg, const std::string& key) {
    return redact_matches(cfg.redact_props, key);
}

void write_jvm_args(JsonWriter& w, JNIEnv* jni) {
    w.key("jvmArgs").begin_array();
    jclass mf = jni->FindClass("java/lang/management/ManagementFactory");
    if (!mf) { clear_ex(jni); w.end_array(); return; }
    jmethodID grt = jni->GetStaticMethodID(
        mf, "getRuntimeMXBean", "()Ljava/lang/management/RuntimeMXBean;");
    jobject rt = grt ? jni->CallStaticObjectMethod(mf, grt) : nullptr;
    if (!rt) { clear_ex(jni); w.end_array(); return; }
    jclass rtc = jni->GetObjectClass(rt);
    jmethodID gia = jni->GetMethodID(rtc, "getInputArguments", "()Ljava/util/List;");
    jobject list = gia ? jni->CallObjectMethod(rt, gia) : nullptr;
    if (!list) { clear_ex(jni); w.end_array(); return; }
    jclass listc = jni->GetObjectClass(list);
    jmethodID size = jni->GetMethodID(listc, "size", "()I");
    jmethodID get = jni->GetMethodID(listc, "get", "(I)Ljava/lang/Object;");
    jint n = (size && get) ? jni->CallIntMethod(list, size) : 0;
    for (jint i = 0; i < n; ++i) {
        jstring s = static_cast<jstring>(jni->CallObjectMethod(list, get, i));
        if (!s) { clear_ex(jni); continue; }
        const char* utf = jni->GetStringUTFChars(s, nullptr);
        w.value_string(utf ? utf : "");
        if (utf) jni->ReleaseStringUTFChars(s, utf);
        jni->DeleteLocalRef(s);
    }
    w.end_array();
}

}  // namespace

std::string build_agent_start_event(AgentContext& ctx, jvmtiEnv* /*jvmti*/,
                                    JNIEnv* jni) {
    const AgentConfig& cfg = ctx.config;
    JsonWriter w;
    w.begin_object();
    w.field("type", "agent_start");
    w.field("timestamp", iso_now());
    w.field("instanceId", cfg.instance_id);
    w.field("deploymentId", cfg.deployment);
    w.field("environment", cfg.environment);

    w.key("jvmInfo").begin_object();
    w.field("version", get_property(jni, "java.version"));
    w.field("vendor", get_property(jni, "java.vendor"));
    w.field("vmName", get_property(jni, "java.vm.name"));
    w.field("vmVersion", get_property(jni, "java.vm.version"));
    w.field("runtimeName", get_property(jni, "java.runtime.name"));
    w.end_object();

    w.key("hostInfo").begin_object();
    w.field("name", platform::hostname());
    w.field("os", get_property(jni, "os.name"));
    w.field("osVersion", get_property(jni, "os.version"));
    w.field("arch", get_property(jni, "os.arch"));
    bool k8s = false;
    for (const auto& kv : platform::environment()) {
        if (kv.first == "KUBERNETES_SERVICE_HOST") { k8s = true; break; }
    }
    w.field("kubernetes", k8s);
    w.end_object();

    write_jvm_args(w, jni);
    w.field("classpath", get_property(jni, "java.class.path"));

    // Captured environment variables (only those matching env_capture globs).
    w.key("envVars").begin_object();
    if (!cfg.env_capture.empty()) {
        for (const auto& kv : platform::environment()) {
            bool keep = false;
            for (const auto& pat : cfg.env_capture) {
                if (glob_match(pat, kv.first)) { keep = true; break; }
            }
            if (keep) {
                w.field(kv.first, is_redacted(cfg, kv.first) ? "***" : kv.second);
            }
        }
    }
    w.end_object();

    // Curated system properties (with redaction).
    static const char* kProps[] = {
        "java.home", "java.io.tmpdir", "user.timezone", "file.encoding",
        "os.name", "os.arch", "user.name", "user.dir", "sun.java.command",
    };
    w.key("systemProperties").begin_object();
    for (const char* p : kProps) {
        std::string v = get_property(jni, p);
        w.field(p, is_redacted(cfg, p) ? "***" : v);
    }
    w.end_object();

    w.key("agentConfig").begin_object();
    w.field("host", cfg.host);
    w.field("port", cfg.port);
    w.field("path", cfg.path);
    w.field("console", cfg.console);
    w.field("depth", cfg.depth);
    w.field("bci", cfg.bci);
    w.end_object();

    w.end_object();
    return w.str();
}
