Component Blueprints – JVMTI Exception Monitoring PlatformPurpose: a self-contained, prompt-ready summary of each component in this project.Each section is sized to be pasted into a "build this from scratch" prompt.Last refreshed: June 12, 2026.## 0. System OverviewA four-tier OverOps-style runtime error monitor:Target JVM — JVMTI native agent —HTTP POST—> Python collector —REST/WS—> Web UI

&#x20;  │              │

&#x20;  └──────────────┴─── (optional) BCI transformer JAR injected via ClassFileLoadHook

ComponentLanguage / runtimeOutput artifactFolderNative agentC++17, MSVC, WinHTTPjvmti-agent.dll\[agent/](agent/)BCI transformer (ASM)Java 11, ASM 9.8shaded bci-transform.jar\[bci-transform/](bci-transform/)BCI transformer (Class-File API)Java 24+, JEP 484bci-classfile-\*.jar (drop-in)\[bci-classfile/](bci-classfile/)CollectorPython 3.10+, FastAPI, async SQLAlchemy, aiosqlitepython -m collector service\[collector/](collector/)Web UIVanilla HTML/CSS/JS SPAstatic files served by collector\[ui/](ui/)Test harnessJavaTestException.class\[test-apps/](test-apps/)Wire format: single JSON document per event. Two event shapes – exception (default) and agent\_start (sent once at JVM init).## 1. Component: Native JVMTI Agent (C++)### GoalA Windows DLL loaded via -agentpath. Intercepts every JVM exception, captures full diagnostic context (stack frames, local variables, cause chain, JVM metrics), filters, and pushes JSON to the collector over HTTP asynchronously.### BuildToolchain: MSVC cl + link via nmake, x64 Native Tools Command Prompt.Flags: /EHsc /MD /W3 /std:c++17 /nologo.Includes: $(JAVA\_HOME)\\include, $(JAVA\_HOME)\\include\\win32.Link: /DLL winhttp.lib.JAVA\_HOME required from env var; Makefile errors out if unset.### Module layoutagent/

├── Makefile                # nmake rules, one obj per .cpp with explicit header deps

└── include/                # 19 headers

&#x20;   ├── agent.h             # legacy globals (g\_jvmti, g\_jvm, g\_output\_mutex)

&#x20;   ├── agent\_context.h     # AgentContext struct - DI container, owns transport + filters

&#x20;   ├── config.h            # AgentConfig POD struct

&#x20;   ├── exception\_handler.h

&#x20;   ├── stack\_walker.h

&#x20;   ├── object\_inspector.h

&#x20;   ├── event\_serializer.h  # JSON payload assembly extracted from exception\_handler

&#x20;   ├── sampling.h

&#x20;   ├── async\_queue.h

&#x20;   ├── http\_transport.h    # legacy free fn (delegates to ITransport)

&#x20;   ├── itransport.h        # pure virtual: send(json) -> bool, name()

&#x20;   ├── winhttp\_transport.h # ITransport implementation

&#x20;   ├── ifilter.h           # pure virtual filter contract

&#x20;   ├── jvm\_metrics.h

&#x20;   ├── bci\_engine.h        # ClassFileLoadHook + JAR injection

&#x20;   ├── bci\_shadow.h        # JNI bridge to \_\_JvmtiShadow

&#x20;   ├── system\_info.h       # VMInit handler, props/host/env capture

&#x20;   ├── json\_utils.h        # EscapeJson

&#x20;   └── jvmti\_utils.h       # JvmtiString + JniLocalFrame RAII, ResolveLineNumber

└── src/                    # 15 .cpp files, one per header (most)

