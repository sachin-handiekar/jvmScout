#ifndef JVMTI_AGENT_ITRANSPORT_H
#define JVMTI_AGENT_ITRANSPORT_H

#include <string>
#include <memory>

struct AgentConfig;

// Outcome of one POST attempt, so the queue can distinguish "try again later"
// (network error, 5xx, 408/429) from "this will never succeed" (auth failure,
// bad request, misconfigured endpoint) and stop retrying the latter.
enum class SendResult {
    kOk,         // 2xx
    kRetryable,  // transient: network error, 5xx, 408, 429
    kPermanent,  // definitive rejection: other 4xx/3xx (e.g. 401 revoked token)
};

// Pluggable HTTP transport. Implemented by WinHttpTransport (Windows) and
// CurlTransport (libcurl, Linux/macOS); selected at compile time.
class ITransport {
public:
    virtual ~ITransport() = default;
    // POST a JSON body to the configured collector endpoint. Must never throw.
    virtual SendResult send(const std::string& json_body) = 0;
    virtual const char* name() const = 0;
};

// Map an HTTP status code to a SendResult (shared by the transports).
inline SendResult classify_http_status(long status) {
    if (status >= 200 && status < 300) return SendResult::kOk;
    if (status == 408 || status == 429 || status >= 500) return SendResult::kRetryable;
    return SendResult::kPermanent;
}

// Factory implemented per platform: returns the appropriate ITransport.
std::unique_ptr<ITransport> create_transport(const AgentConfig& cfg);

#endif  // JVMTI_AGENT_ITRANSPORT_H
