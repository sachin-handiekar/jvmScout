# Component Review — BCI Transformer (`bci-classfile/`)

Java 24+ bytecode transformer built on the JDK `java.lang.classfile` API (JEP
484, no external deps). Injected into the target JVM by the agent and driven from
`CLASS_FILE_LOAD_HOOK`. Its job: inject "shadow" local-variable capture so the
agent can read local values even for classes compiled **without** `javac -g`.
~420 LOC across `BciTransformer`, `ShadowClassTransform`, `ShadowCodeTransform`,
and `__JvmtiShadow`.

## What's already strong

- **Never throws.** `BciTransformer.transform` catches `Throwable` and returns
  `null` (= leave bytecode unchanged) on any failure
  (`src/main/java/BciTransformer.java:33`).
- **All shadow writes are `Throwable`-guarded** so instrumentation can't break
  the host app (`src/main/java/__JvmtiShadow.java`, every method).
- **Class-File API choice is sound** — JDK-native stack-map computation avoids the
  `COMPUTE_FRAMES` correctness pitfalls (lambdas / `invokedynamic`) an ASM
  approach would hit, and it has zero runtime dependencies.

## Production-readiness gaps

### P0 — Correctness / robustness

1. **Depth counter leaks on exceptional unwind.** `exitMethod()` is injected only
   before `ReturnInstruction` (`src/main/java/ShadowCodeTransform.java:63-66`),
   so when a method exits via a thrown exception its frame is never popped. The
   per-thread `DEPTH` counter (`__JvmtiShadow.java:23`) drifts upward over time.
   In a long-running app that throws and catches frequently, `DEPTH` climbs to
   `MAX_DEPTH - 1` and **capture silently stops**, and in the meantime frames are
   misaligned (the native side reads the wrong depth). The class comment
   acknowledges this is "best-effort" — but for production it's a correctness
   bug, not a footnote.
   **Fix options:** inject `exitMethod()` in an injected `try/finally` around the
   method body; or have the native side reconcile/reset depth at capture time
   using the real JVMTI stack depth (it already knows it) rather than trusting the
   shadow counter.

2. **Fixed `MAX_DEPTH = 64` / `MAX_SLOTS = 32` truncate silently.** Methods with
   more than 32 local slots, or recursion deeper than 64, lose data with no
   signal (`__JvmtiShadow.java:20-21`). Make these configurable and/or record a
   "truncated" marker so the UI can show capture was incomplete.

### P1 — Performance (this is the agent's heaviest cost)

3. **Captures *all* known locals before *every* throw-capable instruction.**
   `ShadowCodeTransform.accept` re-emits a capture call for every tracked slot
   ahead of each invoke/field/array op (`ShadowCodeTransform.java:68-72`). In a
   hot method with several locals and several calls, that's a large multiplier of
   injected `invokestatic` calls **plus boxing** — `captureInt/Long/Float/Double`
   box every primitive via `Integer.valueOf(...)` etc.
   (`__JvmtiShadow.java:54-57`). This is significant allocation/GC pressure with
   no sampling at the bytecode level (unlike the native path, which samples).
   **Fix:** capture only slots that changed since the last capture point; consider
   capturing only immediately before the *throwing-most-likely* ops; allow an
   opt-in "entry + last-write only" mode.

4. **Every method is instrumented, including trivial getters.** `enterMethod()` +
   parameter capture is injected at the start of every eligible method
   (`ShadowCodeTransform.java:49-54`). For tiny/hot methods the relative overhead
   is large. Honor an allowlist so only methods that matter are touched.

5. **Configured `bci_packages` / `bci_exclude` are ignored.** The agent parses
   them but the transformer uses its own hardcoded `EXCLUDE`
   (`BciTransformer.java:16-21`). Operators can't actually scope instrumentation.
   Pass the configured scope to the transformer (e.g. via a system property set
   by the agent) and apply it in `isExcluded` / `ShadowClassTransform`.

### P2 — Correctness edge cases

6. **`long`/`double` occupy two slots but are tracked as one** in the `known`
   map keyed by `slot` (`ShadowCodeTransform.java:38,58-61`). Slot reuse with a
   different type across a method is only coarsely handled. Verify category-2
   types and slot-reuse don't produce mislabeled or wrong values.

7. **JDK 24 minimum is a narrow audience.** `java.lang.classfile` is final in
   JDK 24; most production JVMs are 17/21. Document this clearly as a `bci=true`
   prerequisite, and consider (later, out of current scope) an ASM-based fallback
   behind the same `transform(String, byte[])` surface for 11/17/21.

### P3 — Hardening & polish

- **No tests.** Add golden-bytecode / round-trip tests: instrument a sample
  class, load it, throw, and assert the shadow frame contains the expected slot
  values. This is the riskiest code in the project and has zero automated
  coverage.
- **Build is `javac`/`jar` by hand** in the README; there's a `pom.xml` — make
  the Maven build authoritative and produce a reproducible, versioned jar in CI
  (already added to the CI workflow).
- **`__JvmtiShadow` lives in the default package** (required for `FindClass`) —
  document why, and keep its name stable since the native side hardcodes it.

## Suggested order

1. Fix the depth-accounting bug (P0) — without it, capture silently degrades in
   exactly the long-running, exception-heavy apps this product targets.
2. Reduce instrumentation cost: changed-slots-only + allowlist scoping (P1).
3. Wire through `bci_packages`/`bci_exclude` (P1, also a trust issue).
4. Add round-trip tests (P3) before doing anything else clever here.

## Checklist

- [ ] Pop shadow frames on exceptional unwind (try/finally) or reconcile depth natively
- [ ] Make `MAX_DEPTH`/`MAX_SLOTS` configurable + signal truncation
- [ ] Capture only changed slots; add a lighter capture mode
- [ ] Honor `bci_packages`/`bci_exclude` scope
- [ ] Skip trivial/hot methods via allowlist
- [ ] Verify category-2 (long/double) and slot-reuse handling
- [ ] Document JDK 24 requirement prominently
- [ ] Round-trip instrumentation tests in CI
- [ ] Maven-based reproducible, versioned build
