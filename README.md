# JVMTI Exception Monitoring Platform

An OverOps-style runtime error monitor: a native JVMTI agent captures every JVM
exception with full diagnostic context (stack frames, local variable values,
cause chain, JVM metrics) and POSTs it to a Python collector, which persists it
and serves a live web dashboard.

```
Target JVM ── JVMTI native agent ──HTTP POST──> Python collector ──REST/WS──> Web UI
                     │
                     └── (optional) BCI transformer JAR injected via ClassFileLoadHook
```

See [PLAN.md](PLAN.md) for the full design and [NOTES.md](NOTES.md) for the
authoritative component blueprints.

## Components

| Component | Tech | Folder |
|---|---|---|
| Native agent | C++17, CMake, MSVC/GCC/Clang, WinHTTP/libcurl | [`agent/`](agent/) |
| BCI transformer | Java 24+, `java.lang.classfile` (JEP 484) | [`bci-classfile/`](bci-classfile/) |
| Collector | Python 3.10+, FastAPI, async SQLAlchemy, aiosqlite | [`collector/`](collector/) |
| Web UI | Vanilla HTML/CSS/JS (served by collector) | [`ui/`](ui/) |
| Test harness | Java | [`test-apps/`](test-apps/) |

The agent ships as a shared library for **Windows (`.dll`), Linux (`.so`), and
macOS (`.dylib`)** from one codebase; OS-specific HTTP transport and platform
shims sit behind interfaces.

## Prerequisites

- A C++17 compiler (MSVC, GCC, or Clang) and **CMake ≥ 3.20**
- **JDK 24+** (required for the `bci=true` path; core capture works on any
  JVMTI-capable JDK). Set `JAVA_HOME`.
- On Linux/macOS: libcurl development headers (`libcurl4-openssl-dev` / Homebrew `curl`)
- **Python 3.10+** for the collector

## Build & run

```bash
# 1. Build the BCI transformer jar and place it next to the agent library
cd bci-classfile
javac -d out src/main/java/*.java
jar cf bci-transform.jar -C out .
cp bci-transform.jar ../agent/build/      # next to the built library

# 2. Build the native agent (cross-platform)
cd ..
cmake -S agent -B agent/build
cmake --build agent/build
#   -> agent/build/jvmti-agent.dll | libjvmti-agent.so | libjvmti-agent.dylib

# 3. Start the collector (serves the UI at http://localhost:8080)
cd collector
python -m venv .venv && . .venv/Scripts/activate   # or .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=src python -m collector

# 4. Run an instrumented JVM (per-OS agent path)
cd test-apps
javac -g TestException.java
java -agentpath:../agent/build/jvmti-agent.dll=host=localhost,port=8080,deployment=demo TestException

# 5. Open the dashboard
#    http://localhost:8080
```

## Agent configuration

Passed as `-agentpath:<library>=key=val,key=val,...`

| Key | Default | Purpose |
|---|---|---|
| `host`, `port`, `path` | `localhost`, `8080`, `/collector` | Collector endpoint |
| `deployment` | (empty) | Deployment tag on every event |
| `console` | `true` | Print captured exceptions to stdout |
| `depth` | `3` | Object-inspection recursion depth |
| `timeout` | `5000` | HTTP timeout (ms) |
| `deny` | 10 JDK patterns | Extra exception-type denylist (`;`-separated) |
| `location_deny` | 23 framework patterns | Extra throw-site denylist |
| `capture_packages` | (empty) | Allowlist mode — only capture throws from these packages |
| `bci` | `false` | Enable bytecode instrumentation (shadow locals; needs JDK 24+) |
| `bci_jar` | auto (next to library) | Path to `bci-transform.jar` |
| `bci_packages`, `bci_exclude`, `bci_verbose` | | BCI scope / logging |
| `instance_id` | auto UUID | JVM instance identity |
| `env_capture` | (empty) | Env-var glob patterns to capture |
| `redact_props` | 7 patterns | Sensitive keys to redact |

## Collector configuration (env vars)

`COLLECTOR_HOST`, `COLLECTOR_PORT`, `COLLECTOR_DB_URL`, `COLLECTOR_RETENTION_DAYS`.

## How local-variable capture works

- **With `-g`** (debug info): the agent reads locals directly from the JVMTI
  Local Variable Table (`source: "debug_info"`) — names, signatures, values.
- **Without `-g`**: enable `bci=true`. The `java.lang.classfile` transformer
  injects shadow-capture calls so the agent recovers local *values* by slot
  (`source: "bci_shadow"`); the UI marks these with a ● badge.

## Verified

Built and exercised on Windows with JDK 26, GCC (MinGW-w64) + CMake/Ninja, and
Python 3.14: agent load, exception capture (type/message/line/fingerprint),
FULL→REDUCED→COUNT_ONLY sampling, local-variable capture via both JVMTI and BCI
shadow paths, batched HTTP transport, collector ingest/REST/WebSocket, and the
dashboard.
