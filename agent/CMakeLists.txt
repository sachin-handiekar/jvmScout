cmake_minimum_required(VERSION 3.20)
project(jvmti_agent LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)

if(NOT DEFINED ENV{JAVA_HOME})
  message(FATAL_ERROR "JAVA_HOME must be set so the JNI/JVMTI headers can be found.")
endif()
set(JAVA_HOME "$ENV{JAVA_HOME}")

# Per-OS JNI machine-dependent header subdirectory.
if(WIN32)
  set(JNI_MD_DIR win32)
elseif(APPLE)
  set(JNI_MD_DIR darwin)
else()
  set(JNI_MD_DIR linux)
endif()

set(CORE_SOURCES
  src/agent_main.cpp
  src/config.cpp
  src/jvmti_utils.cpp
  src/json_utils.cpp
  src/filters.cpp
  src/sampling.cpp
  src/async_queue.cpp
  src/count_aggregator.cpp
  src/method_info_cache.cpp
  src/fingerprint.cpp
  src/stack_walker.cpp
  src/object_inspector.cpp
  src/jvm_metrics.cpp
  src/event_serializer.cpp
  src/exception_handler.cpp
  src/system_info.cpp
  src/bci_engine.cpp
  src/bci_shadow.cpp
  src/source_cache.cpp
)

if(WIN32)
  set(PLATFORM_SOURCES
    src/platform/platform_win.cpp
    src/platform/winhttp_transport.cpp
  )
else()
  set(PLATFORM_SOURCES
    src/platform/platform_posix.cpp
    src/platform/curl_transport.cpp
  )
endif()

add_library(jvmti-agent SHARED ${CORE_SOURCES} ${PLATFORM_SOURCES})

target_include_directories(jvmti-agent PRIVATE
  include
  "${JAVA_HOME}/include"
  "${JAVA_HOME}/include/${JNI_MD_DIR}"
)

# Emit jvmti-agent.dll on Windows (no "lib" prefix) and libjvmti-agent.{so,dylib} elsewhere.
if(WIN32)
  set_target_properties(jvmti-agent PROPERTIES PREFIX "")
  target_link_libraries(jvmti-agent PRIVATE winhttp)
  target_compile_definitions(jvmti-agent PRIVATE PLATFORM_WINDOWS=1 _WIN32_WINNT=0x0601)
else()
  find_package(CURL REQUIRED)
  target_link_libraries(jvmti-agent PRIVATE CURL::libcurl pthread)
  target_compile_definitions(jvmti-agent PRIVATE PLATFORM_POSIX=1)
  target_compile_options(jvmti-agent PRIVATE -fPIC -O2 -Wall)
  if(APPLE)
    target_link_options(jvmti-agent PRIVATE -undefined dynamic_lookup)
  endif()
endif()

# ---------------------------------------------------------------------------
# Unit tests for the pure-logic components (no JNI/JVMTI required).
# ---------------------------------------------------------------------------
option(AGENT_BUILD_TESTS "Build the agent unit tests" ON)
if(AGENT_BUILD_TESTS)
  enable_testing()
  # config.cpp's settings-file lookup calls platform::this_library_path(), so the
  # matching platform shim is linked in (it only uses default system libraries).
  if(WIN32)
    set(TEST_PLATFORM_SOURCES src/platform/platform_win.cpp)
  else()
    set(TEST_PLATFORM_SOURCES src/platform/platform_posix.cpp)
  endif()
  add_executable(agent_tests
    tests/agent_tests.cpp
    src/fingerprint.cpp
    src/filters.cpp
    src/sampling.cpp
    src/json_utils.cpp
    src/config.cpp
    src/async_queue.cpp
    src/count_aggregator.cpp
    src/event_serializer.cpp
    ${TEST_PLATFORM_SOURCES}
  )
  # jvmti.h is needed (header-only) by event_model.h's metric types.
  target_include_directories(agent_tests PRIVATE
    include
    "${JAVA_HOME}/include"
    "${JAVA_HOME}/include/${JNI_MD_DIR}"
  )
  find_package(Threads REQUIRED)
  target_link_libraries(agent_tests PRIVATE Threads::Threads)
  add_test(NAME agent_tests COMMAND agent_tests)
endif()
