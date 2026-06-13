#include "platform.h"

#include <unistd.h>
#include <limits.h>

#include <cstdio>
#include <cstdlib>
#include <random>

#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

extern char** environ;

namespace platform {

std::string generate_uuid() {
    static thread_local std::mt19937_64 rng(
        std::random_device{}() ^ static_cast<uint64_t>(getpid()));
    uint64_t hi = rng();
    uint64_t lo = rng();
    hi = (hi & 0xFFFFFFFFFFFF0FFFULL) | 0x0000000000004000ULL;  // version 4
    lo = (lo & 0x3FFFFFFFFFFFFFFFULL) | 0x8000000000000000ULL;  // variant
    char buf[37];
    std::snprintf(buf, sizeof(buf), "%08x-%04x-%04x-%04x-%012llx",
                  static_cast<unsigned>(hi >> 32),
                  static_cast<unsigned>((hi >> 16) & 0xFFFF),
                  static_cast<unsigned>(hi & 0xFFFF),
                  static_cast<unsigned>(lo >> 48),
                  static_cast<unsigned long long>(lo & 0xFFFFFFFFFFFFULL));
    return buf;
}

std::string this_library_path() {
    // dladdr on an address inside this library yields its path. Falls back to
    // empty; the agent then relies on an explicit bci_jar setting.
    return "";  // best-effort; explicit bci_jar recommended on POSIX
}

std::string hostname() {
    char name[256];
    if (gethostname(name, sizeof(name)) == 0) {
        name[sizeof(name) - 1] = '\0';
        return name;
    }
    return "unknown";
}

std::vector<std::pair<std::string, std::string>> environment() {
    std::vector<std::pair<std::string, std::string>> out;
    for (char** e = environ; e && *e; ++e) {
        std::string entry(*e);
        auto eq = entry.find('=');
        if (eq != std::string::npos && eq > 0) {
            out.emplace_back(entry.substr(0, eq), entry.substr(eq + 1));
        }
    }
    return out;
}

}  // namespace platform
