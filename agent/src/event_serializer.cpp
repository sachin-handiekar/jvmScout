#include "event_serializer.h"

#include "json_utils.h"

namespace {

void write_location(JsonWriter& w, const std::string& k, const Location& loc) {
    w.key(k);
    if (!loc.valid) { w.value_null(); return; }
    w.begin_object();
    w.field("className", loc.class_name);
    w.field("methodName", loc.method_name);
    if (loc.line_number >= 0) w.field("lineNumber", loc.line_number);
    else w.field_null("lineNumber");
    w.field("sourceFile", loc.source_file);
    w.end_object();
}

void write_causes(JsonWriter& w, const std::string& k,
                  const std::vector<CauseInfo>& causes) {
    w.key(k).begin_array();
    for (const auto& c : causes) {
        w.begin_object();
        w.field("exceptionType", c.exception_type);
        w.field("exceptionMessage", c.exception_message);
        w.end_object();
    }
    w.end_array();
}

void write_metrics(JsonWriter& w, const JvmMetrics& m) {
    w.key("jvmMetrics").begin_object();
    w.field("heapUsedBytes", static_cast<long long>(m.heap_used_bytes));
    w.field("heapMaxBytes", static_cast<long long>(m.heap_max_bytes));
    w.field("gcCollectionCount", static_cast<long long>(m.gc_collection_count));
    w.field("gcTimeMs", static_cast<long long>(m.gc_time_ms));
    w.field("threadCount", m.thread_count);
    w.field("loadedClassCount", m.loaded_class_count);
    w.field("uptimeMs", static_cast<long long>(m.uptime_ms));
    w.end_object();
}

}  // namespace

std::string serialize_event(const CapturedEvent& ev) {
    JsonWriter w;
    w.begin_object();

    w.field("timestamp", ev.timestamp);
    w.field("fingerprint", ev.fingerprint);
    w.field("captureMode", capture_mode_name(ev.mode));
    w.field("hitCount", static_cast<unsigned long long>(ev.hit_count));
    w.field("deploymentId", ev.deployment_id);
    w.field("instanceId", ev.instance_id);
    w.field("exceptionType", ev.exception_type);
    w.field("exceptionMessage", ev.exception_message);
    w.field("caught", ev.caught);

    write_location(w, "location", ev.location);
    write_location(w, "caughtAt", ev.caught_at);

    w.key("threadInfo").begin_object();
    w.field("name", ev.thread.name);
    w.field("priority", ev.thread.priority);
    w.field("isDaemon", ev.thread.is_daemon);
    w.end_object();

    write_causes(w, "causeChain", ev.cause_chain);
    write_causes(w, "suppressedExceptions", ev.suppressed);

    if (ev.metrics_valid) {
        write_metrics(w, ev.metrics);
    } else {
        w.field_null("jvmMetrics");
    }

    w.key("stackTrace").begin_array();
    for (const auto& f : ev.stack) {
        w.begin_object();
        w.field("frameIndex", f.frame_index);
        w.field("className", f.class_name);
        w.field("methodName", f.method_name);
        if (f.line_number >= 0) w.field("lineNumber", f.line_number);
        else w.field_null("lineNumber");
        w.field("sourceFile", f.source_file);
        w.field("isAppCode", f.app_code);
        w.key("localVariables").begin_array();
        for (const auto& lv : f.locals) {
            w.begin_object();
            if (!lv.name.empty()) w.field("name", lv.name);
            if (!lv.signature.empty()) w.field("signature", lv.signature);
            w.field("slot", lv.slot);
            if (!lv.type.empty()) w.field("type", lv.type);
            w.field("value", lv.value);
            w.field("source", lv.source);
            w.end_object();
        }
        w.end_array();
        w.end_object();
    }
    w.end_array();

    w.end_object();
    return w.str();
}