\### JVMTI capabilities requestedcan\_access\_local\_variables, can\_get\_line\_numbers, can\_get\_source\_file\_name, can\_generate\_exception\_events, can\_tag\_objects, can\_generate\_all\_class\_hook\_events, can\_retransform\_classes### JVMTI events registeredEventCallbackWhenJVMTI\_EVENT\_EXCEPTIONExceptionCallbackevery Java throwJVMTI\_EVENT\_CLASS\_FILE\_LOAD\_HOOKClassFileLoadHookCallbackonly when bci=trueJVMTI\_EVENT\_VM\_INITVMInitCallbackonce at JVM init - sends agent\_startJVMTI\_EVENT\_VM\_DEATHVMDeathCallbackshutdown signal### Configuration (parsed from -agentpath:agent.dll=key=val,...)KeyDefaultPurposehost, port, pathlocalhost, 8080, /collectorcollector endpointdeployment(empty)deployment tag attached to every eventconsoletrueprint to stdoutdepth3object inspection recursion depthtimeout5000HTTP timeout (ms)deny10 JDK patternsadditional exception-type denylist (semicolon-separated)capture\_packages(empty)allowlist mode - only capture throws from these packageslocation\_deny23 framework patternsadditional throw-site denylistbcifalseenable bytecode instrumentationbci\_jarauto-detect next to DLLabsolute path to bci-transform.jarbci\_packages(empty)semicolon-separated allowlist of packages to instrumentbci\_exclude14 patternsadditional BCI exclusionsbci\_verbosefalselog every instrumented classinstance\_idauto UUIDidentifies this JVM instanceenv\_capture(empty)env var capture glob patternsredact\_props7 patternsredaction keys for sensitive sys props### Exception pipeline (per throw)Reentrance guard – thread\_local bool blocks recursive captures.Type filter – denylist (and optional allowlist) on exception class signature.Location filter – same on throwing class.Fingerprint – FNV-1a 64-bit of (exception class + throwing class + method + line).Sampling tier – 60s sliding window, 10 hits $\\rightarrow$ FULL $\\rightarrow$ REDUCED $\\rightarrow$ COUNT\_ONLY; re-allow one FULL every 300s.Console output – full banner (FULL) or one-line compact (REDUCED).JSON assembly in event\_serializer.cpp – exception meta, caughtAt, cause chain ($\\le$10), suppressed\[], threadInfo, jvmMetrics, stackTrace ($\\le$100 frames, locals via JVMTI if BCI shadow).Async enqueue – async\_queue.cpp background thread, batched (20/batch, 2s flush), 10k cap with silent drop counter.HTTP POST via WinHttpTransport (implements ITransport).### Safety netEntire ExceptionCallbackImpl wrapped in try/catch(std::exception\&) + catch(...). No C++ exception escapes a JVMTI callback.JvmtiString RAII auto-frees JVMTI allocations; JniLocalFrame auto-pushes/pops local-ref frames.### Known open workP0 EnsureTransformerReady lacks std::call\_once; P1 REDUCED still does full work; P2 JVM metrics not TTL-cached; P7 boxed-primitive method IDs not cached; P8 sampling map has no eviction.### Rebuild prompt seedBuild a C++17 Windows JVMTI agent compiled as a DLL via nmake. On Agent\_OnLoad: parse -agentpath options into an AgentConfig, create an AgentContext DI container that owns a WinHttpTransport (implementing ITransport) and type/location IFilters. Request JVMTI capabilities for local variables, line numbers, source file, exception events, object tagging, ClassFileLoadHook, and class retransformation. Register ExceptionCallback, ClassFileLoadHookCallback (only if bci=true), VMInitCallback, and VMDeathCallback. On every exception: filter by type and throw-site, fingerprint with FNV-1a, apply a FULL->REDUCED->COUNT\_ONLY sampling tier with a 60s window and 5-min resample, build a JSON payload with exception meta, cause chain ($\\le$10), suppressed exceptions, thread info, JVM metrics (heap/GC/threads/uptime via JMX MBeans through JNI), and up to 100 stack frames with local variables read via GetLocalVariableTable (with fallback to a JNI-accessible \_\_JvmtiShadow.getFrame() for code compiled without -g). Enqueue payloads onto a bounded queue serviced by a background thread that POSTs batches to a configurable collector. Use RAII guards (JvmtiString, JniLocalFrame) and a thread\_local reentrance guard. Wrap the entire exception callback body in try/catch(...) so no C++ exception ever escapes back into the JVM.## 2. Component: BCI Transformer – ASM variant (Java)### GoalInject "shadow variable capture" calls into application bytecode at class load time so the native agent can read local variable values at exception time even when classes are compiled without javac -g.### BuildJDK 11+, Maven 3.6+, ASM 9.8 (asm, asm-commons, asm-tree, asm-util, asm-analysis).Maven Shade plugin relocates org.objectweb.asm.\* $\\rightarrow$ jvmti.internal.asm.\* to avoid clashing with apps that bundle their own ASM.Output: target/bci-transform.jar, self-contained. Copy to agent/bci-transform.jar next to the DLL.### Source files (4)FileRoleBciTransformer.javaJNI entry point – static byte\[] transform(String className, byte\[] classFileBuffer). Pre-parses with ClassNode to build per-method LVT map, then runs ClassReader $\\rightarrow$ ShadowClassVisitor $\\rightarrow$ ClassWriter(COMPUTE\_FRAMES). Returns null on any error or skipped class.ShadowClassVisitor.javaClassVisitor – iterates methods, skips <clinit> / native / abstract / bridge / synthetic, wraps each with ShadowMethodVisitor.ShadowMethodVisitor.javaAdviceAdapter – injects \_\_JvmtiShadow.enterMethod() at entry, exitMethod() at every return, and capture calls before every throw-capable instruction. Tracks knownSlots via visitVarInsn, suppresses captures inside loops (P24), emits setSlotType on slot reuse (P22), and emits setSlotMetadata from LVT (P23).\_\_JvmtiShadow.javaThree ThreadLocal's: frames (Object\[64]\[32]), metadata (String\[64]\[32]), slotTypes (int\[64]\[32]). Typed captureInt/Long/Float/Double/Object. Read API for C++: getFrame(depth), getMetadata(depth), getSlotTypes(depth), clearFrame(depth). All write methods are try/catch(Throwable) guarded.### BootstrapNative agent calls AddToBootstrapClassLoaderSearch so \_\_JvmtiShadow is visible to all classloaders.BciTransformer itself is added via AddToSystemClassLoaderSearch.### Throw-capable opcodes instrumentedinvokevirtual/interface/special/static, getfield/putfield, all array load/store, idiv/irem/ldiv/lrem, arraylength, monitorenter/exit, checkcast, athrow.### Rebuild prompt seedCreate a Java 11 Maven module that produces a shaded JAR. Depend on ASM 9.8. Write BciTransformer.transform(String, byte\[]) as a JNI-callable entry point. Use ClassNode to pre-parse the LVT, then ClassReader -> ClassVisitor -> ClassWriter(COMPUTE\_FRAMES). In a MethodVisitor extending AdviceAdapter at method entry, call \_\_JvmtiShadow.enterMethod() and capture this + all parameters; before every throw-capable instruction (invokes, field access, array access, idiv/irem/ldiv/lrem, arraylength, monitorenter, checkcast, athrow), capture all visible locals from a knownSlots map populated by visitVarInsn at every return. Call exitMethod(). Skip <clinit>, native, abstract, bridge, synthetic methods, JDK/Sun/Spring packages, and the BCI infrastructure classes themselves. Implement \_\_JvmtiShadow as a bootstrap-visible class with three ThreadLocal arrays (values, metadata, slot types) of size \[64]\[32], typed capture methods, and a C++-facing read API. Shade org.objectweb.asm.\* to jvmti.internal.asm.\*.## 3. Component: BCI Transformer – JDK Class-File API variant (Java 24)### GoalDrop-in replacement for the ASM variant using the built-in java.lang.classfile API (JEP 484, final in JDK 24). Eliminates the ASM dependency and the COMPUTE\_FRAMES correctness pitfalls around lambdas/invokedynamic.### BuildJDK 24+ (or JDK 25 if java.lang.classfile is finalized there in your distro).Maven, no dependencies. Output: thin JAR with 4 classes.Copy to agent/bci-transform.jar (the native agent doesn't care which variant produced it).### Source files (4)FileRoleBciTransformer.javaSame JNI entry signature as the ASM variant. Uses ClassFile.of().transformClass(...).ShadowClassTransform.javaClassTransform – filters methods, extracts LVT for metadata emission.ShadowCodeTransform.javaCodeTransform – injects shadow capture calls; same P20–P24 semantics as the ASM version.\_\_JvmtiShadow.javaUnchanged from the ASM variant.### Why both variants existASM variant: works on JDK 11+.Class-File API variant: zero external deps, JDK-native stack-map computation, simpler code, but requires JDK 24+.### Rebuild prompt seedReimplement the ASM-based bci-transform module using java.lang.classfile (JEP 484, finalized in JDK 24). Match the exact public surface: BciTransformer.transform(String, byte\[]) returning instrumented bytes (or null to skip). Use ClassTransform to filter methods and CodeTransform to inject capture calls before every throw-capable instruction. Preserve all P20–P24 features: xSTORE tracking, all-visible-locals capture, slot type-change handling, LVT-based variable name metadata, and loop-aware suppression. Keep \_\_JvmtiShadow bit-for-bit compatible so the native agent's JNI bridge needs no changes. Package as a thin JAR with no runtime dependencies.## 4. Component: Python Collector### GoalSingle-process HTTP service that ingests batched events from any number of agents, persists them to SQLite, broadcasts to WebSocket clients, and serves the static UI.### Build / runPython 3.10+, dependencies in requirements.txt (FastAPI, uvicorn, SQLAlchemy\[asyncio], aiosqlite, Pydantic v2).pip install -r requirements.txt $\\rightarrow$ python -m collector (binds 0.0.0.0:8080 by default).Configurable via env vars: COLLECTOR\_DB\_URL, COLLECTOR\_HOST, COLLECTOR\_PORT, COLLECTOR\_RETENTION\_DAYS.### Module layoutcollector/src/collector/

