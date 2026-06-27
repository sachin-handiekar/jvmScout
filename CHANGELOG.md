# Changelog

All notable changes to jvmScout are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims
to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tagging a `vX.Y.Z` release triggers the release workflow, which publishes the
prebuilt agent libraries (`.dll`/`.so`/`.dylib`) and `bci-transform.jar` as
GitHub Release assets.

## [Unreleased]

### Added
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
- BCI shadow-frame depth-counter leak on exceptional unwind (catch-all pop).
- Modified-UTF-8 from JNI now serialized as valid JSON (`\u` escapes), fixing
  non-ASCII / supplementary-character payloads.
- Agent performance: bounded sampling map (LRU), cheaper REDUCED captures,
  TTL-cached JVM metrics, cached object-inspector class/method IDs.
- `fnv1a64` offset basis corrected to the true FNV-1a constant.
