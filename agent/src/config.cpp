#include "config.h"

#include "platform.h"

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <sstream>

namespace {

std::vector<std::string> split(const std::string& s, char delim) {
    std::vector<std::string> out;
    std::string item;
    std::istringstream ss(s);
    while (std::getline(ss, item, delim)) {
        if (!item.empty()) out.push_back(item);
    }
    return out;
}

bool to_bool(const std::string& v) {
    std::string s = v;
    std::transform(s.begin(), s.end(), s.begin(), ::tolower);
    return s == "true" || s == "1" || s == "yes" || s == "on";
}

// Built-in default denylists (abbreviated but representative of NOTES.md).
std::vector<std::string> default_type_deny() {
    return {
        "java/lang/ClassNotFoundException",
        "java/lang/NoClassDefFoundError",
        "java/lang/InterruptedException",
        "java/io/FileNotFoundException",
        "java/net/SocketException",
        "java/net/SocketTimeoutException",
        "java/util/concurrent/TimeoutException",
        "sun/misc/Unsafe",
        "jdk/internal/",
        "java/lang/reflect/InvocationTargetException",
    };
}

std::vector<std::string> default_location_deny() {
    return {
        "java/", "javax/", "jdk/", "sun/", "com/sun/",
        "org/springframework/", "org/apache/catalina/", "org/apache/coyote/",
        "org/apache/tomcat/", "org/eclipse/jetty/", "io/netty/",
        "org/hibernate/", "com/fasterxml/jackson/", "ch/qos/logback/",
        "org/apache/logging/log4j/", "org/slf4j/", "kotlin/",
        "scala/", "groovy/", "clojure/", "org/junit/", "org/testng/",
        "org/mockito/", "net/bytebuddy/",
    };
}

std::vector<std::string> default_redact_props() {
    return {"password", "passwd", "secret", "token", "apikey", "api.key", "credential"};
}

// Strip leading/trailing ASCII whitespace.
std::string trim(const std::string& s) {
    size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// Strip a single layer of matching surrounding quotes (YAML scalars may be quoted).
std::string unquote(std::string s) {
    if (s.size() >= 2 && (s.front() == '"' || s.front() == '\'') && s.back() == s.front()) {
        s = s.substr(1, s.size() - 2);
    }
    return s;
}

// Directory portion of a path (with trailing separator), or "" if none.
std::string dirname(const std::string& path) {
    size_t slash = path.find_last_of("/\\");
    return slash == std::string::npos ? "" : path.substr(0, slash + 1);
}

std::string getenv_str(const char* name) {
    const char* v = std::getenv(name);
    return v ? std::string(v) : std::string();
}

// All recognised configuration keys (for the JVMSCOUT_<UPPER_KEY> env layer).
const std::vector<std::string>& known_keys() {
    static const std::vector<std::string> keys = {
        "host", "port", "path", "deployment", "environment", "console", "depth",
        "timeout", "https", "tls_insecure", "api_key", "deny", "location_deny",
        "capture_packages", "bci", "bci_jar", "bci_packages", "bci_exclude",
        "bci_verbose", "source", "instance_id", "env_capture", "redact_props",
    };
    return keys;
}

// Apply a single key/value onto cfg. Shared by the option-string, YAML, and env
// layers so every source maps keys identically (and keeps the same list
// append-vs-replace semantics). Unknown keys are ignored.
void apply_kv(AgentConfig& cfg, const std::string& key, const std::string& val) {
    if (key == "host") cfg.host = val;
    else if (key == "port") cfg.port = std::atoi(val.c_str());
    else if (key == "path") cfg.path = val;
    else if (key == "deployment") cfg.deployment = val;
    else if (key == "environment") cfg.environment = val;
    else if (key == "console") cfg.console = to_bool(val);
    else if (key == "depth") cfg.depth = std::atoi(val.c_str());
    else if (key == "timeout") cfg.timeout_ms = std::atoi(val.c_str());
    else if (key == "https") cfg.https = to_bool(val);
    else if (key == "tls_insecure") cfg.tls_insecure = to_bool(val);
    else if (key == "api_key") cfg.api_key = val;
    else if (key == "deny") { for (auto& p : split(val, ';')) cfg.deny.push_back(p); }
    else if (key == "location_deny") { for (auto& p : split(val, ';')) cfg.location_deny.push_back(p); }
    else if (key == "capture_packages") cfg.capture_packages = split(val, ';');
    else if (key == "bci") cfg.bci = to_bool(val);
    else if (key == "bci_jar") cfg.bci_jar = val;
    else if (key == "bci_packages") cfg.bci_packages = split(val, ';');
    else if (key == "bci_exclude") cfg.bci_exclude = split(val, ';');
    else if (key == "bci_verbose") cfg.bci_verbose = to_bool(val);
    else if (key == "source") cfg.source = to_bool(val);
    else if (key == "instance_id") cfg.instance_id = val;
    else if (key == "env_capture") cfg.env_capture = split(val, ';');
    else if (key == "redact_props") { for (auto& p : split(val, ';')) cfg.redact_props.push_back(p); }
}

// Apply the -agentpath option string (key=val,key=val,...) onto cfg.
void apply_options(AgentConfig& cfg, const char* options) {
    if (!options || !*options) return;
    for (const std::string& kv : split(options, ',')) {
        auto eq = kv.find('=');
        if (eq == std::string::npos) continue;
        apply_kv(cfg, kv.substr(0, eq), kv.substr(eq + 1));
    }
}

// Layer 3: JVMSCOUT_<UPPER_KEY> environment variables (e.g. JVMSCOUT_API_KEY).
// List values are passed through verbatim so the same ';'-separated form used in
// the option string works (e.g. JVMSCOUT_BCI_PACKAGES=com.x;com.y).
void apply_env_overrides(AgentConfig& cfg) {
    for (const std::string& key : known_keys()) {
        std::string env = "JVMSCOUT_" + key;
        std::transform(env.begin(), env.end(), env.begin(), ::toupper);
        const char* v = std::getenv(env.c_str());
        if (v && *v) apply_kv(cfg, key, v);
    }
}

}  // namespace

bool redact_matches(const std::vector<std::string>& patterns, const std::string& name) {
    std::string k = name;
    std::transform(k.begin(), k.end(), k.begin(), ::tolower);
    for (const auto& pat : patterns) {
        std::string p = pat;
        std::transform(p.begin(), p.end(), p.begin(), ::tolower);
        if (!p.empty() && k.find(p) != std::string::npos) return true;
    }
    return false;
}

AgentConfig parse_config(const char* options) {
    AgentConfig cfg;
    cfg.deny = default_type_deny();
    cfg.location_deny = default_location_deny();
    cfg.redact_props = default_redact_props();
    apply_options(cfg, options);
    return cfg;
}

namespace {

// Parse a YAML flow sequence "[a, b, c]" into ';'-joined form for apply_kv. The
// brackets must already be stripped by the caller.
std::string flow_seq_to_semicolons(const std::string& inner) {
    std::string out;
    for (const std::string& item : split(inner, ',')) {
        std::string v = unquote(trim(item));
        if (v.empty()) continue;
        if (!out.empty()) out += ';';
        out += v;
    }
    return out;
}

}  // namespace

void parse_yaml_config(const std::string& text, AgentConfig& cfg) {
    std::istringstream ss(text);
    std::string line;
    std::string pending_list_key;          // a "key:" awaiting block "- item" entries
    std::vector<std::string> pending_items;

    auto flush_list = [&]() {
        if (!pending_list_key.empty()) {
            // Join collected items with ';' and route through the shared mapper.
            std::string joined;
            for (const auto& it : pending_items) {
                if (!joined.empty()) joined += ';';
                joined += it;
            }
            apply_kv(cfg, pending_list_key, joined);
        }
        pending_list_key.clear();
        pending_items.clear();
    };

    while (std::getline(ss, line)) {
        // Drop comments (we don't support '#' inside quoted scalars — fine here).
        auto hash = line.find('#');
        if (hash != std::string::npos) line = line.substr(0, hash);
        std::string raw = line;
        std::string t = trim(line);
        if (t.empty()) continue;

        // Block-sequence entry "- item" continues the most recent "key:".
        if (t.rfind("- ", 0) == 0 || t == "-") {
            if (!pending_list_key.empty()) {
                std::string item = unquote(trim(t.size() > 1 ? t.substr(1) : ""));
                if (!item.empty()) pending_items.push_back(item);
            }
            continue;
        }

        // Any non-"- " line ends a pending block list.
        flush_list();

        auto colon = t.find(':');
        if (colon == std::string::npos) continue;        // not a mapping line
        std::string key = trim(t.substr(0, colon));
        std::string val = trim(t.substr(colon + 1));

        if (val.empty()) {
            // "key:" with nothing after — start collecting block-sequence items.
            pending_list_key = key;
            continue;
        }
        if (val.front() == '[' && val.back() == ']') {
            // Inline flow sequence.
            apply_kv(cfg, key, flow_seq_to_semicolons(val.substr(1, val.size() - 2)));
            continue;
        }
        apply_kv(cfg, key, unquote(val));
    }
    flush_list();
}

namespace {

// Resolve the settings file path. Precedence: option `config=` > `home=` >
// JVMSCOUT_CONFIG env > JVMSCOUT_HOME env > the loaded library's directory.
// Returns the first jvmscout.yaml / jvmscout.yml that exists, else "".
std::string resolve_config_path(const char* options) {
    // Pull just the home/config hints out of the option string (cheaply).
    std::string opt_home, opt_config;
    if (options && *options) {
        for (const std::string& kv : split(options, ',')) {
            auto eq = kv.find('=');
            if (eq == std::string::npos) continue;
            std::string k = kv.substr(0, eq), v = kv.substr(eq + 1);
            if (k == "home") opt_home = v;
            else if (k == "config") opt_config = v;
        }
    }

    auto exists = [](const std::string& p) {
        if (p.empty()) return false;
        std::ifstream f(p);
        return f.good();
    };

    // An explicit file path wins outright.
    if (!opt_config.empty()) return opt_config;
    std::string env_config = getenv_str("JVMSCOUT_CONFIG");
    if (!env_config.empty()) return env_config;

    // Otherwise look for jvmscout.yaml/.yml in the resolved home directory.
    std::vector<std::string> homes;
    if (!opt_home.empty()) homes.push_back(opt_home);
    std::string env_home = getenv_str("JVMSCOUT_HOME");
    if (!env_home.empty()) homes.push_back(env_home);
    homes.push_back(dirname(platform::this_library_path()));  // may be ""

    for (std::string home : homes) {
        if (home.empty()) continue;
        char last = home.back();
        if (last != '/' && last != '\\') home += '/';
        for (const char* name : {"jvmscout.yaml", "jvmscout.yml"}) {
            std::string candidate = home + name;
            if (exists(candidate)) return candidate;
        }
    }
    return "";
}

}  // namespace

AgentConfig build_config(const char* options, std::string* loaded_path) {
    AgentConfig cfg;
    cfg.deny = default_type_deny();
    cfg.location_deny = default_location_deny();
    cfg.redact_props = default_redact_props();

    // Layer 2: YAML settings file.
    std::string path = resolve_config_path(options);
    if (!path.empty()) {
        std::ifstream f(path, std::ios::binary);
        if (f) {
            std::ostringstream buf;
            buf << f.rdbuf();
            parse_yaml_config(buf.str(), cfg);
            if (loaded_path) *loaded_path = path;
        } else {
            path.clear();
        }
    }
    if (loaded_path && path.empty()) loaded_path->clear();

    // Layer 3: JVMSCOUT_<KEY> environment overrides.
    apply_env_overrides(cfg);

    // Layer 4: -agentpath option string (most explicit).
    apply_options(cfg, options);
    return cfg;
}