├── \_\_main\_\_.py      # uvicorn launcher

├── app.py           # FastAPI app, CORS middleware, lifespan (init\_db + purge\_old\_records), mounts UI as StaticFiles

├── config.py        # env-var-driven settings

├── models.py        # 14 Pydantic models (see schema below)

├── storage.py       # async SQLAlchemy, two tables, CRUD helpers, purge\_old\_records

└── api/

&#x20;   └── routes.py    # REST + WebSocket router

\### Database (SQLite via aiosqlite, two tables)exceptions – 17 columns: id, received\_at, timestamp, fingerprint (idx), capture\_mode, hit\_count, deployment\_id (idx), instance\_id (idx), exception\_type (idx), exception\_message, caught\_class, class\_name, method\_name, line\_number, source\_file, thread\_name, raw\_json.jvm\_instances – 12 columns keyed on unique instance\_id for agent\_start events.### EndpointsMethodPathPurposePOST/collectorIngest list or single event; routes type=agent\_start to jvm\_instances, everything else to exceptions; broadcasts to WSGET/exceptionsPaginated, filterable by exception\_type, deployment\_id, caught, fingerprintGET/exceptions/{id}Full raw JSON detailDELETE/exceptions / /exceptions/{id}PurgeGET/statsTotals, unique fingerprints, top 10 types, recent deploymentsGET/jvm-info, /jvm-info/{id}, /jvm-instancesAgent start metadataWS/ws/liveReal-time event broadcast### Wire JSON schema (excerpt, see models.py for full definition)JSON{

