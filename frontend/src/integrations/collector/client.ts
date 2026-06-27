// Low-level client for the JVMTI exception collector + derivation helpers that
// reshape the collector's flat exception/instance data into the row shapes the
// UI was built against (events / snapshots / stack_frames / variables /
// applications / deployments / servers).
//
// The collector is a single-stream exception sink; it has no native notion of
// applications, deployments-as-entities, severity, or status. Those are derived
// here. Known v1 simplifications:
//   - environment is always "production" (the collector has no env concept)
//   - event_type is only uncaught_exception / caught_exception
//   - an "application" and its "deployment" are both keyed off deployment_id

const BASE = ((import.meta as any).env?.VITE_COLLECTOR_URL ?? "").replace(/\/$/, "");
const API_KEY_STORAGE = "jvmscout_api_key";

export class CollectorAuthError extends Error {
  constructor() {
    super("collector requires an API key (401)");
    this.name = "CollectorAuthError";
  }
}

export function getApiKey(): string | null {
  try {
    return localStorage.getItem(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setApiKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE, key);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  const key = getApiKey();
  if (key) h["X-API-Key"] = key;
  return h;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: authHeaders(init?.headers as Record<string, string> | undefined),
  });
  if (res.status === 401) throw new CollectorAuthError();
  if (!res.ok) throw new Error(`collector ${res.status} on ${path}`);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- raw collector shapes ----------

export interface ExceptionListRow {
  id: number;
  received_at: string;
  timestamp: string | null;
  fingerprint: string;
  capture_mode: string | null;
  hit_count: number;
  deployment_id: string | null;
  instance_id: string | null;
  exception_type: string | null;
  exception_message: string | null;
  caught: boolean | null;
  class_name: string | null;
  method_name: string | null;
  line_number: number | null;
  source_file: string | null;
  thread_name: string | null;
}

// ---------- UI row shapes (subset of the old Supabase schema) ----------

export type Severity = "critical" | "error" | "warning" | "info";
export type EventType =
  | "uncaught_exception"
  | "caught_exception"
  | "logged_error"
  | "logged_warning"
  | "http_error";

const UNKNOWN_APP = "unknown";

function severityFor(row: ExceptionListRow): Severity {
  if (row.caught === false) {
    return /Error$|OutOfMemory|StackOverflow/.test(row.exception_type ?? "")
      ? "critical"
      : "error";
  }
  return "warning";
}

function locationFor(row: ExceptionListRow): string {
  const cls = row.class_name ?? "?";
  const method = row.method_name ?? "?";
  const line = row.line_number ? `:${row.line_number}` : "";
  return `${cls}.${method}${line}`;
}

function tsOf(row: ExceptionListRow): string {
  return row.timestamp ?? row.received_at;
}

// ---------- short-lived cache so the route-level Promise.all fan-out of
//            from("events"), from("applications"), ... hits the network once ----------

let _excCache: { at: number; rows: ExceptionListRow[] } | null = null;
let _instCache: { at: number; rows: any[] } | null = null;
const TTL_MS = 4000;

export function invalidateCache(): void {
  _excCache = null;
  _instCache = null;
}

export async function fetchAllExceptions(cap = 2000): Promise<ExceptionListRow[]> {
  if (_excCache && Date.now() - _excCache.at < TTL_MS) return _excCache.rows;
  const out: ExceptionListRow[] = [];
  const limit = 500;
  let offset = 0;
  for (;;) {
    const res = await http<{ items: ExceptionListRow[]; total: number }>(
      `/exceptions?limit=${limit}&offset=${offset}`,
    );
    out.push(...res.items);
    offset += res.items.length;
    if (res.items.length < limit || out.length >= cap || offset >= res.total) break;
  }
  _excCache = { at: Date.now(), rows: out };
  return out;
}

export async function fetchInstances(): Promise<any[]> {
  if (_instCache && Date.now() - _instCache.at < TTL_MS) return _instCache.rows;
  const rows = await http<any[]>(`/jvm-instances`);
  _instCache = { at: Date.now(), rows };
  return rows;
}

