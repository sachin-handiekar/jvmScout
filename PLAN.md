# JVMTI Exception Monitoring Platform — Development Plan

> **Source of truth:** [NOTES.md](NOTES.md). That document describes the architecture
> as derived from a working JVMTI agent and is authoritative. This plan turns that
> blueprint into an ordered, verifiable build sequence. Where NOTES.md and any older
> design notes disagree, NOTES.md wins.

## 1. What we are building

A four-tier runtime error monitor:

```
Target JVM ── JVMTI native agent ──HTTP POST──> Python collector ──REST/WS──> Web UI
                     │
                     └── (optional) BCI transformer JAR injected via ClassFileLoadHook
```

| Component | Language / runtime | Artifact | Folder |
|---|---|---|---|
| Native agent | C++17, CMake, MSVC/GCC/Clang | `jvmti-agent.dll` / `libjvmti-agent.so` / `libjvmti-agent.dylib` | `agent/` |
| BCI transformer (Class-File API) | Java 24+, JEP 484 | `bci-classfile.jar` | `bci-classfile/` |
| Collector | Python 3.10+, FastAPI, async SQLAlchemy, aiosqlite | `python -m collector` | `collector/` |
| Web UI | Vanilla HTML/CSS/JS SPA | static files served by collector | `ui/` |
| Test harness | Java | `TestException.class` | `test-apps/` |

**Wire format:** one JSON document per event. Two shapes — `exception` (default) and
`agent_start` (sent once at JVM init).

> **Cross-platform scope:** the native agent ships as a shared library for **Windows
> (`.dll`), Linux (`.so`), and macOS (`.dylib`)** from one C++17 codebase. The build is
> **CMake** (replacing the Windows-only nmake Makefile from NOTES.md), and all
> OS-specific code sits behind interfaces so the bulk of the agent is portable:
> - **HTTP transport** is selected at compile time behind the `ITransport` interface —
>   `WinHttpTransport` (WinHTTP) on Windows, `CurlTransport` (libcurl) on Linux + macOS.
> - **Platform shims** (UUID generation for `instance_id`, host/env capture in
>   `system_info`, locating the default `bci_jar` next to the loaded library, thread
>   naming) are isolated in a small `platform/` layer with per-OS implementations.
> JVMTI/JNI itself is already OS-agnostic (`Agent_OnLoad`/`Agent_OnUnload` are standard
> exported entry points), so the capture pipeline, sampling, serialization, and BCI bridge
> are shared verbatim across all three targets.

> **BCI scope:** the bytecode-instrumentation transformer is built **only** on the JDK
> `java.lang.classfile` API (JEP 484). The ASM-based variant described in NOTES.md is
> deliberately **out of scope** for now; if a JDK-11 fallback is ever needed it can be
> added later behind the same `BciTransformer.transform(String, byte[])` surface.

## 2. Guiding principles (non-negotiable invariants)

These come straight from NOTES.md and must hold at every phase:

1. **The agent never crashes the host JVM.** Every JVMTI callback body is wrapped in
   `try/catch(std::exception&)` + `catch(...)`. No C++ exception escapes back into the JVM.
2. **Every BCI failure returns `null`** (= "leave bytecode unchanged"). A throwing
   transformer must never propagate.
3. **RAII for all JVMTI/JNI resources.** `JvmtiString` frees JVMTI allocations;
   `JniLocalFrame` pushes/pops local-ref frames. No manual `Deallocate`/`DeleteLocalRef`
   scattered through the hot path.
4. **A `thread_local` reentrance guard** blocks recursive captures (an exception thrown
   while we are capturing must not re-enter the pipeline).
5. **The throwing thread is never blocked on I/O.** Capture builds a payload and enqueues
   it; a background thread does batching + HTTP.
6. **Wire-format invariants the collector depends on:**
   - `type: "agent_start"` is the discriminator; any other shape is an `ExceptionEvent`.
   - `fingerprint` may be int or string — collector coerces to string on store.
   - `localVariables[].source` is `"debug_info"` (JVMTI LVT) or `"bci_shadow"` (BCI). UI keys the badge off this.
   - `captureMode` ∈ `{ "FULL", "REDUCED", "COUNT_ONLY" }`.

## 3. Repository layout (target)

