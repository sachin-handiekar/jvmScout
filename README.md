# jvmScout

**JVMTI exception monitoring for the JVM.** An OverOps-style runtime error monitor: a native JVMTI agent captures every JVM
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
| Web UI | React 19 + TanStack Router/Query (Vite SPA, served by collector) | [`frontend/`](frontend/) |
| Test harness | Java | [`test-apps/`](test-apps/) |

The agent ships as a shared library for **Windows (`.dll`), Linux (`.so`), and
macOS (`.dylib`)** from one codebase; OS-specific HTTP transport and platform
shims sit behind interfaces.

## Quickstart (Docker)

The collector **and** dashboard ship as a single image. Pull the published
image and run it (no build toolchain needed):

```bash
docker run -p 8080:8080 -v jvmscout-data:/data \
  ghcr.io/<owner>/jvmscout-collector:latest
# dashboard -> http://localhost:8080
```

Replace `<owner>` with the repository owner; use `:latest` for the most recent
release, `:edge` for the latest `main` build, or a specific `:X.Y.Z`. The images
are built and published by the CI/release workflows.

Or build + run locally from source:

```bash
docker compose up        # builds collector/Dockerfile, serves on :8080
```

Either way, then build the native agent (below) and point a host JVM at
`host=localhost,port=8080`. The SQLite database persists in the `jvmscout-data`
volume.

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

# 3. Build the React dashboard (the collector serves the static output)
cd frontend
npm install --legacy-peer-deps
npm run build      # -> frontend/dist/client (the collector auto-detects this)
cd ..

# 4. Start the collector (serves the dashboard at http://localhost:8080)
cd collector
python -m venv .venv && . .venv/Scripts/activate   # or .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=src python -m collector

# 5. Run an instrumented JVM (per-OS agent path)
cd ../test-apps
javac -g TestException.java
java -agentpath:../agent/build/jvmti-agent.dll=host=localhost,port=8080,deployment=demo TestException

