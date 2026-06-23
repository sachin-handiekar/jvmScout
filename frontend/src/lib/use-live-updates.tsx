import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { connectLiveSocket, invalidateCache } from "@/integrations/collector/client";

// Opens the collector's /ws/live WebSocket and, when an exception (or
// agent_start) is broadcast, busts the client-side derive cache and invalidates
// react-query so active screens refetch — giving the dashboard/events near
// real-time updates instead of waiting for a manual refetch.
//
// Refreshes are debounced so an exception storm can't trigger a refetch storm,
// and the socket reconnects with a fixed backoff if it drops.
export function useLiveUpdates(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleRefresh = () => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        invalidateCache(); // drop the short-lived derive cache so refetch sees new data
        void qc.invalidateQueries();
      }, 800);
    };

    const open = () => {
      if (closed) return;
      ws = connectLiveSocket((msg) => {
        if (msg && (msg.kind === "exception" || msg.kind === "agent_start")) {
          scheduleRefresh();
        }
      });
      if (!ws) {
        // Couldn't construct the socket (e.g. SSR/no window) — try again later.
        reconnectTimer = setTimeout(open, 5000);
        return;
      }
      ws.onclose = () => {
        if (!closed) reconnectTimer = setTimeout(open, 3000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };
    };

    open();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, [qc]);
}
