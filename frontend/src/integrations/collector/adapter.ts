// A minimal, Supabase-compatible query builder backed by the collector.
//
// It implements exactly the surface the UI uses:
//   supabase.from(table).select(cols).eq(c,v).in(c,vals).order(c,opts)
//   ...resolved by await (thenable), .single(), or .maybeSingle()
//   supabase.from(table).insert(obj) / .update(patch).eq(...) / .delete().eq(...)
//
// Read tables (events/snapshots/stack_frames/variables/applications/
// deployments/servers/log_lines) are derived from the collector REST API.
// Config tables (alert_rules/integrations/redaction_rules/api_tokens/
// team_members/workspace_settings) are persisted in localStorage for now;
// Phase 3 moves them into the collector.

import {
  configDelete,
  configInsert,
  configList,
  configUpdate,
  deriveApplications,
  deriveDeployments,
  deriveEvents,
  deriveServers,
  deriveSnapshots,
  deriveStackFrames,
  deriveVariables,
} from "./client";

type Row = Record<string, any>;
type Result<T> = { data: T; error: Error | null };

interface Filter {
  kind: "eq" | "in";
  col: string;
  val: any;
}

const CONFIG_TABLES = new Set([
  "alert_rules",
  "integrations",
  "redaction_rules",
  "api_tokens",
  "team_members",
  "workspace_settings",
]);

// ---------- read-table resolution ----------

async function loadReadTable(table: string, filters: Filter[]): Promise<Row[]> {
  switch (table) {
    case "events":
      return deriveEvents();
    case "snapshots":
      return deriveSnapshots();
    case "applications":
      return deriveApplications();
    case "deployments":
      return deriveDeployments();
    case "servers":
      return deriveServers();
    case "log_lines":
      return []; // collector has no log lines (yet)
    case "stack_frames": {
      const snap = filters.find((f) => f.col === "snapshot_id");
      if (!snap) return [];
      const ids = snap.kind === "in" ? (snap.val as string[]) : [String(snap.val)];
      const all = await Promise.all(ids.map((id) => deriveStackFrames(id)));
      return all.flat();
    }
    case "variables": {
      const frame = filters.find((f) => f.col === "frame_id");
      if (!frame) return [];
      const ids = frame.kind === "in" ? (frame.val as string[]) : [String(frame.val)];
      return deriveVariables(ids);
    }
    default:
      throw new Error(`unknown table: ${table}`);
  }
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((r) =>
    filters.every((f) =>
      f.kind === "eq"
        ? r[f.col] === f.val
        : Array.isArray(f.val) && f.val.includes(r[f.col]),
    ),
  );
}

// ---------- query builder ----------

class QueryBuilder<T = Row[]> implements PromiseLike<Result<T>> {
  private filters: Filter[] = [];
  private orderBy: { col: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: any = null;
  private mode: "many" | "single" | "maybeSingle" = "many";

  constructor(private table: string) {}

  select(_cols?: string): this {
    // Column projection is ignored; consumers read named fields off full rows.
    if (this.op !== "insert" && this.op !== "update" && this.op !== "delete") {
      this.op = "select";
    }
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }

  update(patch: Row): this {
    this.op = "update";
    this.payload = patch;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  eq(col: string, val: any): this {
    this.filters.push({ kind: "eq", col, val });
    return this;
  }

  in(col: string, val: any[]): this {
    this.filters.push({ kind: "in", col, val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, ascending: opts?.ascending ?? true };
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  // `data` is intentionally `any` here (like supabase-js, which types single()
  // as the non-null row) so callers can read fields without null guards.
  single(): Promise<{ data: any; error: Error | null }> {
    this.mode = "single";
    return this.run();
  }

  maybeSingle(): Promise<{ data: any; error: Error | null }> {
    this.mode = "maybeSingle";
    return this.run();
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: any) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled as any, onrejected);
  }

  /** Resolve the config-row ids targeted by the current filters. */
  private async matchingConfigIds(): Promise<string[]> {
    const idEq = this.filters.find((f) => f.col === "id" && f.kind === "eq");
    if (idEq && this.filters.length === 1) return [String(idEq.val)];
    const rows = applyFilters(await configList(this.table), this.filters);
    return rows.map((r) => String(r.id));
  }

  private async run(): Promise<Result<any>> {
    try {
      const isConfig = CONFIG_TABLES.has(this.table);

      if (this.op === "insert") {
        if (!isConfig) throw new Error(`insert not supported on ${this.table}`);
        const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted: Row[] = [];
        for (const r of incoming) inserted.push(await configInsert(this.table, r));
        return { data: inserted, error: null };
      }

      if (this.op === "update") {
        if (!isConfig) throw new Error(`update not supported on ${this.table}`);
        const ids = await this.matchingConfigIds();
        let last: Row | null = null;
        for (const id of ids) last = await configUpdate(this.table, id, this.payload);
        return { data: last, error: null };
      }

      if (this.op === "delete") {
        if (!isConfig) throw new Error(`delete not supported on ${this.table}`);
        const ids = await this.matchingConfigIds();
        for (const id of ids) await configDelete(this.table, id);
        return { data: null, error: null };
      }

      // select
      let rows = isConfig
        ? applyFilters(await configList(this.table), this.filters)
        : applyFilters(await loadReadTable(this.table, this.filters), this.filters);

      if (this.orderBy) {
        const { col, ascending } = this.orderBy;
        rows = [...rows].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return ascending ? cmp : -cmp;
        });
      }

      if (this.limitN != null) rows = rows.slice(0, this.limitN);

      if (this.mode === "single") {
        if (rows.length === 0) {
          return { data: null, error: new Error("no rows found (single)") };
        }
        return { data: rows[0], error: null };
      }
      if (this.mode === "maybeSingle") {
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}

export const collectorClient = {
  from(table: string) {
    return new QueryBuilder(table);
  },
};