```
jvmti-agent/
├── PLAN.md
├── NOTES.md
├── README.md                  # setup + CLI options (write in Phase 9)
├── agent/                     # native JVMTI agent (Windows + Linux + macOS)
│   ├── CMakeLists.txt          # cross-platform build; emits .dll/.so/.dylib
│   ├── include/               # ~19 headers (see §4.1)
│   ├── src/                   # portable .cpp files (one per header, mostly)
│   └── src/platform/          # per-OS impls: winhttp_transport, curl_transport,
│                              #   platform_win.cpp / platform_posix.cpp (uuid, paths, env)
├── bci-classfile/             # java.lang.classfile variant (JDK 24+, no deps) — primary BCI
├── collector/
│   ├── requirements.txt
│   └── src/collector/         # __main__, app, config, models, storage, api/routes
├── ui/                        # index.html, css/styles.css, js/app.js
└── test-apps/                 # TestException.java
```

## 4. Component specifications

### 4.1 Native JVMTI agent (`agent/`)

- **Toolchain:** CMake (≥3.20), C++17, building a shared library on all three OSes.
  Compilers: MSVC on Windows, GCC or Clang on Linux, AppleClang on macOS. CMake locates
  the JNI/JVMTI headers via `$JAVA_HOME/include` plus the per-OS subdir (`win32`, `linux`,
  or `darwin`) and errors out if `JAVA_HOME` is unset.
  - **Windows:** `/EHsc /MD /W3 /std:c++17`; link `winhttp.lib`; output `jvmti-agent.dll`.
  - **Linux:** `-std=c++17 -fPIC -O2 -Wall`; link libcurl; output `libjvmti-agent.so`.
  - **macOS:** as Linux plus `-undefined dynamic_lookup`; output `libjvmti-agent.dylib`.
  - Symbol visibility: export only `Agent_OnLoad`/`Agent_OnAttach`/`Agent_OnUnload`
    (`__declspec(dllexport)` on Windows, `__attribute__((visibility("default")))` +
    `-fvisibility=hidden` on POSIX).
- **Capabilities requested:** `can_access_local_variables`, `can_get_line_numbers`,
  `can_get_source_file_name`, `can_generate_exception_events`, `can_tag_objects`,
  `can_generate_all_class_hook_events`, `can_retransform_classes`.
- **Events registered:** `EXCEPTION` (every throw), `CLASS_FILE_LOAD_HOOK` (only when
  `bci=true`), `VM_INIT` (sends `agent_start` once), `VM_DEATH` (shutdown).
- **Header set (DI-oriented):** `agent.h` (legacy globals), `agent_context.h`
  (DI container owning transport + filters), `config.h` (POD `AgentConfig`),
  `exception_handler.h`, `stack_walker.h`, `object_inspector.h`, `event_serializer.h`,
  `sampling.h`, `async_queue.h`, `http_transport.h`, `itransport.h` (pure virtual),
  `winhttp_transport.h` + `curl_transport.h` (per-OS `ITransport` impls), `ifilter.h`,
  `jvm_metrics.h`, `bci_engine.h`, `bci_shadow.h`, `system_info.h`, `platform.h` (per-OS
  shims: UUID, library path, env enumeration), `json_utils.h`, `jvmti_utils.h`
  (`JvmtiString`/`JniLocalFrame` RAII, `ResolveLineNumber`).
- **Config (parsed from `-agentpath:<lib>=key=val,...`):** `host`/`port`/`path`
  (default `localhost`/`8080`/`/collector`), `deployment`, `console` (false), `depth` (3),
  `timeout` (5000ms), `deny` (10 JDK patterns), `capture_packages` (allowlist mode),
  `location_deny` (23 framework patterns), `bci` (false), `bci_jar` (auto-detect next to
  the loaded library — `.dll`/`.so`/`.dylib`), `bci_packages`, `bci_exclude` (14 patterns),
  `bci_verbose`, `instance_id` (auto UUID), `env_capture` globs, `redact_props` (7 patterns).
- **Per-throw pipeline:** reentrance guard → type filter (deny + optional allow) →
  location filter → FNV-1a 64-bit fingerprint of (exception class + throwing class +
  method + line) → sampling tier (60s sliding window, 10 hits → FULL → REDUCED →
  COUNT_ONLY; re-allow one FULL every 300s) → console banner/compact → JSON assembly in
  `event_serializer.cpp` (exception meta, `caughtAt`, cause chain ≤10, `suppressed[]`,
  `threadInfo`, `jvmMetrics`, `stackTrace` ≤100 frames with locals) → async enqueue
  (background thread, 20/batch, 2s flush, 10k cap with silent drop counter) → HTTP POST via
  the active `ITransport` (WinHTTP on Windows, libcurl on Linux/macOS).

### 4.2 BCI transformer — Class-File API (`bci-classfile/`) — **primary**

