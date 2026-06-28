import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Rocket, ArrowUp, ArrowDown, Minus, AlertTriangle, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/lib/app-context";
import { compactNumber, relativeTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PagePlaceholder";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/deployments")({
  head: () => ({ meta: [{ title: "Deployments — jvmScout" }] }),
  component: DeploymentsPage,
});

type AppRow = { id: string; name: string; environment: "production" | "staging" | "development" };
type DeploymentRow = { id: string; name: string; application_id: string; started_at: string };
type EventRow = {
  id: string;
  application_id: string;
  introduced_by_deployment_id: string | null;
  status: "active" | "resolved" | "hidden";
  hit_count: number;
};

export type DeploymentDelta = {
  deployment: DeploymentRow;
  app: AppRow | undefined;
  prev: DeploymentRow | undefined;
  newErrors: number;
  resolvedErrors: number;
  hitsThis: number;
  hitsPrev: number;
  hitsDelta: number;
  badge: "regression" | "improved" | "stable";
};

export function useDeploymentsData() {
  return useQuery({
    queryKey: ["deployments-page"],
    queryFn: async () => {
      const [apps, deploys, events] = await Promise.all([
        supabase.from("applications").select("id,name,environment"),
        supabase.from("deployments").select("id,name,application_id,started_at"),
        supabase
          .from("events")
          .select("id,application_id,introduced_by_deployment_id,status,hit_count"),
      ]);
      return {
        applications: (apps.data ?? []) as AppRow[],
        deployments: (deploys.data ?? []) as DeploymentRow[],
        events: (events.data ?? []) as EventRow[],
      };
    },
  });
}

export function computeDeltas(
  deployments: DeploymentRow[],
  apps: AppRow[],
  events: EventRow[],
): DeploymentDelta[] {
  const byApp = new Map<string, DeploymentRow[]>();
  for (const d of deployments) {
    const list = byApp.get(d.application_id) ?? [];
    list.push(d);
    byApp.set(d.application_id, list);
  }
  for (const list of byApp.values()) {
    list.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  }
  const appById = new Map(apps.map((a) => [a.id, a]));
  return deployments.map((d) => {
    const series = byApp.get(d.application_id) ?? [];
    const idx = series.findIndex((x) => x.id === d.id);
    const prev = idx > 0 ? series[idx - 1] : undefined;
    const thisEvents = events.filter((e) => e.introduced_by_deployment_id === d.id);
    const prevEvents = prev
      ? events.filter((e) => e.introduced_by_deployment_id === prev.id)
      : [];
    const newErrors = thisEvents.length;
    const resolvedErrors = prevEvents.filter((e) => e.status === "resolved").length;
    const hitsThis = thisEvents.reduce((s, e) => s + (e.hit_count ?? 0), 0);
    const hitsPrev = prevEvents.reduce((s, e) => s + (e.hit_count ?? 0), 0);
    const hitsDelta = hitsThis - hitsPrev;
    const badge: DeploymentDelta["badge"] =
      newErrors > 0 && hitsDelta >= 0
        ? "regression"
        : resolvedErrors > newErrors || hitsDelta < -Math.max(10, hitsPrev * 0.1)
          ? "improved"
          : "stable";
    return {
      deployment: d,
      app: appById.get(d.application_id),
      prev,
      newErrors,
      resolvedErrors,
      hitsThis,
      hitsPrev,
      hitsDelta,
      badge,
    };
  });
}

function DeploymentsPage() {
  const { environment } = useAppContext();
  const { data, isLoading } = useDeploymentsData();

  const rows = useMemo(() => {
    if (!data) return [];
    const all = computeDeltas(data.deployments, data.applications, data.events);
    return all
      .filter((r) => r.app?.environment === environment)
      .sort(
        (a, b) =>
          new Date(b.deployment.started_at).getTime() -
          new Date(a.deployment.started_at).getTime(),
      );
  }, [data, environment]);

  return (
    <>
      <PageHeader
        title="Deployments"
        description="Compare reliability across releases and catch regressions early."
      />
      <div className="p-6">
        <div className="overflow-hidden rounded-lg border border-border bg-panel/40">
          <table className="w-full text-sm">
            <thead className="bg-panel/60 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Deployment</th>
                <th className="px-4 py-2 text-left font-medium">Application</th>
                <th className="px-4 py-2 text-left font-medium">Started</th>
                <th className="px-4 py-2 text-right font-medium">New errors</th>
                <th className="px-4 py-2 text-right font-medium">Resolved</th>
                <th className="px-4 py-2 text-right font-medium">Hit volume Δ</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-t border-border">
                    <td colSpan={7} className="px-4 py-2">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-xs text-muted-foreground">
                    No deployments in this environment.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.deployment.id}
                  className="cursor-pointer border-t border-border hover:bg-accent/30"
                >
                  <td className="px-4 py-3">
                    <Link
                      to="/deployments/$id"
                      params={{ id: r.deployment.id }}
                      className="font-mono text-[13px] text-foreground hover:text-primary"
                    >
                      {r.deployment.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-foreground/80">{r.app?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {relativeTime(r.deployment.started_at)}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-3 text-right font-mono text-xs",
                      r.newErrors > 0 ? "text-[var(--severity-error)]" : "text-muted-foreground",
                    )}
                  >
                    {r.newErrors > 0 ? `+${r.newErrors}` : "0"}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-3 text-right font-mono text-xs",
                      r.resolvedErrors > 0
                        ? "text-[var(--severity-resolved)]"
                        : "text-muted-foreground",
                    )}
                  >
                    {r.resolvedErrors > 0 ? `−${r.resolvedErrors}` : "0"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <HitDelta delta={r.hitsDelta} />
                  </td>
                  <td className="px-4 py-3">
                    <DeployBadge badge={r.badge} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export function HitDelta({ delta }: { delta: number }) {
  const isUp = delta > 0;
  const isDown = delta < 0;
  const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
  const color = isUp
    ? "text-[var(--severity-error)]"
    : isDown
      ? "text-[var(--severity-resolved)]"
      : "text-muted-foreground";
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono text-xs", color)}>
      <Icon className="h-3 w-3" />
      {delta === 0 ? "0" : compactNumber(Math.abs(delta))}
    </span>
  );
}

export function DeployBadge({ badge }: { badge: DeploymentDelta["badge"] }) {
  if (badge === "regression")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--severity-error)]/30 bg-[var(--severity-error)]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--severity-error)]">
        <AlertTriangle className="h-3 w-3" /> Regression
      </span>
    );
  if (badge === "improved")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--severity-resolved)]/30 bg-[var(--severity-resolved)]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--severity-resolved)]">
        <CheckCircle2 className="h-3 w-3" /> Improved
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      <Rocket className="h-3 w-3" /> Stable
    </span>
  );
}
