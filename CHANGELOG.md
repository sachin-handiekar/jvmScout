# Changelog

All notable changes to jvmScout are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tagging a `vX.Y.Z` release triggers the release workflow, which publishes the
prebuilt agent libraries (`.dll`/`.so`/`.dylib`) and `bci-transform.jar` as
GitHub Release assets.

## [Unreleased]

### Added
- **`JVMSCOUT_HOME` install directory + `jvmscout.yaml` settings file** (OverOps
  style). Instead of cramming everything into the `-agentpath` string, point
  `JVMSCOUT_HOME` at a directory holding the library, `bci-transform.jar`, and a
  `jvmscout.yaml` file; the JVM flag shrinks to
  `-agentpath:$JVMSCOUT_HOME/lib/libjvmti-agent.so`. Config layers, lowest→highest:
  built-in defaults → `jvmscout.yaml` → `JVMSCOUT_<KEY>` env vars (e.g.
  `JVMSCOUT_API_KEY`, so secrets stay off the command line) → inline `-agentpath`
  options. The settings file is located via `config=`/`home=` options,
  `JVMSCOUT_CONFIG`/`JVMSCOUT_HOME` env, or the library's own directory. Fully
  backward compatible — existing `-agentpath:...=k=v,...` command lines are
  unchanged when no file is present. Uses a small dependency-free YAML-subset
  parser (scalars, `- item` block sequences, `[a, b]` flow sequences, `#`
  comments). The BCI jar is now also found under `$JVMSCOUT_HOME/lib`, which gives
  POSIX builds a jar-location fallback when the library path can't be derived.
- Decompiled **source view** for stack frames (no source upload). The agent
  (`source=true`) captures app-class bytecode and ships it; the collector
  decompiles it on demand (bundled CFR + headless JRE in the image) and attaches
  the throwing method's source to each app frame, so the dashboard's frame panel
  shows code instead of "No source available". `-g` builds keep real local
  names. Degrades gracefully when no decompiler is present. Adds the
  `source_classes` table (Alembic `0004`).
- Multi-tenancy: API tokens are now bound to a **project** and a **role**
  (`ingest` / `viewer` / `admin`). The collector stamps each ingested event with
  the token's project (authoritatively — agents can't claim another tenant) and
  filters every read, stat, and live-WebSocket update by the caller's project.
  `POST /tokens` takes `project_id` + `role`; the master `COLLECTOR_API_KEY` is a
  superadmin that sees all projects. Adds a `project_id` column (Alembic
  `0002_project_id`).
- Dashboard Tokens screen can now mint **scoped tokens**: pick a project and a
  role (ingest / viewer / admin) when generating a token, and the token list
  shows each token's project and role.
- The Settings **Agent install** tab now mints a **real project-scoped ingest
  token** (the credential agents actually authenticate with) and drops it into
  the `JVMSCOUT_API_KEY` install snippet — replacing the previous mock
  `workspace_settings.install_key`, which looked like a key but was never a valid
  collector credential. It also lists existing (non-revoked) ingest keys for the
  tenant; full key management stays on the API tokens tab.
- Per-project config: alert rules, redaction rules, and other UI-managed config
  are now scoped to a project (Alembic `0003_config_project_id`). An admin
  manages only their project's rules and they apply only to that project's
  events (redaction + alert evaluation are cached per-project); the master key
  manages every project.
- Docker image publishing to GitHub Container Registry: CI pushes a rolling
  `ghcr.io/<owner>/jvmscout-collector:edge` (and `:sha-…`) on `main`, and the
  release workflow pushes versioned `:X.Y.Z` / `:latest` images on `v*` tags —
  so users can `docker run` the collector+dashboard without a build toolchain.
- Alert engine: alert rules created in the UI are now evaluated on ingest and
  delivered. `new_event`/`deploy_regression`, `volume_threshold`, and
  `event_reoccurs` triggers are supported, scoped per application/deployment,
  with Slack/webhook (HTTP) delivery, anti-storm debounce, and `last_triggered_at`
  written back. (Email/PagerDuty are not delivered in this build and are not
  marked as triggered.)
- Real per-fingerprint occurrence time-series (`GET /stats/event-series`) now
  backs the dashboard's per-event hit totals, sparklines, and rising/falling
  trend, plus the Applications card sparklines and the Events "increasing"
  filter — replacing the previous client-side fabricated values.
- React dashboard (TanStack Start SPA) integrated with the collector via a
  Supabase-compatible adapter over the collector REST/WebSocket; served as
  static assets by the collector. Live updates over `/ws/live`.
- Collector API-key auth, locked CORS, security headers, body-size + rate
  limits, retention purge, and a generic `/config/{table}` CRUD API backing the
  Alerts/Settings/Team screens. pytest suite.
- Agent TLS + bearer auth (`https`, `tls_insecure`, `api_key`) across the
  WinHTTP and libcurl transports; async-queue retry/requeue.
- Configurable BCI scope (`bci_packages`/`bci_exclude`) and live `depth`
  (array-nesting render depth).
- CI for the frontend (typecheck + build) and the Docker image; C++ unit tests
  for the agent (fingerprint, filters, sampler, JSON escaping, config).
- Release workflow + this changelog.

### Changed
- Replaced the vanilla `ui/` with the React `frontend/`.
- Dashboard/Events event-type taxonomy now lists only the types the agent
  actually produces (uncaught/caught); the always-empty log/HTTP series were
  removed for honesty.

### Fixed
- JNI local-reference discipline in the exception callback: the stack walker now
  bounds references per frame (and releases each declaring-class ref), and the
  message/cause/suppressed helpers release their `GetObjectClass` refs. Deep
  stacks (up to 100 frames) previously accumulated ~one local ref per frame
  inside the callback's reserved frame, which could exceed its capacity under
  sustained volume (and trip `-Xcheck:jni`).
- BCI shadow-frame depth-counter leak on exceptional unwind (catch-all pop).
- Modified-UTF-8 from JNI now serialized as valid JSON (`\u` escapes), fixing
  non-ASCII / supplementary-character payloads.
- Agent performance: bounded sampling map (LRU), cheaper REDUCED captures,
  TTL-cached JVM metrics, cached object-inspector class/method IDs.
- `fnv1a64` offset basis corrected to the true FNV-1a constant.
