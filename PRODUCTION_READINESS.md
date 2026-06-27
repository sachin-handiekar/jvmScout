# jvmScout — Production Readiness & ProductHunt Launch Plan

A practical, prioritized roadmap to take jvmScout from a working prototype (single
commit, verified on Windows) to a product you can confidently launch on ProductHunt.

**Current state (baseline):** working end-to-end on Windows; strong docs (`PLAN.md`,
`NOTES.md`); no LICENSE, no CI, no automated tests, no Docker, no packaged releases, plain
HTTP + wide-open CORS, committed build artifacts.

---

## How to read this

Work is grouped into phases. **Phase 0–2 are blocking** for a credible public launch.
Phase 3–4 make it look professional. Phase 5 is the launch itself. Each item has a rough
effort tag: 🟢 small (hours) · 🟡 medium (1–2 days) · 🔴 large (3+ days).

---

## Phase 0 — Legal, hygiene & repo basics (blocking)

These are cheap and non-negotiable before anything is public.

- [ ] 🟢 **Add a LICENSE.** No license = legally "all rights reserved"; nobody can use it.
      Pick one and commit it (MIT/Apache-2.0 for permissive; AGPL-3.0 if you want
      copyleft to protect a future hosted offering). Add SPDX headers to source files.
- [ ] 🟢 **Stop tracking build artifacts.** `sample-app/target/` (jars, compiled classes)
      is committed. Remove from the index and add to `.gitignore`:
      `git rm -r --cached sample-app/target && echo "**/target/" >> .gitignore`.
- [ ] 🟢 **Add `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`** (how to report
      vulnerabilities — important for a security/observability tool).
- [ ] 🟢 **Add issue/PR templates** under `.github/`.
- [ ] 🟢 **Pin/declare versions:** `requirements.txt` should pin (or constrain) versions;
      document the minimum JDK (24 for `bci=true`), CMake (≥3.20), Python (3.10+).
- [ ] 🟢 **Pick a clear product name + one-line pitch** and use it consistently across
      README, repo description, and the UI title.

---

## Phase 1 — Correctness, stability & known debt (blocking)

The agent runs inside customers' JVMs — bugs here are unacceptable. Close the open items
already flagged in `PLAN.md` Phase 9.

- [ ] 🟡 **P0 — wrap `EnsureTransformerReady` in `std::call_once`** (BCI init race under
      concurrent class loading). `agent/src/bci_*`.
- [ ] 🟢 **P1 — make REDUCED mode actually cheaper.** It currently still walks the stack
      (`agent/src/exception_handler.cpp:265`); skip the walk or cap it.
- [ ] 🟢 **P2 — TTL-cache JVM metrics** instead of recomputing per FULL event.
- [ ] 🟢 **P7 — cache boxed-primitive method IDs** in the object inspector.
- [ ] 🟡 **P8 — bound the sampling map** with eviction (currently unbounded → slow leak on
      apps with many distinct throw sites).
- [ ] 🟡 **Audit JNI local-ref discipline** across the hot path (`fill_cause_chain`,
      `fill_suppressed`, `stack_walker`) under high exception volume — confirm no ref
      table overflow and no leaks.
- [ ] 🟡 **Graceful collector-down behavior verified** under sustained load (drops counted,
      JVM never blocks/crashes — already designed, needs a stress test to prove).
- [ ] 🟢 **Bound payload sizes** (message length, string field truncation, deep object
      graphs) so a pathological exception can't produce a multi-MB event.

---

## Phase 2 — Security & privacy (blocking for a monitoring product)

This tool captures **local variable values and env vars** — i.e. potentially secrets and
PII. Security posture is a feature, not an afterthought.

- [ ] 🔴 **TLS/HTTPS support end to end.** Today it's plain HTTP. Verify cert handling on
      both transports (WinHTTP and libcurl). Document how to point at an HTTPS collector.
- [ ] 🟡 **Authentication on the collector.** Right now `POST /collector` and all GET/DELETE
      endpoints are unauthenticated. Add at least an API-key/bearer-token check on ingest
      and on the dashboard/API.
- [ ] 🟢 **Lock down CORS.** `allow_origins=["*"]` with `allow_credentials=True`
      (`collector/src/collector/app.py:33`) is unsafe — restrict to the configured UI
      origin.
- [ ] 🟡 **Redaction hardening.** There's a `redact_props` default list — expand to a
      documented, testable redaction layer (regex for tokens, credit cards, emails) and
      make redaction apply to captured **local values**, not just properties.
- [ ] 🟢 **Document the data-capture surface** prominently: exactly what is collected
      (locals, env, stack), how to disable each, and the `capture_packages` allowlist as
      the recommended safe-default for production.
- [ ] 🟡 **Run a security review** (you have a `/security-review` workflow available) and a
      dependency scan on the Python side.
- [ ] 🟢 **Rate-limit / size-limit ingest** so a misconfigured agent can't DoS the
      collector.

---

## Phase 3 — Build, test & release engineering

Turns "works on my Windows box" into "anyone can install it."

- [ ] 🔴 **CI matrix (GitHub Actions):** build the three agent libraries on
      `windows-latest` / `ubuntu-latest` / `macos-latest`; build the BCI jar (JDK 24+);
      lint + test the collector (Python 3.10–3.13); run a smoke test.
- [ ] 🔴 **Automated tests:**
  - Agent: unit tests for fingerprinting, filters, sampling, JSON serialization.
  - Collector: pytest for routes, storage, discriminator logic, retention purge.
  - End-to-end smoke: launch `TestException` with the agent → assert events land via REST
    (this is already scripted conceptually in `PLAN.md` Phase 8 — automate it).