export async function fetchExceptionDetail(rowId: number | string): Promise<any> {
  return http<any>(`/exceptions/${rowId}`);
}

export interface TimeseriesBucket {
  t: number; // epoch ms (bucket start)
  caught: number;
  uncaught: number;
}

/** Real per-time-bucket exception counts (caught vs uncaught) from the collector. */
export async function fetchTimeseries(
  hours: number,
  buckets: number,
  environment?: string,
): Promise<TimeseriesBucket[]> {
  const params = new URLSearchParams({ hours: String(hours), buckets: String(buckets) });
  if (environment) params.set("environment", environment);
  const res = await http<{ series: TimeseriesBucket[] }>(`/stats/timeseries?${params.toString()}`);
  return res.series ?? [];
}

export interface FingerprintSeries {
  total: number;
  buckets: number[];
}

export interface EventSeriesResult {
  start: number; // epoch ms of first bucket
  bucket_ms: number;
  series: Record<string, FingerprintSeries>; // keyed by fingerprint
}

/**
 * Real per-fingerprint occurrence counts over a window, bucketed for sparklines.
 * Replaces the client-side fabricated hit/sparkline/trend math on the dashboard.
 */
export async function fetchEventSeries(
  hours: number,
  buckets: number,
  environment?: string,
): Promise<EventSeriesResult> {
  const params = new URLSearchParams({ hours: String(hours), buckets: String(buckets) });
  if (environment) params.set("environment", environment);
  const res = await http<EventSeriesResult>(`/stats/event-series?${params.toString()}`);
  return { start: res.start, bucket_ms: res.bucket_ms, series: res.series ?? {} };
}

/** True if a bucketed series is trending up (later half outweighs the earlier). */
export function isSeriesIncreasing(buckets: number[] | undefined): boolean {
  if (!buckets || buckets.length < 2) return false;
  const mid = Math.floor(buckets.length / 2);
  let first = 0;
  let last = 0;
  for (let i = 0; i < buckets.length; i++) {
    if (i < mid) first += buckets[i];
    else last += buckets[i];
  }
  return last > 0 && last > first * 1.2;
}

/**
 * Validate the current API key against an auth-gated endpoint.
 * Returns true if the collector accepts the request (including the case where
 * the collector runs unauthenticated), false on 401. Network errors propagate
 * so the caller can distinguish "collector down" from "bad key".
 */
export async function verifyApiKey(): Promise<boolean> {
  try {
    await http("/stats");
    return true;
  } catch (e) {
    if (e instanceof CollectorAuthError) return false;
    throw e;
  }
}

// ---------- derivations ----------

export interface EventRow {
  id: string; // = fingerprint
  type: EventType;
  name: string;
  location: string;
  first_seen: string;
  last_seen: string;
  status: "active" | "resolved" | "hidden";
  severity: Severity;
  hit_count: number;
  application_id: string;
  introduced_by_deployment_id: string | null;
}