- **Why:** inject "shadow variable capture" so the native agent can read locals even when
  classes were compiled without `javac -g`. Built on `java.lang.classfile` (JEP 484, final
  in JDK 24): zero external deps, JDK-native stack-map computation, and it avoids the
  `COMPUTE_FRAMES` correctness pitfalls (lambdas / `invokedynamic`) that a bytecode-library
  approach would hit.
- **Build:** JDK 24+ (or the JDK 25 target distro, once `java.lang.classfile` is confirmed
  final there), Maven, **no runtime dependencies**. Output: thin `bci-classfile.jar`,
  copied to `agent/bci-transform.jar` (the native agent loads whatever file sits at the
  configured `bci_jar` path; the filename is just the default it looks for).
- **Classes:**
  - `BciTransformer` — JNI entry `static byte[] transform(String, byte[])`; uses
    `ClassFile.of().transformClass(...)`; returns the instrumented bytes, or `null` on any
    error or skipped class.
  - `ShadowClassTransform` (`ClassTransform`) — filters methods (skip
    `<clinit>`/native/abstract/bridge/synthetic and JDK/Sun/Spring + BCI-infra packages),
    extracts the LVT for variable-name metadata emission.
  - `ShadowCodeTransform` (`CodeTransform`) — injects `__JvmtiShadow.enterMethod()` at
    method entry (capturing `this` + params), capture calls before every throw-capable
    instruction, and `exitMethod()` at every return. Preserves the full feature set:
    xSTORE/store-slot tracking, all-visible-locals capture, slot type-change handling,
    LVT-based variable-name metadata, and loop-aware suppression.
  - `__JvmtiShadow` — bootstrap-visible; three `ThreadLocal`s `Object[64][32]` /
    `String[64][32]` / `int[64][32]`; typed `captureInt/Long/Float/Double/Object`; C++-facing
    read API `getFrame/getMetadata/getSlotTypes/clearFrame(depth)`; **all write methods
    `try/catch(Throwable)`-guarded** so instrumentation can never break the app.
- **Throw-capable opcodes instrumented:** `invokevirtual/interface/special/static`,
  `getfield/putfield`, all array load/store, `idiv/irem/ldiv/lrem`, `arraylength`,
  `monitorenter/exit`, `checkcast`, `athrow`.
- **Bootstrap:** agent calls `AddToBootstrapClassLoaderSearch` for `__JvmtiShadow`;
  `BciTransformer` added via `AddToSystemClassLoaderSearch`.

### 4.3 Python collector (`collector/`)

- **Build/run:** Python 3.10+; FastAPI, uvicorn, SQLAlchemy[asyncio], aiosqlite,
  Pydantic v2. `pip install -r requirements.txt` → `python -m collector` (binds
  `0.0.0.0:8080`). Env: `COLLECTOR_DB_URL`, `COLLECTOR_HOST`, `COLLECTOR_PORT`,
  `COLLECTOR_RETENTION_DAYS`.
- **Layout:** `__main__.py` (uvicorn launcher), `app.py` (FastAPI app, CORS, lifespan =
  init_db + purge_old_records, mounts `ui/` as StaticFiles), `config.py`, `models.py`
  (Pydantic v2: Location, ThreadInfo, Cause, LocalVariable, StackFrame, JvmMetrics,
  ExceptionEvent, AgentStartEvent w/ JvmInfo + HostInfo, …), `storage.py` (async
  SQLAlchemy, CRUD, `purge_old_records`), `api/routes.py` (REST + WS).
- **DB (SQLite):** `exceptions` (17 cols; indexes on `fingerprint`, `deployment_id`,
  `instance_id`, `exception_type`) and `jvm_instances` (unique `instance_id`).
- **Endpoints:** `POST /collector` (single or list; routes `agent_start` →
  `jvm_instances`, else → `exceptions`; broadcasts to WS), `GET /exceptions` (paginated;
  filter by type/deployment/caught/fingerprint), `GET /exceptions/{id}`,
  `DELETE /exceptions` and `/exceptions/{id}`, `GET /stats` (totals, unique fingerprints,
  top 10 types, recent deployments), `GET /jvm-info` + `/{id}` + `/jvm-instances`,
  `WS /ws/live`.

### 4.4 Web UI (`ui/`)

- Vanilla HTML/CSS/JS SPA, no build step, GitHub-dark theme, CSS custom properties,
  responsive (sidebar collapses to 60px below 900px), WS status indicator.
- **Pages:** Dashboard (4 stat cards + pure-CSS bar chart of top types + recent
  deployments, polls `/stats`); Exceptions (filterable/sortable/paginated table from
  `/exceptions`; row → detail); Exception Detail (8 collapsible sections incl. stack
  trace with expandable locals + BCI badge keyed on `source == "bci_shadow"`); Live Feed
  (`/ws/live`, reconnect every 3s, slide-in cards, cap 500 in memory / 200 in DOM);
  JVM Info (7 sections from `/jvm-info` + `/jvm-instances`).

