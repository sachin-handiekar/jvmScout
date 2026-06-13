#ifndef JVMTI_AGENT_PLATFORM_H
#define JVMTI_AGENT_PLATFORM_H

#include <string>
#include <vector>
#include <utility>

// OS-specific shims. Each function has a per-OS implementation in
// src/platform/platform_win.cpp or src/platform/platform_posix.cpp so the rest
// of the agent stays portable.
namespace platform {

// Random RFC-4122-ish UUID string for instance_id.
std::string generate_uuid();

// Absolute path of the loaded agent shared library (.dll/.so/.dylib), used to
// auto-locate bci-transform.jar sitting next to it. Empty on failure.
std::string this_library_path();

// Host name of the machine running the JVM.
std::string hostname();

// All environment variables as (name, value) pairs.
std::vector<std::pair<std::string, std::string>> environment();

}  // namespace platform

#endif  // JVMTI_AGENT_PLATFORM_H
