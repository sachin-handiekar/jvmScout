// This module used to expose a Supabase client. The app now talks to the
// JVMTI Python collector via a Supabase-compatible adapter, so every existing
// `supabase.from(...)` call keeps working unchanged. See
// `@/integrations/collector/adapter`.
import { collectorClient } from "@/integrations/collector/adapter";

export const supabase = collectorClient;
