#include "itransport.h"

#include "config.h"

#include <curl/curl.h>

#include <mutex>
#include <string>

namespace {

size_t discard_body(char* /*ptr*/, size_t size, size_t nmemb, void* /*ud*/) {
    return size * nmemb;  // ignore response body
}

// Process-wide libcurl init, exactly once, on the Agent_OnLoad thread (single-
// threaded phase). curl_global_init is NOT thread-safe, and this library lives
// inside someone else's JVM process — we must neither race a host application
// that also uses libcurl nor tear its state down: curl_global_cleanup is
// intentionally never called (the OS reclaims everything at process exit).
void global_init_once() {
    static std::once_flag once;
    std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

class CurlTransport : public ITransport {
public:
    CurlTransport(std::string url, int timeout_ms, bool tls_insecure, std::string api_key)
        : url_(std::move(url)), timeout_ms_(timeout_ms),
          tls_insecure_(tls_insecure), api_key_(std::move(api_key)) {
        global_init_once();
        headers_ = curl_slist_append(nullptr, "Content-Type: application/json");
        if (!api_key_.empty()) {
            std::string auth = "Authorization: Bearer " + api_key_;
            headers_ = curl_slist_append(headers_, auth.c_str());
        }
    }

    ~CurlTransport() override {
        if (curl_) curl_easy_cleanup(curl_);
        if (headers_) curl_slist_free_all(headers_);
        // No curl_global_cleanup: see global_init_once().
    }

    SendResult send(const std::string& body) override {
        // The easy handle persists across sends so libcurl's connection cache
        // keeps one TCP/TLS connection alive per collector, instead of a fresh
        // handshake per batch. Only the queue worker thread calls send().
        // libcurl honors http_proxy/https_proxy/no_proxy env vars by default.
        if (!curl_) {
            curl_ = curl_easy_init();
            if (!curl_) return SendResult::kRetryable;
            curl_easy_setopt(curl_, CURLOPT_URL, url_.c_str());
            curl_easy_setopt(curl_, CURLOPT_POST, 1L);
            curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, headers_);
            curl_easy_setopt(curl_, CURLOPT_TIMEOUT_MS, static_cast<long>(timeout_ms_));
            curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, discard_body);
            curl_easy_setopt(curl_, CURLOPT_NOSIGNAL, 1L);
            if (tls_insecure_) {
                // Testing/self-signed only: skip peer/host cert verification.
                curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYPEER, 0L);
                curl_easy_setopt(curl_, CURLOPT_SSL_VERIFYHOST, 0L);
            }
        }

        curl_easy_setopt(curl_, CURLOPT_POSTFIELDS, body.data());
        curl_easy_setopt(curl_, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));

        CURLcode rc = curl_easy_perform(curl_);
        if (rc != CURLE_OK) {
            // Network-level failure: recycle the handle so a wedged connection
            // in the cache can't poison every subsequent attempt.
            curl_easy_cleanup(curl_);
            curl_ = nullptr;
            return SendResult::kRetryable;
        }
        long status = 0;
        curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &status);
        return classify_http_status(status);
    }

    const char* name() const override { return "libcurl"; }

private:
    std::string url_;
    int timeout_ms_;
    bool tls_insecure_;
    std::string api_key_;
    CURL* curl_ = nullptr;
    struct curl_slist* headers_ = nullptr;
};

}  // namespace

std::unique_ptr<ITransport> create_transport(const AgentConfig& cfg) {
    std::string scheme = cfg.https ? "https://" : "http://";
    std::string url = scheme + cfg.host + ":" + std::to_string(cfg.port) + cfg.path;
    return std::make_unique<CurlTransport>(url, cfg.timeout_ms, cfg.tls_insecure,
                                           cfg.api_key);
}
