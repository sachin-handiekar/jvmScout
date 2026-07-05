# Horizontal Scalability — Design Options

How to run the jvmScout collector as **multiple stateless replicas** behind a
load balancer. This is a design/options document; no behavior has changed yet.

## The problem

Three pieces of in-process state prevent running >1 collector replica:

| Component (code) | Why it breaks across replicas | Severity |
|---|---|---|
| `ConnectionManager` — WS `/ws/live` (`api/routes.py`) | a replica only knows *its own* connected dashboards; an event ingested by replica A never reaches a dashboard on replica B | **blocking** |
| `RateLimiter` — in-memory per-token deque (`security.py`) | N replicas → N× the real limit | **blocking** |
| `_periodic_purge` (`app.py`) | every replica runs it (redundant but idempotent) | low |
| `redaction_cache`, `token_store` | per-process TTL caches | acceptable (eventually consistent within seconds) |

Already stateless: ingest→DB writes, all REST reads, Postgres store (Alembic +
`postgresql+asyncpg`).

## Design principle: pluggable backends, in-process default

Both fixes are introduced behind a small interface with a **default in-process
implementation that preserves today's exact behavior**. The distributed backend
activates *only* when configured (e.g. `COLLECTOR_REDIS_URL`). Consequences:

- Single-replica deployments, local dev (SQLite), and the existing test suite
  are **unchanged** — zero config, zero new dependencies required.
- Scaling out is an opt-in operational choice, not a code fork.

### Event broker seam

`ConnectionManager.broadcast(...)` is called in exactly two places, both in the
ingest handler (`api/routes.py` `ingest()`): the `agent_start` and `exception`
branches. That is the single seam to route through a broker.

```
            ┌─────────────┐   publish(msg, project_id)   ┌──────────────┐
ingest() ──▶│ EventBroker │ ───────────────────────────▶ │  transport   │
            └─────────────┘                               │ (in-proc /   │
                  ▲                                        │  redis / pg) │
                  │  deliver(msg, project_id)              └──────┬───────┘
            ┌─────┴────────────────┐                              │
            │ ConnectionManager    │ ◀────────────────────────────┘
            │ ._local_fan_out(...) │   (subscriber loop, per replica)
            └──────────────────────┘
```

- `EventBroker.publish(message, project_id)` — called by ingest.
- `ConnectionManager._local_fan_out(message, project_id)` — the current
  project-scoped send loop, renamed from today's `broadcast` body.
- In-process broker: `publish` calls `_local_fan_out` directly (identical to
  today).
- Distributed broker: `publish` writes to the transport; a per-replica
  subscriber task reads from the transport and calls `_local_fan_out`. The
  publishing replica delivers to its own clients via the same subscriber path
  (so there is one delivery code path, not two).

The per-project scoping (`principal.is_master or principal.project_id ==
project_id`) stays **on the local fan-out**, so the wire message must carry
`project_id`. (Master-key dashboards still see all projects.)

### Rate-limiter seam

`RateLimiter.allow(client) -> bool` (`security.py`) is already a clean
interface, called once in `ingest()`. Keep the signature; swap the
implementation by config.

## Option A — Redis (recommended)

One dependency (`redis.asyncio`, shipped with modern `redis-py`) solves **both**
bottlenecks.

**WS fan-out** — Redis Pub/Sub:
- `publish`: `PUBLISH jvmscout:events <json>` where the JSON is
  `{"project_id": ..., "message": {...}}`.
- Each replica runs one subscriber task (started in `lifespan`) that
  `SUBSCRIBE jvmscout:events` and calls `_local_fan_out` for each message.
- No payload-size limit of practical concern (Redis value limit is 512 MB; our
  events are KB-scale).

**Rate limiting** — shared fixed-window counter:
- Key `rl:<client-ip>:<epoch-minute>`, `INCR` then `EXPIRE 60` on first hit;
  reject when the value exceeds `rate_limit_per_min`. (Atomic via a tiny Lua
  script or `INCR` + conditional `EXPIRE`.)
- All replicas share the same counter → the configured limit is the *global*
  limit.

**Config:** `COLLECTOR_REDIS_URL` (e.g. `redis://redis:6379/0`). Unset → both
fall back to the in-process implementations.

**Docker:** add a `redis` service to `docker-compose.yml`; set
`COLLECTOR_REDIS_URL` on the collector service.

**Pros:** least code; one mechanism for both problems; no payload limit; highest
ceiling; standard ops component.
**Cons:** a Redis server to run and operate.

