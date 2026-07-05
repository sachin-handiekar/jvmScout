# End-to-End Verification — main @ 7af4594

**Date:** 2026-07-05 · **Branch:** `verify/e2e-main` (cut from latest `main` after PR #4 merged the production-hardening work)
**Environment:** Windows 11, JDK 26.0.1, MSVC (fresh `agent/build-e2e`, a second-compiler check vs. the usual MinGW build), Python 3.14 venv, PostgreSQL 16 (Docker), Node 22.

## Build matrix

| Component | Result |
|---|---|
| BCI transformer jar (`java.lang.classfile`, JDK 26) | ✅ compiles, packaged |
| Native agent — clean **MSVC** configure+build | ✅ (found + fixed one MSVC-only test-code issue, below) |
| Agent unit tests (ctest, MSVC binary) | ✅ all pass |
| Collector suite — SQLite | ✅ 67 passed, 1 skipped (CFR decompiler not installed — optional) |
| Collector suite — **PostgreSQL 16**, schema via `alembic upgrade head` (0001→0005) | ✅ 67 passed, 1 skipped |
| React dashboard (`npm run build`) | ✅ SPA shell + assets produced; collector serves it with CSP header |

**Fix required:** `agent/tests/agent_tests.cpp` used a lambda with an explicit capture list relying on capture-free use of `const` locals — accepted by GCC/Clang, rejected by MSVC (C3493), i.e. the `windows-latest` CI job would fail. Fixed with a default reference capture (commit `4fa98f4` on this branch).

## Runtime end-to-end (fresh DB, auth bootstrap, port 18090)

| # | Check | Result |
|---|---|---|
| 1 | First start with no `COLLECTOR_API_KEY` bootstraps a master token, printed once | ✅ |
| 2 | `/healthz` public | ✅ 200 |
| 3 | Data endpoints without token | ✅ 401 |
| 4 | Master token works | ✅ 200 |
| 5 | `?key=` on HTTP endpoints rejected | ✅ 401 |
| 6 | Dashboard served (SPA shell) with `Content-Security-Policy` | ✅ |
| 7 | Mint scoped tokens (checkout ingest/viewer/admin, billing viewer) via API | ✅ |
| 8 | Agent ingest with **`api_key_file=`** (secret off the command line) | ✅ 53 events (note: the key file path must be a native Windows path, not an MSYS `/c/...` path) |
| 9 | Tenancy: checkout viewer sees its 53 events | ✅ |
| 10 | Tenancy: billing viewer sees **0** | ✅ |
| 11 | Master sees everything | ✅ |
| 12 | JVM instance registered under the token's project | ✅ |
| 13 | Role enforcement: viewer token cannot ingest | ✅ 403 |
| 14 | `event-series` totals equal real throw counts (51/1/1) | ✅ |
| 15 | Alerts: project-scoped `new_event` rule → webhook delivered (rules are per-project — a master/default-project rule correctly does **not** fire for checkout events) | ✅ 1 notification, `alerts_fired_total 1` |
| 16 | `/metrics` Prometheus counters track ingest | ✅ `events_accepted_total 54` |
| 17 | WebSocket `/ws/live` with scoped viewer over `?key=` handshake receives the live event | ✅ |
| 18 | BCI (`bci=true`, classes without `-g`, MSVC-built agent): all classes instrument, **no VerifyError** | ✅ |
| 19 | Shadow locals captured: 77 `bci_shadow` locals per run with real values (e.g. `"NullPointer"` @ slot 0) | ✅ |
| 20 | Aggregated COUNT_ONLY `occurrences` summed correctly (3 → 3) | ✅ |
| 21 | Agent with revoked/wrong key: one clear 4xx diagnostic, drops counted, prompt JVM exit | ✅ |
| 22 | `DELETE /admin/data?confirm=true` wipes events + instances + source classes | ✅ 267/3/1 deleted |
| 23 | Post-reset stats empty | ✅ |
| 24 | `collector.audit` entries recorded for token minting / config changes / resets | ✅ 7 lines |

## Verdict

Latest `main` is fully coherent end-to-end: the P0–P2 hardening and the source-view/JVMSCOUT_HOME features work together. One portability fix (MSVC lambda capture) ships on this branch and should be merged so Windows CI stays green.

Not exercised here: the decompiled-source *rendering* path (needs the optional CFR jar; its ingest/storage/reset paths were exercised), and multi-replica deployment (single-instance constraint documented in `docs/horizontal-scalability.md`).
