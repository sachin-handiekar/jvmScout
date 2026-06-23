import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Boxes,
  Server as ServerIcon,
  AlertOctagon,
  Search,
  ArrowUpDown,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/lib/app-context";
import { compactNumber, sparklineForEvent } from "@/lib/format";
import { Sparkline } from "@/components/events/Sparkline";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, EmptyState } from "@/components/PagePlaceholder";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/applications")({
  head: () => ({ meta: [{ title: "Applications — Stackline" }] }),
  component: ApplicationsRoute,
});

function ApplicationsRoute() {
  const showingDetail = useRouterState({
    select: (state) =>
      state.matches.some((m) => m.routeId === "/_authenticated/applications/$id"),
  });
  return showingDetail ? <Outlet /> : <ApplicationsPage />;
}

type AppRow = { id: string; name: string; environment: "production" | "staging" | "development" };
type EventRow = {
  id: string;
  application_id: string;
  name: string;
  severity: "critical" | "error" | "warning" | "info";
  status: "active" | "resolved" | "hidden";
  hit_count: number;
  last_seen: string;
};
type ServerRow = {
  id: string;
  application_id: string;
  status: "active" | "dormant" | "offline";
};

export type AppHealth = "healthy" | "degraded" | "at_risk";

export function computeAppHealth(events: EventRow[]): AppHealth {
  const active = events.filter((e) => e.status === "active");
  const critical = active.filter((e) => e.severity === "critical").length;
  const errors = active.filter((e) => e.severity === "error").length;
  if (critical >= 1 || errors >= 5) return "at_risk";
  if (errors >= 1) return "degraded";
  return "healthy";
}

export function HealthPill({ health }: { health: AppHealth }) {
  const map = {
    healthy: {
      label: "Healthy",
      cls: "text-[var(--severity-resolved)] border-[var(--severity-resolved)]/30 bg-[var(--severity-resolved)]/10",
    },
    degraded: {
      label: "Degraded",
      cls: "text-[var(--severity-warning)] border-[var(--severity-warning)]/30 bg-[var(--severity-warning)]/10",
    },
    at_risk: {
      label: "Critical",
      cls: "text-[var(--severity-error)] border-[var(--severity-error)]/30 bg-[var(--severity-error)]/10",
    },
  } as const;
  const v = map[health];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        v.cls,
      )}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {v.label}
    </span>
  );
}

export function EnvPill({ env }: { env: AppRow["environment"] }) {
  const cls =
    env === "production"
      ? "text-[var(--severity-info)] border-[var(--severity-info)]/30 bg-[var(--severity-info)]/10"
      : env === "staging"
        ? "text-[var(--severity-warning)] border-[var(--severity-warning)]/30 bg-[var(--severity-warning)]/10"
        : "text-muted-foreground border-border bg-background/60";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider",
        cls,
      )}
    >
      {env}
    </span>
  );
}

type SortKey = "health" | "volume" | "name";

