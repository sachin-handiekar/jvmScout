#include "stack_walker.h"

#include "bci_shadow.h"
#include "config.h"
#include "ifilter.h"
#include "object_inspector.h"
#include "jvmti_utils.h"

#include <cstdio>
#include <string>

namespace {

bool location_in_scope(jlocation loc, const jvmtiLocalVariableEntry& e) {
    return loc >= e.start_location &&
           loc < e.start_location + static_cast<jlocation>(e.length);
}

std::string render_primitive_or_object(jvmtiEnv* jvmti, JNIEnv* jni,
                                        const ObjectInspector* inspector,
                                        jthread thread, jint depth, jint slot,
                                        const std::string& sig) {
    if (sig.empty()) return "?";
    char kind = sig[0];
    char buf[64];
    switch (kind) {
        case 'L':
        case '[': {
            jobject obj = nullptr;
            if (jvmti->GetLocalObject(thread, depth, slot, &obj) == JVMTI_ERROR_NONE) {
                std::string v = inspector->render(jni, obj);
                if (obj) jni->DeleteLocalRef(obj);
                return v;
            }
            return "<unavailable>";
        }
        case 'Z': {
            jint v;
            if (jvmti->GetLocalInt(thread, depth, slot, &v) == JVMTI_ERROR_NONE)
                return v ? "true" : "false";
            return "<unavailable>";
        }
        case 'C': {
            jint v;
            if (jvmti->GetLocalInt(thread, depth, slot, &v) == JVMTI_ERROR_NONE) {
                std::snprintf(buf, sizeof(buf), "%d", v);
                return buf;
            }
            return "<unavailable>";
        }
        case 'B':
        case 'S':
        case 'I': {
            jint v;
            if (jvmti->GetLocalInt(thread, depth, slot, &v) == JVMTI_ERROR_NONE)
                return std::to_string(v);
            return "<unavailable>";
        }
        case 'J': {
            jlong v;
            if (jvmti->GetLocalLong(thread, depth, slot, &v) == JVMTI_ERROR_NONE)
                return std::to_string(v);
            return "<unavailable>";
        }
        case 'F': {
            jfloat v;
            if (jvmti->GetLocalFloat(thread, depth, slot, &v) == JVMTI_ERROR_NONE) {
                std::snprintf(buf, sizeof(buf), "%g", static_cast<double>(v));
                return buf;
            }
            return "<unavailable>";
        }
        case 'D': {
            jdouble v;
            if (jvmti->GetLocalDouble(thread, depth, slot, &v) == JVMTI_ERROR_NONE) {
                std::snprintf(buf, sizeof(buf), "%g", v);
                return buf;
            }
            return "<unavailable>";
        }
        default:
            return "?";
    }
}

}  // namespace

void StackWalker::capture_frame_locals(JNIEnv* jni, jthread thread, jint depth,
                                       jmethodID method, StackFrame& frame) {
    jint count = 0;
    jvmtiLocalVariableEntry* table = nullptr;
    jvmtiError err = jvmti_->GetLocalVariableTable(method, &count, &table);
    if (err != JVMTI_ERROR_NONE || table == nullptr) {
        // No debug info (no -g). Fall back to BCI shadow-captured locals.
        if (shadow_ && shadow_->ready()) {
            shadow_->read_frame(jni, depth, frame.locals);
        }
        return;
    }

    // We need the current location in this frame to scope variables. Re-read it
    // via GetFrameLocation for the given depth.
    jmethodID fm;
    jlocation loc = 0;
    if (jvmti_->GetFrameLocation(thread, depth, &fm, &loc) != JVMTI_ERROR_NONE) {
        loc = 0;
    }

    for (jint i = 0; i < count; ++i) {
        const jvmtiLocalVariableEntry& e = table[i];
        if (!location_in_scope(loc, e)) continue;

        LocalVariable lv;
        lv.name = e.name ? e.name : "";
        lv.signature = e.signature ? e.signature : "";
        lv.slot = e.slot;
        lv.source = "debug_info";
        lv.value = render_primitive_or_object(jvmti_, jni, inspector_, thread,
                                              depth, e.slot, lv.signature);
        frame.locals.push_back(std::move(lv));
    }

    // Free the table and its strings.
    for (jint i = 0; i < count; ++i) {
        jvmti_->Deallocate(reinterpret_cast<unsigned char*>(table[i].name));
        jvmti_->Deallocate(reinterpret_cast<unsigned char*>(table[i].signature));
        jvmti_->Deallocate(reinterpret_cast<unsigned char*>(table[i].generic_signature));
    }
    jvmti_->Deallocate(reinterpret_cast<unsigned char*>(table));
}

std::vector<StackFrame> StackWalker::walk(JNIEnv* jni, jthread thread,
                                          bool capture_locals, jint max_frames) {
    std::vector<StackFrame> frames;
    jvmtiFrameInfo info[kMaxFrames];
    jint want = (max_frames > 0 && max_frames < kMaxFrames) ? max_frames : kMaxFrames;
    jint count = 0;
    if (jvmti_->GetStackTrace(thread, 0, want, info, &count) != JVMTI_ERROR_NONE) {
        return frames;
    }

    for (jint i = 0; i < count; ++i) {
        StackFrame frame;
        frame.frame_index = i;

        jmethodID method = info[i].method;
        char* mname = nullptr;
        char* msig = nullptr;
        if (jvmti_->GetMethodName(method, &mname, &msig, nullptr) == JVMTI_ERROR_NONE) {
            frame.method_name = mname ? mname : "";
            JvmtiString freeName(jvmti_, mname);
            JvmtiString freeSig(jvmti_, msig);
        }

        jclass decl = nullptr;
        std::string class_sig;
        if (jvmti_->GetMethodDeclaringClass(method, &decl) == JVMTI_ERROR_NONE && decl) {
            char* csig = nullptr;
            if (jvmti_->GetClassSignature(decl, &csig, nullptr) == JVMTI_ERROR_NONE) {
                JvmtiString freeCsig(jvmti_, csig);
                class_sig = csig ? csig : "";
            }
            char* src = nullptr;
            if (jvmti_->GetSourceFileName(decl, &src) == JVMTI_ERROR_NONE) {
                JvmtiString freeSrc(jvmti_, src);
                frame.source_file = src ? src : "";
            }
        }
        frame.class_name = signature_to_dotted(class_sig);
        frame.line_number = resolve_line_number(jvmti_, method, info[i].location);

        std::string slash = signature_to_slash(class_sig);
        frame.app_code = location_filter_ ? location_filter_->accept(slash) : true;

        if (capture_locals && frame.app_code) {
            capture_frame_locals(jni, thread, i, method, frame);
            // Mask sensitive values by variable name (covers both the
            // debug_info and bci_shadow locals just populated) so secrets never
            // leave the JVM.
            if (redact_props_ && !redact_props_->empty()) {
                for (auto& lv : frame.locals) {
                    if (!lv.name.empty() && redact_matches(*redact_props_, lv.name)) {
                        lv.value = "***";
                    }
                }
            }
        }

        frames.push_back(std::move(frame));
    }
    return frames;
}
