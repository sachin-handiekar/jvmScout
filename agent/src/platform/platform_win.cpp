#include "platform.h"

#include <windows.h>

#include <cstdio>
#include <random>

namespace platform {

std::string generate_uuid() {
    static thread_local std::mt19937_64 rng(
        std::random_device{}() ^ static_cast<uint64_t>(GetCurrentProcessId()));
    uint64_t hi = rng();
    uint64_t lo = rng();
    // RFC 4122 version 4 / variant bits.
    hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;
    lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;
    char buf[37];
    std::snprintf(buf, sizeof(buf),
                  "%08x-%04x-%04x-%04x-%012llx",
                  static_cast<unsigned>(hi >> 32),
                  static_cast<unsigned>((hi >> 16) & 0xFFFF),
                  static_cast<unsigned>(hi & 0xFFFF),
                  static_cast<unsigned>(lo >> 48),
                  static_cast<unsigned long long>(lo & 0xFFFFFFFFFFFFULL));
    return buf;
}

std::string this_library_path() {
    HMODULE mod = nullptr;
    if (!GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCSTR>(&this_library_path), &mod)) {
        return "";
    }
    char path[MAX_PATH];
    DWORD n = GetModuleFileNameA(mod, path, MAX_PATH);
    if (n == 0 || n == MAX_PATH) return "";
    return std::string(path, n);
}

std::string hostname() {
    char name[256];
    DWORD size = sizeof(name);
    if (GetComputerNameA(name, &size)) return std::string(name, size);
    return "unknown";
}

std::vector<std::pair<std::string, std::string>> environment() {
    std::vector<std::pair<std::string, std::string>> out;
    LPCH block = GetEnvironmentStringsA();
    if (!block) return out;
    for (LPCH p = block; *p; ) {
        std::string entry(p);
        p += entry.size() + 1;
        auto eq = entry.find('=');
        if (eq != std::string::npos && eq > 0) {
            out.emplace_back(entry.substr(0, eq), entry.substr(eq + 1));
        }
    }
    FreeEnvironmentStringsA(block);
    return out;
}

}  // namespace platform