### 4.5 Test harness (`test-apps/`)

- `TestException.java`: `main` wrapping three try/catch methods —
  `testNullPointer()` (NPE), `testArrayBounds()` (AIOOBE),
  `testWithObjects()` (NPE inside a method holding ≥2 in-scope local objects — a
  constructed POJO and a separate var — to exercise object-graph + local capture).

## 5. Phased build sequence

Each phase ends in something runnable and independently verifiable. The order builds
bottom-up so every phase has a way to prove itself before the next depends on it.

### Phase 0 — Skeleton & toolchains
Create the folder layout, a top-level `CMakeLists.txt` + `pom`/`requirements`, and confirm
toolchains on each target OS: a C++17 compiler (MSVC / GCC / Clang) + CMake ≥3.20 +
`JAVA_HOME`, JDK 24+ (Class-File API; also the JDK 25 target), Python 3.10+. Install
libcurl dev headers on Linux/macOS (e.g. `libcurl4-openssl-dev` / Homebrew `curl`).
**Verify:** `cmake -B build && cmake --build build` produces a loadable stub library on
every OS available, and each other toolchain compiles a hello-world artifact.

### Phase 1 — Minimal native agent (portable core)
`Agent_OnLoad` parses `-agentpath` options into `AgentConfig`; build `AgentContext` DI
container; request all capabilities; register `VM_INIT` (print + send nothing yet) and
`VM_DEATH`. Keep all OS-specific calls behind `platform.h` from the start. **Verify:** on
each OS, `java -agentpath:<path-to-lib>=console=true Anything` loads the library and prints
a banner at VM init; clean detach at exit. (`<lib>` = `jvmti-agent.dll` /
`libjvmti-agent.so` / `libjvmti-agent.dylib`.)

### Phase 2 — Exception capture core (console sink)
Register `EXCEPTION`. Implement reentrance guard, type + location filters, FNV-1a
fingerprint, the FULL→REDUCED→COUNT_ONLY sampling tier, and console output (full banner /
compact). No stack/locals/HTTP yet. **Verify:** run `TestException`; the three throws
print with correct fingerprints; denylisted JDK exceptions are filtered; a tight loop
demotes to REDUCED then COUNT_ONLY and re-allows a FULL after 300s.

### Phase 3 — Stack walk, locals, object inspection
`stack_walker.cpp` (≤100 frames) + `object_inspector.cpp` (depth-limited per `depth`) +
`event_serializer.cpp` producing the full JSON (meta, `caughtAt`, cause chain ≤10,
`suppressed[]`, `threadInfo`, `jvmMetrics`, `stackTrace` with `localVariables`). Read
locals via JVMTI LVT (`source: "debug_info"`); degrade gracefully to slot numbers when
no `-g`. **Verify:** compile `TestException` with `-g`; confirm a known local
(e.g. the POJO and a `String`) appears with name + value in the serialized JSON to console.

### Phase 4 — Transport: async queue + cross-platform HTTP
`itransport.h` + `async_queue.cpp` (background thread, 20/batch, 2s flush, 10k bounded cap
with silent drop counter), plus the two `ITransport` backends — `winhttp_transport.cpp`
(Windows) and `curl_transport.cpp` (libcurl, Linux/macOS) — selected by CMake per target.
`system_info.cpp` builds and sends the `agent_start` event on `VM_INIT`, using `platform.h`
for UUID/host/env. **Verify on each OS:** with a netcat/stub HTTP listener on 8080, confirm
batched POSTs to `/collector`, the one-time `agent_start`, gzip (if implemented), and that
killing the listener never blocks or crashes the JVM (drops counted). Confirm both transport
backends produce byte-identical request bodies.

### Phase 5 — Python collector
Implement models, storage (two tables + indexes + retention purge), `POST /collector`
(discriminate on `type`), the GET/DELETE REST endpoints, `GET /stats`, JVM-info
endpoints, and `WS /ws/live`. **Verify:** point the agent at it; `TestException` events
land in `exceptions`, `agent_start` lands in `jvm_instances`; `GET /exceptions` filters
work; retention purge runs on startup.

### Phase 6 — Web UI
Build the four pages against the live collector. **Verify:** Dashboard stats render;
Exceptions table filters/paginates; Detail view expands stack frames and locals; Live
Feed shows `TestException` throws in real time and auto-reconnects; JVM Info renders.

