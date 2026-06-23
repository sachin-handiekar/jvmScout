#include "itransport.h"

#include "config.h"

#include <windows.h>
#include <winhttp.h>

#include <string>

namespace {

std::wstring widen(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                                nullptr, 0);
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()),
                        &w[0], n);
    return w;
}

// RAII closer for WinHTTP handles.
struct Handle {
    HINTERNET h = nullptr;
    ~Handle() { if (h) WinHttpCloseHandle(h); }
};

class WinHttpTransport : public ITransport {
public:
    WinHttpTransport(std::string host, int port, std::string path, int timeout_ms,
                     bool https, bool tls_insecure, const std::string& api_key)
        : host_(widen(host)), path_(widen(path)),
          port_(static_cast<INTERNET_PORT>(port)), timeout_(timeout_ms),
          https_(https), tls_insecure_(tls_insecure) {
        headers_ = L"Content-Type: application/json\r\n";
        if (!api_key.empty()) {
            headers_ += L"Authorization: Bearer " + widen(api_key) + L"\r\n";
        }
    }

    bool send(const std::string& body) override {
        Handle session;
        session.h = WinHttpOpen(L"jvmti-agent/1.0",
                                WINHTTP_ACCESS_TYPE_NO_PROXY,
                                WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!session.h) return false;
        WinHttpSetTimeouts(session.h, timeout_, timeout_, timeout_, timeout_);

        Handle connect;
        connect.h = WinHttpConnect(session.h, host_.c_str(), port_, 0);
        if (!connect.h) return false;

        Handle request;
        const DWORD request_flags = https_ ? WINHTTP_FLAG_SECURE : 0;
        request.h = WinHttpOpenRequest(connect.h, L"POST", path_.c_str(), nullptr,
                                       WINHTTP_NO_REFERER,
                                       WINHTTP_DEFAULT_ACCEPT_TYPES, request_flags);
        if (!request.h) return false;

        if (https_ && tls_insecure_) {
            // Testing/self-signed only: ignore certificate validation errors.
            DWORD sec = SECURITY_FLAG_IGNORE_UNKNOWN_CA |
                        SECURITY_FLAG_IGNORE_CERT_CN_INVALID |
                        SECURITY_FLAG_IGNORE_CERT_DATE_INVALID |
                        SECURITY_FLAG_IGNORE_CERT_WRONG_USAGE;
            WinHttpSetOption(request.h, WINHTTP_OPTION_SECURITY_FLAGS, &sec, sizeof(sec));
        }

        if (!WinHttpSendRequest(request.h, headers_.c_str(), static_cast<DWORD>(-1),
                                const_cast<char*>(body.data()),
                                static_cast<DWORD>(body.size()),
                                static_cast<DWORD>(body.size()), 0)) {
            return false;
        }
        if (!WinHttpReceiveResponse(request.h, nullptr)) return false;

        DWORD status = 0;
        DWORD len = sizeof(status);
        if (!WinHttpQueryHeaders(
                request.h,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX, &status, &len,
                WINHTTP_NO_HEADER_INDEX)) {
            return false;
        }
        return status >= 200 && status < 300;
    }

    const char* name() const override { return "winhttp"; }

private:
    std::wstring host_;
    std::wstring path_;
    INTERNET_PORT port_;
    int timeout_;
    bool https_;
    bool tls_insecure_;
    std::wstring headers_;
};

}  // namespace

std::unique_ptr<ITransport> create_transport(const AgentConfig& cfg) {
    return std::make_unique<WinHttpTransport>(cfg.host, cfg.port, cfg.path,
                                              cfg.timeout_ms, cfg.https,
                                              cfg.tls_insecure, cfg.api_key);
}
