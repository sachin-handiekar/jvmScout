import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Copy,
  RefreshCw,
  Check,
  Plug,
  Plus,
  Trash2,
  Slack,
  Siren,
  Webhook,
  Activity,
  Boxes,
  Mail,
  AlertTriangle,
  Database,
  Server,
  FileCode,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import {
  createApiToken,
  resetAllData,
  invalidateCache,
} from "@/integrations/collector/client";
import { PageHeader } from "@/components/PagePlaceholder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Settings — jvmScout" }] }),
  component: SettingsPage,
});

function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Agent install, integrations, redaction, API tokens, and team."
      />
      <div className="p-6">
        <Tabs defaultValue="agent" className="w-full">
          <TabsList>
            <TabsTrigger value="agent">Agent install</TabsTrigger>
            <TabsTrigger value="integrations">Integrations</TabsTrigger>
            <TabsTrigger value="redaction">Data privacy</TabsTrigger>
            <TabsTrigger value="tokens">API tokens</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="admin">Admin</TabsTrigger>
          </TabsList>
          <TabsContent value="agent" className="mt-4">
            <AgentInstallTab />
          </TabsContent>
          <TabsContent value="integrations" className="mt-4">
            <IntegrationsTab />
          </TabsContent>
          <TabsContent value="redaction" className="mt-4">
            <RedactionTab />
          </TabsContent>
          <TabsContent value="tokens" className="mt-4">
            <TokensTab />
          </TabsContent>
          <TabsContent value="team" className="mt-4">
            <TeamTab />
          </TabsContent>
          <TabsContent value="admin" className="mt-4">
            <AdminTab />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

// ============= Shared =============

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success("Copied to clipboard");
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="ml-1.5">{label}</span>
    </Button>
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-lg border border-border bg-panel/40 p-4", className)}>
      {children}
    </div>
  );
}

