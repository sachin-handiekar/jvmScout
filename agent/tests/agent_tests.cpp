// Zero-dependency unit tests for the agent's pure-logic components (no JNI):
// fingerprint, filters, adaptive sampler (tiering + LRU bound), the JSON
// string escaper (modified-UTF-8 handling), and config parsing.
//
// Built as the `agent_tests` CMake target and run via ctest.

#include "async_queue.h"
#include "config.h"
#include "fingerprint.h"
#include "ifilter.h"
#include "itransport.h"
#include "json_utils.h"
#include "sampling.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <string>
#include <thread>

#if defined(_WIN32)
#include <stdlib.h>
static void set_env(const char* k, const char* v) { _putenv_s(k, v ? v : ""); }
static void unset_env(const char* k) { _putenv_s(k, ""); }
#else
#include <stdlib.h>
static void set_env(const char* k, const char* v) { setenv(k, v ? v : "", 1); }
static void unset_env(const char* k) { unsetenv(k); }
#endif

static int g_fail = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);        \
            ++g_fail;                                                          \
        }                                                                      \
    } while (0)

// Build an expected JSON fragment using '#' as a stand-in for backslash, so the
// source contains no \u / \x escapes (which the compiler would mis-parse).
static std::string E(std::string p) {
    for (char& c : p) if (c == '#') c = static_cast<char>(92);
    return p;
}
static std::string bytes(std::initializer_list<int> bs) {
    std::string s;
    for (int b : bs) s.push_back(static_cast<char>(b));
    return s;
}

static void test_fingerprint() {
    // FNV-1a 64-bit offset basis for the empty string.
    CHECK(fnv1a64("") == 0xcbf29ce484222325ULL);
    CHECK(fnv1a64("a") != fnv1a64("b"));

    std::string fp1 = compute_fingerprint("E", "C", "m", 10);
    std::string fp2 = compute_fingerprint("E", "C", "m", 10);
    std::string fp3 = compute_fingerprint("E", "C", "m", 11);
    CHECK(fp1 == fp2);           // deterministic
    CHECK(fp1 != fp3);           // line is part of the identity
    CHECK(!fp1.empty());
}

static void test_filters() {
    // Deny-only: substring match drops.
    DenyAllowFilter deny("deny", {"java/", "sun/"}, {});
    CHECK(deny.accept("com/example/Foo") == true);
    CHECK(deny.accept("java/lang/String") == false);

    // Allow-only mode: must match allowlist AND avoid denylist.
    DenyAllowFilter allow("allow", {"com/secret/"}, {"com/example/"});
    CHECK(allow.accept("com/example/Foo") == true);
    CHECK(allow.accept("org/other/Bar") == false);          // not allowlisted
    CHECK(allow.accept("com/example/secret/X") == true);    // denylist needs full prefix
    CHECK(allow.accept("com/secret/Thing") == false);       // not allowlisted anyway
}

static void test_sampler_tiers() {
    Sampler s;
    const std::string fp = "abc";
    // First 10 hits FULL, next 40 REDUCED, then COUNT_ONLY (single time window).
    for (int i = 1; i <= 60; ++i) {
        CaptureMode m = s.decide(fp).mode;
        if (i <= 10)       CHECK(m == CaptureMode::FULL);
        else if (i <= 50)  CHECK(m == CaptureMode::REDUCED);
        else               CHECK(m == CaptureMode::COUNT_ONLY);
    }
    CHECK(s.decide(fp).hit_count == 61);
}

static void test_sampler_lru_bound() {
    Sampler s(4);  // tiny cap
    for (int i = 0; i < 100; ++i) {
        s.decide("fp-" + std::to_string(i));
    }
    CHECK(s.tracked() <= 4);
}

