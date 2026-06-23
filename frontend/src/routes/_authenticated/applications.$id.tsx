import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  ArrowLeft,
  Server as ServerIcon,
  AlertOctagon,
  Rocket,
  CircleAlert,
  CircleCheck,
  CircleSlash,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PagePlaceholder";
import { compactNumber, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { computeAppHealth, HealthPill, EnvPill } from "./applications";
import { computeDeltas, HitDelta, DeployBadge } from "./deployments";
import { useAppContext } from "@/lib/app-context";

export const Route = createFileRoute("/_authenticated/applications/$id")({
  head: () => ({ meta: [{ title: "Application — Stackline" }] }),
  component: ApplicationDetailPage,
});

type AppRow = { id: string; name: string; environment: "production" | "staging" | "development" };
type EventRow = {
  id: string;
  type: string;
  name: string;
  location: string;
  severity: "critical" | "error" | "warning" | "info";
  status: "active" | "resolved" | "hidden";
  hit_count: number;
  last_seen: string;
  application_id: string;
  introduced_by_deployment_id: string | null;
};
type ServerRow = {
  id: string;
  hostname: string;
  agent_version: string;
  status: "active" | "dormant" | "offline";
  last_seen: string;
  application_id: string;
};
type DeploymentRow = { id: string; name: string; application_id: string; started_at: string };

const RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  custom: 24 * 60 * 60 * 1000,
};