- [ ] 🟡 **Prebuilt release artifacts.** Publish `.dll` / `.so` / `.dylib` + `bci-transform.jar`
      as GitHub Release assets (x64 everywhere; add `aarch64` Linux + Apple Silicon if
      runners allow). This is the #1 thing that makes the tool "just work" for visitors.
- [ ] 🟡 **Dockerize the collector + UI** with a `docker-compose.yml` so evaluators can run
      `docker compose up` and have a dashboard in one command. Huge for ProductHunt
      try-it conversion.
- [ ] 🟢 **Versioning + CHANGELOG.** Tag `v0.1.0`, adopt SemVer, keep `CHANGELOG.md`.
- [ ] 🟡 **macOS code-signing/notarization note** (Gatekeeper blocks unsigned `.dylib`).
- [ ] 🟢 **Reproducible build instructions** validated on a clean machine per OS.

---

## Phase 4 — Product polish & docs (what makes it "launchable")

ProductHunt visitors decide in ~30 seconds. The README and a demo carry the launch.

- [ ] 🔴 **A killer README top section:** logo, one-line pitch, animated GIF/screenshot of
      the live dashboard catching an exception with local-variable values, a
      `docker compose up` quickstart, and a feature bullet list.
- [ ] 🟡 **Live demo or hosted sandbox** (even a short Loom/YouTube video) showing: run an
      app → throw an exception → see it appear in the Live Feed with the local variable
      that caused it. The "you can see the variable values without `-g`" moment is the wow.
- [ ] 🟡 **UI polish pass:** empty states, loading states, error toasts, dark/light, mobile
      check, a proper favicon/logo, and a friendly first-run experience.
- [ ] 🟢 **Landing page** (GitHub Pages is fine): hero, 3 feature cards, screenshots, "get
      started," link to repo + ProductHunt.
- [ ] 🟢 **Docs site or `/docs` folder:** configuration reference (every `-agentpath` key),
      architecture overview, FAQ, troubleshooting, comparison to alternatives (OverOps,
      Sentry, Datadog Error Tracking) — honest about what jvmScout is and isn't
      (self-hosted, JVM-focused, captures locals).
- [ ] 🟢 **Performance numbers.** Run the planned microbenchmark (tight loop throwing ~1M
      caught exceptions with/without the agent) and publish the overhead ratio. Credible,
      concrete numbers build trust for an in-process agent.
- [ ] 🟢 **Spring Boot integration story** (you already have `sample-app/`) — a 5-minute
      "add this to your Spring Boot app" guide is a strong hook for the Java crowd.

---

## Phase 5 — ProductHunt launch mechanics

- [ ] 🟢 **Assets:** logo (240×240), gallery images/GIFs (1270×760), a 60–90s demo video,
      and a crisp tagline (≤60 chars), e.g. *"See the variable that crashed your JVM —
      self-hosted error monitoring."*
- [ ] 🟢 **First comment / maker's story:** why you built it, the hard technical bit
      (capturing locals without `-g` via the Class-File API), and what's next.
- [ ] 🟢 **Pick the launch day** (Tue–Thu, post at 12:01am PT) and line up a hunter if you
      can get a well-followed one; otherwise self-hunt.
- [ ] 🟢 **Pre-launch audience:** tease on r/java, Hacker News ("Show HN"), Java/JVM
      Discords, LinkedIn, X. Build a small email/Discord list to notify on launch morning.
- [ ] 🟢 **Be present all launch day** to answer every comment quickly.
- [ ] 🟢 **Clear CTA on the listing:** GitHub repo, `docker compose up` quickstart, demo
      video, and a way to follow updates.
- [ ] 🟢 **Set expectations honestly:** label it `v0.1` / beta if it is — early adopters
      reward candor and punish overclaiming.

---

## Suggested ordering (minimum viable launch)

If you want the fastest credible path to ProductHunt, do in order:

1. **Phase 0** (license, clean repo, basic community files) — 1 day.
2. **Phase 2 security must-haves** (TLS or at least auth + locked CORS + documented data
   capture) — 2–3 days.
3. **Phase 1 P0/P1/P8 stability fixes** — 2 days.
4. **Phase 3 essentials**: CI smoke test + prebuilt release binaries + `docker compose up`
   — 3–4 days.
5. **Phase 4 README + demo GIF + landing page** — 2 days.
6. **Phase 5 launch** — 1 day live.

≈ **2–3 focused weeks** to a launch you won't have to apologize for.

---

## Highest-leverage items (if you only do five)

1. **LICENSE** — without it nothing else matters.
2. **`docker compose up` for collector + UI** — turns curiosity into a running dashboard.
3. **Prebuilt agent binaries as GitHub Releases** — removes the C++ build barrier.
4. **Auth + locked CORS + TLS on the collector** — it captures secrets; it must be secure.
5. **A README demo GIF showing local-variable capture** — that's the screenshot that sells
   it.

---

## Open risks to call out at launch

- Plain HTTP / no auth today → must be closed before recommending anything beyond
  localhost.
- `bci=true` requires **JDK 24+** — narrow audience until/unless an ASM fallback for older
  JDKs is added (currently out of scope per `PLAN.md`).
- Capturing local variables and env vars is powerful but privacy-sensitive — lead with the
  redaction/allowlist story, not as a footnote.
- In-process native agent = high trust bar; published benchmarks + crash-safety guarantees
  + open source are what earn that trust.
