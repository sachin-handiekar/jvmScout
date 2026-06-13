# Top-level build. Only the native agent is built by CMake; the BCI transformer
# (Maven/javac), the Python collector (pip), and the UI (static files) build
# independently — see PLAN.md section 6 for the full build/run order.
cmake_minimum_required(VERSION 3.20)
project(jvmti_monitoring LANGUAGES CXX)

add_subdirectory(agent)
