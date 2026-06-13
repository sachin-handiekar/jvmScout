#include "jvmti_utils.h"

int resolve_line_number(jvmtiEnv* jvmti, jmethodID method, jlocation location) {
    if (location < 0) return -1;
    jint count = 0;
    jvmtiLineNumberEntry* table = nullptr;
    jvmtiError err = jvmti->GetLineNumberTable(method, &count, &table);
    if (err != JVMTI_ERROR_NONE || table == nullptr) {
        return -1;  // no -g, native method, or absent table
    }
    int line = -1;
    // Entries are ordered by start_location; pick the last one that starts at
    // or before our location.
    for (jint i = 0; i < count; ++i) {
        if (table[i].start_location <= location) {
            line = table[i].line_number;
        } else {
            break;
        }
    }
    jvmti->Deallocate(reinterpret_cast<unsigned char*>(table));
    return line;
}

std::string signature_to_dotted(const std::string& sig) {
    // "Lcom/foo/Bar;" -> "com.foo.Bar"; arrays/primitives passed through best-effort.
    if (sig.size() >= 2 && sig.front() == 'L' && sig.back() == ';') {
        std::string s = sig.substr(1, sig.size() - 2);
        for (char& c : s) {
            if (c == '/') c = '.';
        }
        return s;
    }
    return sig;
}

std::string signature_to_slash(const std::string& sig) {
    // "Lcom/foo/Bar;" -> "com/foo/Bar".
    if (sig.size() >= 2 && sig.front() == 'L' && sig.back() == ';') {
        return sig.substr(1, sig.size() - 2);
    }
    return sig;
}
