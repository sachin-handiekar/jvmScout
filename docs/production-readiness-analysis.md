# jvmScout — Production Readiness Analysis

**Date:** 2026-07-05
**Scope:** `agent/` (C++17 JVMTI agent), `bci-classfile/` (Java bytecode transformer), `collector/` (Python FastAPI collector), deployment/CI surface.

> **Remediation status (updated 2026-07-05, branch `fix/production-hardening`):**
> all P0 items, P1 items 6–10, and the P2 tier from §9 have been implemented
> and verified. Fixed: C1 (WAL/indexes/batch-txn/SQL-aggregation + asyncpg,
> Alembic revision 0004, Postgres 16 CI job), C2 (block-local dominance capture
> + post-transform verify-and-fallback), C3, C4 (+`occurrences` wire
> field/column), C5, H1, H2 (method cache + sharded sampler), H3 (COUNT_ONLY
> aggregation), H4, H5, H6, H7 (auth-by-default bootstrap token, `?key=`
> removed from HTTP, `api_key_file=`, token-keyed rate limit), H8, H9, M1, M4
> (stale-instance eviction + VACUUM), M7, M9 (/metrics + audit log), M10
> (constraint documented in docs/horizontal-scalability.md; distributed
> backends remain future work). Still open: pre-aggregated rollups table
> (optional at current query cost) and the multi-replica broker/limiter
> backends. Findings below are kept as originally written for the audit trail;
> see git history for the fixes.
**Reviewed as:** an expert JVM/JVMTI engineer assessing readiness for real-world production use with **concurrent users** (many dashboard viewers, many tenants) and **multiple instrumented applications** (many JVMs reporting concurrently).

---

## 1. Executive Summary

