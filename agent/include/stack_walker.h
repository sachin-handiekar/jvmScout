#ifndef JVMTI_AGENT_STACK_WALKER_H
#define JVMTI_AGENT_STACK_WALKER_H

#include <jvmti.h>
#include <vector>

#include "event_model.h"

class ObjectInspector;
class IFilter;
class BciShadow;

// Walks the current thread's stack (top-down, <=100 frames) inside the
// Exception callback. For each frame resolves class/method/line/source and,
// when capturing FULL, reads local variables via the JVMTI Local Variable
// Table (source = "debug_info"); degrades to slot-only entries without -g.
class StackWalker {
public:
    static constexpr jint kMaxFrames = 100;
    // REDUCED mode keeps only the top frames (no locals) so it is materially
    // cheaper than FULL under an exception storm.
    static constexpr jint kReducedFrames = 8;

    StackWalker(jvmtiEnv* jvmti, const ObjectInspector* inspector,
                const IFilter* location_filter, BciShadow* shadow = nullptr)
        : jvmti_(jvmti), inspector_(inspector),
          location_filter_(location_filter), shadow_(shadow) {}

    // capture_locals=false for REDUCED mode (frames only, no variable reads).
    // max_frames caps how many frames are fetched/resolved (defaults to the full
    // limit); REDUCED passes kReducedFrames.
    std::vector<StackFrame> walk(JNIEnv* jni, jthread thread, bool capture_locals,
                                 jint max_frames = kMaxFrames);

private:
    void capture_frame_locals(JNIEnv* jni, jthread thread, jint depth,
                              jmethodID method, StackFrame& frame);

    jvmtiEnv* jvmti_;
    const ObjectInspector* inspector_;
    const IFilter* location_filter_;
    BciShadow* shadow_;
};

#endif  // JVMTI_AGENT_STACK_WALKER_H