export async function deriveEvents(): Promise<EventRow[]> {
  const rows = await fetchAllExceptions();
  const groups = new Map<string, ExceptionListRow[]>();
  for (const r of rows) {
    const key = r.fingerprint || `id:${r.id}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const events: EventRow[] = [];
  for (const [fp, g] of groups) {
    // rows arrive id-desc, so g[0] is the most recent occurrence.
    const rep = g[0];
    const times = g.map(tsOf).sort();
    events.push({
      id: fp,
      type: rep.caught === false ? "uncaught_exception" : "caught_exception",
      name: rep.exception_type ?? "java.lang.Throwable",
      location: locationFor(rep),
      first_seen: times[0],
      last_seen: times[times.length - 1],
      status: "active",
      severity: severityFor(rep),
      hit_count: g.reduce((sum, r) => sum + (r.hit_count || 1), 0),
      application_id: rep.deployment_id ?? UNKNOWN_APP,
      introduced_by_deployment_id: null,
    });
  }
  return events;
}

export interface SnapshotRow {
  id: string; // = exception row id
  event_id: string; // = fingerprint
  server_id: string | null; // = instance_id
  deployment_id: string | null;
  timestamp: string;
  thread_name: string | null;
  message: string | null;
}

export async function deriveSnapshots(): Promise<SnapshotRow[]> {
  const rows = await fetchAllExceptions();
  return rows.map((r) => ({
    id: String(r.id),
    event_id: r.fingerprint || `id:${r.id}`,
    server_id: r.instance_id,
    deployment_id: r.deployment_id,
    timestamp: tsOf(r),
    thread_name: r.thread_name,
    message: r.exception_message,
  }));
}

export interface ApplicationRow {
  id: string;
  name: string;
  environment: "production" | "staging" | "development";
  created_at: string;
}

function normalizeEnvironment(raw: unknown): ApplicationRow["environment"] {
  const v = String(raw ?? "").toLowerCase();
  if (v === "staging" || v === "stage" || v === "stg") return "staging";
  if (v === "development" || v === "dev" || v === "local") return "development";
  return "production"; // default + explicit "production"/"prod"/unknown
}

export async function deriveApplications(): Promise<ApplicationRow[]> {
  const [rows, instances] = await Promise.all([fetchAllExceptions(), fetchInstances()]);
  const ids = new Set<string>();
  const earliest: Record<string, string> = {};
  for (const r of rows) {
    const id = r.deployment_id ?? UNKNOWN_APP;
    ids.add(id);
    const t = tsOf(r);
    if (!earliest[id] || t < earliest[id]) earliest[id] = t;
  }
  // Environment is reported on agent_start (per instance); map it per deployment.
  const envByApp: Record<string, ApplicationRow["environment"]> = {};
  for (const inst of instances) {
    const id = inst.deploymentId ?? inst.deployment_id ?? UNKNOWN_APP;
    ids.add(id);
    if (inst.environment) envByApp[id] = normalizeEnvironment(inst.environment);
  }
  return Array.from(ids).map((id) => ({
    id,
    name: id,
    environment: envByApp[id] ?? "production",
    created_at: earliest[id] ?? new Date().toISOString(),
  }));
}

export interface DeploymentRow {
  id: string;
  name: string;
  application_id: string;
  started_at: string;
}

export async function deriveDeployments(): Promise<DeploymentRow[]> {
  const apps = await deriveApplications();
  // One synthetic deployment per application (keyed identically).
  return apps.map((a) => ({
    id: a.id,
    name: a.id,
    application_id: a.id,
    started_at: a.created_at,
  }));
}

export interface ServerRow {
  id: string;
  hostname: string;
  application_id: string;
  status: "active" | "dormant" | "offline";
  agent_version: string;
  last_seen: string;
}

export async function deriveServers(): Promise<ServerRow[]> {
  const instances = await fetchInstances();
  const now = Date.now();
  return instances.map((inst) => {
    const instanceId = inst.instanceId ?? inst.instance_id ?? "unknown";
    const host = inst.hostInfo ?? inst.host_info ?? {};
    const lastSeen = inst.timestamp ?? inst.receivedAt ?? new Date().toISOString();
    const ageMs = now - new Date(lastSeen).getTime();
    const status: ServerRow["status"] =
      ageMs < 5 * 60_000 ? "active" : ageMs < 60 * 60_000 ? "dormant" : "offline";
    return {
      id: instanceId,
      hostname: host.name ?? instanceId,
      application_id: inst.deploymentId ?? inst.deployment_id ?? UNKNOWN_APP,
      status,
      agent_version: (inst.agentConfig ?? inst.agent_config ?? {})?.version ?? "—",
      last_seen: lastSeen,
    };
  });
}

export interface FrameRow {
  id: string; // `${snapshotId}:${frameIndex}`
  snapshot_id: string;
  frame_index: number;
  class_name: string;
  method: string;
  file: string;
  line: number;
  in_user_code: boolean;
  source_snippet: string | null;
}

export interface VariableRow {
  id: string;
  frame_id: string;
  name: string;
  type: string;
  value: string | null;
  redacted: boolean;
}

async function detailFrames(snapshotId: string): Promise<{ frames: FrameRow[]; variables: VariableRow[] }> {
  const detail = await fetchExceptionDetail(snapshotId);
  const stack: any[] = detail?.stackTrace ?? detail?.stack_trace ?? [];
  const frames: FrameRow[] = [];
  const variables: VariableRow[] = [];
  stack.forEach((f, i) => {
    const idx = f.frameIndex ?? f.frame_index ?? i;
    const frameId = `${snapshotId}:${idx}`;
    frames.push({
      id: frameId,
      snapshot_id: snapshotId,
      frame_index: idx,
      class_name: f.className ?? f.class_name ?? "?",
      method: f.methodName ?? f.method_name ?? "?",
      file: f.sourceFile ?? f.source_file ?? "",
      line: f.lineNumber ?? f.line_number ?? 0,
      in_user_code: f.isAppCode ?? f.is_app_code ?? false,
      // Decompiled source the collector attaches per app frame (null if no
      // bytecode was captured / no decompiler is available).
      source_snippet: f.sourceSnippet ?? f.source_snippet ?? null,
    });
    const locals: any[] = f.localVariables ?? f.local_variables ?? [];
    locals.forEach((v, vi) => {
      variables.push({
        id: `${frameId}:${vi}`,
        frame_id: frameId,
        name: v.name ?? "?",
        type: v.type ?? v.signature ?? "?",
        value: v.value ?? null,
        redacted: false,
      });
    });
  });
  return { frames, variables };
}

export async function deriveStackFrames(snapshotId: string): Promise<FrameRow[]> {
  return (await detailFrames(snapshotId)).frames;
}

/** Variables for a set of frame ids (frame id = `${snapshotId}:${frameIndex}`). */
export async function deriveVariables(frameIds: string[]): Promise<VariableRow[]> {
  const snapshotIds = Array.from(new Set(frameIds.map((f) => f.split(":")[0])));
  const wanted = new Set(frameIds);
  const all = await Promise.all(snapshotIds.map((sid) => detailFrames(sid)));
  return all.flatMap((d) => d.variables).filter((v) => wanted.has(v.frame_id));
}

// ---------- config entities (alert_rules, integrations, redaction_rules,
//            api_tokens, team_members, workspace_settings) ----------

export async function configList(table: string): Promise<any[]> {
  return http<any[]>(`/config/${table}`);
}

export async function configInsert(table: string, row: Record<string, any>): Promise<any> {
  return http<any>(`/config/${table}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(row),
  });
}

export async function configUpdate(
  table: string,
  id: string,
  patch: Record<string, any>,
): Promise<any> {
  return http<any>(`/config/${table}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function configDelete(table: string, id: string): Promise<void> {
  await http(`/config/${table}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Issue an API token server-side; the raw token is returned exactly once. The
 * token is bound to a project and a role (ingest | viewer | admin). */
export async function createApiToken(
  name: string,
  opts?: { project_id?: string; role?: string },
): Promise<{
  token: string;
  token_prefix: string;
  id: string;
  name: string;
  project_id: string;
  role: string;
}> {
  return http(`/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      project_id: opts?.project_id || undefined,
      role: opts?.role || undefined,
    }),
  });
}

/** Live event stream over the collector WebSocket. */
export function connectLiveSocket(onMessage: (msg: any) => void): WebSocket | null {
  try {
    const httpBase = BASE || window.location.origin;
    const wsBase = httpBase.replace(/^http/, "ws");
    const key = getApiKey();
    const url = `${wsBase}/ws/live${key ? `?key=${encodeURIComponent(key)}` : ""}`;
    const ws = new WebSocket(url);
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    return ws;
  } catch {
    return null;
  }
}
