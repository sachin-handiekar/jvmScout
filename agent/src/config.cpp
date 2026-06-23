#include "config.h"

#include <algorithm>
#include <cstdlib>
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

    if (options && *options) {
        for (const std::string& kv : split(options, ',')) {
            auto eq = kv.find('=');
            if (eq == std::string::npos) continue;
            std::string key = kv.substr(0, eq);
            std::string val = kv.substr(eq + 1);

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
            else if (key == "instance_id") cfg.instance_id = val;
            else if (key == "env_capture") cfg.env_capture = split(val, ';');
            else if (key == "redact_props") { for (auto& p : split(val, ';')) cfg.redact_props.push_back(p); }
        }
    }
    return cfg;
}
