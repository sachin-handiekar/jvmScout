import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { getApiKey, setApiKey, verifyApiKey } from "@/integrations/collector/client";

// Auth is the collector's API key (sent as X-API-Key). When the collector runs
// without COLLECTOR_API_KEY set, any/empty key is accepted and the app signs in
// automatically. The context shape is unchanged from the previous mock so the
// rest of the UI (AppShell, _authenticated guard, login page) is untouched.

type User = { email: string; name: string };
type AuthCtx = {
  user: User | null;
  ready: boolean;
  /** Sign in with a collector API key (empty string is valid for open collectors). Throws on a bad key. */
  login: (apiKey: string) => Promise<void>;
  logout: () => void;
};

const Ctx = createContext<AuthCtx>({
  user: null,
  ready: false,
  login: async () => {},
  logout: () => {},
});

function userFor(apiKey: string | null): User {
  const masked = apiKey ? `key ••••${apiKey.slice(-4)}` : "unauthenticated";
  return { name: "Operator", email: masked };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // On boot, probe the collector. If it accepts us (open collector, or a valid
  // stored key), sign in automatically; otherwise fall through to the login page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (await verifyApiKey()) {
          if (!cancelled) setUser(userFor(getApiKey()));
        }
      } catch {
        // collector unreachable — leave signed out so the login page shows.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = async (apiKey: string) => {
    setApiKey(apiKey || null);
    const ok = await verifyApiKey();
    if (!ok) {
      setApiKey(null);
      throw new Error("The collector rejected that API key.");
    }
    setUser(userFor(apiKey || null));
  };

  const logout = () => {
    setApiKey(null);
    setUser(null);
  };

  return <Ctx.Provider value={{ user, ready, login, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