&#x20; "timestamp": "...", "fingerprint": "...", "captureMode": "FULL|REDUCED|COUNT\_ONLY",

&#x20; "hitCount": 1, "deploymentId": "...", "instanceId": "...",

&#x20; "exceptionType": "java/lang/NullPointerException",

&#x20; "exceptionMessage": "...", "caught": true,

&#x20; "location": { "className": "...", "methodName": "...", "lineNumber": 42, "sourceFile": "..." },

&#x20; "caughtAt": { ... },

&#x20; "threadInfo": { "name": "...", "priority": 5, "isDaemon": false },

&#x20; "causeChain": \[ { "exceptionType": "...", "exceptionMessage": "..." } ],

&#x20; "suppressedExceptions": \[ ... ],

&#x20; "jvmMetrics": { "heapUsedBytes": ..., "heapMaxBytes": ..., "gcCollectionCount": ..., "gcTimeMs": ..., "threadCount": ..., "loadedClassCount": ..., "uptimeMs": ... },

&#x20; "stackTrace": \[

&#x20;   { "frameIndex": 0, "className": "...", "methodName": "...", "lineNumber": 42, "sourceFile": "...",

&#x20;     "localVariables": \[

&#x20;       { "name": "userId", "signature": "Ljava/lang/String;", "slot": 1, "value": "user-123", "source": "debug\_info" },

