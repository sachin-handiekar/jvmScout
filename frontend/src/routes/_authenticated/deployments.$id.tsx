import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  ArrowLeft,
  Rocket,
  Boxes,
  Server as ServerIcon,
  AlertOctagon,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PagePlaceholder";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { compactNumber, relativeTime } from "@/lib/format";
import {
  useDeploymentsData,
  computeDeltas,
  HitDelta,
  DeployBadge,
} from "./deployments";

export const Route = createFileRoute("/_authenticated/deployments/$id")({
  head: () => ({ meta: [{ title: "Deployment — jvmScout" }] }),
  component: DeploymentDetailPage,
});

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
  status: string;
  application_id: string;
};

function DeploymentDetailPage() {
  const { id } = Route.useParams();
  const { data, isLoading } = useDeploymentsData();

  const detail = useMemo(() => {
    if (!data) return null;
    const all = computeDeltas(data.deployments, data.applications, data.events);
    return all.find((r) => r.deployment.id === id) ?? null;
  }, [data, id]);

  const { data: extra } = useQuery({
    enabled: !!detail,
    queryKey: ["deployment-extra", id],
    queryFn: async () => {
      const [eventsQ, serversQ] = await Promise.all([
        supabase
          .from("events")
          .select(
            "id,type,name,location,severity,status,hit_count,last_seen,application_id,introduced_by_deployment_id",
          )
          .eq("introduced_by_deployment_id", id),
        supabase
          .from("servers")
          .select("id,hostname,agent_version,status,application_id")
          .eq("application_id", detail!.app!.id),
      ]);
      return {
        newEvents: (eventsQ.data ?? []) as EventRow[],
        servers: (serversQ.data ?? []) as ServerRow[],
      };
    },
  });

  if (isLoading) {
    return (
      <>
        <PageHeader title="Deployment" />
        <div className="space-y-4 p-6">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    );
  }

  if (!detail) throw notFound();

  const chartData = [
    { label: "Before", hits: detail.hitsPrev },
    { label: "After", hits: detail.hitsThis },
  ];

  return (
    <>
      <PageHeader
        title={detail.deployment.name}
        description={`${detail.app?.name ?? "—"} · deployed ${relativeTime(detail.deployment.started_at)}`}
        actions={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/deployments">
              <ArrowLeft className="mr-1 h-3.5 w-3.5" /> All deployments
            </Link>
          </Button>
        }
      />
      <div className="space-y-6 p-6">
        {/* Summary */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard label="Status">
            <DeployBadge badge={detail.badge} />
          </SummaryCard>
          <SummaryCard label="New errors introduced">
            <span
              className={
                detail.newErrors > 0
                  ? "font-mono text-2xl text-[var(--severity-error)]"
                  : "font-mono text-2xl text-muted-foreground"
              }
            >
              {detail.newErrors > 0 ? `+${detail.newErrors}` : "0"}
            </span>
          </SummaryCard>
          <SummaryCard label="Resolved since previous">
            <span
              className={
                detail.resolvedErrors > 0
                  ? "font-mono text-2xl text-[var(--severity-resolved)]"
                  : "font-mono text-2xl text-muted-foreground"
              }
            >
              {detail.resolvedErrors > 0 ? `−${detail.resolvedErrors}` : "0"}
            </span>
          </SummaryCard>
          <SummaryCard label="Error volume Δ">
            <div className="text-2xl">
              <HitDelta delta={detail.hitsDelta} />
            </div>
            {detail.prev && (
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                vs {detail.prev.name}
              </div>
            )}
          </SummaryCard>
        </div>

        {/* Chart + Affected */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-border bg-panel/40 p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">Error volume — before vs. after</h2>
              <span className="font-mono text-[11px] text-muted-foreground">
                hit_count totals from events introduced in each release
              </span>
            </div>
            <div className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="currentColor"
                    className="text-muted-foreground"
                    fontSize={11}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    stroke="currentColor"
                    className="text-muted-foreground"
                    fontSize={11}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => compactNumber(Number(v))}
                  />
                  <RTooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      fontSize: 12,
                    }}
                    formatter={(v) => compactNumber(Number(v))}
                  />
                  <Bar
                    dataKey="hits"
                    radius={[4, 4, 0, 0]}
                    fill={detail.hitsDelta > 0 ? "#F0556B" : "#34D399"}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-border bg-panel/40 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Boxes className="h-3.5 w-3.5" /> Application
              </h3>
              {detail.app ? (
                <Link
                  to="/events"
                  search={{
                    q: "",
                    type: "",
                    severity: "",
                    status: "",
                    app: detail.app.id,
                    deployment: "",
                    server: "",
                    chip: "",
                    sort: "last_seen",
                    dir: "desc",
                  }}
                  className="block"
                >
                  <div className="font-medium text-foreground hover:text-primary">
                    {detail.app.name}
                  </div>
                  <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                    {detail.app.environment}
                  </div>
                </Link>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
            <div className="rounded-lg border border-border bg-panel/40 p-4">
              <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <ServerIcon className="h-3.5 w-3.5" /> Servers running this release
              </h3>
              <ul className="space-y-1.5">
                {(extra?.servers ?? []).map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono text-foreground">{s.hostname}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      agent {s.agent_version}
                    </span>
                  </li>
                ))}
                {extra && extra.servers.length === 0 && (
                  <li className="text-xs text-muted-foreground">No servers reporting.</li>
                )}
              </ul>
            </div>
          </div>
        </div>

        {/* New errors introduced */}
        <div className="rounded-lg border border-border bg-panel/40">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <AlertOctagon className="h-4 w-4 text-[var(--severity-error)]" />
              New errors introduced in this deployment
            </h2>
            <span className="font-mono text-[11px] text-muted-foreground">
              {extra?.newEvents.length ?? 0} events
            </span>
          </div>
          {!extra && (
            <div className="space-y-2 p-4">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
            </div>
          )}
          {extra && extra.newEvents.length === 0 && (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              <Rocket className="mx-auto mb-2 h-5 w-5" />
              Clean release — no new errors introduced.
            </div>
          )}
          {extra && extra.newEvents.length > 0 && (
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
                {extra.newEvents
                  .slice()
                  .sort((a, b) => b.hit_count - a.hit_count)
                  .map((e) => (
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
      </div>
    </>
  );
}

function SummaryCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-panel/40 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-2">{children}</div>
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
