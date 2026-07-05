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

    // Source-code mapping: capture original app-class bytecode (via the class
    // load hook) and ship it so the collector can decompile it for the source
    // view. Independent of BCI *transformation* (it only reads bytes, so it
    // can't break a class). Enabling bci also enables capture.
    bool source = false;

    std::string instance_id;                   // auto UUID if empty
    std::vector<std::string> env_capture;      // env var glob patterns
    std::vector<std::string> redact_props;     // sensitive sys-prop keys to redact
};

// Parse the raw -agentpath option string into an AgentConfig, applying defaults
// (including the built-in deny/location_deny/redact_props pattern sets). This is
// the low-level "defaults + option string only" path, kept for tests and as the
// final (highest-precedence) layer of build_config.
AgentConfig parse_config(const char* options);

// Build the effective configuration the agent runs with, layering sources from
// lowest to highest precedence:
//   1. built-in defaults
//   2. the YAML settings file (jvmscout.yaml) if one is found
//   3. JVMSCOUT_<UPPER_KEY> environment variables (e.g. JVMSCOUT_API_KEY)
//   4. the -agentpath option string (key=val,...) — most explicit, wins
// The settings file is located via: a `config=` option key, then `home=` option
// key, then the JVMSCOUT_CONFIG / JVMSCOUT_HOME environment variables, then the
// directory of the loaded agent library; the file name is jvmscout.yaml (or .yml).
// When no file is found the agent runs purely off env + option string (the
// historical behaviour), so existing -agentpath command lines keep working.
// `loaded_path`, if non-null, receives the settings file actually loaded (empty
// if none) so the caller can log the configuration source.
AgentConfig build_config(const char* options, std::string* loaded_path = nullptr);

// Apply a restricted-subset YAML document (top-level `key: value` scalars, block
// sequences of `- item`, and inline `[a, b]` flow sequences; `#` comments) onto an
// existing config. Exposed for unit testing. Not a full YAML parser — nested maps,
// multi-doc, anchors, and multiline scalars are intentionally unsupported.
void parse_yaml_config(const std::string& text, AgentConfig& cfg);

// True if `name` contains any of `patterns` (case-insensitive substring). Used
// to decide whether a captured value (by variable/property/env name) should be
// redacted. Shared by the local-variable capture path and system-info capture.
bool redact_matches(const std::vector<std::string>& patterns, const std::string& name);

#endif  // JVMTI_AGENT_CONFIG_H