function ApplicationDetailPage() {
  const { id } = Route.useParams();
  const { timeRange } = useAppContext();
  const { data, isLoading } = useQuery({
    queryKey: ["application-detail", id],
    queryFn: async () => {
      const [appsQ, eventsQ, serversQ, deploysQ] = await Promise.all([
        supabase.from("applications").select("id,name,environment"),
        supabase
          .from("events")
          .select(
            "id,type,name,location,severity,status,hit_count,last_seen,first_seen,application_id,introduced_by_deployment_id",
          ),
        supabase
          .from("servers")
          .select("id,hostname,agent_version,status,last_seen,application_id"),
        supabase.from("deployments").select("id,name,application_id,started_at"),
      ]);
      return {
        applications: (appsQ.data ?? []) as AppRow[],
        events: (eventsQ.data ?? []) as (EventRow & { first_seen: string })[],
        servers: (serversQ.data ?? []) as ServerRow[],
        deployments: (deploysQ.data ?? []) as DeploymentRow[],
      };
    },
  });

  const view = useMemo(() => {
    if (!data) return null;
    const app = data.applications.find((a) => a.id === id);
    if (!app) return null;
    const events = data.events.filter((e) => e.application_id === id);
    const servers = data.servers.filter((s) => s.application_id === id);
    const latestVersion = data.servers
      .map((s) => s.agent_version)
      .sort(compareSemver)
      .at(-1) ?? "0.0.0";
    const active = events.filter((e) => e.status === "active");
    const totalHits = active.reduce((s, e) => s + (e.hit_count ?? 0), 0);
    const health = computeAppHealth(events);
    const since = Date.now() - (RANGE_MS[timeRange] ?? RANGE_MS["24h"]);
    const newEvents = events.filter(
      (e) => new Date(e.first_seen ?? e.last_seen).getTime() >= since,
    ).length;
    const appDeployments = data.deployments
      .filter((d) => d.application_id === id)
      .sort(
        (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
      );
    const latestDeployment = appDeployments[0] ?? null;
    const serverStats = {
      total: servers.length,
      active: servers.filter((s) => s.status === "active").length,
      dormant: servers.filter((s) => s.status === "dormant").length,
      offline: servers.filter((s) => s.status === "offline").length,
    };
    const deltas = computeDeltas(data.deployments, data.applications, data.events).filter(
      (d) => d.app?.id === id,
    );
    return {
      app,
      events,
      servers,
      latestVersion,
      active,
      totalHits,
      health,
      deltas,
      newEvents,
      latestDeployment,
      serverStats,
    };
  }, [data, id, timeRange]);

  if (isLoading) {
    return (
      <>
        <PageHeader title="Application" />
        <div className="space-y-4 p-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    );
  }
  if (!view) throw notFound();

  return (
    <>
      <PageHeader
        title={view.app.name}
        description={
          <span className="flex items-center gap-2">
            <EnvPill env={view.app.environment} />
            <HealthPill health={view.health} />
          </span>
        }
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/applications">
              <ArrowLeft className="mr-1 h-3.5 w-3.5" /> All applications
            </Link>
          </Button>
        }
      />
      <div className="space-y-6 p-6">
        {/* KPIs */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Active events">
            <span
              className={cn(
                "font-mono text-2xl",
                view.active.length > 0 ? "text-[var(--severity-error)]" : "text-muted-foreground",
              )}
            >
              {view.active.length}
            </span>
          </Stat>
          <Stat label="Error volume">
            <span className="font-mono text-2xl">{compactNumber(view.totalHits)}</span>
          </Stat>
          <Stat label={`New events · ${timeRange}`}>
            <span
              className={cn(
                "font-mono text-2xl",
                view.newEvents > 0 ? "text-[var(--severity-warning)]" : "text-muted-foreground",
              )}
            >
              {view.newEvents}
            </span>
          </Stat>
          <Stat label="Servers reporting">
            <span className="font-mono text-2xl">{view.servers.length}</span>
          </Stat>
          <Stat label="Latest deployment">
            {view.latestDeployment ? (
              <Link
                to="/deployments/$id"
                params={{ id: view.latestDeployment.id }}
                className="block truncate font-mono text-sm text-foreground hover:text-primary"
                title={view.latestDeployment.name}
              >
                {view.latestDeployment.name}
                <span className="ml-1 text-[10px] text-muted-foreground">
                  · {relativeTime(view.latestDeployment.started_at)}
                </span>
              </Link>
            ) : (
              <span className="font-mono text-sm text-muted-foreground">—</span>
            )}
          </Stat>
        </div>


        <Tabs defaultValue="events" className="w-full">
          <TabsList>
            <TabsTrigger value="events" className="gap-1.5">
              <AlertOctagon className="h-3.5 w-3.5" /> Events
            </TabsTrigger>
            <TabsTrigger value="servers" className="gap-1.5">
              <ServerIcon className="h-3.5 w-3.5" /> Servers / Agents
            </TabsTrigger>
            <TabsTrigger value="deployments" className="gap-1.5">
              <Rocket className="h-3.5 w-3.5" /> Deployments
            </TabsTrigger>
          </TabsList>

          {/* Events */}
          <TabsContent value="events" className="mt-4">
            <EventsForApp appId={view.app.id} events={view.events} />
          </TabsContent>

          {/* Servers */}
          <TabsContent value="servers" className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-3 px-1 font-mono text-[11px] text-muted-foreground">
              <span className="text-foreground">{view.serverStats.total} servers</span>
              <span>·</span>
              <span className="text-[var(--severity-resolved)]">
                {view.serverStats.active} active
              </span>
              <span>·</span>
              <span className="text-[var(--severity-warning)]">
                {view.serverStats.dormant} dormant
              </span>
              <span>·</span>
              <span className="text-[var(--severity-error)]">
                {view.serverStats.offline} offline
              </span>
            </div>
            <ServersTable servers={view.servers} latestVersion={view.latestVersion} />
          </TabsContent>


          {/* Deployments */}
          <TabsContent value="deployments" className="mt-4">
            <DeploymentsForApp deltas={view.deltas} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-panel/40 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function EventsForApp({ appId, events }: { appId: string; events: EventRow[] }) {
  const rows = events
    .filter((e) => e.status === "active")
    .slice()
    .sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime());

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Active events ({rows.length})
        </h3>
        <Button variant="ghost" size="sm" asChild>
          <Link
            to="/events"
            search={{
              q: "",
              type: "",
              severity: "",
              status: "",
              app: appId,
              deployment: "",
              server: "",
              chip: "",
              sort: "last_seen",
              dir: "desc",
            }}
            className="text-xs"
          >
            Open in full Events view →
          </Link>
        </Button>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-xs text-muted-foreground">
          No active events for this application.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-panel/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Event</th>
              <th className="px-4 py-2 text-left font-medium">Location</th>
              <th className="px-4 py-2 text-left font-medium">Severity</th>
              <th className="px-4 py-2 text-right font-medium">Hits</th>
              <th className="px-4 py-2 text-left font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 25).map((e) => (
              <tr key={e.id} className="border-t border-border hover:bg-accent/30">
                <td className="px-4 py-2">
                  <Link
                    to="/events/$id"
                    params={{ id: e.id }}
                    className="font-mono text-[13px] text-foreground hover:text-primary"
                  >
                    {e.name}
                  </Link>
                </td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                  {e.location}
                </td>
                <td className="px-4 py-2">
                  <SeverityChip severity={e.severity} />
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs">
                  {compactNumber(e.hit_count)}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {relativeTime(e.last_seen)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ServersTable({
  servers,
  latestVersion,
}: {
  servers: ServerRow[];
  latestVersion: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel/40">
      <table className="w-full text-sm">
        <thead className="bg-panel/60 text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Host</th>
            <th className="px-4 py-2 text-left font-medium">Agent</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
            <th className="px-4 py-2 text-left font-medium">Last seen</th>
            <th className="px-4 py-2 text-left font-medium">Flags</th>
          </tr>
        </thead>
        <tbody>
          {servers.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-xs text-muted-foreground">
                No agents reporting for this application.
              </td>
            </tr>
          )}
          {servers.map((s) => {
            const outdated = compareSemver(s.agent_version, latestVersion) < 0;
            const isDown = s.status === "offline" || s.status === "dormant";
            return (
              <tr key={s.id} className="border-t border-border hover:bg-accent/30">
                <td className="px-4 py-2 font-mono text-[13px]">{s.hostname}</td>
                <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                  v{s.agent_version}
                </td>
                <td className="px-4 py-2">
                  <ServerStatusPill status={s.status} />
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  {relativeTime(s.last_seen)}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {outdated && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--severity-warning)]/30 bg-[var(--severity-warning)]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--severity-warning)]">
                        Update available · v{latestVersion}
                      </span>
                    )}
                    {isDown && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--severity-error)]/30 bg-[var(--severity-error)]/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--severity-error)]">
                        Agent {s.status}
                      </span>
                    )}
                    {!outdated && !isDown && (
                      <span className="font-mono text-[11px] text-muted-foreground">—</span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ServerStatusPill({ status }: { status: ServerRow["status"] }) {
  const map = {
    active: {
      Icon: CircleCheck,
      cls: "text-[var(--severity-resolved)] border-[var(--severity-resolved)]/30 bg-[var(--severity-resolved)]/10",
    },
    dormant: {
      Icon: CircleAlert,
      cls: "text-[var(--severity-warning)] border-[var(--severity-warning)]/30 bg-[var(--severity-warning)]/10",
    },
    offline: {
      Icon: CircleSlash,
      cls: "text-[var(--severity-error)] border-[var(--severity-error)]/30 bg-[var(--severity-error)]/10",
    },
  } as const;
  const v = map[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        v.cls,
      )}
    >
      <v.Icon className="h-3 w-3" />
      {status}
    </span>
  );
}