static void test_json_escape() {
    CHECK(JsonWriter::escape("hello") == "hello");
    // quote + newline
    std::string q(1, static_cast<char>(34)), nl(1, static_cast<char>(10));
    CHECK(JsonWriter::escape("a" + q + "b" + nl) == E("a#" + q + "b#n"));
    // modified UTF-8: embedded NUL, BMP, supplementary (surrogate pair), invalid
    CHECK(JsonWriter::escape(bytes({0xC0, 0x80})) == E("#u0000"));
    CHECK(JsonWriter::escape(bytes({0xC3, 0xA9})) == E("#u00e9"));
    CHECK(JsonWriter::escape(bytes({0xED, 0xA0, 0xBD, 0xED, 0xB8, 0x80})) == E("#ud83d#ude00"));
    CHECK(JsonWriter::escape(bytes({0xFF})) == E("#ufffd"));
}

static void test_config_parse() {
    AgentConfig def = parse_config("");
    CHECK(def.port == 8080);
    CHECK(def.bci == false);
    CHECK(!def.deny.empty());  // built-in type denylist applied

    AgentConfig cfg = parse_config("host=h,port=9090,bci=true,bci_packages=com.x;com.y,depth=5");
    CHECK(cfg.host == "h");
    CHECK(cfg.port == 9090);
    CHECK(cfg.bci == true);
    CHECK(cfg.depth == 5);
    CHECK(cfg.bci_packages.size() == 2);
}

static void test_yaml_parse() {
    // Scalars, block sequence, inline flow sequence, comments, quoted values.
    const char* yaml =
        "# jvmscout settings\n"
        "host: collector.internal   # trailing comment\n"
        "port: 9090\n"
        "bci: true\n"
        "deployment: \"checkout\"\n"
        "bci_packages:\n"
        "  - com.acme\n"
        "  - com.acme.payments\n"
        "capture_packages: [com.x, com.y, com.z]\n";
    AgentConfig cfg = parse_config("");   // start from defaults
    parse_yaml_config(yaml, cfg);
    CHECK(cfg.host == "collector.internal");
    CHECK(cfg.port == 9090);
    CHECK(cfg.bci == true);
    CHECK(cfg.deployment == "checkout");          // quotes stripped
    CHECK(cfg.bci_packages.size() == 2);
    CHECK(cfg.bci_packages[1] == "com.acme.payments");
    CHECK(cfg.capture_packages.size() == 3);      // inline flow sequence
    CHECK(cfg.capture_packages[2] == "com.z");
}

static void test_build_config_precedence() {
    // Write a temp YAML file and point JVMSCOUT_CONFIG at it.
    std::string dir;
    if (const char* t = std::getenv("TMP")) dir = t;
    else if (const char* t2 = std::getenv("TMPDIR")) dir = t2;
    else dir = "/tmp";
    if (!dir.empty() && dir.back() != '/' && dir.back() != '\\') dir += '/';
    std::string path = dir + "jvmscout_test.yaml";
    {
        std::ofstream f(path);
        f << "host: from_file\nport: 1111\ndeployment: file_dep\n";
    }
    set_env("JVMSCOUT_CONFIG", path.c_str());
    unset_env("JVMSCOUT_HOST");
    unset_env("JVMSCOUT_DEPLOYMENT");

    // File only.
    AgentConfig a = build_config("");
    CHECK(a.host == "from_file");
    CHECK(a.port == 1111);
    CHECK(a.deployment == "file_dep");

    // Env overrides file.
    set_env("JVMSCOUT_DEPLOYMENT", "env_dep");
    AgentConfig b = build_config("");
    CHECK(b.deployment == "env_dep");
    CHECK(b.host == "from_file");          // untouched key still from file

    // agentpath option overrides both env and file.
    AgentConfig c = build_config("host=from_opt,deployment=opt_dep");
    CHECK(c.host == "from_opt");
    CHECK(c.deployment == "opt_dep");
    CHECK(c.port == 1111);                 // untouched key still from file

    unset_env("JVMSCOUT_CONFIG");
    unset_env("JVMSCOUT_DEPLOYMENT");
    std::remove(path.c_str());

    // No file / no env: identical to parse_config (defaults + options).
    AgentConfig d = build_config("port=7777");
    CHECK(d.port == 7777);
    CHECK(d.host == "localhost");
    CHECK(!d.deny.empty());                // built-in defaults still applied
}

