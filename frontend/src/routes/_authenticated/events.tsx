import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import {
  Search,
  X,
  ArrowUp,
  RotateCcw,
  CheckCheck,
  EyeOff,
  UserPlus,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext, type TimeRange } from "@/lib/app-context";
import { compactNumber, relativeTime } from "@/lib/format";
import {
  fetchEventSeries,
  isSeriesIncreasing,
  type EventSeriesResult,
} from "@/integrations/collector/client";
import { Sparkline } from "@/components/events/Sparkline";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type EventType =
  | "uncaught_exception"
  | "caught_exception"
  | "logged_error"
  | "logged_warning"
  | "http_error";
type Severity = "critical" | "error" | "warning" | "info";
type Status = "active" | "resolved" | "hidden";

const SEVERITIES: Severity[] = ["critical", "error", "warning", "info"];
const STATUSES: Status[] = ["active", "resolved", "hidden"];
// Only the event types the agent actually produces (see dashboard).
const TYPES: EventType[] = ["uncaught_exception", "caught_exception"];

const TYPE_LABEL: Record<EventType, string> = {
  uncaught_exception: "uncaught",
  caught_exception: "caught",
  logged_error: "log.error",
  logged_warning: "log.warn",
  http_error: "http",
};

const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-[var(--severity-critical,#ef4444)]",
  error: "bg-[var(--severity-error,#f97316)]",
  warning: "bg-[var(--severity-warning,#eab308)]",
  info: "bg-[var(--severity-info,#3b82f6)]",
};
const SEVERITY_RING: Record<Severity, string> = {
  critical: "ring-[var(--severity-critical,#ef4444)]/30",
  error: "ring-[var(--severity-error,#f97316)]/30",
  warning: "ring-[var(--severity-warning,#eab308)]/30",
  info: "ring-[var(--severity-info,#3b82f6)]/30",
};

const TIME_HOURS: Record<TimeRange, number | null> = {
  "1h": 1,
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  custom: null,
};

type SortField = "last_seen" | "first_seen" | "hit_count" | "name";

const searchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  type: fallback(z.string(), "").default(""), // csv
  severity: fallback(z.string(), "").default(""),
  status: fallback(z.string(), "").default(""), // empty = default (active only)
  app: fallback(z.string(), "").default(""),
  deployment: fallback(z.string(), "").default(""),
  server: fallback(z.string(), "").default(""),
  chip: fallback(z.enum(["", "new", "increasing", "unresolved"]), "").default(""),
  sort: fallback(z.enum(["last_seen", "first_seen", "hit_count", "name"]), "last_seen").default("last_seen"),
  dir: fallback(z.enum(["asc", "desc"]), "desc").default("desc"),
});

const csvSet = (s: string) => new Set(s.split(",").filter(Boolean));
const toggleCsv = (csv: string, value: string) => {
  const set = csvSet(csv);
  set.has(value) ? set.delete(value) : set.add(value);
  return Array.from(set).join(",");
};

export const Route = createFileRoute("/_authenticated/events")({
  head: () => ({ meta: [{ title: "Events — jvmScout" }] }),
  validateSearch: zodValidator(searchSchema),
  component: EventsRoute,
});

function EventsRoute() {
  const showingDetail = useRouterState({
    select: (state) => state.matches.some((match) => match.routeId === "/_authenticated/events/$id"),
  });

  return showingDetail ? <Outlet /> : <EventsPage />;
}

type EventRow = {
  id: string;
  type: EventType;
  name: string;
  location: string;
  first_seen: string;
  last_seen: string;
  status: Status;
  severity: Severity;
  hit_count: number;
  application_id: string;
  introduced_by_deployment_id: string | null;
};

type AppRow = { id: string; name: string; environment: "production" | "staging" | "development" };
type DeploymentRow = { id: string; name: string; application_id: string; started_at: string };
type ServerRow = { id: string; hostname: string; application_id: string };
type SnapshotRow = { event_id: string; server_id: string };

