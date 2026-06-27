# Changelog

All notable changes to jvmScout are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tagging a `vX.Y.Z` release triggers the release workflow, which publishes the
prebuilt agent libraries (`.dll`/`.so`/`.dylib`) and `bci-transform.jar` as
GitHub Release assets.

## [Unreleased]

### Added
- Multi-tenancy: API tokens are now bound to a **project** and a **role**
  (`ingest` / `viewer` / `admin`). The collector stamps each ingested event with
  the token's project (authoritatively — agents can't claim another tenant) and
  filters every read, stat, and live-WebSocket update by the caller's project.
  `POST /tokens` takes `project_id` + `role`; the master `COLLECTOR_API_KEY` is a
  superadmin that sees all projects. Adds a `project_id` column (Alembic
  `0002_project_id`).
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
