# Component Reviews

Per-component production-readiness analysis for jvmScout. Each file covers what's
already solid, the gaps that matter for production (with `file:line` references),
prioritized recommendations, and a checklist.

| Component | Tech | Review |
|---|---|---|
| Native JVMTI agent | C++17 / CMake / WinHTTP / libcurl | [agent.md](agent.md) |
| BCI transformer | Java 24+ / `java.lang.classfile` | [bci-transformer.md](bci-transformer.md) |
| Python collector | FastAPI / async SQLAlchemy / aiosqlite | [collector.md](collector.md) |
| Web UI | Vanilla HTML/CSS/JS | [web-ui.md](web-ui.md) |

For the overall roadmap and launch plan, see
[`../../PRODUCTION_READINESS.md`](../../PRODUCTION_READINESS.md); for the
architecture overview see [`../../ANALYSIS.md`](../../ANALYSIS.md).

## The cross-cutting theme: security & data loss

Three issues recur across components and are the real launch-blockers, because
jvmScout captures **secrets and PII** (local variable values, env vars, system
properties):

1. **No transport security or auth, end to end.** The agent only speaks plaintext
   HTTP ([agent.md](agent.md) P0-1) and the collector authenticates nothing —
   including a `DELETE` that wipes all data ([collector.md](collector.md) P0-1).
   The UI has no login ([web-ui.md](web-ui.md) P0-1). Fixing this is one coherent
   workstream: API-key on ingest, auth on dashboard/REST/WS, TLS, locked CORS,
   CSP.
2. **Silent data loss.** Failed POSTs are dropped with no retry
   ([agent.md](agent.md) P0-2); one malformed event can fail a whole ingest batch
   ([collector.md](collector.md) P1-4); the BCI depth counter drifts on
   exceptional unwind until capture silently stops
   ([bci-transformer.md](bci-transformer.md) P0-1).
3. **No automated tests anywhere.** Every component has zero unit/integration
   coverage; the BCI transformer (the riskiest code) most urgently needs it.

## Highest-leverage fixes (in order)

1. End-to-end **auth + TLS + locked CORS/CSP** (agent + collector + UI).
2. **No-silent-loss**: agent send-retry, per-item ingest, BCI depth fix.
3. **Tests + CI** for each component (CI scaffold already added).
4. **Perf**: bounded sampling map, cheaper REDUCED, metrics caching, lighter BCI
   instrumentation.
5. **Launch polish**: UI branding/empty states + README demo.
