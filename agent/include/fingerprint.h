#ifndef JVMTI_AGENT_FINGERPRINT_H
#define JVMTI_AGENT_FINGERPRINT_H

#include <cstdint>
#include <string>

// FNV-1a 64-bit hash used for the per-event fingerprint
// (exception class + throwing class + method + line).
uint64_t fnv1a64(const std::string& s);

std::string compute_fingerprint(const std::string& exception_sig,
                                 const std::string& throw_class,
                                 const std::string& method,
                                 int line);

#endif  // JVMTI_AGENT_FINGERPRINT_H