## Option B — Postgres `LISTEN/NOTIFY` (no new infra)

Reuses the Postgres instance already required for multi-replica (shared store).

**WS fan-out** — signal-only, because `NOTIFY` has an **~8 KB payload limit** and
our events (full stack + locals) can exceed it:
- `publish`: after the row is stored, `NOTIFY jvmscout_events,
  '<kind>:<row_id>:<project_id>'` — an identifier, not the event.
- Each replica holds one dedicated `asyncpg` connection (separate from the
  SQLAlchemy pool) running `LISTEN jvmscout_events`; on a notification it
  **re-reads the event from the DB** (`storage.get_exception(...)`) and calls
  `_local_fan_out`.
- Cost: one extra DB read per event *per replica*. `agent_start` needs a small
  reconstruct/re-read path too (today it broadcasts the raw payload).

**Rate limiting** — **not** solved cheaply by Postgres. Recommended: do
rate-limiting at the **edge** (nginx / Envoy / API gateway `limit_req`) and keep
the in-memory limiter as a per-replica safety net. Document this; the in-memory
limiter becomes advisory once you scale out.

**Config:** reuse `COLLECTOR_DB_URL` when it is a `postgresql+asyncpg://` URL;
enable the listener via a flag (e.g. `COLLECTOR_BROKER=postgres`). SQLite dev →
in-process (LISTEN/NOTIFY is Postgres-only).

**Pros:** no new infrastructure beyond the Postgres you already run.
**Cons:** more code; extra DB read per event per replica; doesn't address
rate-limiting (push to the edge); dedicated listener connection lifecycle to
manage; lower ceiling than Redis pub/sub.

## Option C — Pluggable, both; Redis first

Build the `EventBroker` and `RateLimiter` as clean interfaces with **in-process +
Redis** implementations now, and leave a documented seam (the same `publish` /
`_local_fan_out` boundary) for a Postgres `LISTEN/NOTIFY` broker later.

**Pros:** maximum flexibility; backend chosen by deployment, not by code; easy to
add Postgres or a queue (Kafka/Redis Streams) backend later without touching
ingest.
**Cons:** a little more upfront abstraction than Option A.

## Recommendation

**Option A (Redis)**, or **Option C** if you want the pluggable seam from day one
(C is A plus thin interfaces — small extra cost, and it matches the "revisit
language/queue later" stance in [ROADMAP.md](../ROADMAP.md)). Redis cleanly
covers *both* bottlenecks with the least code and no payload-size caveats;
Postgres `LISTEN/NOTIFY` (Option B) avoids new infra but leaves rate-limiting to
the edge and adds a re-read per event.

## Out of scope / follow-ups (any option)

- **Purge singleton** — make `_periodic_purge` a leader-elected/cron singleton
  (k8s `CronJob` or an advisory lock) instead of running in every replica. Low
  priority (idempotent today).
- **Sticky sessions** — not needed once fan-out is shared; WS clients can land on
  any replica.
- **Load test** — validate the chosen backend under target ingest + dashboard
  fan-out before declaring scale-ready ([ROADMAP.md](../ROADMAP.md) staged plan,
  step 5).
- **Ingest queue** — only if ingest throughput becomes the limit: enqueue
  (Redis Streams / Kafka) and persist in workers ([ROADMAP.md](../ROADMAP.md)
  step 6).

## Implementation outline (for the chosen option, later)

1. New `collector/src/collector/broker.py`: `EventBroker` interface +
   `InProcessBroker` + the chosen distributed broker; module-level `broker`
   selected from config.
2. `ConnectionManager`: rename the `broadcast` body to `_local_fan_out`; the
   subscriber task calls it. Wire the subscriber start/stop into `app.py`
   `lifespan`.
3. `api/routes.py` `ingest()`: replace the two `manager.broadcast(...)` calls
   with `broker.publish(...)`.
4. `security.py`: extract a `RateLimiter` interface; add the shared backend;
   select by config. Keep `allow()` signature.
5. `config.py`: add `COLLECTOR_REDIS_URL` (and/or `COLLECTOR_BROKER`).
6. `requirements.txt`: add `redis>=5` (Option A/C only).
7. `docker-compose.yml`: add the `redis` service (Option A/C only).
8. Tests: a broker-level test (publish on one broker instance → delivered to a
   fake client) and a shared-rate-limit test; existing tests stay green because
   the default is in-process.