function ApplicationsPage() {
  const { environment } = useAppContext();
  const [search, setSearch] = useState("");
  const [envFilter, setEnvFilter] = useState<"all" | AppRow["environment"]>("all");
  const [sort, setSort] = useState<SortKey>("health");

  const { data, isLoading } = useQuery({
    queryKey: ["applications-page"],
    queryFn: async () => {
      const [apps, events, servers] = await Promise.all([
        supabase.from("applications").select("id,name,environment"),
        supabase
          .from("events")
          .select("id,application_id,name,severity,status,hit_count,last_seen"),
        supabase.from("servers").select("id,application_id,status"),
      ]);
      return {
        applications: (apps.data ?? []) as AppRow[],
        events: (events.data ?? []) as EventRow[],
        servers: (servers.data ?? []) as ServerRow[],
      };
    },
  });

  const cards = useMemo(() => {
    if (!data) return [];
    const healthRank: Record<AppHealth, number> = { at_risk: 0, degraded: 1, healthy: 2 };
    return data.applications
      .filter((a) => (envFilter === "all" ? a.environment === environment : a.environment === envFilter))
      .filter((a) => (search ? a.name.toLowerCase().includes(search.toLowerCase()) : true))
      .map((app) => {
        const appEvents = data.events.filter((e) => e.application_id === app.id);
        const activeEvents = appEvents.filter((e) => e.status === "active");
        const totalHits = activeEvents.reduce((s, e) => s + (e.hit_count ?? 0), 0);
        const appServers = data.servers.filter((s) => s.application_id === app.id);
        const offlineServers = appServers.filter(
          (s) => s.status === "offline" || s.status === "dormant",
        ).length;
        const worst = [...activeEvents]
          .sort((a, b) => {
            const sev = { critical: 0, error: 1, warning: 2, info: 3 } as const;
            const d = sev[a.severity] - sev[b.severity];
            if (d !== 0) return d;
            return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
          })[0];
        const series = sparklineForEvent(app.id, totalHits + 1, totalHits > 500);
        return {
          app,
          health: computeAppHealth(appEvents),
          activeCount: activeEvents.length,
          serverCount: appServers.length,
          offlineServers,
          totalHits,
          series,
          worst,
        };
      })
      .sort((a, b) => {
        if (sort === "name") return a.app.name.localeCompare(b.app.name);
        if (sort === "volume") return b.totalHits - a.totalHits;
        const d = healthRank[a.health] - healthRank[b.health];
        return d !== 0 ? d : b.totalHits - a.totalHits;
      });
  }, [data, environment, envFilter, sort, search]);

  return (
    <>
      <PageHeader
        title="Applications"
        description="JVM services reporting into this workspace."
      />
      <div className="space-y-4 p-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1 max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search applications..."
              className="h-8 pl-8 font-mono text-xs"
            />
          </div>
          <Select value={envFilter} onValueChange={(v) => setEnvFilter(v as typeof envFilter)}>
            <SelectTrigger className="h-8 w-[160px] text-xs">
              <SelectValue placeholder="Environment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All environments</SelectItem>
              <SelectItem value="production">Production</SelectItem>
              <SelectItem value="staging">Staging</SelectItem>
              <SelectItem value="development">Development</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-8 w-[160px] text-xs">
              <ArrowUpDown className="mr-1 h-3 w-3" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="health">Sort: Health</SelectItem>
              <SelectItem value="volume">Sort: Error volume</SelectItem>
              <SelectItem value="name">Sort: Name</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-48 w-full" />
            ))}
          </div>
        )}
        {!isLoading && cards.length === 0 && (
          <EmptyState
            icon={Boxes}
            title="No applications reporting yet"
            hint="Install an agent to start streaming errors into Stackline."
          />
        )}
        {!isLoading && cards.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((c) => (
              <Link
                key={c.app.id}
                to="/applications/$id"
                params={{ id: c.app.id }}
                className="group flex flex-col rounded-lg border border-border bg-panel/40 p-4 transition-colors hover:border-primary/50 hover:bg-panel/70"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold tracking-tight group-hover:text-primary">
                      {c.app.name}
                    </div>
                    <div className="mt-1">
                      <EnvPill env={c.app.environment} />
                    </div>
                  </div>
                  <HealthPill health={c.health} />
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <Stat
                    icon={<AlertOctagon className="h-3 w-3" />}
                    label="active"
                    value={c.activeCount.toString()}
                    danger={c.activeCount > 0}
                  />
                  <Stat label="hits" value={compactNumber(c.totalHits)} />
                  <Stat
                    icon={<ServerIcon className="h-3 w-3" />}
                    label="servers"
                    value={c.serverCount.toString()}
                    warningDot={c.offlineServers > 0}
                  />
                </div>

                <div className="mt-3 flex items-end justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Worst recent
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-foreground/90">
                      {c.worst ? c.worst.name : <span className="text-muted-foreground">—</span>}
                    </div>
                  </div>
                  <Sparkline data={c.series} height={28} trendUp={c.totalHits > 500} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  danger,
  warningDot,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  danger?: boolean;
  warningDot?: boolean;
}) {
  return (
    <div className="relative rounded-md border border-border/60 bg-background/40 px-2 py-1.5">
      {warningDot && (
        <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[var(--severity-warning)] shadow-[0_0_0_2px_var(--panel)]" />
      )}
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon} {label}
      </div>
      <div
        className={cn(
          "mt-0.5 font-mono text-sm",
          danger ? "text-[var(--severity-error)]" : "text-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}
