#include "itransport.h"

#include "config.h"

#include <curl/curl.h>

#include <string>

namespace {

size_t discard_body(char* /*ptr*/, size_t size, size_t nmemb, void* /*ud*/) {
    return size * nmemb;  // ignore response body
}

class CurlTransport : public ITransport {
public:
    CurlTransport(std::string url, int timeout_ms, bool tls_insecure, std::string api_key)
        : url_(std::move(url)), timeout_ms_(timeout_ms),
          tls_insecure_(tls_insecure), api_key_(std::move(api_key)) {
        curl_global_init(CURL_GLOBAL_DEFAULT);
    }
    ~CurlTransport() override { curl_global_cleanup(); }

    SendResult send(const std::string& body) override {
        CURL* curl = curl_easy_init();
        if (!curl) return SendResult::kRetryable;

        struct curl_slist* headers = nullptr;
        headers = curl_slist_append(headers, "Content-Type: application/json");
        std::string auth;
        if (!api_key_.empty()) {
            auth = "Authorization: Bearer " + api_key_;
            headers = curl_slist_append(headers, auth.c_str());
        }

        curl_easy_setopt(curl, CURLOPT_URL, url_.c_str());
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.data());
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, static_cast<long>(timeout_ms_));
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discard_body);
        curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
        if (tls_insecure_) {
            // Testing/self-signed only: skip peer/host certificate verification.
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
        }

        CURLcode rc = curl_easy_perform(curl);
        long status = 0;
        if (rc == CURLE_OK) {
            curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
        }

        curl_slist_free_all(headers);
        curl_easy_cleanup(curl);
        if (rc != CURLE_OK) return SendResult::kRetryable;  // network-level failure
        return classify_http_status(status);
    }

    const char* name() const override { return "libcurl"; }

private:
    std::string url_;
    int timeout_ms_;
    bool tls_insecure_;
    std::string api_key_;
};

}  // namespace

std::unique_ptr<ITransport> create_transport(const AgentConfig& cfg) {
    std::string scheme = cfg.https ? "https://" : "http://";
    std::string url = scheme + cfg.host + ":" + std::to_string(cfg.port) + cfg.path;
    return std::make_unique<CurlTransport>(url, cfg.timeout_ms, cfg.tls_insecure,
                                           cfg.api_key);
}
