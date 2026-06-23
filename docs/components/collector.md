# Component Review — Python Collector (`collector/`)

FastAPI service (Python 3.10+) with async SQLAlchemy + aiosqlite. Ingests events
from agents, persists them in two SQLite tables, serves a REST API + WebSocket
live feed, and mounts the web UI as static files. ~660 LOC across `app.py`,
`config.py`, `models.py`, `storage.py`, `api/routes.py`.

## What's already strong

- **Clean async data layer.** Typed SQLAlchemy 2.0 models, indexed columns,
  paginated/filterable queries, retention purge (`storage.py`).
- **Robust wire-format handling.** Pydantic v2 with a camelCase alias generator
  and `extra="ignore"`; `fingerprint` coerced int→str
  (`models.py:87-91`); `type` discriminates `agent_start` vs exception
  (`routes.py:52`).
- **WebSocket fan-out** with a lock-guarded client set and auto-pruning of dead
  sockets (`routes.py:15-41`).

## Production-readiness gaps

### P0 — Security (launch-blocking)

1. **No authentication on any endpoint.** `POST /collector` accepts events from
   anyone, and — more dangerously — `DELETE /exceptions` wipes the entire table
   unauthenticated (`routes.py:94-97`), as does `DELETE /exceptions/{id}`. The
   read endpoints expose captured local variables, env vars, and system
   properties to anyone who can reach the port. Add auth: an **API key / bearer
   token** on ingest (matched by the agent) and session/token auth (or at minimum
   a shared secret) on the dashboard + REST/WS.

2. **CORS is wide open with credentials.** `allow_origins=["*"]` together with
   `allow_credentials=True` (`app.py:31-37`). The UI is served same-origin and
   needs no CORS at all — restrict origins to the configured dashboard origin (or
   drop the middleware).

3. **No request size or rate limiting.** `ingest` does `await request.json()`
   (`routes.py:46`), reading an unbounded body into memory — a single large POST
   can OOM the process. Add a max body size and per-source rate limiting.

### P1 — Reliability / correctness

4. **One bad event fails the whole batch.** `ingest` calls `model_validate`
   without a per-item guard (`routes.py:53,57`); a single malformed event raises
   and aborts the entire POST (and any already-processed items in the loop are
   committed while the rest are lost, with a 500 to the agent → the agent may
   retry the whole batch). Wrap each item in try/except, count failures, and
   return a per-item result.

5. **No health endpoint.** Orchestrators need a cheap liveness/readiness probe.
   `/stats` runs several full-table aggregations (`storage.py:187-208`) and is a
   poor health check. Add `GET /healthz` (and the Dockerfile/CI should use it).

6. **No schema migrations.** Startup only runs `create_all` (`storage.py:68-70`);
   any column change silently fails to apply to existing databases. Adopt Alembic
   before the schema is in users' hands.

### P2 — Scale & operability

7. **SQLite is the only tested backend.** `db_url` is configurable so Postgres is
   *possible*, but `asyncpg` isn't in `requirements.txt` and nothing tests it.
   SQLite's single-writer model will bottleneck under many concurrent agents.
   Document SQLite as "single-node/dev," add + test an `asyncpg` Postgres path
   for production, and pin dependency versions (currently only lower bounds,
   `requirements.txt`).

8. **WebSocket broadcast has no backpressure.** `broadcast` sends the full raw
   event to every client (`routes.py:31-38`); large events × many dashboards ×
   slow clients can stall the loop. Send a compact summary over WS (the client
   already fetches detail on demand) and/or cap/queue per client.

9. **No structured logging or metrics.** Only `print()` statements
   (`app.py:25`). Add structured logging and expose basic counters
   (events ingested, dropped, validation failures) — useful operationally and as
   a selling point.

### P3 — Polish

- **Retention purge runs only at startup** (`app.py:23`); long-running instances
  never purge again. Schedule it periodically.
- **`delete_all_exceptions` is a footgun** even with auth — require an explicit
  confirmation parameter.
- **No tests.** The storage layer, the `type` discriminator, fingerprint
  coercion, retention, and filters are all easily unit-testable with an in-memory
  SQLite DB. Add pytest + httpx; wire into CI (the CI currently only smoke-tests
  `/stats`).

## Suggested order

1. Auth + locked CORS + body/rate limits (P0 — this service exposes secrets).
2. Per-item ingest resilience + `/healthz` + Alembic (P1).
3. Postgres path + WS backpressure + logging/metrics (P2).
4. pytest suite in CI (P3, ongoing).

## Checklist

- [ ] API-key auth on ingest; auth on dashboard/REST/WS
- [ ] Restrict CORS (or remove it)
- [ ] Max request body size + rate limiting
- [ ] Per-item ingest error handling (don't fail whole batch)
- [ ] `GET /healthz` (used by Docker/CI/orchestrator)
- [ ] Alembic migrations
- [ ] Tested Postgres (`asyncpg`) backend + pinned deps
- [ ] Compact WS payloads / backpressure
- [ ] Structured logging + ingest metrics
- [ ] Periodic retention purge
- [ ] pytest suite (storage, routes, discriminator, retention) in CI