### Phase 7 — BCI shadow capture (Class-File API)
Build the `bci-classfile` transformer (`BciTransformer` + `ShadowClassTransform` +
`ShadowCodeTransform` + `__JvmtiShadow`, thin no-dep JAR). On the native side, wire
`bci_engine.cpp` (`CLASS_FILE_LOAD_HOOK` + JAR injection) and `bci_shadow.cpp` (JNI bridge
to `__JvmtiShadow.getFrame()`), and bootstrap-inject the classes. **Verify:** compile
`TestException` **without** `-g`; with `bci=true`, locals still appear in the JSON tagged
`source: "bci_shadow"` and the UI badge lights up.

### Phase 8 — End-to-end validation (per OS)
Scripted run: build BCI JAR → build the agent library (CMake) → start collector → launch
`TestException` with the agent → assert via REST that dedup counts, a known local value,
cause chain, and `agent_start` metadata are all present; confirm Live Feed received the
events. Run the script on Windows, Linux, and macOS (the collector/UI are OS-independent
and can be shared). A CI matrix (e.g. GitHub Actions `windows-latest` / `ubuntu-latest` /
`macos-latest`) builds all three libraries and runs this smoke test on each.

### Phase 9 — Hardening, perf, docs
Close the known open work from NOTES.md and add benchmarks + README:
- **P0** — wrap `EnsureTransformerReady` in `std::call_once`.
- **P1** — make REDUCED actually skip full work (currently still does it).
- **P2** — TTL-cache JVM metrics instead of recomputing per event.
- **P7** — cache boxed-primitive method IDs.
- **P8** — add eviction to the sampling map (currently unbounded).
- Microbenchmark: tight loop throwing ~1M caught exceptions with/without the agent;
  document overhead ratio and that sampling keeps it bounded (run per OS).
- **Release packaging:** publish the three prebuilt libraries (`.dll`/`.so`/`.dylib`) plus
  the BCI JAR as release artifacts; document arch coverage (x64 everywhere, plus
  `aarch64` Linux and Apple-Silicon macOS if the CI runners allow).
- Write `README.md` (setup + every config key, with the `-agentpath` line shown per OS) and
  a config reference.

## 6. Build / run order (operator quickref)

1. Build the BCI JAR (`bci-classfile`) → copy next to the agent library as `bci-transform.jar`.
2. Build the agent library: `cmake -B agent/build agent && cmake --build agent/build`
   → `jvmti-agent.dll` (Windows) / `libjvmti-agent.so` (Linux) / `libjvmti-agent.dylib` (macOS).
3. Start the collector (`python -m collector` in `collector/`).
4. Launch the target JVM with the OS-appropriate library path:
   - Windows: `java -agentpath:agent\build\jvmti-agent.dll=host=localhost,port=8080[,bci=true] TestException`
   - Linux:   `java -agentpath:agent/build/libjvmti-agent.so=host=localhost,port=8080[,bci=true] TestException`
   - macOS:   `java -agentpath:agent/build/libjvmti-agent.dylib=host=localhost,port=8080[,bci=true] TestException`
5. Open `http://localhost:8080`.

## 7. Risks & notes

- **Locals without `-g`:** JVMTI LVT yields only slot numbers; the BCI shadow path (Phase 7)
  is the answer, so don't over-invest in the JVMTI-only fallback beyond graceful degradation.
- **`GetLocalVariable` safepoint constraint:** read locals only on the event thread inside
  the Exception callback; never from the async/background thread.
- **Cross-platform build:** keep every OS-specific call behind `ITransport`/`platform.h`
  from Phase 1 — retrofitting portability after the Windows path hardens is far costlier.
  libcurl is a real runtime/link dependency on Linux/macOS (Windows uses the OS-bundled
  WinHTTP); document how to install it and consider linking it statically for distributable
  binaries.
- **HTTPS/TLS parity:** WinHTTP and libcurl handle TLS and proxies differently. If the
  collector is ever reached over HTTPS, verify cert handling on all three backends; the
  default plan assumes plain HTTP to a local/intranet collector.
- **macOS specifics:** Gatekeeper/code-signing may block an unsigned `.dylib`; JVMTI
  attach works the same, but document signing for distribution. JNI header subdir is
  `darwin`, not `linux`.
- **JDK version for Class-File API:** the BCI transformer requires `java.lang.classfile`
  (JEP 484, final in JDK 24) — confirm it's final in the chosen JDK 24/25 distro before
  relying on it. There is no fallback transformer in scope, so the minimum JDK for the
  `bci=true` path is 24. (An ASM-based JDK-11 fallback could be added later if needed.)
- **Parity is bounded** to the components in §1; SaaS multi-tenant / source-attach are not in scope.
```