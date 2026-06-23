#include "json_utils.h"

#include <cstdint>
#include <cstdio>

namespace {

// Append one UTF-16 code unit to the output as JSON. Printable ASCII passes
// through; everything else (controls, surrogates, BMP non-ASCII) is \u-escaped,
// which keeps the output pure-ASCII and always valid JSON.
void append_unit(std::string& out, uint32_t u) {
    switch (u) {
        case '"':  out += "\\\""; return;
        case '\\': out += "\\\\"; return;
        case '\b': out += "\\b";  return;
        case '\f': out += "\\f";  return;
        case '\n': out += "\\n";  return;
        case '\r': out += "\\r";  return;
        case '\t': out += "\\t";  return;
    }
    if (u >= 0x20 && u < 0x7F) {
        out += static_cast<char>(u);
        return;
    }
    char buf[8];
    std::snprintf(buf, sizeof(buf), "\\u%04x", u & 0xFFFFu);
    out += buf;
}

}  // namespace

// Strings from JNI/JVMTI are *modified* UTF-8: an embedded NUL is 0xC0 0x80 and
// supplementary characters are a surrogate pair, each encoded as a 3-byte form
// (so no 4-byte sequences). Emitted verbatim those are invalid standard UTF-8
// and break the collector's JSON decode. Decode to UTF-16 code units and emit
// JSON \u escapes; surrogate halves naturally become a valid JSON pair. Invalid
// bytes degrade to U+FFFD so the output is always well-formed.
std::string JsonWriter::escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    const unsigned char* p = reinterpret_cast<const unsigned char*>(s.data());
    const size_t n = s.size();
    size_t i = 0;
    while (i < n) {
        const unsigned char b0 = p[i];
        uint32_t unit;
        if (b0 < 0x80) {
            unit = b0;
            i += 1;
        } else if ((b0 & 0xE0) == 0xC0 && i + 1 < n && (p[i + 1] & 0xC0) == 0x80) {
            unit = ((b0 & 0x1Fu) << 6) | (p[i + 1] & 0x3Fu);
            i += 2;
        } else if ((b0 & 0xF0) == 0xE0 && i + 2 < n &&
                   (p[i + 1] & 0xC0) == 0x80 && (p[i + 2] & 0xC0) == 0x80) {
            unit = ((b0 & 0x0Fu) << 12) | ((p[i + 1] & 0x3Fu) << 6) | (p[i + 2] & 0x3Fu);
            i += 3;
        } else {
            unit = 0xFFFD;  // invalid lead/continuation byte
            i += 1;
        }
        append_unit(out, unit);
    }
    return out;
}

void JsonWriter::prefix() {
    if (after_key_) {
        after_key_ = false;
        return;
    }
    if (need_comma_) out_ += ',';
}

JsonWriter& JsonWriter::begin_object() {
    prefix();
    out_ += '{';
    need_comma_ = false;
    return *this;
}

JsonWriter& JsonWriter::end_object() {
    out_ += '}';
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::begin_array() {
    prefix();
    out_ += '[';
    need_comma_ = false;
    return *this;
}

JsonWriter& JsonWriter::end_array() {
    out_ += ']';
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::key(const std::string& k) {
    prefix();
    out_ += '"';
    out_ += escape(k);
    out_ += "\":";
    after_key_ = true;
    return *this;
}

JsonWriter& JsonWriter::value_string(const std::string& v) {
    prefix();
    out_ += '"';
    out_ += escape(v);
    out_ += '"';
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::value_int(long long v) {
    prefix();
    out_ += std::to_string(v);
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::value_uint(unsigned long long v) {
    prefix();
    out_ += std::to_string(v);
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::value_bool(bool v) {
    prefix();
    out_ += v ? "true" : "false";
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::value_null() {
    prefix();
    out_ += "null";
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::value_raw(const std::string& raw) {
    prefix();
    out_ += raw;
    need_comma_ = true;
    return *this;
}

JsonWriter& JsonWriter::field(const std::string& k, const std::string& v) {
    return key(k).value_string(v);
}
JsonWriter& JsonWriter::field(const std::string& k, const char* v) {
    return key(k).value_string(v ? v : "");
}
JsonWriter& JsonWriter::field(const std::string& k, long long v) {
    return key(k).value_int(v);
}
JsonWriter& JsonWriter::field(const std::string& k, int v) {
    return key(k).value_int(v);
}
JsonWriter& JsonWriter::field(const std::string& k, unsigned long long v) {
    return key(k).value_uint(v);
}
JsonWriter& JsonWriter::field(const std::string& k, bool v) {
    return key(k).value_bool(v);
}
JsonWriter& JsonWriter::field_null(const std::string& k) {
    return key(k).value_null();
}
