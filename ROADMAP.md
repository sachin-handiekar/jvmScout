# jvmScout Roadmap

Forward-looking engineering roadmap. For the launch-readiness checklist see
[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md); for architecture see
[ANALYSIS.md](ANALYSIS.md) and [PLAN.md](PLAN.md).

---

## Collector horizontal scalability

**Thesis: the blocker to running multiple collector replicas is in-process
shared state, not the language.** Make the collector stateless + add shared
infrastructure; revisit the language only if profiling later proves Python
can't meet throughput cost-effectively.

### What blocks multi-replica today

| Component (code) | Why it breaks across replicas | Fix |
|---|---|---|
| `ConnectionManager` (WS `/ws/live`) | a replica only knows *its own* connected dashboards; an event ingested by replica A never reaches a dashboard on replica B | shared pub/sub fan-out |
| `RateLimiter` (in-memory per-IP deque) | N replicas → N× the real limit | shared counter, or rate-limit at the edge |
| SQLite | single-file, single-writer — cannot be shared | **Postgres — DONE** (Alembic + `postgresql+asyncpg`) |
| `_periodic_purge` task | every replica runs it (redundant but idempotent) | singleton (cron / leader lock) — low priority |
| `redaction_cache`, `token_store` | per-process TTL caches | acceptable — eventually consistent within a few seconds |

Ingest (→ DB write) and REST reads are already stateless. The only real work to
unlock scale-out is **live fan-out** and **rate limiting**.

### Staged plan (incremental, measure between steps)

1. **Postgres** — DONE. Shared, concurrent store.
2. **Decouple live fan-out via pub/sub.** On ingest, publish the event to a
   channel; every replica subscribes and pushes to its local WS clients. Swap
   only the `ConnectionManager.broadcast` path.
   - **Postgres `LISTEN/NOTIFY`** — no new infra (Postgres already required);
     good to moderate scale. *Recommended first step.*
   - **Redis pub/sub** — cleaner at high fan-out / many replicas; also provides
     the shared rate-limit store.
3. **Rate limiting** — move to the ingress (nginx/Envoy/API gateway) or back it
   with Redis (`INCR` + TTL). Edge limiting is the pragmatic default.
4. **Purge** — make it a singleton (k8s CronJob or a leader lock).
5. **Run N stateless replicas behind a load balancer.** With shared pub/sub, WS
   connections need no sticky sessions. **Then load-test.**
6. **(If ingest throughput becomes the limit)** introduce a queue between ingest
   and persistence (Redis Streams / Kafka): the endpoint enqueues, workers
   persist. Absorbs spikes and keeps the API thin.

### Decision record: keep Python (for now)

A Go/Rust rewrite is **not** recommended at this stage:

- **Errors aren't high-QPS.** Unlike metrics/traces, exceptions are comparatively
  rare and the agent already samples + batches (20/event; FULL→REDUCED→COUNT_ONLY).
  The collector is I/O-bound on DB writes — where async Python is fine.
- **Language doesn't fix architecture.** A single-process Go collector with an
  in-memory client set has the identical fan-out/rate-limit problem.
- **Cost of rewrite** — discards working, tested code (auth, redaction,
  timeseries, migrations) and the FastAPI/SQLAlchemy/Alembic ecosystem.

**Revisit another language only if:**
- profiling shows Python is CPU-bound at the target rate and replica
  count/cost is unacceptable; or
- a single static binary is wanted to match the native-agent distribution; or
- a specific hot path needs it — then write *just* a thin ingest gateway (Go) in
  front of a queue and keep the Python REST/WS/UI backend. Prefer polyglot over a
  full rewrite.

---

## Other tracked work (summary)

Detailed status lives in the working notes; headline remaining items:

- **UI honesty:** mostly resolved — dashboard/Events/Applications hit counts,
  sparklines, and trend now come from a real per-fingerprint time-series
  (`/stats/event-series`); the event-type taxonomy lists only the
  uncaught/caught types the agent produces; Alerts now fire (evaluation on
  ingest + Slack/webhook delivery). Remaining: Integrations are still
  storage-only, and Email/PagerDuty alert channels need real connectors.
- **Security:** mostly done — CSP header on the SPA; dependency scanning
  (pip-audit / npm audit) in CI; multi-tenant **project + role** token scoping
  (ingest/viewer/admin) on data, live updates, **and** alert/redaction/config
  rules. Remaining: a UI for managing projects / minting scoped tokens with a
  role + project picker (the API supports it today).
- **Agent:** done — JNI local-ref audit + per-frame bounding; collector-down
  stress tests. Remaining: the libcurl/POSIX transport is CI-built but not yet
  run end-to-end on Linux/macOS.
- **Scale/ops:** horizontal scale (above); retention size cap (currently
  age-only); Postgres load-test.
- **Distribution/launch:** cut the first tagged release (workflow exists,
  unrun); macOS `.dylib` notarization; agent self-version; aarch64 Linux build;
  end-to-end test in CI; README demo + landing page + benchmarks. (Docker image
  publishing to GHCR is wired — `:edge` on main, `:X.Y.Z`/`:latest` on tags.)

### Done (recent hardening)

Collector auth + per-token auth, locked CORS / headers / rate + size limits,
redaction (agent-side by name + collector-side `redaction_rules`), retention
purge; agent TLS + retry/requeue, perf (bounded sampling LRU, cheaper REDUCED,
metric/inspector caching), BCI depth-leak fix + scope config, modified-UTF-8
JSON, real `environment` dimension, real time-series volume chart; React
dashboard integrated with the collector + live updates; real per-fingerprint
event series behind all hit counts / sparklines / trend; honest event-type
taxonomy; alert engine (evaluation on ingest + Slack/webhook delivery); Alembic
+ Postgres path; CI (agent×3 / bci / collector / frontend / docker), C++ unit
tests, release workflow, CHANGELOG.
