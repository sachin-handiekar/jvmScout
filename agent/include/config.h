#ifndef JVMTI_AGENT_CONFIG_H
#define JVMTI_AGENT_CONFIG_H

#include <string>
#include <vector>
#include <cstdint>

// Plain-old-data configuration parsed from the -agentpath option string
// (key=val,key=val,...). See PLAN.md section 4.1 for the full key reference.
struct AgentConfig {
    std::string host = "localhost";
    int port = 8080;
    std::string path = "/collector";
    std::string deployment;
    std::string environment;  // e.g. production/staging/development (UI grouping)
    bool console = false;  // per-event stdout logging; opt-in (console=true) —
                           // a production agent must not spam the host app's logs
    int depth = 3;            // object-inspection recursion depth
    int timeout_ms = 5000;    // HTTP timeout

    // Transport security. When https is set the collector is reached over TLS;
    // tls_insecure skips certificate verification (testing/self-signed only).
    // api_key, if set, is sent as an "Authorization: Bearer <key>" header so an
    // authenticated collector (COLLECTOR_API_KEY) accepts the agent's events.
    bool https = false;
    bool tls_insecure = false;
    std::string api_key;

    // Filtering: exception-type denylist and throw-site (location) denylist,
    // plus an optional allowlist that, when non-empty, switches to allow-only mode.
    std::vector<std::string> deny;             // exception class signatures
    std::vector<std::string> location_deny;    // throwing class signatures
    std::vector<std::string> capture_packages; // allowlist mode when non-empty

    // Bytecode instrumentation (shadow local capture).
    bool bci = false;
    std::string bci_jar;                       // auto-detected next to the library if empty
    std::vector<std::string> bci_packages;     // allowlist of packages to instrument
    std::vector<std::string> bci_exclude;
    bool bci_verbose = false;

    std::string instance_id;                   // auto UUID if empty
    std::vector<std::string> env_capture;      // env var glob patterns
    std::vector<std::string> redact_props;     // sensitive sys-prop keys to redact
};

// Parse the raw -agentpath option string into an AgentConfig, applying defaults
// (including the built-in deny/location_deny/redact_props pattern sets).
AgentConfig parse_config(const char* options);

// True if `name` contains any of `patterns` (case-insensitive substring). Used
// to decide whether a captured value (by variable/property/env name) should be
// redacted. Shared by the local-variable capture path and system-info capture.
bool redact_matches(const std::vector<std::string>& patterns, const std::string& name);

#endif  // JVMTI_AGENT_CONFIG_H