# 6. Open the dashboard
#    http://localhost:8080
```

### Dashboard development (hot reload)

The collector serves the production build, but for UI work run the Vite dev
server against a running collector:

```bash
cd frontend
# Point the dashboard at the collector and allow its origin through CORS:
echo 'VITE_COLLECTOR_URL=http://localhost:8080' >> .env        # dev only
COLLECTOR_CORS_ORIGINS=http://localhost:3000 PYTHONPATH=src python -m collector  # in the collector dir
npm run dev        # http://localhost:3000, proxying data to the collector
```

When the collector serves the built SPA it is same-origin, so `VITE_COLLECTOR_URL`
is left empty and no CORS config is needed. The dashboard prompts for the
collector API key (`COLLECTOR_API_KEY`) on first load and stores it locally;
leave it blank when the collector runs unauthenticated.

## Agent configuration

Passed as `-agentpath:<library>=key=val,key=val,...`

| Key | Default | Purpose |
|---|---|---|
| `host`, `port`, `path` | `localhost`, `8080`, `/collector` | Collector endpoint |
| `https` | `false` | Reach the collector over TLS |
| `tls_insecure` | `false` | Skip certificate verification (testing/self-signed only) |
| `api_key` | (empty) | Sent as `Authorization: Bearer <key>`; must match the collector's `COLLECTOR_API_KEY` |
| `deployment` | (empty) | Deployment tag on every event |
| `environment` | (empty) | Environment tag (`production`/`staging`/`development`) reported at startup; drives the dashboard's environment switcher (defaults to `production`) |
| `console` | `true` | Print captured exceptions to stdout |
| `depth` | `3` | Array-nesting depth when rendering captured values (object arrays recurse up to this depth; primitive arrays show `kind[len]`). Plain object fields are summarized as `type@hash`. |
| `timeout` | `5000` | HTTP timeout (ms) |
| `deny` | 10 JDK patterns | Extra exception-type denylist (`;`-separated) |
| `location_deny` | 23 framework patterns | Extra throw-site denylist |
| `capture_packages` | (empty) | Allowlist mode — only capture throws from these packages |
| `bci` | `false` | Enable bytecode instrumentation (shadow locals; needs JDK 24+) |
| `bci_jar` | auto (next to library) | Path to `bci-transform.jar` |
| `bci_packages` | (empty) | BCI allowlist (`;`-separated package prefixes, dot or slash form). When set, only matching classes are instrumented. |
| `bci_exclude` | (empty) | BCI denylist (`;`-separated prefixes); matching classes are never instrumented. Applied on top of the transformer's built-in JDK/framework excludes. |
| `bci_verbose` | `false` | Log per-class BCI instrument/skip decisions. |
| `instance_id` | auto UUID | JVM instance identity |
| `env_capture` | (empty) | Env-var glob patterns to capture |
| `redact_props` | 7 patterns | Sensitive keys to redact |

## Collector configuration (env vars)

| Env var | Default | Purpose |
|---|---|---|
| `COLLECTOR_HOST`, `COLLECTOR_PORT` | `0.0.0.0`, `8080` | Bind address |
| `COLLECTOR_DB_URL` | `sqlite+aiosqlite:///./collector.db` | Database URL |
| `COLLECTOR_RETENTION_DAYS` | `30` | Purge events older than this |
| `COLLECTOR_API_KEY` | (empty) | **Require an API key** on all data endpoints (ingest + REST + WS). When unset, the collector runs **unauthenticated** and logs a warning — only safe on a trusted local network. |
| `COLLECTOR_CORS_ORIGINS` | (empty) | Comma-separated allowed CORS origins. Empty = no CORS (the dashboard is same-origin and needs none). |
| `COLLECTOR_MAX_BODY_BYTES` | `5242880` | Max ingest request body size (rejects with 413). |
| `COLLECTOR_RATE_LIMIT_PER_MIN` | `0` (off) | Per-client-IP ingest rate limit. |
| `COLLECTOR_PURGE_INTERVAL_SECONDS` | `3600` | Periodic retention purge interval (`0` disables). |
| `COLLECTOR_CSP` | (built-in) | Override the `Content-Security-Policy` sent with the dashboard. By default a strict policy is built automatically (hashes the SPA's inline bootstrap scripts; allows same-origin XHR/WebSocket + Google Fonts). Set a custom value if the dashboard talks to a **cross-origin** collector (add that origin to `connect-src`); set empty to disable. |
| `COLLECTOR_CSP_REPORT_ONLY` | (off) | When `1`/`true`, send the policy as `Content-Security-Policy-Report-Only` (reports violations without blocking) — useful to validate a policy before enforcing. |
| `COLLECTOR_LOG_LEVEL` | `INFO` | Log level. |

### Authentication

Set `COLLECTOR_API_KEY` to require a key. The agent must send it (configurable
auth header — see the agent review/roadmap), and the dashboard prompts for it and
stores it in `localStorage`. Clients may present the key as `Authorization: Bearer
<key>`, an `X-API-Key` header, or a `?key=` query parameter. `GET /healthz` is
always public for liveness probes. TLS is expected to be terminated by a reverse
proxy in front of the collector.

## How local-variable capture works

- **With `-g`** (debug info): the agent reads locals directly from the JVMTI
  Local Variable Table (`source: "debug_info"`) — names, signatures, values.
- **Without `-g`**: enable `bci=true`. The `java.lang.classfile` transformer
  injects shadow-capture calls so the agent recovers local *values* by slot
  (`source: "bci_shadow"`); the UI marks these with a ● badge.

## Database & migrations

The collector uses SQLAlchemy (async) and ships with **SQLite** by default
(`sqlite+aiosqlite:///./collector.db`). Schema is managed with **Alembic**.

```bash
cd collector
PYTHONPATH=src alembic upgrade head     # create/upgrade the schema
PYTHONPATH=src alembic revision -m "msg" --autogenerate   # author a new migration
```

For zero-config local dev, `python -m collector` also calls `create_all` on
startup, so a fresh SQLite DB just works without running Alembic. In Docker the
container runs `alembic upgrade head` before starting. **After any schema change,
run `alembic upgrade head`** (a plain SQLite file created by an older build won't
auto-gain new columns — recreate it or migrate).

### Moving from SQLite to Postgres

The same models and migrations target Postgres — only the URL and driver change:

1. Install the async driver: `pip install asyncpg` (already implied for Docker —
   add it to `requirements.txt` or the image).
2. Point the collector at Postgres:
   ```bash
   export COLLECTOR_DB_URL="postgresql+asyncpg://user:pass@host:5432/jvmscout"
   ```
3. Create the schema: `PYTHONPATH=src alembic upgrade head`.
4. Start the collector. (To migrate existing data, dump the SQLite tables and
   load them into Postgres with your tool of choice — there's no automatic copy.)

Postgres is recommended once you outgrow a single process: the in-memory
WebSocket fan-out and rate-limiter are per-process, so horizontal scaling also
needs shared infrastructure for those (not yet built).

## Redaction

Two layers, defense in depth:

- **Agent-side (never leaves the JVM):** `redact_props` masks sensitive
  **system properties, env vars, and captured local-variable values** by name
  (case-insensitive substring, e.g. `password`/`token`/`secret`) — the value is
  replaced with `***` before the event is sent.
- **Collector-side (centrally managed):** the dashboard's **Redaction** screen
  manages rules the collector applies to captured local values (and the
  exception message) on ingest, before anything is stored or broadcast:
  - **identifier** rules mask a local whose name matches;
  - **pattern** rules mask any value matching a regex (e.g. card numbers, JWTs).

## Verified

Built and exercised on Windows with JDK 26, GCC (MinGW-w64) + CMake/Ninja, and
Python 3.14: agent load, exception capture (type/message/line/fingerprint),
FULL→REDUCED→COUNT_ONLY sampling, local-variable capture via both JVMTI and BCI
shadow paths, batched HTTP transport, collector ingest/REST/WebSocket, and the
dashboard.