jvmScout is a well-structured OverOps-style exception monitor with an unusually clean codebase for its maturity: RAII wrappers for JVMTI/JNI resources, a bounded async send queue, adaptive per-fingerprint sampling, tenant-scoped tokens, server-side redaction, and honest engineering throughout (e.g., the alert engine refuses to claim deliveries it didn't make).

**Verdict: NOT production-ready today for concurrent multi-application deployments.** It is close for a *single team, low-volume, trusted-network* deployment, but there are blocking issues in three areas:

1. **Collector storage throughput** — one SQLite transaction per event, no WAL, no `received_at` index, whole-window scans for every chart, single-process server. This collapses under a handful of chatty JVMs plus a few dashboard users.
2. **BCI path correctness and cost** — the shadow-capture transform can emit verifier-invalid bytecode for real-world classes (VerifyError → application class fails to load), leaks JNI global references on every shadow frame read, and imposes per-instruction capture overhead (with boxing) that is unacceptable on hot paths.
3. **Analytics/alerting correctness** — the agent sends a *cumulative* per-fingerprint `hitCount`, which the collector then *sums across rows* for alert thresholds and sparkline totals, systematically overcounting by orders of magnitude.

Additionally, a full send queue at JVM shutdown can stall `VMDeath` for **up to ~40 minutes** if the collector is unreachable (500 batches × 5 s timeout), which in the real world means "the agent hung our service's shutdown" — the fastest way to get an APM agent banned from a fleet.

The core JVMTI capture path (exception callback → stack walk → locals → async POST) is fundamentally sound and shows real JVMTI expertise (modified-UTF-8 handling, per-frame `PushLocalFrame`, re-entrance guards, capability-degradation fallback). The issues below are fixable without architectural rework, except for the storage layer, which needs PostgreSQL to be a first-class, tested path.

### Findings at a glance

| Severity | Count | Areas |
|---|---|---|
| Critical (blockers) | 5 | storage throughput, BCI verifier safety, shutdown hang, hitCount semantics, BCI global-ref leak |
| High | 9 | data races, ingest fan-out, tenant instance hijack, transport, callback overhead, alert engine, auth surface |
| Medium | 10 | attach path, retention, virtual threads, path handling, observability gaps |
| Low | 6 | polish items |

---

## 2. Architecture Recap (as reviewed)

```
Target JVM ── JVMTI agent (.dll/.so/.dylib)
   │   Exception callback → filters → fingerprint → Sampler (FULL/REDUCED/COUNT_ONLY)
   │   → StackWalker (+ locals via debug info or BCI shadow) → JSON → AsyncQueue
   │   AsyncQueue: bounded 10k, batches of 20, 2s flush, 3 retries, requeue-on-fail
   │   Transport: WinHTTP (Windows) / libcurl (POSIX), new connection per POST
   │
   └── optional BCI: ClassFileLoadHook → BciTransformer (java.lang.classfile)
       injects __JvmtiShadow.enter/capture/exit into app methods

Collector (FastAPI, single uvicorn worker)
   POST /collector (batch) → redaction → pydantic validate → 1 INSERT+COMMIT per event
   → WebSocket fan-out (per-project) → fire-and-forget alert evaluation
   Storage: SQLite (aiosqlite) default; Postgres possible via env but not installed/tested
   Multi-tenancy: hashed project/role tokens; master key; project-scoped queries
```

---

## 3. Critical Findings (release blockers)

### C1. Collector storage cannot sustain concurrent agents — SQLite, per-event commits, no indexes on the hot path

- `storage.store_exception()` (`collector/src/collector/storage.py:120`) performs **one INSERT and one COMMIT per event**, even though agents deliver batches of 20. On SQLite every commit is an fsync; realistic ceiling is a few hundred events/sec on good disks, far less on network volumes — and that's before dashboard reads contend for the same single-writer database.
- The engine is created with defaults (`storage.py:83`): **no WAL mode, no `busy_timeout`, no pool tuning**. Under concurrent read+write, aiosqlite will raise `database is locked` errors; readers block the writer and vice versa.
- **`received_at` has no index**, yet it is the filter for `timeseries()`, `event_series()`, `count_occurrences()` (alerts) and `purge_old_records()` — all full table scans, repeated per dashboard refresh and per alert evaluation.
- `timeseries()`/`event_series()` (`storage.py:287,322`) fetch **every row in the window into Python** and bucket in-process. A 90-day window (`hours=2160` is allowed by the API) over a busy fleet loads millions of rows per chart render, per user.
- Postgres is mentioned in `requirements.txt` comments, but `asyncpg` is not installed, there are **no Alembic migrations** (schema is `create_all()` only, despite alembic being a dependency), and nothing in CI tests the Postgres path.
- The server runs as a **single uvicorn worker** (`__main__.py`) — one Python process, one event loop, one GIL for JSON parsing/serialization of 5 MiB bodies.

**Impact:** with, say, 20 JVMs in an exception storm (easily 1–5k events/sec offered load) plus 5 dashboard users, ingest latency explodes, agents' queues fill and drop, charts time out, and SQLite lock errors surface as 500s.

**Fix (ordered):**
1. Batch the entire ingest payload into **one transaction** (`session.add_all()` + single commit).
2. Enable WAL + `busy_timeout` on connect for SQLite (`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000` via an `event.listens_for(engine.sync_engine, "connect")` hook).
3. Add indexes: `received_at`, and composite `(project_id, received_at)`, `(fingerprint, received_at)`.
4. Move bucketing into SQL (`GROUP BY strftime(...)` / `date_trunc`), and cap `hours × expected-rows`.
5. Make PostgreSQL the documented production backend: ship `asyncpg`, real Alembic migrations, and a CI job that runs the test suite against Postgres.
6. Consider a pre-aggregated `fingerprint_rollups` table (fingerprint, bucket, count) maintained at ingest, so charts and alert thresholds never scan raw events.

### C2. BCI shadow transform can produce verifier-invalid bytecode → application classes fail to load

`ShadowCodeTransform` (`bci-classfile/src/main/java/ShadowCodeTransform.java`) learns local slots by watching `StoreInstruction`s **in linear bytecode order**, then before *every* throw-capable instruction re-emits loads of **all slots seen so far** (`accept()`, lines 78–95).

Bytecode is not linear. Two real-world failure shapes:

1. **Not-definitely-assigned slots:** a store inside one branch (or later in a loop body) is "known" when the transform reaches an instruction on a path where that slot was never assigned. Emitting `aload`/`iload` of an unassigned slot fails verification (`VerifyError`) — and because the *transform* succeeded, the agent hands the broken bytes to the JVM and the **application class fails to load**. The try/catch in `BciTransformer` cannot save you; the error happens after transform, in the verifier.
2. **Slot reuse with different types:** javac routinely reuses slot numbers across disjoint scopes (`int i` then `String s` in sibling blocks). The map keeps the *latest linear* `TypeKind`, so an `aload` can target a slot that holds an `int` (or the second half of a `long`) at that point → `VerifyError`.

There is a second, independent problem even when verification passes: **capture cost**. Before every `invoke`, `getfield/putfield`, and every array load/store, the transform emits one static call *per known local*, boxing every primitive (`Integer.valueOf`, etc.). In a hot loop with 8 live locals, that's 8 extra calls + up to 8 allocations *per array access per iteration*. This is a 10–100× slowdown plus severe allocation/GC pressure for exactly the code you least want to perturb. The `__JvmtiShadow` write path itself (4 `ThreadLocal.get()`s per operation) adds more.

**Fix:**
- Correctness: derive definite-assignment per instruction (a small dataflow pass over basic blocks, or use the `CodeModel`'s `StackMapTable` frames to know live slot types at each offset) — never emit a load the verifier can't prove. Short-term mitigation: run the transformed bytes through a verifier check in-process (`ClassFile.verify()`) and fall back to the original bytes on any error.
- Cost: capture **only at method entry** (parameters) and optionally at a low, fixed number of "checkpoint" sites; or gate per-instruction capture behind an explicit `bci_hot=false` default. Document the overhead honestly.
- Until both are done, `bci=true` must be labeled **experimental — not for production** in the README (it currently reads as a peer feature).

### C3. JVM shutdown can hang for minutes to ~40 minutes when the collector is down

`vm_death` → `AsyncQueue::stop()` → `join()`, and the worker's shutdown path (`async_queue.cpp:82–115`) drains the **entire remaining queue**, attempting one `transport_->send()` per batch. With the default 10,000-event queue, batch size 20 and 5 s HTTP timeout (`config.h:18`): 500 batches × 5 s = **~42 minutes** blocking `VMDeath` — i.e., blocking the host application's exit. Kubernetes will SIGKILL the pod long before, but plain services, CLI jobs, and CI runners will just hang.

Also: batches that fail during drain are silently discarded **without incrementing `dropped_`**, and `vm_death` reads `dropped()` *before* `stop()`, so drain-time losses are never reported.

**Fix:** add a hard shutdown deadline (e.g., 3–5 s total): after the first failed send while stopping, drop the remainder, count them, and log once. Read `dropped()` after `stop()`.

### C4. `hitCount` semantics are wrong end-to-end — alerts and charts overcount by orders of magnitude

The agent's `Sampler::decide()` returns `st.total` — the **cumulative lifetime count** for the fingerprint (`sampling.cpp:52`, reset only on LRU eviction) — and serializes it as `hitCount` on every event.

The collector then treats `hit_count` as a **per-event delta**:
- `count_occurrences()` (`storage.py:384`) does `SUM(hit_count)` over a window to evaluate `volume_threshold` alerts;
- `event_series()` (`storage.py:362-364`) sums it into totals and sparkline buckets.

If one fingerprint throws 1,000 times, the stored rows carry `hitCount = 1, 2, 3, …, 1000`, and a window sum reports ~500,500 occurrences instead of 1,000. Volume alerts fire wildly early; dashboard "hits" numbers are fiction.

**Fix:** send both fields explicitly — `hitCount` (cumulative, for display as "seen N times") and `windowDelta`/implicit `1` per event — and make the collector sum **deltas** (or simply `COUNT(*)` weighted by nothing, since COUNT_ONLY events are also individual rows today). Decide once, document the wire contract in NOTES.md, and add a regression test.

### C5. JNI global-reference leak on every BCI shadow frame read

`BciShadow::read_frame()` (`bci_shadow.cpp:66`) constructs a **transient** `ObjectInspector(2)` per call. `ObjectInspector::ensure_init()` creates **six `NewGlobalRef`s** (String/Number/Boolean/Character/Class/System) that are never released — `ObjectInspector` has no destructor (`object_inspector.h`). Every captured frame that falls back to shadow locals therefore leaks 6 global refs plus repeats `FindClass`/`GetMethodID` work the cache exists to avoid.

JVMs cap global references (HotSpot historically ~65k before `-XX:+...` era; modern VMs degrade or fatal-error with `global reference table overflow`). A busy service on the BCI path will hit this in hours.

**Fix:** pass the long-lived `ctx->inspector` into `read_frame` (it's already available at the call site in `stack_walker.cpp:96`), and give `ObjectInspector` an explicit `release(JNIEnv*)` called from `Agent_OnUnload` for hygiene.

---

## 4. High-Severity Findings

### H1. Data races on `AgentContext` fields (C++ UB, visibility bugs)

- `ctx->started` is a plain `bool` written by the `VMInit`/`VMDeath`/attach threads and read concurrently by every exception callback and `ClassFileLoadHook` (`agent_context.h:35`, `agent_main.cpp:26,51`, `exception_handler.cpp:217`, `bci_engine.cpp:112`). This is a data race — undefined behavior in the C++ memory model, and in practice a visibility problem (a thread may never observe `started=true/false`).
- `ctx->bci_transformer_class` / `bci_transform_method` are written in `vm_init` and read from arbitrary class-loading threads with no synchronization or release/acquire pairing.

**Fix:** make `started` a `std::atomic<bool>` (release store, acquire load) and publish the BCI method IDs before the `started` release store (piggyback on its ordering), or make them atomics too. Cheap, mechanical, removes TSan findings that would otherwise mask real bugs later.

### H2. Exception callback does non-trivial JVMTI/JNI work on *every* throw, pre-sampling, behind one global mutex

For **every** exception thrown anywhere in the JVM (including control-flow exceptions inside frameworks), the callback (`exception_handler.cpp:209`) performs: `GetObjectClass` + `GetClassSignature` (alloc+dealloc), `GetMethodDeclaringClass` + another signature fetch, `GetMethodName`, a full **line-number-table allocation and scan** (`resolve_line_number`), and then `Sampler::decide()` which takes a single global `std::mutex` shared by all threads (`sampling.cpp:32`), doing string hashing and LRU list splicing under the lock. Only *after* all that does COUNT_ONLY demotion apply — and even COUNT_ONLY events still call `getMessage()` (arbitrary user Java code) and enqueue a JSON event.

Two further structural costs: merely enabling `can_generate_exception_events` forces HotSpot onto slow exception-delivery paths JVM-wide, and `can_access_local_variables` inhibits escape analysis/scalar replacement globally. That's the price of the product category — but it means the *callback itself* must be as close to free as possible, and today it isn't.

**Impact:** exception-heavy workloads (some Spring/Hibernate stacks throw thousands/sec as control flow) will see measurable p99 regression and cross-thread contention on the sampler mutex; the deny-filters help but only after two signature lookups have already happened.

**Fix:**
- Cache `jmethodID → (name, class signature, deny-verdict, line table)` in a lock-free/sharded map — method identity is stable for the life of a class.
- Shard the sampler by fingerprint hash (e.g., 16 stripes) or use per-thread counters merged lazily.
- For COUNT_ONLY, skip `getMessage()` and enqueue nothing per-event: keep an in-agent counter and flush one summary event per fingerprint per flush interval (this also fixes the row-flood in C1/C4).
- Add a global circuit breaker: if throw rate exceeds N/sec, drop to COUNT_ONLY globally and log once.

### H3. Every event becomes a stored row — no agent-side aggregation for COUNT_ONLY

Related to H2/C4 but worth its own line: a single hot fingerprint at 1k throws/sec generates 1k enqueued events/sec (drops start at 10k queue), ~50 POSTs/sec, and 1k DB rows/sec of near-identical COUNT_ONLY records. The sampling tiers reduce *payload size*, not *event count*. Real-world APM agents aggregate counts client-side; jvmScout must too, or a single hot loop saturates the entire pipeline.

### H4. Cross-tenant JVM-instance hijack in `store_agent_start`

`storage.store_agent_start()` (`storage.py:149`) looks up the existing row **by `instance_id` alone** and then overwrites `raw_json` and reassigns `project_id` to the caller's project. Any tenant (or misconfigured agent) that sends an `agent_start` with another tenant's `instance_id` **steals/overwrites that instance record**, moving it into its own project. Instance IDs are agent-self-reported UUIDs, so collision is trivially forgeable.

**Fix:** scope the lookup by `(instance_id, project_id)`; treat a cross-project match as a new row (or reject). Never reassign `project_id` on update.

### H5. Transport: new TCP/TLS connection per batch, no proxy support, `curl_global_init` hazards

- Both transports (`winhttp_transport.cpp:41`, `curl_transport.cpp:24`) build a **fresh session/connection per POST**. At 2 s flush that's a full TCP+TLS handshake every 2 s per JVM; across a fleet, that's needless collector CPU (TLS accepts) and agent latency. Reuse the session/easy handle (the queue is single-threaded, so a member handle with keep-alive is safe).
- WinHTTP is opened with `WINHTTP_ACCESS_TYPE_NO_PROXY` — corporate environments with mandatory egress proxies cannot ship events at all. Use `WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY_CONFIG` or honor env config.
- `curl_global_init()`/`curl_global_cleanup()` in the transport constructor/destructor (`curl_transport.cpp:20,22`): `curl_global_init` is **not thread-safe** and must not race with a host application's own libcurl usage — and an agent lives inside someone else's process. Calling `curl_global_cleanup` at unload can yank libcurl state out from under the host app. Init once in `Agent_OnLoad` (single-threaded context), and **never** call global cleanup from an agent.
- No `Retry-After`/429 handling; a 4xx (e.g., 401 bad token) is retried identically to a 5xx, then requeued — an agent with a revoked token will spin retrying forever. Treat 4xx (except 408/429) as permanent drops with one log line.

### H6. Alert engine: unbounded task fan-out, per-event table scans, and SSRF surface

- `alerts.schedule_evaluation()` creates a **fire-and-forget task per ingested exception** (`alerts.py:267`). Each evaluation runs `fingerprint_row_count()` (indexed, OK) and, for volume rules, `count_occurrences()` — an unindexed window scan (C1). Under storm load this is thousands of concurrent tasks × table scans, on the same event loop serving ingest. Add a bounded work queue (e.g., `asyncio.Queue(maxsize=…)` + single consumer) and evaluate volume rules on a timer, not per event.
- Webhook/Slack destinations are arbitrary URLs POSTed **from the collector's network position** (`alerts.py:186`). In multi-tenant mode, any project admin can aim the collector at internal endpoints (`http://169.254.169.254/…`, internal services) — classic SSRF. Validate destinations (scheme, deny link-local/RFC1918 by default with an allowlist opt-out) and consider egress-proxying alert delivery.
- `new_event` trigger fires when `fingerprint_row_count() <= 1` — races with concurrent ingest of the same fingerprint (two rows insert, both evaluate, both may see count ≤ 1 → duplicate alerts) and re-fires after retention purges old rows. Acceptable-ish, but document it.

### H7. Auth and token-handling weaknesses

- **Auth is off by default** and everything is open (`security.py:159`, warned at startup). Fine for local dev, but the Docker quickstart publishes 0.0.0.0:8080 with no key — the default experience is an open collector full of PII-bearing local variables. Consider generating a random master key on first boot and printing it once, instead of open-by-default.
- Tokens are accepted via `?key=` query string (`security.py:143`) — keys land in access logs, browser history, and proxies. Keep it for the WS handshake if needed (headers are awkward in browsers), but strip it from HTTP endpoints, or at minimum redact it from logs.
- The agent's `api_key` rides the `-agentpath:` option string — visible in `ps`/Task Manager/`/proc/*/cmdline` on every host. Support reading the key from an env var or file (`api_key_file=`).
- `resolve_principal` linearly `compare_digest`s the candidate against every stored hash (`security.py:117`). Constant-time comparison of *hashes* is unnecessary (they're not secret-equality oracles) — a dict lookup by hash is O(1) and equally safe. Cosmetic now, matters at hundreds of tokens.
- Rate limiter keys on the direct peer IP (`security.py:233`): behind any LB/ingress every agent shares one bucket (mutual starvation), and with no `X-Forwarded-For` handling it can't be fixed by config. Key on the token (principal) instead — it's already authenticated. Also the per-client deques dict is unbounded (slow memory growth from IP churn).

### H8. Shadow store retains strong references to application objects

`__JvmtiShadow.exitMethod()` only decrements the depth counter — it does **not** clear the frame's `Object[]` slots, and the native reader never calls `clearFrame()`. Captured objects (potentially large request/response graphs) stay strongly referenced in the `ThreadLocal` arrays until that thread happens to re-enter an instrumented method at the same depth and overwrite the slots. On pooled threads that park after a deep call chain, this pins arbitrary object graphs indefinitely — a memory "leak" that will show up in heap dumps with jvmScout's name on it. Clear slots in `exitMethod()` (or null them in the catch-all handler).

Also: `MAX_DEPTH × MAX_SLOTS` = 64×32 refs + names + types per thread ≈ tens of KB per thread — and per **virtual thread** under Loom, where ThreadLocals are the canonical scalability anti-pattern. Millions of virtual threads → GBs. At minimum, document incompatibility with virtual threads; ideally key shadow frames off carrier-thread scoped structures or `ScopedValue`.

### H9. WebSocket fan-out serializes all clients and re-sends under one lock… without one

`ConnectionManager.broadcast()` (`routes.py:51`) snapshots clients under the lock, then awaits `send_json` **sequentially per client**. One slow dashboard (e.g., laptop on VPN with a full TCP window) delays event delivery to every other client and back-pressures ingest (broadcast is awaited inside the ingest handler). Send concurrently with per-client timeouts (`asyncio.gather` + `wait_for`), or queue per client and drop-on-full.

---

## 5. Medium-Severity Findings

**M1. Dynamic attach (`Agent_OnAttach`) is half-wired** (`agent_main.cpp:168`). `VMInit` never fires after attach, so: `bci_engine::initialize` never runs (bci silently dead), and — more importantly — `build_agent_start_event` is never sent, so the attached JVM **never appears in the dashboard's instance list**; its exceptions arrive orphaned. Call the init work directly in `OnAttach` (with a `GetPhase()` check).

**M2. `VMDeath` / in-flight callback race.** JVMTI does not join in-flight event callbacks before delivering `VMDeath`; `vm_death` sets `started=false` and stops the queue while an exception callback on another thread may still be mid-capture holding `ctx->queue`. Window is tiny and `enqueue` on a stopped queue is safe here, but `Agent_OnUnload`'s `delete ctx` (`agent_main.cpp:182`) would be a use-after-free if the library unloads early. Acceptable risk on HotSpot in practice; document the assumption or add a capture-in-progress refcount.

**M3. Sampler LRU eviction resets `total`** — an evicted-and-recreated fingerprint restarts `hit_count` at 1, so "seen N times" silently rewinds. With C4's fix (deltas), this mostly stops mattering; otherwise persist totals collector-side only.

**M4. `store_exception` retention/purge gaps.** `purge_old_records` deletes only `exceptions` (fine) but SQLite never shrinks (`VACUUM`/`auto_vacuum` unset) — disk usage is a ratchet. `jvm_instances` rows live forever (stale instances accumulate in the UI). Add `last_seen` touch + staleness eviction.

**M5. SPA fallback path check has a prefix bug** (`app.py:188–194`): `candidate.startswith(ui_dir)` with no trailing separator lets `/…/ui-sibling` pass if such a directory existed next to `ui/`; use `os.path.commonpath` or append `os.sep`. Low exploitability today, cheap to fix.

**M6. Ingest body limit vs. agent batch sizing mismatch.** Agent batches 20 FULL events with 100 frames × locals each; a pathological-but-legit batch can exceed the collector's 5 MiB cap → the **whole batch** 413s, is retried 3× identically, then requeued (head-of-line blocking: the poison batch returns to the front and fails forever until 10k newer events push it out via drops). Agent-side: cap serialized event size and split batches on 413; collector-side: consider per-event acceptance (it already returns `accepted/failed` per item — but only after parsing).

**M7. `console=true` is the default** (`config.h:16`): every captured event printf+fflushes to the host app's stdout. Production JVMs log to collected stdout; this both spams the app's logs and adds synchronous I/O to the exception path. Default should be `false`.

**M8. Filters are O(patterns × substring) per throw** with case-sensitive raw `find` over ~30 default deny patterns (`filters.cpp:4`). Combined with H2's caching this becomes irrelevant; standalone it's another per-throw cost. Also substring (not prefix) matching means `deny=Error` would nuke far more than intended — document or switch to prefix semantics.

**M9. No collector observability.** No `/metrics` (Prometheus), no ingest-rate/queue-depth/DB-latency counters, no structured audit log for admin actions (token minting, delete-all). You cannot operate what you cannot see; this is table stakes for a monitoring product.

**M10. `_RedactionCache`/`_RuleCache`/`TokenStore` are per-process only** — fine today (single worker), but they hard-block the "scale out with multiple workers/replicas" story together with the in-memory `ConnectionManager` and `RateLimiter`. The (uncommitted) horizontal-scalability doc should gate any multi-worker deployment.

---

## 6. Low-Severity / Polish

- `AsyncQueue::send_with_retry` while stopping makes "one last attempt" per batch — that's the C3 hang; after C3's deadline fix, also make the final attempt count toward `dropped_`.
- `exception_type_slash` result for array/primitive signatures passes through raw (`signature_to_slash` only strips `L…;`) — fingerprints for e.g. hidden classes/lambdas (`Lcom/foo/Bar$$Lambda+0x…;`) churn per JVM run, bloating the sampler LRU and fingerprint cardinality. Consider normalizing lambda/proxy/generated-class name suffixes.
- `iso8601_now()` uses `%lld` format assumptions fine, but two near-identical time formatters exist (`exception_handler.cpp`, `system_info.cpp`) — consolidate.
- `insert_config` trusts client-supplied `id`/`created_at` (`storage.py:471`) — a project admin can collide `entity_id`s (no uniqueness constraint on `(table, entity_id)`); duplicates then behave oddly in update/delete (first match wins). Add a unique index.
- FNV-1a-64 fingerprint is fine for this cardinality; document the (remote) collision consequence: two errors sharing a sampler budget/dashboard row.
- `docker-compose.yml` / Dockerfile run as root; add a non-root `USER` and read-only FS where possible.

---

## 7. Concurrency & Multi-Application Readiness Scorecard

| Concern | Verdict | Notes |
|---|---|---|
| Agent: many app threads throwing concurrently | ⚠️ Mostly correct, contended | Callback is thread-safe (thread-local guards, per-frame JNI frames, RAII), but sampler mutex + per-throw JVMTI work serialize hot paths (H2). `started` race (H1). |
| Agent: safe cohabitation in host process | ⚠️ | curl global init/cleanup (H5), stdout spam (M7), no proxy support (H5), shutdown hang (C3). |
| Many JVMs → one collector | ❌ | Per-event commits, no WAL, no indexes, single worker (C1); every throw = a row (H3). |
| Concurrent dashboard users | ❌ | Whole-window scans per chart per user (C1); sequential WS broadcast (H9). |
| Multi-tenancy isolation | ⚠️ Good design, one hole | Token-scoped queries are consistently applied; instance hijack (H4) and SSRF-via-alerts (H6) break the boundary. |
| Data correctness under load | ❌ | hitCount summing (C4); alert races (H6). |
| BCI in production | ❌ | Verifier safety (C2), global-ref leak (C5), retention (H8), overhead (C2). |
| Horizontal scale-out | ❌ by design (today) | In-memory caches/limiter/WS registry are single-process (M10). |

---

## 8. What Is Genuinely Good (keep it)

- **JVMTI/JNI hygiene:** `JvmtiString`/`JniLocalFrame` RAII everywhere, per-stack-frame `PushLocalFrame(16)` to survive deep stacks under `-Xcheck:jni`, careful `Deallocate` of local-variable tables, capability-degradation retry in `add_capabilities`, `GetLocal*` error tolerance for slots the JIT dropped.
- **Modified UTF-8 → JSON `\u` escaping** (`json_utils.cpp`) — most homegrown agents get this wrong and produce collector-breaking JSON on the first non-ASCII exception message.
- **Re-entrance guards** on both the exception pipeline and the class-file transform (`t_in_capture`, `t_in_transform`) — the classic infinite-recursion traps are covered.
- **Safe object rendering:** `toString()` only on non-overridable JDK value types; strings truncated; primitive arrays summarized, never dumped.
- **Adaptive sampling design** (FULL/REDUCED/COUNT_ONLY + periodic resample + bounded LRU) is the right shape; it needs sharding and client-side count aggregation, not redesign.
- **Collector security posture** for its size: hashed tokens shown once, role/project scoping applied uniformly through `Principal.scope`, server-side redaction *before* persistence/broadcast, hashed-inline-script CSP, body-size caps, honest alert delivery semantics.
- **Tests exist and are real:** 55 collector tests including tenancy isolation; agent unit tests; 3-OS CI matrix building the native library.

---

## 9. Prioritized Remediation Plan

**P0 — before any production pilot (agent must be harmless):**
1. Shutdown drain deadline (C3) — small, isolated change.
2. `std::atomic` for `started` + BCI publish ordering (H1).
3. Fix `hitCount` wire semantics + collector summing (C4).
4. BCI: mark experimental, add post-transform verify-or-fallback (C2 mitigation); fix global-ref leak (C5) and `exitMethod` frame clearing (H8).
5. `console=false` default (M7); treat 4xx as permanent send failures (H5).

**P1 — before multi-application production (collector must survive load):**
6. Ingest: one transaction per batch; WAL + busy_timeout; `received_at`/composite indexes; SQL-side bucketing (C1).
7. Agent-side COUNT_ONLY aggregation + method-metadata caching + sharded sampler (H2, H3).
8. Fix instance hijack (H4); bound alert task fan-out; SSRF guards on alert destinations (H6).
9. Concurrent WS broadcast with timeouts (H9). Rate-limit by principal, not peer IP (H7).
10. Transport keep-alive; proxy support; move curl global init to OnLoad, drop global cleanup (H5).

**P2 — before selling it as a product:**
11. First-class PostgreSQL: asyncpg shipped, Alembic migrations, CI against Postgres (C1).
12. Pre-aggregated rollups table for charts/alerts; retention with vacuum + stale-instance eviction (M4).
13. `/metrics`, ingest/queue/DB gauges, admin audit log (M9).
14. Auth-by-default bootstrap key; remove `?key=` from HTTP; `api_key_file=` for agents (H7).
15. Complete `Agent_OnAttach` (agent_start + bci init) (M1). Verifier-correct BCI capture via dataflow/StackMapTable (C2 full fix).
16. Multi-worker/replica story: shared cache/limiter/WS bus or documented single-instance constraint (M10).

**Suggested validation gates before declaring production-ready:**
- Load test: 50 simulated agents × 200 events/sec sustained for 1 h, p99 ingest < 250 ms, zero lock errors, zero drops below queue cap.
- Chaos: kill collector for 10 min under load → agents recover, bounded drops, JVM shutdown during outage completes < 5 s.
- Agent overhead benchmark published in README: throw-heavy microbenchmark + a Spring PetClinic-style macro test, with/without agent, with/without BCI.
- Soak: 72 h with `-Xcheck:jni` and a global-ref counter — flat lines required.
- Multi-tenant abuse tests: forged `instance_id`, cross-project token attempts, SSRF destinations.

---

*Report generated from a full read of `agent/src`, `agent/include`, `bci-classfile/src`, and `collector/src` at the current `main` (82831fb). File/line references are to that revision.*
