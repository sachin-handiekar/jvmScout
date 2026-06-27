import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Rocket,
  Server as ServerIcon,
} from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip as RTooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

import { supabase } from "@/integrations/supabase/client";
import {
  fetchTimeseries,
  fetchEventSeries,
  isSeriesIncreasing,
  type EventSeriesResult,
} from "@/integrations/collector/client";
import { useAppContext, type TimeRange } from "@/lib/app-context";
import { compactNumber, relativeTime } from "@/lib/format";
import { Sparkline } from "@/components/events/Sparkline";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Stackline" }] }),
  component: DashboardPage,
});

type EventType =
  | "uncaught_exception"
  | "caught_exception"
  | "logged_error"
  | "logged_warning"
  | "http_error";

type EventRow = {
  id: string;
  type: EventType;
  name: string;
  location: string;
  first_seen: string;
  last_seen: string;
  status: "active" | "resolved" | "hidden";
  severity: "critical" | "error" | "warning" | "info";
  hit_count: number;
  application_id: string;
  introduced_by_deployment_id: string | null;
};
type AppRow = { id: string; name: string; environment: "production" | "staging" | "development" };
type DeploymentRow = { id: string; name: string; application_id: string; started_at: string };

const TIME_HOURS: Record<TimeRange, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  custom: 24,
};

const TYPE_LABEL: Record<EventType, string> = {
  uncaught_exception: "uncaught",
  caught_exception: "caught",
  logged_error: "log.error",
  logged_warning: "log.warn",
  http_error: "http",
};

// Type color tokens (used for stacked chart and legend)
const TYPE_COLOR: Record<EventType, string> = {
  uncaught_exception: "#ef4444",
  caught_exception: "#f97316",
  logged_error: "#eab308",
  logged_warning: "#a3a3a3",
  http_error: "#3b82f6",
};

// Only the event types the agent actually produces. Log/HTTP taxonomies are not
// captured today, so they are deliberately absent rather than shown as empty.
const TYPES: EventType[] = ["uncaught_exception", "caught_exception"];

async function fetchAll() {
  const [events, apps, deployments] = await Promise.all([
    supabase.from("events").select("*"),
    supabase.from("applications").select("id,name,environment"),
    supabase.from("deployments").select("id,name,application_id,started_at"),
  ]);
  if (events.error) throw events.error;
  if (apps.error) throw apps.error;
  if (deployments.error) throw deployments.error;
  return {
    events: events.data as EventRow[],
    apps: apps.data as AppRow[],
    deployments: deployments.data as DeploymentRow[],
  };
}

