#include "json_utils.h"

#include <cstdio>

std::string JsonWriter::escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
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