function DeploymentsForApp({
  deltas,
}: {
  deltas: ReturnType<typeof computeDeltas>;
}) {
  const rows = deltas
    .slice()
    .sort(
      (a, b) =>
        new Date(b.deployment.started_at).getTime() -
        new Date(a.deployment.started_at).getTime(),
    );
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel/40">
      <table className="w-full text-sm">
        <thead className="bg-panel/60 text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Deployment</th>
            <th className="px-4 py-2 text-left font-medium">Started</th>
            <th className="px-4 py-2 text-right font-medium">New</th>
            <th className="px-4 py-2 text-right font-medium">Resolved</th>
            <th className="px-4 py-2 text-right font-medium">Hit Δ</th>
            <th className="px-4 py-2 text-left font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-xs text-muted-foreground">
                No deployments recorded for this application.
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.deployment.id} className="border-t border-border hover:bg-accent/30">
              <td className="px-4 py-2">
                <Link
                  to="/deployments/$id"
                  params={{ id: r.deployment.id }}
                  className="font-mono text-[13px] text-foreground hover:text-primary"
                >
                  {r.deployment.name}
                </Link>
              </td>
              <td className="px-4 py-2 text-xs text-muted-foreground">
                {relativeTime(r.deployment.started_at)}
              </td>
              <td
                className={cn(
                  "px-4 py-2 text-right font-mono text-xs",
                  r.newErrors > 0 ? "text-[var(--severity-error)]" : "text-muted-foreground",
                )}
              >
                {r.newErrors > 0 ? `+${r.newErrors}` : "0"}
              </td>
              <td
                className={cn(
                  "px-4 py-2 text-right font-mono text-xs",
                  r.resolvedErrors > 0
                    ? "text-[var(--severity-resolved)]"
                    : "text-muted-foreground",
                )}
              >
                {r.resolvedErrors > 0 ? `−${r.resolvedErrors}` : "0"}
              </td>
              <td className="px-4 py-2 text-right">
                <HitDelta delta={r.hitsDelta} />
              </td>
              <td className="px-4 py-2">
                <DeployBadge badge={r.badge} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeverityChip({ severity }: { severity: EventRow["severity"] }) {
  const color =
    severity === "critical" || severity === "error"
      ? "text-[var(--severity-error)] border-[var(--severity-error)]/30 bg-[var(--severity-error)]/10"
      : severity === "warning"
        ? "text-[var(--severity-warning)] border-[var(--severity-warning)]/30 bg-[var(--severity-warning)]/10"
        : "text-[var(--severity-info)] border-[var(--severity-info)]/30 bg-[var(--severity-info)]/10";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${color}`}
    >
      {severity}
    </span>
  );
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
