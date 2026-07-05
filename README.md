<div align="center">

# 🛰️ jvmScout

**Runtime exception monitoring for the JVM, powered by JVMTI.**

A native JVMTI agent captures *every* JVM exception with full diagnostic context —
stack frames, **live local-variable values**, cause chain, and JVM metrics — and
streams it to a Python collector that persists it and serves a live web dashboard.

<!-- Build & release -->
[![CI](https://github.com/sachin-handiekar/jvmScout/actions/workflows/ci.yml/badge.svg)](https://github.com/sachin-handiekar/jvmScout/actions/workflows/ci.yml)
[![Release](https://github.com/sachin-handiekar/jvmScout/actions/workflows/release.yml/badge.svg)](https://github.com/sachin-handiekar/jvmScout/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GHCR](https://img.shields.io/badge/ghcr.io-jvmscout--collector-2496ED?logo=docker&logoColor=white)](https://github.com/sachin-handiekar/jvmScout/pkgs/container/jvmscout-collector)

<!-- Stack -->
![C++17](https://img.shields.io/badge/C%2B%2B-17-00599C?logo=cplusplus&logoColor=white)
![Java](https://img.shields.io/badge/Java-24%2B-ED8B00?logo=openjdk&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![FastAPI](https://img.shields.io/badge/FastAPI-async-009688?logo=fastapi&logoColor=white)

<!-- Platforms -->
![Windows](https://img.shields.io/badge/Windows-.dll-0078D6?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-.so-FCC624?logo=linux&logoColor=black)
![macOS](https://img.shields.io/badge/macOS-.dylib-000000?logo=apple&logoColor=white)

[Quickstart](#-quickstart-docker) · [Build](#-build--run) · [Configuration](#-agent-configuration) · [Source View](#-source-view-decompiled) · [Architecture](#-architecture) · [Roadmap](ROADMAP.md)

</div>

---

## 📋 Table of Contents

- [Why jvmScout?](#-why-jvmscout)
- [Screenshots](#-screenshots)
- [Architecture](#-architecture)
- [Components](#-components)
- [Quickstart (Docker)](#-quickstart-docker)
- [Prerequisites](#-prerequisites)
- [Build & run](#-build--run)
- [Configuration via JVMSCOUT_HOME](#-configuration-via-jvmscout_home-settings-file)
- [Agent configuration](#-agent-configuration)
- [Collector configuration](#-collector-configuration-env-vars)
- [Authentication](#authentication)
- [Multiple apps & teams](#multiple-apps--teams-projects-scoped-tokens)
- [Source view (decompiled)](#-source-view-decompiled)
- [Local-variable capture](#-how-local-variable-capture-works)
- [Database & migrations](#-database--migrations)
- [Redaction](#-redaction)
- [Alerts](#-alerts)
- [Verified](#-verified)
- [Contributing](#-contributing)
- [License](#-license)

## 💡 Why jvmScout?

Most error monitors need you to wire a logging library into your app and only see
what you remembered to log. jvmScout attaches to the JVM itself as a native JVMTI
agent — **no code changes, no SDK, no recompile** — and observes exceptions at the
source. For each throw it captures:

- ✅ Exception **type, message, line, and a stable fingerprint** for grouping
- ✅ The full **stack trace** with per-frame **local-variable values** (via the JVMTI
  Local Variable Table, or via bytecode shadow-capture when classes lack `-g`)
- ✅ The **cause chain**, JVM metrics, environment/deployment tags, and instance identity
- ✅ Optional **decompiled source** for each app frame, reconstructed from bytecode
- ✅ Adaptive sampling (`FULL → REDUCED → COUNT_ONLY`) so a storm of errors never
  overwhelms the collector

It ships as a single cross-platform agent (Windows `.dll`, Linux `.so`, macOS
`.dylib`), a multi-tenant collector with scoped API tokens, redaction, and alert
rules, and a live React dashboard.

## 📸 Screenshots

> ⚠️ **Placeholder images** — replace the files in [`docs/screenshots/`](docs/screenshots/)
> with real captures. See [`docs/screenshots/README.md`](docs/screenshots/README.md) for the expected filenames.

<div align="center">

| Dashboard | Event detail |
|:---:|:---:|
| [![Dashboard](docs/screenshots/dashboard.png)](docs/screenshots/dashboard.png) | [![Event detail](docs/screenshots/event-detail.png)](docs/screenshots/event-detail.png) |
| **Decompiled source view** | **Alerts** |
| [![Source view](docs/screenshots/source-view.png)](docs/screenshots/source-view.png) | [![Alerts](docs/screenshots/alerts.png)](docs/screenshots/alerts.png) |

</div>

## 🏗️ Architecture

```
                ┌──────────────────────── Target JVM ────────────────────────┐
                │                                                             │
                │   Application code                                          │
                │        │ throws                                             │
                │        ▼                                                    │
                │   JVMTI native agent ──┐                                    │
                │        │               │ (optional) BCI transformer JAR     │
                │        │               └── injected via ClassFileLoadHook   │
                └────────┼────────────────────────────────────────────────────┘
                         │ HTTP POST (batched, async)
                         ▼
                ┌─────────────────────────┐         ┌────────────────────┐
                │   Python collector      │◄───────►│  SQLite / Postgres │
                │   (FastAPI, async)      │         └────────────────────┘
                │   REST + WebSocket      │
                └────────────┬────────────┘
                             │ serves SPA + live data
                             ▼
                    ┌────────────────┐
                    │  React dashboard│
                    └────────────────┘
```

See [PLAN.md](PLAN.md) for the full design and [NOTES.md](NOTES.md) for the
authoritative component blueprints.

## 🧩 Components

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

## 🚀 Quickstart (Docker)

The collector **and** dashboard ship as a single image. Pull the published
image and run it (no build toolchain needed):

```bash
docker run -p 8080:8080 -v jvmscout-data:/data \
  ghcr.io/sachin-handiekar/jvmscout-collector:latest
# dashboard -> http://localhost:8080
```

Use `:latest` for the most recent release, `:edge` for the latest `main` build,
or a specific `:X.Y.Z`. The images are built and published by the CI/release
workflows.

Or build + run locally from source:

```bash
docker compose up        # builds collector/Dockerfile, serves on :8080
```

Either way, then build the native agent (below) and point a host JVM at
`host=localhost,port=8080`. The SQLite database persists in the `jvmscout-data`
volume.

## ✅ Prerequisites

- A C++17 compiler (MSVC, GCC, or Clang) and **CMake ≥ 3.20**
- **JDK 24+** (required for the `bci=true` path; core capture works on any
  JVMTI-capable JDK). Set `JAVA_HOME`.
- On Linux/macOS: libcurl development headers (`libcurl4-openssl-dev` / Homebrew `curl`)
- **Python 3.10+** for the collector

## 🔧 Build & run

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

## 🏠 Configuration via `JVMSCOUT_HOME` (settings file)

For anything beyond a quick demo, **don't** pack settings into the `-agentpath`
string — it's brittle and leaks secrets like `api_key` into process listings
(`ps`). Instead, point an environment variable at an **install home directory**
that holds the library, the transformer jar, and a `jvmscout.yaml` settings file
(OverOps-style). The JVM flag then shrinks to just *"load the library"*:

```
$JVMSCOUT_HOME/
  jvmscout.yaml              # all settings (keys below)
  lib/
    libjvmti-agent.so        # | jvmti-agent.dll | libjvmti-agent.dylib
    bci-transform.jar        # auto-found next to the library
```

```bash
export JVMSCOUT_HOME=/opt/jvmscout
java -agentpath:$JVMSCOUT_HOME/lib/libjvmti-agent.so -jar your-app.jar
```

Example `jvmscout.yaml` (every key from the [table below](#-agent-configuration)
is valid; lists are YAML block or flow sequences):

```yaml
host: collector.internal
port: 8080
# Prefer the JVMSCOUT_API_KEY env var over putting the secret on disk;
# if you do store it here, chmod 600 the file.
api_key: stk_abc123
deployment: checkout
environment: production
bci: true
bci_packages:
  - com.acme
  - com.acme.payments
redact_props: [ssn, cardNumber]
```

**Precedence** (lowest → highest), so you can keep shared settings in the file and
override per-host or per-JVM:

| Layer | Source | Typical use |
|---|---|---|
| 1 | Built-in defaults | denylists, redaction patterns |
| 2 | `jvmscout.yaml` | the shared, version-controlled config |
| 3 | `JVMSCOUT_<KEY>` env vars (e.g. `JVMSCOUT_API_KEY`, `JVMSCOUT_DEPLOYMENT`) | secrets & per-host values |
| 4 | `-agentpath` inline `key=val` | per-JVM overrides (most explicit, wins) |

The settings file is located via the `config=`/`home=` agentpath keys, then the
`JVMSCOUT_CONFIG` / `JVMSCOUT_HOME` env vars, then the directory of the loaded
library (so `jvmscout.yaml` sitting next to the `.so/.dll` is picked up
automatically). If no file is found the agent runs purely off env + agentpath —
so **existing `-agentpath:...=k=v,...` command lines keep working unchanged**.

The agent logs its config source on startup, e.g.
`[jvmti-agent] config: loaded /opt/jvmscout/jvmscout.yaml`.

> The YAML reader is a small flat-schema parser (scalars, `- item` block
> sequences, `[a, b]` flow sequences, `#` comments) — nested maps/anchors aren't
> needed and aren't supported.

## ⚙️ Agent configuration

Settings can be supplied inline as `-agentpath:<library>=key=val,key=val,...` **or**
(recommended) via `jvmscout.yaml` / `JVMSCOUT_*` env vars — the key names below are
identical across all three.

| Key | Default | Purpose |
|---|---|---|
| `host`, `port`, `path` | `localhost`, `8080`, `/collector` | Collector endpoint |
| `https` | `false` | Reach the collector over TLS |
| `tls_insecure` | `false` | Skip certificate verification (testing/self-signed only) |
| `api_key` | (empty) | Sent as `Authorization: Bearer <key>`; the master key or a project-scoped **ingest** token (see Multiple apps & teams) |
| `api_key_file` | (empty) | Read the key from a file instead (first line, trimmed) — keeps the secret off the process command line, which any local user can read |
| `deployment` | (empty) | Deployment tag on every event |
| `environment` | (empty) | Environment tag (`production`/`staging`/`development`) reported at startup; drives the dashboard's environment switcher (defaults to `production`) |
| `console` | `false` | Print captured exceptions to the host app's stdout (debugging aid; leave off in production) |
| `depth` | `3` | Array-nesting depth when rendering captured values (object arrays recurse up to this depth; primitive arrays show `kind[len]`). Plain object fields are summarized as `type@hash`. |
| `timeout` | `5000` | HTTP timeout (ms) |
| `deny` | 10 JDK patterns | Extra exception-type denylist (`;`-separated) |
| `location_deny` | 23 framework patterns | Extra throw-site denylist |
| `capture_packages` | (empty) | Allowlist mode — only capture throws from these packages |
| `bci` | `false` | **Experimental — not for production.** Enable bytecode instrumentation (shadow locals; needs JDK 24+). Adds significant per-call overhead in instrumented code; transformed classes are verifier-checked and fall back to the original bytecode on any doubt. |
| `bci_jar` | auto (next to library) | Path to `bci-transform.jar` |
| `bci_packages` | (empty) | BCI allowlist (`;`-separated package prefixes, dot or slash form). When set, only matching classes are instrumented. |
| `bci_exclude` | (empty) | BCI denylist (`;`-separated prefixes); matching classes are never instrumented. Applied on top of the transformer's built-in JDK/framework excludes. |
| `bci_verbose` | `false` | Log per-class BCI instrument/skip decisions. |
| `source` | `false` | Capture original app-class bytecode and ship it so the collector can show **decompiled source** per stack frame. Read-only (never rewrites bytecode, unlike `bci`), so it can't break a class. `bci=true` also enables capture. |
| `instance_id` | auto UUID | JVM instance identity |
| `env_capture` | (empty) | Env-var glob patterns to capture |
| `redact_props` | 7 patterns | Sensitive keys to redact |
| `home` | (see above) | Override the install home dir used to find `jvmscout.yaml` (option-string/env only) |
| `config` | (see above) | Explicit path to the settings file (option-string/env only) |

## 🗄️ Collector configuration (env vars)

| Env var | Default | Purpose |
|---|---|---|
| `COLLECTOR_HOST`, `COLLECTOR_PORT` | `0.0.0.0`, `8080` | Bind address |
| `COLLECTOR_DB_URL` | `sqlite+aiosqlite:///./collector.db` | Database URL |
| `COLLECTOR_RETENTION_DAYS` | `30` | Purge events older than this |
| `COLLECTOR_API_KEY` | (empty) | Master key (superadmin) accepted on all data endpoints (ingest + REST + WS). If unset, a **master token is bootstrapped on first start and printed once** to the logs — the collector never silently runs open. |
| `COLLECTOR_ALLOW_ANONYMOUS` | (off) | Explicitly run **unauthenticated** (skips the bootstrap token). Only safe on a trusted local network. |
| `COLLECTOR_ALERT_ALLOW_PRIVATE` | (off) | Allow alert webhooks to target private/internal addresses. Off by default (SSRF guard): destinations must resolve to public addresses. |
| `COLLECTOR_CORS_ORIGINS` | (empty) | Comma-separated allowed CORS origins. Empty = no CORS (the dashboard is same-origin and needs none). |
| `COLLECTOR_MAX_BODY_BYTES` | `5242880` | Max ingest request body size (rejects with 413). |
| `COLLECTOR_RATE_LIMIT_PER_MIN` | `0` (off) | Ingest rate limit, keyed per token (per client IP when anonymous). |
| `COLLECTOR_PURGE_INTERVAL_SECONDS` | `3600` | Periodic retention purge interval (`0` disables). |
| `COLLECTOR_CSP` | (built-in) | Override the `Content-Security-Policy` sent with the dashboard. By default a strict policy is built automatically (hashes the SPA's inline bootstrap scripts; allows same-origin XHR/WebSocket + Google Fonts). Set a custom value if the dashboard talks to a **cross-origin** collector (add that origin to `connect-src`); set empty to disable. |
| `COLLECTOR_CSP_REPORT_ONLY` | (off) | When `1`/`true`, send the policy as `Content-Security-Policy-Report-Only` (reports violations without blocking) — useful to validate a policy before enforcing. |
| `COLLECTOR_DECOMPILER_JAR` | (auto) | Path to the CFR decompiler jar used for the **source view**. The Docker image bundles it (`/app/cfr.jar`) with a headless JRE; for local dev, download CFR and point this at it (and have `java` on PATH / `JAVA_HOME` set). Absent ⇒ source view shows "No source available". |
| `COLLECTOR_LOG_LEVEL` | `INFO` | Log level. |

### Authentication

Authentication is on by default. Either set `COLLECTOR_API_KEY`, or let the
collector **bootstrap a master token on first start** (printed once in the
startup logs — store it). Clients present the key as `Authorization: Bearer
<key>` or an `X-API-Key` header; a `?key=` query parameter is accepted **only**
on the WebSocket handshake (browsers can't set headers there) and is rejected
on HTTP endpoints so keys never land in access logs. `GET /healthz` is always
public for liveness probes; `GET /metrics` (Prometheus text format, aggregate
operational counters) needs any read-capable token. TLS is expected to be
terminated by a reverse proxy in front of the collector.

The `COLLECTOR_API_KEY` is the **master key** (superadmin): it can do everything
and see every project. For per-app/per-team setups, issue scoped tokens instead
(below) and keep the master key for administration only.

### Multiple apps & teams (projects, scoped tokens)

The collector is multi-tenant. A **token** is bound to a **project** and a
**role**, and the project is derived *from the token* on ingest — so one app
can't read or pollute another's data even if it lies about its `deployment`.

Roles:

| Role | Can |
|---|---|
| `ingest` | POST events only (give this to agents) |
| `viewer` | read-only dashboard access, scoped to its project |
| `admin` | also manage the project's tokens/config |

Issue a token with the master key (or via the dashboard's Tokens screen):

```bash
# An ingest token for each app/team's JVMs:
curl -sX POST http://localhost:8080/tokens \
  -H "Authorization: Bearer $COLLECTOR_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"payments-agent","project_id":"payments","role":"ingest"}'
# -> {"token":"stk_…","project_id":"payments","role":"ingest"}

# A viewer token for that team's dashboard login:
curl -sX POST http://localhost:8080/tokens \
  -H "Authorization: Bearer $COLLECTOR_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"payments-dash","project_id":"payments","role":"viewer"}'
```

Then run each JVM with its project's **ingest** token:

```bash
java -agentpath:...=host=localhost,port=8080,api_key=stk_…,deployment=checkout MyApp
```

Multiple JVMs sharing a token belong to the same project; within a project they
are still separated as individual apps/instances by the agent's `deployment` and
`instance_id`. Logging into the dashboard with a project's **viewer** token
shows only that project; the master key sees all projects.

Alert rules, redaction rules, and other config are also **per-project**: an
admin manages only their own project's rules, and they apply only to that
project's events. The master key manages every project.

## 🔍 Source view (decompiled)

The dashboard shows the source of each app frame in a stack trace. A JVMTI agent
has no source — only bytecode — so:

1. Run the agent with **`source=true`** (or `bci=true`). It captures the original
   bytecode of app classes (read-only — it never rewrites them) and ships each
   class once to the collector.
2. The collector **decompiles** that bytecode on demand (bundled CFR + a headless
   JRE in the Docker image) and attaches the throwing method's source to each
   frame. Classes compiled with `-g` (Maven's default) keep their real parameter
   and local-variable names.

No application source is uploaded or stored — only bytecode, which the collector
already needs nothing else to reconstruct. Decompiled code is faithful but not
identical to the original (names/layout can differ), so it's labelled as
decompiled and shows the method that threw rather than a pixel-exact line.

## 🧠 How local-variable capture works

- **With `-g`** (debug info): the agent reads locals directly from the JVMTI
  Local Variable Table (`source: "debug_info"`) — names, signatures, values.
- **Without `-g`**: enable `bci=true` (**experimental**). The
  `java.lang.classfile` transformer injects shadow-capture calls so the agent
  recovers local *values* by slot (`source: "bci_shadow"`); the UI marks these
  with a ● badge. The instrumentation adds real overhead to instrumented code
  paths (per-call-site capture with boxing) — scope it tightly with
  `bci_packages` and keep it out of production until it graduates.

## 🛢️ Database & migrations

The collector uses SQLAlchemy (async) and ships with **SQLite** by default
(`sqlite+aiosqlite:///./collector.db`). Schema is managed with **Alembic**.

```bash
cd collector
PYTHONPATH=src alembic upgrade head     # create/upgrade the schema
PYTHONPATH=src alembic revision -m "msg" --autogenerate   # author a new migration
```

For zero-config local dev, `python -m collector` also calls `create_all` on
startup (plus a small in-place index/column backfill), so a fresh SQLite DB
just works without running Alembic. In Docker the container runs
`alembic upgrade head` before starting. **After any schema change, run
`alembic upgrade head`** — for a database originally created by `create_all`,
run `alembic stamp head` once to adopt it, then upgrade normally. The migration
chain and the full test suite are exercised against **PostgreSQL 16 in CI**
(`collector-postgres` job).

### Moving from SQLite to Postgres

The same models and migrations target Postgres — only the URL and driver change:

1. Install dependencies (`asyncpg` ships in `requirements.txt`).
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

## 🛡️ Redaction

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

## 🔔 Alerts

The dashboard's **Alerts** screen defines rules that the collector evaluates on
every ingested exception (off the ingest path, so alerting never blocks or
breaks capture) and delivers when they match:

- **Triggers:** new exception class first seen, occurrences over a threshold in a
  window, a specific exception type reoccurring, or a new error introduced by a
  deployment. Rate-based rules have an anti-storm cool-down.
- **Delivery:** `webhook` and `slack` are delivered over HTTP (a Slack incoming
  webhook is just a JSON POST). `email`/`pagerduty` need infrastructure this
  build doesn't ship, so they are logged and **not** marked as triggered.
- **Per-project:** an admin's rules apply only to their own project's events.

## 🧪 Verified

Built and exercised on Windows with JDK 26, GCC (MinGW-w64) + CMake/Ninja, and
Python 3.14: agent load, exception capture (type/message/line/fingerprint),
FULL→REDUCED→COUNT_ONLY sampling, local-variable capture via both JVMTI and BCI
shadow paths, batched HTTP transport, collector ingest/REST/WebSocket, and the
dashboard. The collector has an automated test suite (55 tests) covering auth,
multi-tenant project/role scoping, redaction, alerts, time-series, and config;
the agent has C++ unit tests (incl. a collector-down/queue stress test). CI also
builds the agent on Linux/macOS/Windows — but the libcurl transport has not yet
been exercised end-to-end on Linux/macOS.

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) before opening a pull request. Security
issues should follow the process in [SECURITY.md](SECURITY.md). The
[ROADMAP.md](ROADMAP.md) and [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)
documents track what's planned and what's left before launch.

## 📄 License

Released under the [MIT License](LICENSE) — © 2026 The jvmScout Authors.