static void test_redact_matches() {
    std::vector<std::string> pats = {"password", "secret", "token"};
    CHECK(redact_matches(pats, "userPassword") == true);   // case-insensitive substring
    CHECK(redact_matches(pats, "SECRET_KEY") == true);
    CHECK(redact_matches(pats, "username") == false);
    CHECK(redact_matches({}, "password") == false);        // no patterns -> never redact
}

// --- async queue / collector-down behavior --------------------------------

// Controllable in-memory transport. `up` toggles collector availability;
// `delivered` counts events in successfully-sent batches (each test event is
// the single token "x", so the count is the number of 'x' bytes in the body).
class FakeTransport : public ITransport {
public:
    std::atomic<bool> up{true};
    std::atomic<int> send_calls{0};
    std::atomic<int> delivered{0};
    bool send(const std::string& body) override {
        send_calls.fetch_add(1, std::memory_order_relaxed);
        if (!up.load()) return false;
        int n = 0;
        for (char c : body) if (c == 'x') ++n;
        delivered.fetch_add(n, std::memory_order_relaxed);
        return true;
    }
    const char* name() const override { return "fake"; }
};

static void poll_until(const std::function<bool()>& done, int max_ms) {
    for (int waited = 0; waited < max_ms && !done(); waited += 10)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
}

// Producer never blocks on I/O; at capacity events are dropped and counted.
static void test_async_queue_bounded_drops() {
    FakeTransport t;
    AsyncQueue q(&t, "test");  // worker intentionally NOT started -> nothing drains
    size_t ok = 0;
    for (size_t i = 0; i < AsyncQueue::kMaxQueue + 100; ++i)
        if (q.enqueue("x")) ++ok;
    CHECK(ok == AsyncQueue::kMaxQueue);       // bounded at capacity
    CHECK(q.dropped() == 100);                // overflow is counted, not lost silently
    CHECK(t.send_calls.load() == 0);          // no worker -> no I/O attempted
}

// Collector down: the throwing thread keeps running (enqueue returns fast) and
// the worker retries without dropping anything while under capacity.
static void test_async_queue_no_drop_during_outage() {
    FakeTransport t;
    t.up = false;  // collector unreachable
    AsyncQueue q(&t, "test");
    q.start();

    const int N = 50;  // well under kMaxQueue
    for (int i = 0; i < N; ++i) CHECK(q.enqueue("x"));  // none of these block

    poll_until([&] { return t.send_calls.load() >= 1; }, 3000);
    CHECK(t.send_calls.load() >= 1);  // worker attempted delivery
    CHECK(q.dropped() == 0);          // under capacity -> requeued, not dropped
    q.stop();
}

// Collector up: enqueued events are batched and delivered, none dropped.
static void test_async_queue_delivers_when_up() {
    FakeTransport t;  // up by default
    AsyncQueue q(&t, "test");
    q.start();

    const int N = AsyncQueue::kBatchSize;  // exactly one batch -> immediate flush
    for (int i = 0; i < N; ++i) CHECK(q.enqueue("x"));

    poll_until([&] { return t.delivered.load() >= N; }, 5000);
    CHECK(t.delivered.load() == N);
    CHECK(q.dropped() == 0);
    q.stop();
}

int main() {
    test_fingerprint();
    test_filters();
    test_sampler_tiers();
    test_sampler_lru_bound();
    test_json_escape();
    test_config_parse();
    test_yaml_parse();
    test_build_config_precedence();
    test_redact_matches();
    test_async_queue_bounded_drops();
    test_async_queue_no_drop_during_outage();
    test_async_queue_delivers_when_up();
    if (g_fail == 0) std::printf("ALL %s\n", "PASS");
    else std::printf("%d CHECK(S) FAILED\n", g_fail);
    return g_fail ? 1 : 0;
}
