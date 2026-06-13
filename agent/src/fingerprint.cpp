#include "fingerprint.h"

#include <cstdio>

uint64_t fnv1a64(const std::string& s) {
    uint64_t hash = 1469598103934665603ULL;  // FNV offset basis
    for (unsigned char c : s) {
        hash ^= c;
        hash *= 1099511628211ULL;  // FNV prime
    }
    return hash;
}

std::string compute_fingerprint(const std::string& exception_sig,
                                 const std::string& throw_class,
                                 const std::string& method,
                                 int line) {
    std::string material = exception_sig;
    material += '|';
    material += throw_class;
    material += '|';
    material += method;
    material += '|';
    material += std::to_string(line);

    uint64_t h = fnv1a64(material);
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(h));
    return std::string(buf);
}
