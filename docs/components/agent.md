# Component Review — Native JVMTI Agent (`agent/`)

C++17 shared library loaded into the target JVM via `-agentpath`. Hooks every
exception, captures context (stack, locals, cause chain, JVM metrics), and ships
batched JSON to the collector over HTTP. ~2,000 LOC, cross-platform
(WinHTTP / libcurl behind `ITransport`, OS shims behind `platform.h`).

## What's already strong

- **Crash-safety invariant is honored.** Every callback body is wrapped in
  `try/catch(std::exception&)` + `catch(...)` (`src/exception_handler.cpp:276`),
  a `thread_local` reentrance guard prevents recursive capture
  (`src/exception_handler.cpp:20`), and RAII (`JvmtiString`, `JniLocalFrame`)
  manages JVMTI/JNI lifetimes.
- **Clean dependency injection.** `AgentContext` owns transport, filters,
  inspector, queue, and sampler — easy to test and swap.
- **Non-blocking pipeline.** Capture enqueues; a background `AsyncQueue` batches
  (20/batch, 2 s flush, 10k cap with a drop counter) so the throwing thread never
  does I/O (`src/async_queue.cpp`).
- **Adaptive sampling** bounds overhead under exception storms
  (`src/sampling.cpp`).

## Production-readiness gaps

### P0 — Correctness / data-loss / safety

1. **No TLS. HTTP is hardcoded.** `curl_transport.cpp:60` hardcodes `http://`;
   `winhttp_transport.cpp` never sets `WINHTTP_FLAG_SECURE`. The agent cannot
   talk to an HTTPS collector at all. Any deployment beyond localhost ships
   captured **local variable values and env vars in plaintext**. Add an `https`
   config flag, set the secure flag / `https://` scheme, and verify cert handling
   on both backends.
2. **Failed sends are dropped with no retry.** `AsyncQueue::run` ignores the
   return value of `transport_->send(...)` (`src/async_queue.cpp:71-73`); a batch
   that fails to POST is gone. Add bounded retry with backoff, or requeue to the
   front up to a cap, before counting as dropped. Today a brief collector blip =
   silent data loss.
3. **`BciShadow::ensure_ready` has a data race** (the P0 from `PLAN.md`).
   `ready_` is read/written without synchronization
   (`src/bci_shadow.cpp:9-26`) and is called from the exception callback on
   arbitrary threads — concurrent first-calls can `NewGlobalRef` twice (leak) or
   publish a half-initialized state. Wrap initialization in `std::call_once`.

### P1 — Performance

4. **Sampling map is unbounded** (P8). `states_` in `Sampler` grows one entry per
   distinct fingerprint forever (`src/sampling.cpp:28`) — a slow leak on apps
   with many throw sites. Add LRU/TTL eviction.
5. **REDUCED still walks the full stack** (P1). `src/exception_handler.cpp:265-268`
   walks frames (just without locals); the intent was a cheaper tier. Cap depth
   or skip the walk for REDUCED.
6. **JVM metrics recomputed every FULL event** (P2). `collect_jvm_metrics` does
   ~6 MXBean reflective lookups per event (`src/jvm_metrics.cpp`). Cache method
   IDs and TTL-cache the values (e.g. 1 s) so a burst doesn't hammer JMX.
7. **No payload compression.** `PLAN.md` mentions gzip "if implemented" — it
   isn't. Large stack/locals batches go uncompressed. Add gzip (both transports
   support it) behind a config flag.

### P2 — Correctness gaps & feature claims

8. **`depth` config does nothing.** `ObjectInspector::render_rec` ignores its
   `depth` parameter (`src/object_inspector.cpp:71,95`) and never expands object
   graphs — it renders `type@identityHash`. README/PLAN advertise depth-limited
   object inspection. Either implement field expansion bounded by `depth`, or
   drop the claim.
9. **`bci_packages` / `bci_exclude` are dead config.** They're parsed
   (`src/config.cpp:84-85`) but never passed to the Java transformer, which uses
   its own hardcoded `EXCLUDE` list (`bci-classfile/.../BciTransformer.java:16`).
   Either wire them through (e.g. a system property the transformer reads) or
   remove them from the documented options.
10. **Modified-UTF-8 → JSON.** `GetStringUTFChars` yields *modified* UTF-8;
    bytes ≥ 0x20 are emitted raw by `JsonWriter::escape`
    (`src/json_utils.cpp:22`). Supplementary characters and embedded-null
    encodings can produce invalid UTF-8 / JSON. Convert via `GetStringChars` +
    proper UTF-16→UTF-8, or sanitize.
11. **No API-key / auth header** on outbound requests — needed once the collector
    requires auth (see collector review). Add a configurable bearer/API-key
    header.

### P3 — Hardening & polish

- **Bound payload sizes**: cap message length, per-string length (the inspector
  caps strings at 256 but not exception messages), and total event bytes, so a
  pathological exception can't produce a multi-MB event.
- **Config validation**: `port`/`depth`/`timeout` use `atoi` with no validation
  (`src/config.cpp:73-78`); option values can't contain `,` (the split
  delimiter) — a `deployment` with a comma silently truncates.
- **Version string hardcoded** (`"jvmti-agent/1.0"`, `winhttp_transport.cpp:36`)
  — drive from a build-time version.
- **Unit tests**: fingerprinting, filters (`DenyAllowFilter`), sampler tiers,
  `JsonWriter`, config parsing are all pure and trivially testable. None exist.
- **Static analysis / sanitizers** in CI: build a Linux job with
  `-fsanitize=address,undefined` and run `TestException` to catch JNI ref leaks
  and UB.

## Suggested order

1. TLS + retry/backoff + `std::call_once` (P0 — these are launch-blocking for any
   non-localhost use).
2. Sampling eviction, cheaper REDUCED, metrics caching (P1 — perf the agent is
   judged on).
3. Fix or remove the `depth` and `bci_packages` claims (P2 — honesty/trust).
4. Tests + ASan/UBSan CI job (ongoing).

## Checklist

- [ ] HTTPS/TLS support (both transports) + cert verification
- [ ] Retry/backoff on failed batch send (no silent loss)
- [ ] `std::call_once` around BCI shadow init
- [ ] Evict entries from the sampling map
- [ ] Make REDUCED genuinely cheaper than FULL
- [ ] Cache JVM-metric method IDs + TTL-cache values
- [ ] Optional gzip compression
- [ ] Implement depth-limited object inspection (or drop the claim)
- [ ] Wire `bci_packages`/`bci_exclude` through (or remove)
- [ ] Correct UTF-8 conversion for Java strings
- [ ] Configurable auth header for the collector
- [ ] Payload size bounds + config validation
- [ ] Unit tests + ASan/UBSan CI job
