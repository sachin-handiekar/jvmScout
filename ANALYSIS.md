# jvmScout — Project Analysis

A self-hosted **runtime exception monitoring platform for the JVM**.
A native JVMTI agent hooks every exception thrown inside a target JVM, captures rich
diagnostic context (stack frames, *local variable values*, cause chain, JVM metrics),
and ships it over HTTP to a Python collector that persists events and serves a live web
dashboard. ~4,500 lines across four languages.

## Architecture (4 tiers)

```
Target JVM ──[JVMTI native agent]──HTTP POST──> [Python collector] ──REST/WS──> [Web UI]
                     │
                     └── (bci=true) Class-File API transformer JAR injected via ClassFileLoadHook
```

| Component | Tech | Folder | LOC (approx) |
|---|---|---|---|
| **Native agent** | C++17, CMake, WinHTTP/libcurl | `agent/` | ~2,000 |
| **BCI transformer** | Java 24+, `java.lang.classfile` (JEP 484) | `bci-classfile/` | ~420 |
| **Collector** | Python 3.10+, FastAPI, async SQLAlchemy, aiosqlite | `collector/` | ~660 |
| **Web UI** | Vanilla HTML/CSS/JS (no build step) | `ui/` | ~590 |
| **Test/sample apps** | Java (+ Spring Boot sample) | `test-apps/`, `sample-app/` | — |

The agent ships as a shared library for **Windows (`.dll`), Linux (`.so`), and macOS
(`.dylib`)** from one C++17 codebase; OS-specific HTTP transport and platform shims sit
behind interfaces.

## How the interesting parts work

### 1. The agent never crashes the host JVM
This is the central design invariant (`PLAN.md` §2), and it holds in the code:

- Every JVMTI callback body is wrapped in `try/catch(std::exception&)` + `catch(...)`
  (`agent/src/exception_handler.cpp:276`).
- A `thread_local` reentrance guard (`agent/src/exception_handler.cpp:20`) stops an
  exception thrown *during* capture (e.g. inside `getMessage()`) from re-entering the
  pipeline.
- The throwing thread never blocks on I/O — capture builds a payload and enqueues it; a
  background `AsyncQueue` does batching + HTTP (20/batch, 2s flush, 10k bounded cap with
  a silent drop counter).
- RAII wrappers (`JvmtiString`, `JniLocalFrame`) manage JVMTI/JNI resource lifetimes.

### 2. Adaptive sampling
An FNV-1a fingerprint of (exception class + throwing class + method + line) feeds a
sliding-window `Sampler` that degrades a hot error site `FULL → REDUCED → COUNT_ONLY`,
then re-allows one FULL every 300s. This bounds overhead under exception storms
(`agent/src/exception_handler.cpp:230`, `:259-269`).

### 3. Local-variable capture, two ways (the standout feature)
- **With `javac -g`**: read locals straight from the JVMTI Local Variable Table →
  `source: "debug_info"`.
- **Without `-g`**: `bci=true` injects shadow-capture calls via the JDK Class-File API so
  values are recovered by slot → `source: "bci_shadow"` (UI shows a ● badge).
  `__JvmtiShadow` holds per-thread `Object[64][32]` shadow frames, all writes
  `try/catch(Throwable)`-guarded.

### 4. Cross-platform from one codebase
Windows `.dll` / Linux `.so` / macOS `.dylib`. OS-specific HTTP (WinHTTP vs libcurl) sits
behind `ITransport`; UUID/host/env/paths behind `platform.h`. CMake selects per-OS
sources.

## Wire format & collector

- One JSON document per event. Two shapes — `exception` (default) and `agent_start`
  (sent once at JVM init); the collector discriminates on the `type` field.
- SQLite storage with two tables: `exceptions` (indexed on `fingerprint`,
  `deployment_id`, `instance_id`, `exception_type`) and `jvm_instances` (unique
  `instance_id`).
- REST + WebSocket API: `POST /collector`, `GET /exceptions` (paginated/filterable),
  `GET /exceptions/{id}`, `DELETE` endpoints, `GET /stats`, JVM-info endpoints, and
  `WS /ws/live`.
- Retention purge runs on startup (`COLLECTOR_RETENTION_DAYS`).

## Project state

- **Single initial commit**, clean tree, on `main`. README states it's been built and
  exercised end-to-end on Windows (JDK 26, MinGW GCC, Python 3.14).
- **Documentation is unusually strong**: `PLAN.md` (9 phased, verifiable build stages)
  and `NOTES.md` (22 KB authoritative blueprint) drive the implementation; `NOTES.md` is
  the declared source of truth.
- **`sample-app/target/` artifacts are committed** (`error-demo-0.1.0.jar`, compiled
  classes) — build output that probably shouldn't be tracked.

## Notable observations / open work

`PLAN.md` Phase 9 lists known hardening items, and the code confirms several are still
open:

- **P0** — `EnsureTransformerReady` should be wrapped in `std::call_once` (BCI init race).
- **P1** — REDUCED mode still does a stack walk
  (`agent/src/exception_handler.cpp:265`), just without locals; the plan wants it to skip
  more work.
- **P2** — JVM metrics recomputed per FULL event (no TTL cache).
- **P8** — the sampling map is unbounded (no eviction).
- **Security defaults** — collector CORS is wide open (`allow_origins=["*"]` with
  credentials, `collector/src/collector/app.py:33`) and the wire protocol is plain HTTP.
  Fine for a local/intranet collector as documented, but worth flagging for any non-local
  deployment.

## Strengths

- Clear separation of concerns and dependency-injection wiring in the agent
  (`AgentContext` owns transport, filters, inspector, queue, sampler).
- Safety-first JVMTI/JNI handling that respects the "never crash the host" invariant.
- Genuinely hard feature (no-`-g` local capture via bytecode shadowing) implemented on the
  modern, dependency-free Class-File API.
- Thorough, honest documentation that tracks known debt rather than hiding it.