function DashboardPage() {
  const { environment, timeRange } = useAppContext();
  const query = useQuery({ queryKey: ["dashboard"], queryFn: fetchAll });

  const hours = TIME_HOURS[timeRange];
  const windowMs = hours * 3600_000;
  const now = Date.now();
  const cutoff = now - windowMs;

  // Real per-bucket volume from the collector (caught vs uncaught), env-scoped.
  const bucketCount = hours <= 1 ? 12 : hours <= 24 ? 24 : hours <= 24 * 7 ? 28 : 30;
  const tsQuery = useQuery({
    queryKey: ["dashboard-timeseries", environment, timeRange],
    queryFn: () => fetchTimeseries(hours, bucketCount, environment),
  });

  // Real per-fingerprint occurrence counts over the window (drives per-event hit
  // totals, sparklines, and rising/falling trend — no client-side fabrication).
  const esQuery = useQuery({
    queryKey: ["dashboard-event-series", environment, timeRange],
    queryFn: () => fetchEventSeries(hours, 24, environment),
  });
  const eventSeries: EventSeriesResult["series"] = esQuery.data?.series ?? {};

  // Occurrences of an event within the selected window (real, from the collector).
  const hitsInPeriod = (e: EventRow): number => eventSeries[e.id]?.total ?? 0;
  const trendUpFor = (e: EventRow): boolean => isSeriesIncreasing(eventSeries[e.id]?.buckets);
  const sparkFor = (e: EventRow): number[] => eventSeries[e.id]?.buckets ?? [];

  const envApps = useMemo(
    () => (query.data?.apps ?? []).filter((a) => a.environment === environment),
    [query.data, environment],
  );
  const envAppIds = useMemo(() => new Set(envApps.map((a) => a.id)), [envApps]);
  const appsById = useMemo(() => {
    const m = new Map<string, AppRow>();
    envApps.forEach((a) => m.set(a.id, a));
    return m;
  }, [envApps]);

  const envEvents = useMemo(
    () => (query.data?.events ?? []).filter((e) => envAppIds.has(e.application_id) && e.status === "active"),
    [query.data, envAppIds],
  );

  // Period-scoped events: those with real occurrences in the window (from the
  // per-fingerprint series), so counts/volume reflect what was actually captured.
  const periodEvents = useMemo(
    () => envEvents.filter((e) => (eventSeries[e.id]?.total ?? 0) > 0),
    [envEvents, eventSeries],
  );

  const totalEvents = periodEvents.length;
  const totalHits = useMemo(
    () => periodEvents.reduce((sum, e) => sum + hitsInPeriod(e), 0),
    [periodEvents, eventSeries],
  );
  const newEvents = useMemo(
    () => periodEvents.filter((e) => new Date(e.first_seen).getTime() >= cutoff),
    [periodEvents, cutoff],
  );
  const increasing = useMemo(
    () => periodEvents.filter((e) => trendUpFor(e)),
    [periodEvents, eventSeries],
  );

  // Reliability score: 100 - penalty for new/increasing relative to total
  const reliability = useMemo(() => {
    if (periodEvents.length === 0) return 100;
    const penalty =
      (newEvents.length * 4 + increasing.length * 2) /
      Math.max(1, periodEvents.length);
    return Math.max(0, Math.min(100, Math.round(100 - penalty * 30)));
  }, [periodEvents, newEvents, increasing]);

  // Volume chart: real per-bucket counts from the collector time-series.
  // Only the two event types the agent actually produces (uncaught/caught) carry
  // data; the remaining (log/http) series stay at zero until those are captured.
  const chart = useMemo(() => {
    const series = tsQuery.data ?? [];
    return series.map((b) => ({
      label: formatBucketLabel(b.t, hours),
      uncaught_exception: b.uncaught,
      caught_exception: b.caught,
    }));
  }, [tsQuery.data, hours]);

  const chartTotal = useMemo(
    () => (tsQuery.data ?? []).reduce((sum, b) => sum + b.caught + b.uncaught, 0),
    [tsQuery.data],
  );

  // New & increasing
  const newAndIncreasing = useMemo(() => {
    const set = new Map<string, EventRow>();
    newEvents.forEach((e) => set.set(e.id, e));
    increasing.forEach((e) => set.set(e.id, e));
    return Array.from(set.values())
      .sort((a, b) => hitsInPeriod(b) - hitsInPeriod(a))
      .slice(0, 8);
  }, [newEvents, increasing]);

  // Top events
  const topEvents = useMemo(
    () =>
      [...periodEvents]
        .sort((a, b) => hitsInPeriod(b) - hitsInPeriod(a))
        .slice(0, 6),
    [periodEvents, eventSeries],
  );

  // App health
  const appHealth = useMemo(() => {
    return envApps.map((app) => {
      const appEvts = periodEvents.filter((e) => e.application_id === app.id);
      const count = appEvts.length;
      const worst =
        [...appEvts].sort((a, b) => {
          const sev = { critical: 0, error: 1, warning: 2, info: 3 } as const;
          return sev[a.severity] - sev[b.severity];
        })[0] ?? null;
      const critCount = appEvts.filter((e) => e.severity === "critical").length;
      const health: "green" | "amber" | "red" =
        critCount > 0 || count >= 6 ? "red" : count >= 2 ? "amber" : "green";
      return { app, count, worst, health };
    });
  }, [envApps, periodEvents]);

  // Recent deployments
  const recentDeployments = useMemo(() => {
    const deps = (query.data?.deployments ?? []).filter((d) => envAppIds.has(d.application_id));
    return [...deps]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, 6)
      .map((d) => {
        const introduced = envEvents.filter((e) => e.introduced_by_deployment_id === d.id);
        const delta = introduced.length;
        return { d, delta, introduced };
      });
  }, [query.data, envAppIds, envEvents]);

  if (query.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-80 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border bg-panel/40 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Reliability overview for <span className="font-mono">{environment}</span> over the last {timeRange}.
          </p>
        </div>
      </div>

      <div className="space-y-4 p-6">
        {/* KPI row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Total events"
            value={compactNumber(totalEvents)}
            icon={Activity}
            sub={`${envApps.length} apps in ${environment}`}
          />
          <KpiCard
            label="Error volume"
            value={compactNumber(totalHits)}
            icon={AlertTriangle}
            sub={`${compactNumber(Math.round(totalHits / Math.max(1, hours)))} / hr`}
          />
          <KpiCard
            label="New events"
            value={compactNumber(newEvents.length)}
            icon={Sparkles}
            sub={`${increasing.length} increasing`}
            accent={newEvents.length > 0 ? "warn" : undefined}
          />
          <ReliabilityCard score={reliability} />
        </div>

        {/* Volume chart */}
        <Card>
          <CardHeader
            title="Error volume over time"
            subtitle="Stacked by event type"
            right={
              <div className="flex flex-wrap items-center gap-3">
                {TYPES.map((t) => (
                  <div key={t} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="h-2 w-2 rounded-sm" style={{ background: TYPE_COLOR[t] }} />
                    <span className="font-mono">{TYPE_LABEL[t]}</span>
                  </div>
                ))}
              </div>
            }
          />
          <div className="h-72 px-2 pb-3">
            {chart.length === 0 || chartTotal === 0 ? (
              <EmptyChart />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    {TYPES.map((t) => (
                      <linearGradient key={t} id={`grad-${t}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={TYPE_COLOR[t]} stopOpacity={0.7} />
                        <stop offset="100%" stopColor={TYPE_COLOR[t]} stopOpacity={0.1} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={36}
                    tickFormatter={(v) => compactNumber(v as number)}
                  />
                  <RTooltip
                    contentStyle={{
                      background: "hsl(var(--popover))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                    labelStyle={{ color: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    formatter={(v: number, name) => [compactNumber(v), TYPE_LABEL[name as EventType] ?? name]}
                  />
                  {TYPES.map((t) => (
                    <Area
                      key={t}
                      type="monotone"
                      dataKey={t}
                      stackId="1"
                      stroke={TYPE_COLOR[t]}
                      strokeWidth={1.2}
                      fill={`url(#grad-${t})`}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        {/* Two-column lists */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              title="New & increasing errors"
              subtitle={`${newAndIncreasing.length} regressions in this window`}
              right={
                <Link
                  to="/events"
                  search={{
                    q: "",
                    type: "",
                    severity: "",
                    status: "",
                    app: "",
                    deployment: "",
                    server: "",
                    chip: "new",
                    sort: "last_seen",
                    dir: "desc",
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  View all →
                </Link>
              }
            />
            <div className="divide-y divide-border">
              {newAndIncreasing.length === 0 && <EmptyRow label="No new regressions." />}
              {newAndIncreasing.map((e) => {
                const isNew = newEvents.some((n) => n.id === e.id);
                return (
                  <Link
                    key={e.id}
                    to="/events/$id"
                    params={{ id: e.id }}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40"
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        e.severity === "critical" && "bg-[#ef4444]",
                        e.severity === "error" && "bg-[#f97316]",
                        e.severity === "warning" && "bg-[#eab308]",
                        e.severity === "info" && "bg-[#3b82f6]",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs text-foreground">{e.name}</div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {e.location}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                        isNew
                          ? "bg-[#3b82f6]/15 text-[#3b82f6]"
                          : "bg-[#f97316]/15 text-[#f97316]",
                      )}
                    >
                      {isNew ? "New" : "↑ Spike"}
                    </span>
                    <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                      {compactNumber(hitsInPeriod(e))}
                    </span>
                  </Link>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Top events"
              subtitle="Highest volume in window"
              right={
                <Link
                  to="/events"
                  search={{
                    q: "",
                    type: "",
                    severity: "",
                    status: "",
                    app: "",
                    deployment: "",
                    server: "",
                    chip: "",
                    sort: "hit_count",
                    dir: "desc",
                  }}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  View all →
                </Link>
              }
            />
            <div className="divide-y divide-border">
              {topEvents.length === 0 && <EmptyRow label="No events in this window." />}
              {topEvents.map((e, idx) => (
                <Link
                  key={e.id}
                  to="/events/$id"
                  params={{ id: e.id }}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/40"
                >
                  <span className="w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs">{e.name}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {appsById.get(e.application_id)?.name ?? "—"} · {relativeTime(e.last_seen)}
                    </div>
                  </div>
                  <Sparkline
                    data={sparkFor(e)}
                    trendUp={trendUpFor(e)}
                    width={80}
                    height={20}
                  />
                  <span className="w-14 shrink-0 text-right font-mono text-[11px] text-foreground">
                    {compactNumber(hitsInPeriod(e))}
                  </span>
                </Link>
              ))}
            </div>
          </Card>
        </div>

        {/* Apps + deployments */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Applications health" subtitle={`${envApps.length} services in ${environment}`} />
            <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
              {appHealth.length === 0 && <EmptyRow label="No applications in this environment." />}
              {appHealth.map(({ app, count, worst, health }) => (
                <Link
                  key={app.id}
                  to="/events"
                  search={{
                    q: "",
                    type: "",
                    severity: "",
                    status: "",
                    app: app.id,
                    deployment: "",
                    server: "",
                    chip: "",
                    sort: "last_seen",
                    dir: "desc",
                  }}
                  className="rounded-md border border-border bg-background/40 p-3 transition hover:border-foreground/20 hover:bg-accent/40"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ServerIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono text-xs">{app.name}</span>
                    </div>
                    <HealthPill health={health} />
                  </div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-lg font-semibold">{compactNumber(count)}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">events</span>
                  </div>
                  <div className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
                    {worst ? worst.name : "No errors in window"}
                  </div>
                </Link>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Recent deployments"
              subtitle="Post-deploy error delta"
              right={
                <Link to="/deployments" className="text-[11px] text-muted-foreground hover:text-foreground">
                  View all →
                </Link>
              }
            />
            <div className="divide-y divide-border">
              {recentDeployments.length === 0 && <EmptyRow label="No recent deployments." />}
              {recentDeployments.map(({ d, delta }) => {
                const app = appsById.get(d.application_id);
                const bad = delta > 0;
                return (
                  <div
                    key={d.id}
                    className="flex items-center gap-3 px-4 py-2.5"
                  >
                    <Rocket className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-xs">{d.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {app?.name ?? "—"} · {relativeTime(d.started_at)}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]",
                        bad
                          ? "bg-[#ef4444]/12 text-[#ef4444]"
                          : "bg-[#22c55e]/12 text-[#22c55e]",
                      )}
                    >
                      {bad ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                      {bad ? `+${delta}` : "0"} new
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function formatBucketLabel(t: number, hours: number): string {
  const d = new Date(t);
  if (hours <= 1) return `${d.getMinutes().toString().padStart(2, "0")}m`;
  if (hours <= 24) return `${d.getHours().toString().padStart(2, "0")}:00`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-panel/40">
      {children}
    </div>
  );
}

function CardHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>}
      </div>
      {right && <div className="flex shrink-0 items-center">{right}</div>}
    </div>
  );
}

function KpiCard({
  label,
  value,
  icon: Icon,
  sub,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  sub?: string;
  accent?: "warn" | "bad";
}) {
  return (
    <div className="rounded-lg border border-border bg-panel/40 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Icon
          className={cn(
            "h-3.5 w-3.5",
            accent === "warn" && "text-[#f97316]",
            accent === "bad" && "text-[#ef4444]",
            !accent && "text-muted-foreground",
          )}
        />
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ReliabilityCard({ score }: { score: number }) {
  const color = score >= 90 ? "#22c55e" : score >= 70 ? "#eab308" : "#ef4444";
  const label = score >= 90 ? "Healthy" : score >= 70 ? "Degraded" : "At risk";
  const r = 28;
  const c = 2 * Math.PI * r;
  const dash = (score / 100) * c;
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-panel/40 p-4">
      <div>
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Reliability
        </span>
        <div className="mt-2 text-2xl font-semibold tracking-tight">{score}</div>
        <div className="mt-1 text-[11px]" style={{ color }}>
          {label}
        </div>
      </div>
      <svg width={72} height={72} viewBox="0 0 72 72" className="-rotate-90">
        <circle cx="36" cy="36" r={r} stroke="hsl(var(--border))" strokeWidth={6} fill="none" />
        <circle
          cx="36"
          cy="36"
          r={r}
          stroke={color}
          strokeWidth={6}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ transition: "stroke-dasharray 600ms ease" }}
        />
      </svg>
    </div>
  );
}

function HealthPill({ health }: { health: "green" | "amber" | "red" }) {
  const map = {
    green: { bg: "bg-[#22c55e]/15", text: "text-[#22c55e]", label: "Healthy" },
    amber: { bg: "bg-[#eab308]/15", text: "text-[#eab308]", label: "Degraded" },
    red: { bg: "bg-[#ef4444]/15", text: "text-[#ef4444]", label: "At risk" },
  }[health];
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider", map.bg, map.text)}>
      {map.label}
    </span>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      No volume in this window.
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return <div className="px-4 py-6 text-center text-xs text-muted-foreground">{label}</div>;
}
