#ifndef JVMTI_AGENT_EVENT_SERIALIZER_H
#define JVMTI_AGENT_EVENT_SERIALIZER_H

#include <string>

#include "event_model.h"

// Serialize a captured exception event to a single JSON object string matching
// the collector wire schema (PLAN.md section 4.3). Standalone (no JVMTI calls)
// so it can run off the event thread.
std::string serialize_event(const CapturedEvent& ev);

#endif  // JVMTI_AGENT_EVENT_SERIALIZER_H
