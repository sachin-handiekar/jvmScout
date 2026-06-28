import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useEffect } from "react";
import { z } from "zod";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import {
  ArrowLeft,
  AlertOctagon,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronRight as ChevronRightIcon,
  Check,
  EyeOff,
  UserPlus,
  Share2,
  BellOff,
  ExternalLink,
  Lock,
  Loader2,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/PagePlaceholder";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { compactNumber, relativeTime } from "@/lib/format";

// ---------- route ----------

const searchSchema = z.object({
  occ: z.number().int().min(0).optional(),
  frame: z.number().int().min(0).optional(),
});

export const Route = createFileRoute("/_authenticated/events/$id")({
  validateSearch: zodValidator(searchSchema),
  head: () => ({ meta: [{ title: "Event — jvmScout" }] }),
  component: EventDetailPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-sm text-destructive">Failed to load event: {error.message}</div>
  ),
  notFoundComponent: () => (
    <EmptyState icon={AlertOctagon} title="Event not found" hint="This event may have been deleted." />
  ),
});

// ---------- types ----------

type Severity = "critical" | "error" | "warning" | "info";
type EventType =
  | "uncaught_exception"
  | "caught_exception"
  | "logged_error"
  | "logged_warning"
  | "http_error";
type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

type EventRow = {
  id: string;
  name: string;
  type: EventType;
  severity: Severity;
  status: string;
  location: string;
  first_seen: string;
  last_seen: string;
  hit_count: number;
  application_id: string;
  introduced_by_deployment_id: string | null;
  applications: { name: string; environment: string } | null;
  introduced: { name: string } | null;
};

type SnapshotRow = {
  id: string;
  timestamp: string;
  thread_name: string | null;
  message: string | null;
  deployment_id: string | null;
  server_id: string | null;
  servers: { hostname: string } | null;
  deployments: { name: string } | null;
};

type FrameRow = {
  id: string;
  frame_index: number;
  class_name: string;
  method: string;
  file: string;
  line: number;
  in_user_code: boolean;
  source_snippet: string | null;
};

type VariableRow = {
  id: string;
  frame_id: string;
  name: string;
  type: string;
  value: string | null;
  redacted: boolean;
};

type LogRow = {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
};

// ---------- styling helpers ----------

const SEV_PILL: Record<Severity, string> = {
  critical: "bg-[var(--severity-critical,#ef4444)]/15 text-[var(--severity-critical,#ef4444)] border-[var(--severity-critical,#ef4444)]/30",
  error: "bg-[var(--severity-error,#f97316)]/15 text-[var(--severity-error,#f97316)] border-[var(--severity-error,#f97316)]/30",
  warning: "bg-[var(--severity-warning,#eab308)]/15 text-[var(--severity-warning,#eab308)] border-[var(--severity-warning,#eab308)]/30",
  info: "bg-[var(--severity-info,#3b82f6)]/15 text-[var(--severity-info,#3b82f6)] border-[var(--severity-info,#3b82f6)]/30",
};

const TYPE_LABEL: Record<EventType, string> = {
  uncaught_exception: "uncaught",
  caught_exception: "caught",
  logged_error: "log.error",
  logged_warning: "log.warn",
  http_error: "http",
};

const LOG_LEVEL_CLASS: Record<LogLevel, string> = {
  ERROR: "text-[var(--severity-error,#f97316)] border-[var(--severity-error,#f97316)]/40",
  WARN: "text-[var(--severity-warning,#eab308)] border-[var(--severity-warning,#eab308)]/40",
  INFO: "text-muted-foreground border-border",
  DEBUG: "text-muted-foreground/70 border-border",
  TRACE: "text-muted-foreground/60 border-border",
};

// ---------- data hooks ----------

