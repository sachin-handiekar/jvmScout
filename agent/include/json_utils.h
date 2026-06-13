#ifndef JVMTI_AGENT_JSON_UTILS_H
#define JVMTI_AGENT_JSON_UTILS_H

#include <string>
#include <cstdint>

// Minimal zero-dependency JSON writer. Keeps comma/brace bookkeeping so the
// serializer can stay declarative. Not a general-purpose library: it assumes
// the caller emits well-formed structure (every begin has a matching end).
class JsonWriter {
public:
    static std::string escape(const std::string& s);

    JsonWriter& begin_object();
    JsonWriter& end_object();
    JsonWriter& begin_array();
    JsonWriter& end_array();

    // Key for the next value inside an object.
    JsonWriter& key(const std::string& k);

    // Standalone values (used inside arrays).
    JsonWriter& value_string(const std::string& v);
    JsonWriter& value_int(long long v);
    JsonWriter& value_uint(unsigned long long v);
    JsonWriter& value_bool(bool v);
    JsonWriter& value_null();
    JsonWriter& value_raw(const std::string& raw);  // already-valid JSON

    // key + value convenience helpers.
    JsonWriter& field(const std::string& k, const std::string& v);
    JsonWriter& field(const std::string& k, const char* v);
    JsonWriter& field(const std::string& k, long long v);
    JsonWriter& field(const std::string& k, int v);
    JsonWriter& field(const std::string& k, unsigned long long v);
    JsonWriter& field(const std::string& k, bool v);
    JsonWriter& field_null(const std::string& k);

    const std::string& str() const { return out_; }

private:
    void prefix();          // emit a comma if needed before a value/key
    std::string out_;
    bool need_comma_ = false;
    bool after_key_ = false;
};

#endif  // JVMTI_AGENT_JSON_UTILS_H
