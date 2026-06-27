import { createMiddleware } from '@tanstack/react-start'

// The app no longer uses Supabase auth or server functions — it talks to the
// JVMTI collector directly from the client with an API key. This middleware is
// kept as a no-op so the existing start.ts registration stays valid.
export const attachSupabaseAuth = createMiddleware({ type: 'function' }).client(
  async ({ next }) => next(),
)
