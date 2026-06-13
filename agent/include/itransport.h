#ifndef JVMTI_AGENT_ITRANSPORT_H
#define JVMTI_AGENT_ITRANSPORT_H

#include <string>
#include <memory>

struct AgentConfig;

// Pluggable HTTP transport. Implemented by WinHttpTransport (Windows) and
// CurlTransport (libcurl, Linux/macOS); selected at compile time.
class ITransport {
public:
    virtual ~ITransport() = default;
    // POST a JSON body to the configured collector endpoint. Returns true on a
    // 2xx response. Must never throw.
    virtual bool send(const std::string& json_body) = 0;
    virtual const char* name() const = 0;
};

// Factory implemented per platform: returns the appropriate ITransport.
std::unique_ptr<ITransport> create_transport(const AgentConfig& cfg);

#endif  // JVMTI_AGENT_ITRANSPORT_H