&#x20;       { "slot": 2, "type": "Object", "value": "null", "source": "bci\_shadow" }

&#x20;     ]

&#x20;   }

&#x20; ]

}

\### Rebuild prompt seedBuild a Python 3.10+ FastAPI service. Use Pydantic v2 models matching the wire schema documented in section 4 (Location, ThreadInfo, Cause, LocalVariable with optional name/signature/source, StackFrame, JvmMetrics, ExceptionEvent, AgentStartEvent with nested JvmInfo and HostInfo). Persist with async SQLAlchemy + aiosqlite to two tables: exceptions (17 cols, indexes on fingerprint, deployment\_id, instance\_id, exception\_type) and jvm\_instances (unique instance\_id). Endpoints: POST /collector accepting either a single event or a list; route type=agent\_start payloads to jvm\_instances and others to exceptions; broadcast every event to all clients on WS /ws/live. Add GET /exceptions (paginated, filter by type/deployment/caught/fingerprint), GET /exceptions/{id}, DELETE /exceptions/{id}, GET /stats (totals + top 10 types + recent deployments), GET /jvm-info, GET /jvm-info/{id}, GET /jvm-instances. Configure via env vars COLLECTOR\_HOST, COLLECTOR\_PORT, COLLECTOR\_DB\_URL, COLLECTOR\_RETENTION\_DAYS. On startup: create tables and purge records older than retention. Mount the static ui/ directory at /. Enable CORS for all origins (dev-friendly).## 5. Component: Web UI### GoalSingle-page application served by the collector. Four pages, dark theme, real-time WebSocket updates, no build step.### Build / serveStatic files served directly by the collector via FastAPI StaticFiles. Pure vanilla JS (no React/Vue/build tool). Single file each: index.html, css/styles.css, js/app.js ($\\sim$670 lines).### PagesPageElementBehaviorDashboard4 stat cards + pure-CSS bar chart of top types + recent deploymentsPolls /stats on load and on focusExceptionsFilterable, sortable, paginated tableCalls /exceptions with query params; row click $\\rightarrow$ detail viewException Detail8 collapsible sections: Overview, Throw Location, Catch Location, Thread Info, Stack Trace (with expandable local variables and BCI $\\bullet$ tag), Cause Chain, Suppressed, JVM MetricsFetches /exceptions/{id}Live FeedWebSocket-driven slide-in cardsReconnects every 3 s on drop; caps memory at 500 events / DOM at 200JVM Info7 sections covering identity, host (with Kubernetes detection), JVM args, classpath (collapsed), env vars, system properties (collapsed table), agent configFetches /jvm-info and /jvm-instances### Visual designGitHub-dark-inspired palette, CSS custom properties, responsive (sidebar collapses to 60 px icon-only below 900 px), WS connection status indicator with green/red dot.### Rebuild prompt seedBuild a single-page web UI in vanilla HTML/CSS/JS (no framework, no build step). Layout: a fixed left sidebar with 4 nav links (Dashboard, Exceptions, Live Feed, JVM Info) and a WebSocket connection status indicator; a main content area that swaps between four hash-routed views. Implement a Dashboard with 4 stat cards (total, unique fingerprints, deployments, uncaught) plus a pure-CSS bar chart of the top 10 exception types using /stats. Implement an Exceptions page with a sortable, filterable, paginated table backed by /exceptions (filter by type, deployment, caught/uncaught); clicking a row opens a detail view with 8 collapsible sections including a stack trace where each frame can expand to show local variables (mark BCI-sourced vars with a $\\bullet$ tag). Implement a Live Feed page that connects to ws://host/ws/live, auto-reconnects every 3 s, animates new events as slide-in cards, caps in-memory events at 500 and rendered DOM at 200, and shows a badge counter in the sidebar. Implement a JVM Info page with 7 sections from /jvm-info. Use a GitHub-dark theme with CSS custom properties; make the sidebar collapse to a 60 px icon strip below 900 px.## 6. Component: Test Harness### GoalMinimal Java program that triggers three exception scenarios for end-to-end validation.### Sourcetest-apps/TestException.java – a single class with main and three private methods:testNullPointer() – String nullString = null; nullString.length(); $\\rightarrow$ NPE.testArrayBounds() – int\[] a = {1..5}; a\[10]; $\\rightarrow$ 