async function fetchAll() {
  const [events, apps, deployments, servers, snapshots] = await Promise.all([
    supabase.from("events").select("*"),
    supabase.from("applications").select("id,name,environment"),
    supabase.from("deployments").select("id,name,application_id,started_at"),
    supabase.from("servers").select("id,hostname,application_id"),
    supabase.from("snapshots").select("event_id,server_id"),
  ]);
  if (events.error) throw events.error;
  if (apps.error) throw apps.error;
  if (deployments.error) throw deployments.error;
  if (servers.error) throw servers.error;
  if (snapshots.error) throw snapshots.error;
  return {
    events: events.data as EventRow[],
    apps: apps.data as AppRow[],
    deployments: deployments.data as DeploymentRow[],
    servers: servers.data as ServerRow[],
    snapshots: snapshots.data as SnapshotRow[],
  };
}

function EventsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/events" });
  const { environment, timeRange } = useAppContext();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const update = (patch: Partial<typeof search>) =>
    navigate({ search: (prev: typeof search) => ({ ...prev, ...patch }) });

  const query = useQuery({ queryKey: ["events-page"], queryFn: fetchAll });

  // Real per-fingerprint occurrence series (drives the per-row sparkline + the
  // "increasing" quick filter — no fabricated trend data).
  const esHours = TIME_HOURS[timeRange] ?? 24;
  const esQuery = useQuery({
    queryKey: ["events-series", environment, timeRange],
    queryFn: () => fetchEventSeries(esHours, 24, environment),
  });
  const eventSeries: EventSeriesResult["series"] = esQuery.data?.series ?? {};

  const appsById = useMemo(() => {
    const m = new Map<string, AppRow>();
    query.data?.apps.forEach((a) => m.set(a.id, a));
    return m;
  }, [query.data]);

  const deploysById = useMemo(() => {
    const m = new Map<string, DeploymentRow>();
    query.data?.deployments.forEach((d) => m.set(d.id, d));
    return m;
  }, [query.data]);

  // Most recent deployment per application
  const latestDeployByApp = useMemo(() => {
    const m = new Map<string, string>();
    query.data?.deployments.forEach((d) => {
      const cur = m.get(d.application_id);
      if (!cur || d.started_at > (deploysById.get(cur)?.started_at ?? "")) {
        m.set(d.application_id, d.id);
      }
    });
    return m;
  }, [query.data, deploysById]);

  // Server ids per event (from snapshots)
  const serversByEvent = useMemo(() => {
    const m = new Map<string, Set<string>>();
    query.data?.snapshots.forEach((s) => {
      if (!m.has(s.event_id)) m.set(s.event_id, new Set());
      m.get(s.event_id)!.add(s.server_id);
    });
    return m;
  }, [query.data]);

  const envFilteredApps = useMemo(
    () => (query.data?.apps ?? []).filter((a) => a.environment === environment),
    [query.data, environment],
  );
  const envAppIds = useMemo(() => new Set(envFilteredApps.map((a) => a.id)), [envFilteredApps]);

  const filterTypes = csvSet(search.type);
  const filterSev = csvSet(search.severity);
  const filterStatus = csvSet(search.status);
  const filterApps = csvSet(search.app);
  const filterDeploys = csvSet(search.deployment);
  const filterServers = csvSet(search.server);

  const cutoff = useMemo(() => {
    const h = TIME_HOURS[timeRange];
    return h ? Date.now() - h * 3600_000 : 0;
  }, [timeRange]);

  const rows = useMemo(() => {
    const all = query.data?.events ?? [];
    return all
      .filter((e) => envAppIds.has(e.application_id))
      .filter((e) => {
        // Default: only active. If status filter explicit, honour it. Quick chip "unresolved" forces active.
        if (search.chip === "unresolved") return e.status === "active";
        if (filterStatus.size > 0) return filterStatus.has(e.status);
        return e.status === "active";
      })
      .filter((e) => (filterTypes.size === 0 ? true : filterTypes.has(e.type)))
      .filter((e) => (filterSev.size === 0 ? true : filterSev.has(e.severity)))
      .filter((e) => (filterApps.size === 0 ? true : filterApps.has(e.application_id)))
      .filter((e) => {
        if (filterDeploys.size === 0) return true;
        return e.introduced_by_deployment_id ? filterDeploys.has(e.introduced_by_deployment_id) : false;
      })
      .filter((e) => {
        if (filterServers.size === 0) return true;
        const set = serversByEvent.get(e.id);
        if (!set) return false;
        for (const id of filterServers) if (set.has(id)) return true;
        return false;
      })
      .filter((e) => (cutoff ? new Date(e.last_seen).getTime() >= cutoff : true))
      .filter((e) => {
        if (!search.q) return true;
        const q = search.q.toLowerCase();
        return e.name.toLowerCase().includes(q) || e.location.toLowerCase().includes(q);
      })
      .filter((e) => {
        if (search.chip === "new") {
          return (
            !!e.introduced_by_deployment_id &&
            latestDeployByApp.get(e.application_id) === e.introduced_by_deployment_id
          );
        }
        if (search.chip === "increasing") {
          return isSeriesIncreasing(eventSeries[e.id]?.buckets);
        }
        return true;
      })
      .sort((a, b) => {
        const dir = search.dir === "asc" ? 1 : -1;
        const f = search.sort;
        if (f === "name") return a.name.localeCompare(b.name) * dir;
        if (f === "hit_count") return (a.hit_count - b.hit_count) * dir;
        const av = new Date(f === "first_seen" ? a.first_seen : a.last_seen).getTime();
        const bv = new Date(f === "first_seen" ? b.first_seen : b.last_seen).getTime();
        return (av - bv) * dir;
      });
  }, [
    query.data,
    envAppIds,
    filterTypes,
    filterSev,
    filterStatus,
    filterApps,
    filterDeploys,
    filterServers,
    serversByEvent,
    cutoff,
    search.q,
    search.chip,
    search.sort,
    search.dir,
    latestDeployByApp,
    eventSeries,
  ]);

  const resetFilters = () =>
    navigate({
      search: {
        q: "",
        type: "",
        severity: "",
        status: "",
        app: "",
        deployment: "",
        server: "",
        chip: "",
        sort: "last_seen",
        dir: "desc",
      },
    });

  const activeFilterCount =
    (search.q ? 1 : 0) +
    filterTypes.size +
    filterSev.size +
    filterStatus.size +
    filterApps.size +
    filterDeploys.size +
    filterServers.size +
    (search.chip ? 1 : 0);

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const SortHeader = ({ field, children, className }: { field: SortField; children: React.ReactNode; className?: string }) => {
    const active = search.sort === field;
    const Icon = active && search.dir === "asc" ? ChevronUp : ChevronDown;
    return (
      <button
        onClick={() =>
          update({ sort: field, dir: active && search.dir === "desc" ? "asc" : "desc" })
        }
        className={cn(
          "inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground",
          active && "text-foreground",
          className,
        )}
      >
        {children}
        <Icon className={cn("h-3 w-3 opacity-0 transition", active && "opacity-100")} />
      </button>
    );
  };

  // Deployments scoped to current env (for filter rail)
  const envDeployments = (query.data?.deployments ?? []).filter((d) => envAppIds.has(d.application_id));
  const envServers = (query.data?.servers ?? []).filter((s) => envAppIds.has(s.application_id));

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full min-h-0 w-full">
        {/* Filter rail */}
        <aside className="hidden w-[220px] shrink-0 border-r border-border bg-panel/30 lg:block">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Filters
            </span>
            {activeFilterCount > 0 && (
              <button
                onClick={resetFilters}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
            )}
          </div>
          <div className="space-y-4 px-3 py-3">
            <FilterGroup label="Type">
              {TYPES.map((t) => (
                <FilterCheck
                  key={t}
                  label={TYPE_LABEL[t]}
                  mono
                  checked={filterTypes.has(t)}
                  onChange={() => update({ type: toggleCsv(search.type, t) })}
                />
              ))}
            </FilterGroup>
            <FilterGroup label="Severity">
              {SEVERITIES.map((s) => (
                <FilterCheck
                  key={s}
                  label={s}
                  dot={SEVERITY_DOT[s]}
                  checked={filterSev.has(s)}
                  onChange={() => update({ severity: toggleCsv(search.severity, s) })}
                />
              ))}
            </FilterGroup>
            <FilterGroup label="Status">
              {STATUSES.map((s) => (
                <FilterCheck
                  key={s}
                  label={s}
                  checked={filterStatus.has(s)}
                  onChange={() => update({ status: toggleCsv(search.status, s) })}
                />
              ))}
            </FilterGroup>
            <FilterGroup label="Application">
              {envFilteredApps.map((a) => (
                <FilterCheck
                  key={a.id}
                  label={a.name}
                  mono
                  checked={filterApps.has(a.id)}
                  onChange={() => update({ app: toggleCsv(search.app, a.id) })}
                />
              ))}
            </FilterGroup>
            <FilterGroup label="Deployment">
              {envDeployments.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No deployments in scope.</p>
              )}
              {envDeployments.map((d) => (
                <FilterCheck
                  key={d.id}
                  label={d.name}
                  mono
                  checked={filterDeploys.has(d.id)}
                  onChange={() => update({ deployment: toggleCsv(search.deployment, d.id) })}
                />
              ))}
            </FilterGroup>
            <FilterGroup label="Server">
              {envServers.map((s) => (
                <FilterCheck
                  key={s.id}
                  label={s.hostname}
                  mono
                  checked={filterServers.has(s.id)}
                  onChange={() => update({ server: toggleCsv(search.server, s.id) })}
                />
              ))}
            </FilterGroup>
          </div>
        </aside>

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Page header */}
          <div className="flex items-center justify-between gap-4 border-b border-border bg-panel/40 px-6 py-4">
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Events</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Every exception in <span className="font-mono">{environment}</span> over the last {timeRange}.
                {rows.length > 0 && (
                  <> &middot; <span className="text-foreground">{compactNumber(rows.length)}</span> matching</>
                )}
              </p>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-6 py-2.5">
            <div className="relative max-w-md flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search.q}
                onChange={(e) => update({ q: e.target.value })}
                placeholder="Search event name or location…"
                className="h-8 border-border bg-background pl-8 font-mono text-xs"
              />
              {search.q && (
                <button
                  onClick={() => update({ q: "" })}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-1">
              <Chip
                active={search.chip === "new"}
                onClick={() => update({ chip: search.chip === "new" ? "" : "new" })}
              >
                New in last deploy
              </Chip>
              <Chip
                active={search.chip === "increasing"}
                onClick={() => update({ chip: search.chip === "increasing" ? "" : "increasing" })}
              >
                <ArrowUp className="mr-1 h-3 w-3 text-[var(--severity-error,#f97316)]" />
                Increasing
              </Chip>
              <Chip
                active={search.chip === "unresolved"}
                onClick={() => update({ chip: search.chip === "unresolved" ? "" : "unresolved" })}
              >
                Unresolved
              </Chip>
            </div>

            <div className="ml-auto flex items-center gap-1">
              {activeFilterCount > 0 && (
                <Button variant="ghost" size="sm" onClick={resetFilters} className="h-7 gap-1 text-xs">
                  <RotateCcw className="h-3 w-3" /> Reset filters
                </Button>
              )}
            </div>
          </div>

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2 border-b border-border bg-primary/10 px-6 py-2 text-xs">
              <span className="font-medium">{selected.size} selected</span>
              <span className="text-muted-foreground">·</span>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setSelected(new Set())}>
                <CheckCheck className="h-3.5 w-3.5" /> Resolve
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setSelected(new Set())}>
                <EyeOff className="h-3.5 w-3.5" /> Hide
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setSelected(new Set())}>
                <UserPlus className="h-3.5 w-3.5" /> Assign
              </Button>
              <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {/* Table */}
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10 bg-panel/95 backdrop-blur">
                <tr className="border-b border-border">
                  <th className="w-9 border-b border-border px-3 py-2 text-left">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" />
                  </th>
                  <th className="w-7 border-b border-border px-1 py-2"></th>
                  <th className="border-b border-border py-2 pr-4 text-left">
                    <SortHeader field="name">Event</SortHeader>
                  </th>
                  <th className="border-b border-border py-2 pr-4 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Location
                  </th>
                  <th className="border-b border-border py-2 pr-4 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    App
                  </th>
                  <th className="border-b border-border py-2 pr-4 text-left">
                    <SortHeader field="last_seen">Last seen</SortHeader>
                  </th>
                  <th className="border-b border-border py-2 pr-4 text-left">
                    <SortHeader field="first_seen">First seen</SortHeader>
                  </th>
                  <th className="border-b border-border py-2 pr-4 text-right">
                    <SortHeader field="hit_count" className="justify-end">Hits</SortHeader>
                  </th>
                  <th className="border-b border-border py-2 pr-6 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    24h
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.isLoading &&
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/60">
                      {Array.from({ length: 9 }).map((_, j) => (
                        <td key={j} className="px-3 py-3">
                          <Skeleton className="h-3 w-full" />
                        </td>
                      ))}
                    </tr>
                  ))}

                {!query.isLoading && rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <div className="m-6 flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-panel/40 px-6 py-16 text-center">
                        <h3 className="text-sm font-medium">No events match these filters</h3>
                        <p className="mt-1 max-w-md text-xs text-muted-foreground">
                          Try widening the time range, switching environment, or clearing filters.
                        </p>
                        <Button variant="outline" size="sm" className="mt-4 gap-1" onClick={resetFilters}>
                          <RotateCcw className="h-3.5 w-3.5" /> Reset filters
                        </Button>
                      </div>
                    </td>
                  </tr>
                )}

                {rows.map((e) => {
                  const app = appsById.get(e.application_id);
                  const isNew =
                    !!e.introduced_by_deployment_id &&
                    latestDeployByApp.get(e.application_id) === e.introduced_by_deployment_id;
                  const climbing = isSeriesIncreasing(eventSeries[e.id]?.buckets);
                  const spark = eventSeries[e.id]?.buckets ?? [];
                  const checked = selected.has(e.id);
                  return (
                    <tr
                      key={e.id}
                      onClick={() => navigate({ to: "/events/$id", params: { id: e.id } })}
                      className={cn(
                        "group cursor-pointer border-b border-border/60 hover:bg-accent/40",
                        checked && "bg-accent/30",
                      )}
                    >
                      <td className="px-3 py-2.5" onClick={(ev) => ev.stopPropagation()}>
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleOne(e.id)}
                          aria-label="Select row"
                        />
                      </td>
                      <td className="px-1 py-2.5">
                        <span
                          className={cn(
                            "inline-block h-2 w-2 rounded-full ring-2",
                            SEVERITY_DOT[e.severity],
                            SEVERITY_RING[e.severity],
                          )}
                          title={e.severity}
                        />
                      </td>
                      <td className="py-2.5 pr-4">
                        <div className="flex min-w-0 items-center gap-2">
                          <Link
                            to="/events/$id"
                            params={{ id: e.id }}
                            className="min-w-0 truncate font-mono text-[12.5px] font-medium text-foreground hover:underline"
                            onClick={(ev: React.MouseEvent) => ev.stopPropagation()}
                          >
                            {e.name}
                          </Link>
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 rounded px-1.5 py-0 font-mono text-[10px] font-normal text-muted-foreground"
                          >
                            {TYPE_LABEL[e.type]}
                          </Badge>
                          {isNew && (
                            <Badge
                              className="h-4 shrink-0 rounded bg-primary/15 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wider text-primary"
                              variant="outline"
                            >
                              new
                            </Badge>
                          )}
                          {climbing && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="shrink-0 text-[var(--severity-error,#f97316)]">
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>Recent rate is climbing</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </td>
                      <td className="max-w-[280px] py-2.5 pr-4">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="block truncate font-mono text-[11.5px] text-muted-foreground">
                              {e.location}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="font-mono text-[11px]">{e.location}</TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-[11.5px] text-muted-foreground">
                        {app?.name ?? "—"}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4 text-[12px] text-foreground/90">
                        {relativeTime(e.last_seen)}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4 text-[12px] text-muted-foreground">
                        {relativeTime(e.first_seen)}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4 text-right font-mono text-[12px] tabular-nums text-foreground">
                        {compactNumber(e.hit_count)}
                      </td>
                      <td className="py-2.5 pr-6">
                        <Sparkline data={spark} trendUp={climbing} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function FilterCheck({
  label,
  checked,
  onChange,
  mono,
  dot,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  mono?: boolean;
  dot?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-accent/50">
      <Checkbox checked={checked} onCheckedChange={onChange} className="h-3.5 w-3.5" />
      {dot && <span className={cn("h-2 w-2 rounded-full", dot)} />}
      <span className={cn("truncate text-[12px]", mono && "font-mono text-[11.5px]")}>{label}</span>
    </label>
  );
}

function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] transition-colors",
        active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