function useEvent(id: string) {
  return useQuery({
    queryKey: ["event", id],
    queryFn: async () => {
      const { data: ev, error } = await supabase
        .from("events")
        .select(
          "id, name, type, severity, status, location, first_seen, last_seen, hit_count, application_id, introduced_by_deployment_id",
        )
        .eq("id", id)
        .single();
      if (error) throw error;

      const [appRes, depRes] = await Promise.all([
        ev.application_id
          ? supabase.from("applications").select("name, environment").eq("id", ev.application_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        ev.introduced_by_deployment_id
          ? supabase.from("deployments").select("name").eq("id", ev.introduced_by_deployment_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      if (appRes.error) throw appRes.error;
      if (depRes.error) throw depRes.error;

      return {
        ...ev,
        applications: appRes.data,
        introduced: depRes.data,
      } as unknown as EventRow;
    },
  });
}

function useSnapshots(eventId: string) {
  return useQuery({
    queryKey: ["event", eventId, "snapshots"],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("snapshots")
        .select("id, timestamp, thread_name, message, deployment_id, server_id")
        .eq("event_id", eventId)
        .order("timestamp", { ascending: false });
      if (error) throw error;
      const snaps = rows ?? [];

      const serverIds = Array.from(new Set(snaps.map((s) => s.server_id).filter(Boolean) as string[]));
      const deployIds = Array.from(new Set(snaps.map((s) => s.deployment_id).filter(Boolean) as string[]));

      const [serverRes, deployRes] = await Promise.all([
        serverIds.length
          ? supabase.from("servers").select("id, hostname").in("id", serverIds)
          : Promise.resolve({ data: [], error: null }),
        deployIds.length
          ? supabase.from("deployments").select("id, name").in("id", deployIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (serverRes.error) throw serverRes.error;
      if (deployRes.error) throw deployRes.error;

      const serverMap = new Map((serverRes.data ?? []).map((r) => [r.id, r]));
      const deployMap = new Map((deployRes.data ?? []).map((r) => [r.id, r]));

      return snaps.map((s) => ({
        ...s,
        servers: s.server_id ? serverMap.get(s.server_id) ?? null : null,
        deployments: s.deployment_id ? deployMap.get(s.deployment_id) ?? null : null,
      })) as unknown as SnapshotRow[];
    },
  });
}

function useSnapshotDetail(snapshotId: string | undefined) {
  return useQuery({
    enabled: !!snapshotId,
    queryKey: ["snapshot", snapshotId],
    queryFn: async () => {
      const [framesRes, logsRes] = await Promise.all([
        supabase
          .from("stack_frames")
          .select("*")
          .eq("snapshot_id", snapshotId!)
          .order("frame_index", { ascending: true }),
        supabase
          .from("log_lines")
          .select("*")
          .eq("snapshot_id", snapshotId!)
          .order("timestamp", { ascending: true }),
      ]);
      if (framesRes.error) throw framesRes.error;
      if (logsRes.error) throw logsRes.error;
      const frames = (framesRes.data ?? []) as FrameRow[];

      let variables: VariableRow[] = [];
      if (frames.length) {
        const { data, error } = await supabase
          .from("variables")
          .select("*")
          .in(
            "frame_id",
            frames.map((f) => f.id),
          );
        if (error) throw error;
        variables = (data ?? []) as VariableRow[];
      }
      return {
        frames,
        logs: (logsRes.data ?? []) as LogRow[],
        variables,
      };
    },
  });
}

// ---------- page ----------

function EventDetailPage() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/events/$id" });

  const eventQ = useEvent(id);
  const snapshotsQ = useSnapshots(id);

  const snapshots = snapshotsQ.data ?? [];
  const occIndex = Math.min(Math.max(search.occ ?? 0, 0), Math.max(snapshots.length - 1, 0));
  const currentSnapshot = snapshots[occIndex];

  const detailQ = useSnapshotDetail(currentSnapshot?.id);
  const frames = detailQ.data?.frames ?? [];
  const logs = detailQ.data?.logs ?? [];
  const variables = detailQ.data?.variables ?? [];

  const defaultFrameIdx = useMemo(() => {
    const userFrame = frames.find((f) => f.in_user_code);
    return userFrame?.frame_index ?? frames[0]?.frame_index ?? 0;
  }, [frames]);

  const selectedFrameIdx = search.frame ?? defaultFrameIdx;
  const selectedFrame = frames.find((f) => f.frame_index === selectedFrameIdx) ?? frames[0];

  // reset frame param when occurrence changes and the chosen frame no longer exists
  useEffect(() => {
    if (frames.length === 0) return;
    if (!frames.some((f) => f.frame_index === selectedFrameIdx)) {
      navigate({
        search: (prev: z.infer<typeof searchSchema>) => ({ ...prev, frame: undefined }),
        replace: true,
      });
    }
  }, [frames, selectedFrameIdx, navigate]);

  const setOcc = (next: number) => {
    navigate({
      search: (prev: z.infer<typeof searchSchema>) => ({ ...prev, occ: next, frame: undefined }),
      replace: true,
    });
  };
  const setFrame = (idx: number) => {
    navigate({
      search: (prev: z.infer<typeof searchSchema>) => ({ ...prev, frame: idx }),
      replace: true,
    });
  };

  if (eventQ.isLoading) {
    return (
      <>
        <div className="border-b border-border bg-panel/40 px-6 py-4">
          <Skeleton className="h-5 w-80" />
          <Skeleton className="mt-2 h-3 w-96" />
        </div>
        <div className="p-6">
          <Skeleton className="h-96 w-full" />
        </div>
      </>
    );
  }

  if (eventQ.error || !eventQ.data) {
    return (
      <EmptyState
        icon={AlertOctagon}
        title="Couldn't load event"
        hint={eventQ.error?.message ?? "Unknown error"}
      />
    );
  }

  const ev = eventQ.data;

  return (
    <TooltipProvider delayDuration={150}>
      <EventHeader
        event={ev}
        snapshotsCount={snapshots.length}
        occIndex={occIndex}
        currentSnapshot={currentSnapshot}
        onPrev={() => setOcc(Math.max(0, occIndex - 1))}
        onNext={() => setOcc(Math.min(snapshots.length - 1, occIndex + 1))}
      />

      {snapshotsQ.isLoading ? (
        <div className="p-6">
          <Skeleton className="h-96 w-full" />
        </div>
      ) : snapshots.length === 0 ? (
        <EmptyState
          icon={AlertOctagon}
          title="No snapshot data captured for this event"
          hint="The agent didn't capture a stack snapshot for any occurrence of this event yet."
        />
      ) : (
        <div className="flex h-[calc(100vh-9.5rem)] flex-col">
          <div className="flex flex-1 min-h-0 divide-x divide-border">
            <div className="w-[22%] min-w-[220px]">
              <StackTracePane
                frames={frames}
                selected={selectedFrame?.frame_index ?? 0}
                onSelect={setFrame}
                loading={detailQ.isLoading}
              />
            </div>
            <div className="flex-1 min-w-0">
              <SourcePane frame={selectedFrame} loading={detailQ.isLoading} />
            </div>
            <div className="w-[30%] min-w-[280px]">
              <VariablesPane
                snapshot={currentSnapshot}
                frame={selectedFrame}
                variables={variables.filter((v) => v.frame_id === selectedFrame?.id)}
                loading={detailQ.isLoading}
              />
            </div>
          </div>
          <div className="border-t border-border">
            <LogsPane logs={logs} loading={detailQ.isLoading} />
          </div>
        </div>
      )}
    </TooltipProvider>
  );
}

// ---------- header ----------

function EventHeader({
  event,
  snapshotsCount,
  occIndex,
  currentSnapshot,
  onPrev,
  onNext,
}: {
  event: EventRow;
  snapshotsCount: number;
  occIndex: number;
  currentSnapshot: SnapshotRow | undefined;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="border-b border-border bg-panel/40 px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild className="-ml-2 h-7">
              <Link to="/events">
                <ArrowLeft className="mr-1 h-3.5 w-3.5" /> Events
              </Link>
            </Button>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-base font-semibold tracking-tight">{event.name}</h1>
            <Badge variant="outline" className="font-mono text-[10px] uppercase">
              {TYPE_LABEL[event.type]}
            </Badge>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                SEV_PILL[event.severity],
              )}
            >
              {event.severity}
            </span>
            {event.status !== "active" && (
              <Badge variant="secondary" className="text-[10px] uppercase">
                {event.status}
              </Badge>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono text-foreground/80">{event.location}</span>
            <span>·</span>
            <span>{event.applications?.name ?? "—"}</span>
            {event.introduced?.name && (
              <>
                <span>·</span>
                <span>
                  introduced in <span className="font-mono text-foreground/80">{event.introduced.name}</span>
                </span>
              </>
            )}
            <span>·</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>first seen {relativeTime(event.first_seen)}</span>
              </TooltipTrigger>
              <TooltipContent>{new Date(event.first_seen).toLocaleString()}</TooltipContent>
            </Tooltip>
            <span>·</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>last seen {relativeTime(event.last_seen)}</span>
              </TooltipTrigger>
              <TooltipContent>{new Date(event.last_seen).toLocaleString()}</TooltipContent>
            </Tooltip>
            <span>·</span>
            <span className="font-mono text-foreground/80">{compactNumber(event.hit_count)} hits</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7"><Check className="mr-1 h-3.5 w-3.5"/>Resolve</Button>
          <Button size="sm" variant="ghost" className="h-7"><EyeOff className="mr-1 h-3.5 w-3.5"/>Hide</Button>
          <Button size="sm" variant="ghost" className="h-7"><UserPlus className="mr-1 h-3.5 w-3.5"/>Assign</Button>
          <Button size="sm" variant="ghost" className="h-7"><ExternalLink className="mr-1 h-3.5 w-3.5"/>Jira</Button>
          <Button size="sm" variant="ghost" className="h-7"><Share2 className="mr-1 h-3.5 w-3.5"/>Share</Button>
          <Button size="sm" variant="ghost" className="h-7"><BellOff className="mr-1 h-3.5 w-3.5"/>Mute</Button>
        </div>
      </div>

      {/* Occurrence selector */}
      {snapshotsCount > 0 && (
        <div className="mt-3 flex items-center gap-3 rounded-md border border-border bg-background/60 px-3 py-1.5 text-xs">
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              disabled={occIndex === 0}
              onClick={onPrev}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="font-mono">
              Occurrence {occIndex + 1} of {snapshotsCount}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              disabled={occIndex >= snapshotsCount - 1}
              onClick={onNext}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          {currentSnapshot && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="font-mono text-foreground/80">{currentSnapshot.servers?.hostname ?? "—"}</span>
              <span className="text-muted-foreground">·</span>
              <span className="font-mono text-foreground/80">{currentSnapshot.deployments?.name ?? "—"}</span>
              <span className="text-muted-foreground">·</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground">{relativeTime(currentSnapshot.timestamp)}</span>
                </TooltipTrigger>
                <TooltipContent>{new Date(currentSnapshot.timestamp).toLocaleString()}</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- stack trace pane ----------

type TraceRow =
  | { kind: "frame"; frame: FrameRow }
  | { kind: "collapsed"; frames: FrameRow[] };

function StackTracePane({
  frames,
  selected,
  onSelect,
  loading,
}: {
  frames: FrameRow[];
  selected: number;
  onSelect: (idx: number) => void;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set()); // keyed by first frame_index of group

  const rows: TraceRow[] = useMemo(() => {
    const out: TraceRow[] = [];
    let buffer: FrameRow[] = [];
    const flush = () => {
      if (buffer.length === 0) return;
      if (buffer.length === 1) out.push({ kind: "frame", frame: buffer[0] });
      else out.push({ kind: "collapsed", frames: buffer });
      buffer = [];
    };
    for (const f of frames) {
      if (f.in_user_code) {
        flush();
        out.push({ kind: "frame", frame: f });
      } else {
        buffer.push(f);
      }
    }
    flush();
    return out;
  }, [frames]);

  return (
    <div className="flex h-full flex-col bg-panel/20">
      <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Stack trace
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">No frames captured.</div>
        ) : (
          <ul>
            {rows.map((row, i) => {
              if (row.kind === "collapsed") {
                const key = row.frames[0].frame_index;
                const isOpen = expanded.has(key);
                if (!isOpen) {
                  return (
                    <li key={`c-${key}`}>
                      <button
                        onClick={() => {
                          const next = new Set(expanded);
                          next.add(key);
                          setExpanded(next);
                        }}
                        className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-[11px] text-muted-foreground hover:bg-elevated/40"
                      >
                        <ChevronRightIcon className="h-3 w-3" />
                        <span className="font-mono">{row.frames.length} library frames</span>
                      </button>
                    </li>
                  );
                }
                return (
                  <li key={`c-${key}`}>
                    <button
                      onClick={() => {
                        const next = new Set(expanded);
                        next.delete(key);
                        setExpanded(next);
                      }}
                      className="flex w-full items-center gap-2 border-b border-border px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-elevated/40"
                    >
                      <ChevronDown className="h-3 w-3" />
                      <span className="font-mono">{row.frames.length} library frames</span>
                    </button>
                    {row.frames.map((f) => (
                      <FrameItem
                        key={f.id}
                        frame={f}
                        selected={f.frame_index === selected}
                        onSelect={onSelect}
                        dimmed
                      />
                    ))}
                  </li>
                );
              }
              return (
                <FrameItem
                  key={row.frame.id}
                  frame={row.frame}
                  selected={row.frame.frame_index === selected}
                  onSelect={onSelect}
                />
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function FrameItem({
  frame,
  selected,
  onSelect,
  dimmed,
}: {
  frame: FrameRow;
  selected: boolean;
  onSelect: (idx: number) => void;
  dimmed?: boolean;
}) {
  const shortClass = frame.class_name.split(".").pop() ?? frame.class_name;
  return (
    <li>
      <button
        onClick={() => onSelect(frame.frame_index)}
        className={cn(
          "block w-full border-b border-border px-3 py-2 text-left transition-colors hover:bg-elevated/50",
          selected && "bg-elevated/70",
          frame.in_user_code
            ? "border-l-2 border-l-primary"
            : "border-l-2 border-l-transparent",
        )}
      >
        <div
          className={cn(
            "truncate font-mono text-[12px]",
            dimmed ? "text-muted-foreground" : "text-foreground",
          )}
          title={`${frame.class_name}.${frame.method}`}
        >
          <span className="text-muted-foreground">{frame.class_name.replace(shortClass, "")}</span>
          <span>{shortClass}</span>
          <span className="text-muted-foreground">.</span>
          <span>{frame.method}</span>
        </div>
        <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">
          {frame.file}:{frame.line}
        </div>
      </button>
    </li>
  );
}

// ---------- source pane ----------

function SourcePane({ frame, loading }: { frame: FrameRow | undefined; loading: boolean }) {
  if (loading) {
    return (
      <div className="h-full p-3">
        <Skeleton className="h-full w-full" />
      </div>
    );
  }
  if (!frame) {
    return <div className="p-4 text-xs text-muted-foreground">Select a frame.</div>;
  }
  if (!frame.source_snippet) {
    return (
      <div className="flex h-full flex-col bg-panel/10">
        <SourceHeader frame={frame} />
        <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
          No source available for this frame.
        </div>
      </div>
    );
  }

  // Parse "  N: code" and ">>> code" lines.
  const lines = frame.source_snippet.split("\n");
  const parsed = lines.map((raw) => {
    const m = /^\s*(>>>\s+)?(\d+):\s?(.*)$/.exec(raw);
    if (m) {
      return { lineNo: parseInt(m[2], 10), code: m[3], failing: !!m[1] };
    }
    // line marked with ">>> code" without explicit number
    const f = /^\s*>>>\s+(.*)$/.exec(raw);
    if (f) return { lineNo: null as number | null, code: f[1], failing: true };
    return { lineNo: null as number | null, code: raw, failing: false };
  });

  return (
    <div className="flex h-full flex-col bg-panel/10">
      <SourceHeader frame={frame} />
      <div className="flex-1 overflow-auto">
        <pre className="font-mono text-[12.5px] leading-[1.55]">
          {parsed.map((p, i) => {
            const isFailing = p.failing || p.lineNo === frame.line;
            return (
              <div
                key={i}
                className={cn(
                  "grid grid-cols-[3.5rem_1fr] items-start",
                  isFailing && "bg-[var(--severity-error,#f97316)]/10",
                )}
              >
                <span
                  className={cn(
                    "select-none border-r border-border px-2 py-0.5 text-right text-[11px] text-muted-foreground",
                    isFailing && "bg-[var(--severity-error,#f97316)]/20 font-bold text-[var(--severity-error,#f97316)]",
                  )}
                >
                  {p.lineNo ?? ""}
                </span>
                <code className="whitespace-pre px-3 py-0.5">{highlightJava(p.code)}</code>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

function SourceHeader({ frame }: { frame: FrameRow }) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-panel/30 px-3 py-2 text-[11px]">
      <span className="font-mono text-foreground/90">{frame.file}</span>
      <span className="font-mono text-muted-foreground">line {frame.line}</span>
    </div>
  );
}

// Very lightweight Java token highlighter (keywords, strings, comments, numbers).
const JAVA_KEYWORDS = new Set([
  "abstract","assert","boolean","break","byte","case","catch","char","class","const","continue",
  "default","do","double","else","enum","extends","final","finally","float","for","goto","if",
  "implements","import","instanceof","int","interface","long","native","new","package","private",
  "protected","public","return","short","static","strictfp","super","switch","synchronized",
  "this","throw","throws","transient","try","void","volatile","while","true","false","null",
  "var","record","yield",
]);

function highlightJava(src: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  // Tokenize: comments, strings, numbers, identifiers, other
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*")|(\b\d+\.?\d*[fFdDlL]?\b)|([A-Za-z_$][\w$]*)|([^\s\w]+)|(\s+)/g;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(src))) {
    if (m[1]) out.push(<span key={key++} className="text-muted-foreground/70">{m[1]}</span>);
    else if (m[2]) out.push(<span key={key++} className="text-[#a5d6a7]">{m[2]}</span>);
    else if (m[3]) out.push(<span key={key++} className="text-[#ffcc80]">{m[3]}</span>);
    else if (m[4]) {
      if (JAVA_KEYWORDS.has(m[4])) out.push(<span key={key++} className="text-[#82aaff] font-medium">{m[4]}</span>);
      else if (/^[A-Z]/.test(m[4])) out.push(<span key={key++} className="text-[#c792ea]">{m[4]}</span>);
      else out.push(<span key={key++}>{m[4]}</span>);
    } else if (m[5]) out.push(<span key={key++} className="text-muted-foreground">{m[5]}</span>);
    else out.push(<span key={key++}>{m[0]}</span>);
  }
  return out;
}

// ---------- variables pane ----------

function VariablesPane({
  snapshot,
  frame,
  variables,
  loading,
}: {
  snapshot: SnapshotRow | undefined;
  frame: FrameRow | undefined;
  variables: VariableRow[];
  loading: boolean;
}) {
  return (
    <div className="flex h-full flex-col bg-panel/20">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Variable state
        </div>
        {snapshot && (
          <div className="mt-1 space-y-0.5">
            <div className="truncate font-mono text-[11px] text-foreground/80">
              thread <span className="text-muted-foreground">·</span> {snapshot.thread_name ?? "—"}
            </div>
            {snapshot.message && (
              <div className="font-mono text-[11px] text-[var(--severity-error,#f97316)]">
                {snapshot.message}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : !frame ? (
          <div className="p-4 text-xs text-muted-foreground">No frame selected.</div>
        ) : !frame.in_user_code && variables.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">
            No variable data captured for library frames.
          </div>
        ) : variables.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">No variables captured.</div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-panel/60 text-[10.5px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Name</th>
                <th className="px-3 py-1.5 text-left font-medium">Type</th>
                <th className="px-3 py-1.5 text-left font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {variables.map((v) => (
                <VariableRowView key={v.id} v={v} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function VariableRowView({ v }: { v: VariableRow }) {
  const [open, setOpen] = useState(false);
  const value = v.value ?? "";
  const short = shortType(v.type);

  const isLong = value.length > 60;
  const json = tryParseJson(value);
  const expandable = !v.redacted && (isLong || !!json);

  return (
    <tr className="border-b border-border align-top">
      <td className="px-3 py-1.5 font-mono font-semibold text-foreground">{v.name}</td>
      <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground" title={v.type}>
        {short}
      </td>
      <td className="px-3 py-1.5 font-mono text-[12px]">
        {v.redacted ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
            <Lock className="h-3 w-3" /> [REDACTED]
          </span>
        ) : json ? (
          <div>
            <button
              onClick={() => setOpen((o) => !o)}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
              <span className="text-[11px] uppercase tracking-wide">json</span>
            </button>
            {open ? (
              <JsonView value={json} />
            ) : (
              <div className="mt-0.5 truncate text-foreground/80">{value}</div>
            )}
          </div>
        ) : expandable ? (
          <div>
            <button
              onClick={() => setOpen((o) => !o)}
              className={cn("text-left", open ? "whitespace-pre-wrap break-all" : "block max-w-[28ch] truncate")}
            >
              {value}
            </button>
          </div>
        ) : (
          <span className="break-all">{value}</span>
        )}
      </td>
    </tr>
  );
}

function shortType(t: string): string {
  const parts = t.split(".");
  return parts[parts.length - 1] || t;
}

function tryParseJson(s: string): unknown | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function JsonView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 1);

  if (value === null) return <span className="text-[#ffcc80]">null</span>;
  if (typeof value === "string") return <span className="text-[#a5d6a7]">"{value}"</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <span className="text-[#ffcc80]">{String(value)}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>;
    return (
      <div className="ml-2">
        <button onClick={() => setOpen((o) => !o)} className="text-muted-foreground hover:text-foreground">
          {open ? "▾" : "▸"} [{value.length}]
        </button>
        {open && (
          <div className="ml-3 border-l border-border pl-2">
            {value.map((item, i) => (
              <div key={i}>
                <span className="text-muted-foreground">{i}: </span>
                <JsonView value={item} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span>{"{}"}</span>;
    return (
      <div className="ml-2">
        <button onClick={() => setOpen((o) => !o)} className="text-muted-foreground hover:text-foreground">
          {open ? "▾" : "▸"} {"{"}
          {entries.length}
          {"}"}
        </button>
        {open && (
          <div className="ml-3 border-l border-border pl-2">
            {entries.map(([k, v2]) => (
              <div key={k}>
                <span className="text-[#82aaff]">{k}</span>
                <span className="text-muted-foreground">: </span>
                <JsonView value={v2} depth={depth + 1} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return <span>{String(value)}</span>;
}

// ---------- logs pane ----------

function LogsPane({ logs, loading }: { logs: LogRow[]; loading: boolean }) {
  return (
    <div className="bg-panel/10">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Logs leading up to this error
        </div>
        <div className="text-[11px] text-muted-foreground">{logs.length} lines</div>
      </div>
      <div className="max-h-56 overflow-auto">
        {loading ? (
          <div className="space-y-1.5 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">No log lines captured for this snapshot.</div>
        ) : (
          <ul className="font-mono text-[12px]">
            {logs.map((l) => (
              <li
                key={l.id}
                className={cn(
                  "grid grid-cols-[10.5rem_4rem_1fr] items-baseline gap-2 border-b border-border/60 px-3 py-1",
                  (l.level === "DEBUG" || l.level === "TRACE" || l.level === "INFO") && "text-muted-foreground",
                )}
              >
                <span className="text-[11px] text-muted-foreground">
                  {new Date(l.timestamp).toISOString().replace("T", " ").replace("Z", "")}
                </span>
                <span
                  className={cn(
                    "inline-flex justify-center rounded border px-1.5 py-0 text-[10px] font-semibold uppercase",
                    LOG_LEVEL_CLASS[l.level],
                  )}
                >
                  {l.level}
                </span>
                <span className="whitespace-pre-wrap break-words">{l.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// quiet unused-import warning in some bundlers
void Loader2;