function SectionHeader({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

function Snippet({ code }: { code: string }) {
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[12px] text-foreground/90">
        {code}
      </pre>
      <div className="absolute right-2 top-2 opacity-0 transition group-hover:opacity-100">
        <CopyButton value={code} label="" />
      </div>
    </div>
  );
}

// ============= Tab 1: Agent Install =============

function AgentInstallTab() {
  const qc = useQueryClient();

  // Real, project-scoped ingest tokens for this tenant — the actual credentials
  // agents authenticate with. There is no separate "install key": a token's raw
  // value is returned by the collector only once, at creation.
  const { data: ingestTokens } = useQuery({
    // Distinct from TokensTab's ["api_tokens"] (different row shape), but still
    // refreshed by its prefix-matching invalidations.
    queryKey: ["api_tokens", "ingest"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("api_tokens")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).filter(
        (t: any) => (t.role ?? "ingest") === "ingest" && !t.revoked_at,
      );
    },
  });

  // Live fleet status, derived from the collector's /jvm-instances feed.
  const { data: agentStats } = useQuery({
    queryKey: ["agent_stats"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("servers")
        .select("id, status, last_seen");
      if (error) throw error;
      const active = (data ?? []).filter((s) => s.status === "active").length;
      const total = (data ?? []).length;
      const latest = (data ?? [])
        .map((s) => s.last_seen)
        .filter(Boolean)
        .sort()
        .reverse()[0];
      return { active, total, latest };
    },
    refetchInterval: 30_000,
  });

  const [project, setProject] = useState("default");
  const [newKey, setNewKey] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: async () => {
      const pid = project.trim() || "default";
      // Mint a real ingest token bound to the project; raw value returns once.
      const res = await createApiToken(`agent-${pid}`, { project_id: pid, role: "ingest" });
      return res.token;
    },
    onSuccess: (raw) => {
      qc.invalidateQueries({ queryKey: ["api_tokens"] });
      setNewKey(raw);
      toast.success("Ingest key generated — copy it now");
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Could not generate key"),
  });

  // The snippets show the just-minted key (once) or a placeholder otherwise.
  const key = newKey ?? "<your-ingest-token>";
  const reportingActive = (agentStats?.active ?? 0) > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <SectionHeader
          title="Get started"
          hint="Point JVMSCOUT_HOME at a directory holding the agent library, bci-transform.jar, and a jvmscout.yaml settings file. The JVM flag then just loads the library; everything else comes from the file or environment."
        />

        <div className="space-y-5">
          <div>
            <Label className="mb-1.5 block text-xs font-medium">1. Generate an ingest key</Label>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[160px] flex-1 space-y-1">
                <Label className="text-[11px] text-muted-foreground">Project</Label>
                <Input
                  placeholder="default"
                  value={project}
                  onChange={(e) => setProject(e.target.value)}
                  className="font-mono"
                />
              </div>
              <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
                <Plus className="h-3.5 w-3.5" />
                <span className="ml-1.5">Generate</span>
              </Button>
            </div>
            {newKey ? (
              <div className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                <div className="mb-1 text-[11px] font-medium text-emerald-400">
                  Ingest key created — copy it now, you won't see it again.
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-xs">
                    {newKey}
                  </code>
                  <CopyButton value={newKey} label="Copy" />
                  <Button size="sm" variant="ghost" onClick={() => setNewKey(null)}>Dismiss</Button>
                </div>
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Mints a project-scoped <span className="font-mono">ingest</span> token. Manage or
                revoke keys under the <span className="font-medium">API tokens</span> tab.
              </p>
            )}
          </div>

          <div>
            <Label className="mb-1.5 block text-xs font-medium">2. $JVMSCOUT_HOME/jvmscout.yaml</Label>
            <Snippet code={`host: <collector-host>\nport: 8080\ndeployment: <your-service>\nenvironment: production`} />
            <p className="mt-1.5 text-xs text-muted-foreground">
              Keep the key out of the file — pass it as the{" "}
              <span className="font-mono">JVMSCOUT_API_KEY</span> environment variable below.
            </p>
          </div>

          <div>
            <Label className="mb-1.5 block text-xs font-medium">3. Linux / JVM flag</Label>
            <Snippet code={`export JVMSCOUT_HOME=/opt/jvmscout\nexport JVMSCOUT_API_KEY=${key}\njava -agentpath:$JVMSCOUT_HOME/lib/libjvmti-agent.so -jar your-app.jar`} />
          </div>

          <div>
            <Label className="mb-1.5 block text-xs font-medium">Docker</Label>
            <Snippet
              code={`docker run -d \\\n  -v /opt/jvmscout:/opt/jvmscout:ro \\\n  -e JVMSCOUT_HOME=/opt/jvmscout \\\n  -e JVMSCOUT_API_KEY=${key} \\\n  -e JAVA_TOOL_OPTIONS="-agentpath:/opt/jvmscout/lib/libjvmti-agent.so" \\\n  your-org/your-app:latest`}
            />
          </div>

          {(ingestTokens ?? []).length > 0 && (
            <div>
              <Label className="mb-1.5 block text-xs font-medium">Existing ingest keys</Label>
              <div className="divide-y divide-border rounded-md border border-border">
                {(ingestTokens ?? []).map((t: any) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-[11px]"
                  >
                    <span className="font-medium">{t.name}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className="font-mono">{t.token_prefix}…</span>
                      <span className="rounded border border-border px-1.5 py-px font-mono">
                        {t.project_id || "default"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <SectionHeader title="Agent status" hint="Live reporting from your fleet." />
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "relative inline-flex h-2.5 w-2.5 rounded-full",
              reportingActive ? "bg-emerald-500" : "bg-muted-foreground/40",
            )}
          >
            {reportingActive && (
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60" />
            )}
          </span>
          <div>
            <div className="text-sm font-medium">
              {reportingActive ? "Agents reporting" : "Waiting for first agent"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {agentStats
                ? `${agentStats.active} active · ${agentStats.total} total`
                : "—"}
            </div>
          </div>
        </div>
        {agentStats?.latest && (
          <div className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
            Last check-in {relativeTime(agentStats.latest)}
          </div>
        )}
      </Card>
    </div>
  );
}

// ============= Tab 2: Integrations =============

const INTEGRATION_CATALOG: Array<{
  type: string;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { type: "slack", name: "Slack", description: "Post alerts to channels.", icon: Slack },
  { type: "pagerduty", name: "PagerDuty", description: "Page on-call for critical errors.", icon: Siren },
  { type: "jira", name: "Jira", description: "File issues from events.", icon: Boxes },
  { type: "datadog", name: "Datadog", description: "Forward metrics & traces.", icon: Activity },
  { type: "webhook", name: "Webhook", description: "Send JSON to any endpoint.", icon: Webhook },
];

function IntegrationsTab() {
  const qc = useQueryClient();
  const { data: rows, isLoading } = useQuery({
    queryKey: ["integrations"],
    queryFn: async () => {
      const { data, error } = await supabase.from("integrations").select("*");
      if (error) throw error;
      return data ?? [];
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ type, connect }: { type: string; connect: boolean }) => {
      const existing = rows?.find((r: any) => r.type === type);
      if (existing) {
        const { error } = await supabase
          .from("integrations")
          .update({ status: connect ? "connected" : "disconnected" })
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("integrations")
          .insert({ type, status: connect ? "connected" : "disconnected", config: {} });
        if (error) throw error;
      }
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["integrations"] });
      toast.success(vars.connect ? "Integration connected" : "Integration disconnected");
    },
  });

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {INTEGRATION_CATALOG.map((item) => {
        const row = rows?.find((r: any) => r.type === item.type);
        const connected = row?.status === "connected";
        const Icon = item.icon;
        return (
          <Card key={item.type}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background">
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{item.name}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{item.description}</div>
                </div>
              </div>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                  connected
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                    : "border-border text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    connected ? "bg-emerald-500" : "bg-muted-foreground/50",
                  )}
                />
                {connected ? "Connected" : "Not connected"}
              </span>
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                size="sm"
                variant={connected ? "outline" : "default"}
                disabled={isLoading || toggle.isPending}
                onClick={() => {
                  if (!connected) {
                    toast.info(`Redirecting to ${item.name}…`, { duration: 800 });
                    setTimeout(() => toggle.mutate({ type: item.type, connect: true }), 400);
                  } else {
                    toggle.mutate({ type: item.type, connect: false });
                  }
                }}
              >
                <Plug className="h-3.5 w-3.5" />
                <span className="ml-1.5">{connected ? "Disconnect" : "Connect"}</span>
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ============= Tab 3: Redaction =============

function RedactionTab() {
  const qc = useQueryClient();
  const { data: rules, isLoading } = useQuery({
    queryKey: ["redaction_rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("redaction_rules")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<{ kind: "pattern" | "identifier"; name: string; value: string }>({
    kind: "pattern",
    name: "",
    value: "",
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase.from("redaction_rules").update({ enabled }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["redaction_rules"] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("redaction_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["redaction_rules"] });
      toast.success("Rule removed");
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("redaction_rules").insert({
        kind: draft.kind,
        name: draft.name,
        value: draft.value,
        enabled: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["redaction_rules"] });
      toast.success("Rule added");
      setOpen(false);
      setDraft({ kind: "pattern", name: "", value: "" });
    },
  });

  const patterns = (rules ?? []).filter((r: any) => r.kind === "pattern");
  const identifiers = (rules ?? []).filter((r: any) => r.kind === "identifier");

  return (
    <div className="space-y-4">
      <Card className="border-amber-500/20 bg-amber-500/5">
        <div className="text-xs text-amber-300/90">
          <strong className="font-semibold">Redaction happens at capture time.</strong>{" "}
          Matching variable values are replaced with <code className="rounded bg-background/60 px-1">[REDACTED]</code>
          {" "}before leaving the host. Disabling a rule does <em>not</em> reveal previously redacted data.
        </div>
      </Card>

      <Card>
        <SectionHeader
          title="Patterns"
          hint="Regex patterns matched against variable values."
          action={
            <Button size="sm" onClick={() => { setDraft({ kind: "pattern", name: "", value: "" }); setOpen(true); }}>
              <Plus className="h-3.5 w-3.5" /> <span className="ml-1.5">Add rule</span>
            </Button>
          }
        />
        <RuleList rows={patterns} loading={isLoading} mono onToggle={(id, v) => toggle.mutate({ id, enabled: v })} onDelete={(id) => remove.mutate(id)} />
      </Card>

      <Card>
        <SectionHeader
          title="Identifiers"
          hint="Variable names that should always be masked, regardless of value."
          action={
            <Button size="sm" onClick={() => { setDraft({ kind: "identifier", name: "", value: "" }); setOpen(true); }}>
              <Plus className="h-3.5 w-3.5" /> <span className="ml-1.5">Add rule</span>
            </Button>
          }
        />
        <RuleList rows={identifiers} loading={isLoading} mono onToggle={(id, v) => toggle.mutate({ id, enabled: v })} onDelete={(id) => remove.mutate(id)} />
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New {draft.kind === "pattern" ? "pattern" : "identifier"} rule</DialogTitle>
            <DialogDescription>
              {draft.kind === "pattern"
                ? "Regex matched against captured variable values."
                : "Variable name (case-insensitive contains match)."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={draft.kind === "pattern" ? "Phone numbers" : "Session token"}
              />
            </div>
            <div>
              <Label className="text-xs">{draft.kind === "pattern" ? "Regex" : "Identifier"}</Label>
              <Input
                value={draft.value}
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                placeholder={draft.kind === "pattern" ? "\\d{3}-\\d{4}" : "sessionToken"}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={!draft.name || !draft.value || create.isPending}>
              Add rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RuleList({
  rows,
  loading,
  mono,
  onToggle,
  onDelete,
}: {
  rows: any[];
  loading: boolean;
  mono?: boolean;
  onToggle: (id: string, v: boolean) => void;
  onDelete: (id: string) => void;
}) {
  if (loading) return <Skeleton className="h-16 w-full" />;
  if (rows.length === 0)
    return <div className="py-6 text-center text-xs text-muted-foreground">No rules yet.</div>;
  return (
    <div className="divide-y divide-border">
      {rows.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium">{r.name}</div>
            <div className={cn("mt-0.5 truncate text-[11px] text-muted-foreground", mono && "font-mono")}>
              {r.value}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={r.enabled} onCheckedChange={(v) => onToggle(r.id, v)} />
            <Button size="icon" variant="ghost" onClick={() => onDelete(r.id)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============= Tab 4: API Tokens =============

const TOKEN_ROLES = ["ingest", "viewer", "admin"] as const;
type TokenRole = (typeof TOKEN_ROLES)[number];

function TokensTab() {
  const qc = useQueryClient();
  const { data: tokens, isLoading } = useQuery({
    queryKey: ["api_tokens"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("api_tokens")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const [name, setName] = useState("");
  const [project, setProject] = useState("default");
  const [role, setRole] = useState<TokenRole>("ingest");
  const [newToken, setNewToken] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: async () => {
      // Token is generated and hashed server-side; the raw value is returned once.
      const res = await createApiToken(name || "Untitled token", {
        project_id: project.trim() || "default",
        role,
      });
      return res.token;
    },
    onSuccess: (raw) => {
      qc.invalidateQueries({ queryKey: ["api_tokens"] });
      setNewToken(raw);
      setName("");
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("api_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api_tokens"] });
      toast.success("Token revoked");
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeader
          title="Create token"
          hint="Bound to a project + role. ingest = agents (send only), viewer = read-only dashboard, admin = manage. Shown once — store it securely."
        />
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[180px] flex-1 space-y-1">
            <Label className="text-[11px] text-muted-foreground">Name</Label>
            <Input
              placeholder="e.g. payments-agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="w-40 space-y-1">
            <Label className="text-[11px] text-muted-foreground">Project</Label>
            <Input
              placeholder="default"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="w-32 space-y-1">
            <Label className="text-[11px] text-muted-foreground">Role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as TokenRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOKEN_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={() => generate.mutate()} disabled={generate.isPending}>
            <Plus className="h-3.5 w-3.5" /> <span className="ml-1.5">Generate</span>
          </Button>
        </div>
        {newToken && (
          <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
            <div className="mb-1 text-[11px] font-medium text-emerald-400">
              Token created — copy it now, you won't see it again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-xs">
                {newToken}
              </code>
              <CopyButton value={newToken} label="Copy" />
              <Button size="sm" variant="ghost" onClick={() => setNewToken(null)}>Dismiss</Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <SectionHeader title="Active tokens" />
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (tokens ?? []).length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">No tokens yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {(tokens ?? []).map((t: any) => {
              const revoked = !!t.revoked_at;
              return (
                <div key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{t.name}</span>
                      {revoked && (
                        <span className="rounded-full border border-border px-1.5 py-px text-[10px] text-muted-foreground">
                          revoked
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="font-mono">{t.token_prefix}…</span>
                      <span className="rounded border border-border px-1.5 py-px font-mono">
                        {t.project_id || "default"}
                      </span>
                      <span className="rounded border border-border px-1.5 py-px uppercase tracking-wide">
                        {t.role || "ingest"}
                      </span>
                      <span>Created {relativeTime(t.created_at)}</span>
                    </div>
                  </div>
                  {!revoked && (
                    <Button size="sm" variant="outline" onClick={() => revoke.mutate(t.id)}>
                      Revoke
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ============= Tab 6: Admin (danger zone) =============

function AdminTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  // Show how much data the reset will clear, using the same derived tables the
  // rest of the dashboard reads (events = grouped exceptions, servers = agents).
  const { data: counts, isLoading } = useQuery({
    queryKey: ["admin_data_counts"],
    queryFn: async () => {
      const [events, servers] = await Promise.all([
        supabase.from("events").select("id"),
        supabase.from("servers").select("id"),
      ]);
      if (events.error) throw events.error;
      if (servers.error) throw servers.error;
      return {
        events: (events.data ?? []).length,
        servers: (servers.data ?? []).length,
      };
    },
  });

  const reset = useMutation({
    mutationFn: () => resetAllData(),
    onSuccess: (res) => {
      const d = res.deleted;
      // Drop the client-side derivation cache, then refetch every screen.
      invalidateCache();
      qc.invalidateQueries();
      setOpen(false);
      setConfirmText("");
      toast.success(
        `Deleted ${d.exceptions} events, ${d.instances} agents, ${d.source_classes} source classes`,
      );
    },
    onError: (e: any) =>
      toast.error(
        e?.name === "CollectorAuthError"
          ? "Your API key is not authorized to delete data (admin role required)."
          : e?.message ?? "Could not delete data",
      ),
  });

  const stat = (icon: React.ReactNode, label: string, value: React.ReactNode) => (
    <div className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground">
        {icon}
      </div>
      <div>
        <div className="text-sm font-semibold">{value}</div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeader
          title="Stored data"
          hint="Captured monitoring data currently held by the collector for this project."
        />
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {stat(<Database className="h-4 w-4" />, "Events", counts?.events ?? 0)}
            {stat(<Server className="h-4 w-4" />, "Agents", counts?.servers ?? 0)}
            {stat(<FileCode className="h-4 w-4" />, "Source classes", "—")}
          </div>
        )}
      </Card>

      <Card className="border-destructive/30 bg-destructive/5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Permanently delete <strong>all captured monitoring data</strong> for this
              project — events &amp; stack traces, JVM agents/instances, and decompiled
              source classes. Your integrations, redaction rules, API tokens, and team
              are <strong>not</strong> affected. This cannot be undone.
            </p>
            <div className="mt-3">
              <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
                <Trash2 className="h-3.5 w-3.5" />
                <span className="ml-1.5">Delete all data</span>
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setConfirmText("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete all monitoring data?</DialogTitle>
            <DialogDescription>
              This permanently removes every captured event, JVM agent, and source class
              for this project. Configuration is preserved. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">
              Type <span className="font-mono font-semibold">DELETE</span> to confirm
            </Label>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmText !== "DELETE" || reset.isPending}
              onClick={() => reset.mutate()}
            >
              {reset.isPending ? "Deleting…" : "Delete everything"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============= Tab 5: Team =============

const ROLES = ["admin", "member", "viewer"] as const;

function TeamTab() {
  const qc = useQueryClient();
  const { data: members, isLoading } = useQuery({
    queryKey: ["team_members"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("team_members")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");

  const invite = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("team_members").insert({
        email,
        role,
        status: "invited",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team_members"] });
      toast.success(`Invitation sent to ${email}`);
      setEmail("");
      setRole("member");
    },
    onError: (e: any) => toast.error(e.message ?? "Could not send invite"),
  });

  const changeRole = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: string }) => {
      const { error } = await supabase.from("team_members").update({ role }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team_members"] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("team_members").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team_members"] });
      toast.success("Member removed");
    },
  });

  return (
    <div className="space-y-4">
      <Card>
        <SectionHeader title="Invite member" />
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Mail className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={role} onValueChange={(v) => setRole(v as any)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={!email || invite.isPending}
            onClick={() => invite.mutate()}
          >
            Send invite
          </Button>
        </div>
      </Card>

      <Card>
        <SectionHeader title="Members" />
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="divide-y divide-border">
            {(members ?? []).map((m: any) => (
              <div key={m.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-[11px] font-medium text-muted-foreground">
                    {(m.name ?? m.email).slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {m.name ?? m.email}
                      {m.status === "invited" && (
                        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-400">
                          invited
                        </span>
                      )}
                    </div>
                    {m.name && <div className="text-[11px] text-muted-foreground">{m.email}</div>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={m.role}
                    onValueChange={(v) => changeRole.mutate({ id: m.id, role: v })}
                  >
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="icon" variant="ghost" onClick={() => remove.mutate(m.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
