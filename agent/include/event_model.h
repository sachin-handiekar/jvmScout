#ifndef JVMTI_AGENT_EVENT_MODEL_H
#define JVMTI_AGENT_EVENT_MODEL_H

#include <cstdint>
#include <string>
#include <vector>

#include "sampling.h"
#include "jvm_metrics.h"

// Captured data structures produced by the capture path and consumed by the
// serializer. Field naming maps onto the wire schema in PLAN.md section 4.3.

struct LocalVariable {
    std::string name;       // empty when no debug info / unnamed slot
    std::string signature;  // JVM type signature, may be empty
    int slot = -1;
    std::string type;       // coarse kind for slot-only vars: "Object","int",...
    std::string value;      // rendered value (already display-ready)
    std::string source;     // "debug_info" or "bci_shadow"
};

struct StackFrame {
    int frame_index = 0;
    std::string class_name;   // dotted
    std::string method_name;
    int line_number = -1;
    std::string source_file;
    bool app_code = true;
    std::vector<LocalVariable> locals;
};

struct Location {
    std::string class_name;   // dotted
    std::string method_name;
    int line_number = -1;
    std::string source_file;
    bool valid = false;
};

struct CauseInfo {
    std::string exception_type;     // slash form
    std::string exception_message;
};

struct ThreadDetails {
    std::string name;
    int priority = -1;
    bool is_daemon = false;
};

// One captured exception ready to serialize.
struct CapturedEvent {
    std::string fingerprint;
    CaptureMode mode = CaptureMode::FULL;
    uint64_t hit_count = 0;    // cumulative per-fingerprint counter (display)
    uint64_t occurrences = 1;  // real throws this event represents (>1 for
                               // aggregated COUNT_ONLY summaries)
    std::string timestamp;  // ISO-8601 UTC
    std::string deployment_id;
    std::string environment;
    std::string instance_id;

    std::string exception_type;     // slash form, e.g. java/lang/NullPointerException
    std::string exception_message;
    bool caught = true;

    Location location;              // throw site
    Location caught_at;             // catch site (valid only if known)

    ThreadDetails thread;
    std::vector<CauseInfo> cause_chain;        // <= 10
    std::vector<CauseInfo> suppressed;
    JvmMetrics metrics;
    bool metrics_valid = false;
    std::vector<StackFrame> stack;             // <= 100 frames
};

#endif  // JVMTI_AGENT_EVENT_MODEL_H
