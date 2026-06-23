// Zero-dependency unit tests for the agent's pure-logic components (no JNI):
// fingerprint, filters, adaptive sampler (tiering + LRU bound), the JSON
// string escaper (modified-UTF-8 handling), and config parsing.
//
// Built as the `agent_tests` CMake target and run via ctest.

#include "config.h"
#include "fingerprint.h"
#include "ifilter.h"
#include "json_utils.h"
#include "sampling.h"

#include <cstdio>
#include <string>

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

static void test_redact_matches() {
    std::vector<std::string> pats = {"password", "secret", "token"};
    CHECK(redact_matches(pats, "userPassword") == true);   // case-insensitive substring
    CHECK(redact_matches(pats, "SECRET_KEY") == true);
    CHECK(redact_matches(pats, "username") == false);
    CHECK(redact_matches({}, "password") == false);        // no patterns -> never redact
}

int main() {
    test_fingerprint();
    test_filters();
    test_sampler_tiers();
    test_sampler_lru_bound();
    test_json_escape();
    test_config_parse();
    test_redact_matches();
    if (g_fail == 0) std::printf("ALL %s\n", "PASS");
    else std::printf("%d CHECK(S) FAILED\n", g_fail);
    return g_fail ? 1 : 0;
}