ArrayIndexOutOfBoundsException.





\## 6. Component: Test Harness (Continued)### Source (Continued)testWithObjects() – constructs a nested Person POJO, then derefs a null address to verify object-graph inspection and local-variable capture.### UseBashjavac TestException.java

java -agentpath:..\\agent\\jvmti-agent.dll=host=localhost,port=8080 TestException

\### Rebuild prompt seedWrite a single Java class TestException with a main that wraps three private test methods in try/catch blocks and prints their outcomes. The three methods must deterministically throw NullPointerException, ArrayIndexOutOfBoundsException, and a NullPointerException thrown inside a method that has at least two in-scope local objects (a constructed POJO and a separate variable) so local-variable capture can be verified.## 7. Cross-Component Contracts### Build / runtime orderBuild a BCI JAR (bci-transform or bci-classfile) $\\rightarrow$ copy to agent/bci-transform.jar.Build the agent DLL (nmake in agent/).Start the collector (python -m collector in collector/).Launch the target JVM with -agentpath:../jvmti-agent.dll=host=...,port=...\[,bci=true,bci\_jar=...].Open http://localhost:8080 in a browser.### Wire-format invariants (do not break)The collector treats type: "agent\_start" as the discriminator for the registration event; any other shape is parsed as ExceptionEvent.fingerprint may be int or string – the collector coerces to string when storing.localVariables\[].source is "debug\_info" (JVMTI LVT) or "bci\_shadow" (BCI ThreadLocal). UI keys off this for the 🟣 badge.captureMode is one of "FULL", "REDUCED", "COUNT\_ONLY".The agent never crashes the host JVM: every callback is try/catch(...) guarded; every BCI failure returns null (= "leave bytecode unchanged").### Build-order independenceThe two BCI JAR variants are interchangeable – agent loads whichever file exists at the configured bci\_jar path.Collector and UI are decoupled: UI only depends on the REST + WS contract.## 8. Suggested Reading Order for a Newcomer\[README.md](README.md) – setup and CLI options.This file – high-level mental model.\[FEATURE\_AUDIT.md](FEATURE\_AUDIT.md) – done/remaining inventory.\[BCI\_IMPLEMENTATION\_PLAN.md](BCI\_IMPLEMENTATION\_PLAN.md) – why and how the BCI engine exists.\[OVEROPS\_GAP\_ANALYSIS.md](OVEROPS\_GAP\_ANALYSIS.md) – what's still missing vs. the reference product.\[ARCHITECTURE\_REVIEW.md](ARCHITECTURE\_REVIEW.md) – current C++ tech debt and the P0–P10 fix list.\[ENHANCEMENTS.md](ENHANCEMENTS.md), \[SOURCE\_OVERLAY\_DESIGN.md](SOURCE\_OVERLAY\_DESIGN.md), \[AI\_AGENT\_INTEGRATION.md](AI\_AGENT\_INTEGRATION.md) – forward-looking designs.\[ROADMAP.md](ROADMAP.md) – phased work plan.

