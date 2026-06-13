# error-demo — Spring Boot test app for the JVMTI agent

A small Spring Boot web app whose endpoints deliberately throw a variety of
exceptions so you can watch the JVMTI agent capture them and forward them to the
collector / dashboard.

## Prerequisites

- **JDK 25** (Spring Boot 4 runs on it). Because that is ≥ 24, you can also test
  the agent's BCI shadow path here. Your installed JDK 26 builds release-25
  bytecode fine; run on JDK 25 (JDK 26 will likely also work).
- **Maven** (`mvn`). If it isn't installed: `winget install Apache.Maven` or
  `choco install maven`, or just import this folder into an IDE (IntelliJ/VS Code).
  Spring Boot 4 needs a recent Maven (3.9+).
- The built agent library and the running collector (see the repo root README).

## Run

```bash
# 1. Start the collector (from repo root), listening on 8080
cd ../collector
PYTHONPATH=src python -m collector

# 2. In another shell: build and run this app WITH the agent attached.
#    Point JAVA_HOME at JDK 17/21 for Spring Boot compatibility.
cd ../sample-app
export JAVA_HOME="/c/Program Files/Java/jdk-25"   # a JDK 25 install

# Option A — let the Spring Boot plugin launch with the agent JVM arg:
mvn spring-boot:run \
  -Dspring-boot.run.jvmArguments="-agentpath:../agent/build/jvmti-agent.dll=host=localhost,port=8080,deployment=spring-demo,console=false"

# Option B — build a jar, then run it with the agent:
mvn -q clean package
java -agentpath:../agent/build/jvmti-agent.dll=host=localhost,port=8080,deployment=spring-demo \
     -jar target/error-demo-0.1.0.jar

# Option C — exercise the BCI shadow path (locals without -g): add bci=true.
#   Build the bci-classfile jar first and place it next to the agent library.
java -agentpath:../agent/build/jvmti-agent.dll=host=localhost,port=8080,deployment=spring-demo,bci=true \
     -jar target/error-demo-0.1.0.jar
```

Then open the dashboard at <http://localhost:8080> and trigger some errors:

```bash
curl localhost:8081/                       # list of endpoints
curl localhost:8081/api/npe                # NullPointerException (named locals)
curl localhost:8081/api/divide?a=10&b=0    # ArithmeticException
curl localhost:8081/api/array?index=10     # ArrayIndexOutOfBoundsException
curl localhost:8081/api/parse?value=abc    # NumberFormatException
curl localhost:8081/api/orders/7?qty=12    # PricingException + cause chain + rich locals
curl localhost:8081/api/caught             # caught + logged, returns 200
curl "localhost:8081/api/burst?count=80"   # sampling: FULL -> REDUCED -> COUNT_ONLY
curl localhost:8081/api/async              # uncaught exception on a background thread
```

## What each endpoint exercises

| Endpoint | Demonstrates |
|---|---|
| `/api/npe`, `/api/divide`, `/api/array`, `/api/parse` | Common exception types with named local variables (captured via JVMTI debug info, since Maven compiles with `-g` by default) |
| `/api/orders/{id}` | Deep service call with object-graph locals (`Customer`, `Order`, `List<LineItem>`, `BigDecimal` totals) and a two-level **cause chain** (`PricingException` ⇐ `IllegalStateException`) |
| `/api/caught` | Caught/swallowed exceptions plus an SLF4J `log.error(...)` — useful when log-capture instrumentation is added |
| `/api/burst` | The same fingerprint repeated, so you can watch the adaptive **sampling tiers** demote |
| `/api/async` | A genuinely **uncaught** exception on a background thread (`caught=false`) |

## Notes

- Request-handler exceptions are caught by Spring's DispatcherServlet, so the
  agent records them with `caught=true` and a catch location in framework code;
  the client gets HTTP 500. Only `/api/async` produces `caught=false`.
- Maven compiles with `-g` by default, so the agent reads **named** locals
  straight from JVMTI (`source: "debug_info"`) — no BCI required for normal use.
- The **BCI shadow path** (`bci=true`) is fully testable here since the app runs
  on JDK 25 (≥ 24). To compare, build with `-g:none` (Spring Boot plugin:
  `<configuration><compilerArguments>-g:none</compilerArguments></configuration>`
  on maven-compiler-plugin) and confirm locals still appear, tagged
  `source: "bci_shadow"` with the dashboard's ● badge.
