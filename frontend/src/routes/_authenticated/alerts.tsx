import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  BellRing,
  Plus,
  Pencil,
  Trash2,
  Slack,
  Mail,
  Webhook,
  Siren,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/PagePlaceholder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/alerts")({
  head: () => ({ meta: [{ title: "Alerts — jvmScout" }] }),
  component: AlertsPage,
});

type TriggerType = "new_event" | "volume_threshold" | "deploy_regression" | "event_reoccurs";
type ChannelType = "slack" | "pagerduty" | "email" | "webhook";

type AppRow = { id: string; name: string; environment: string };
type DeploymentRow = { id: string; name: string; application_id: string };

type AlertConfig = {
  threshold?: number;
  windowMinutes?: number;
  eventName?: string;
  destination?: string; // slack channel / email / url / pagerduty service key
};

type AlertRow = {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: TriggerType;
  application_id: string | null;
  deployment_id: string | null;
  channel: ChannelType;
  target: string;
  condition: string;
  config: AlertConfig;
  last_triggered_at: string | null;
};

const TRIGGER_LABEL: Record<TriggerType, string> = {
  new_event: "New event detected",
  volume_threshold: "Event volume exceeds threshold",
  deploy_regression: "New error introduced by deployment",
  event_reoccurs: "Specific event reoccurs",
};

const CHANNEL_META: Record<
  ChannelType,
  { label: string; Icon: typeof Slack; field: string; placeholder: string }
> = {
  slack: { label: "Slack", Icon: Slack, field: "Channel", placeholder: "#alerts-prod" },
  pagerduty: {
    label: "PagerDuty",
    Icon: Siren,
    field: "Service key",
    placeholder: "R01XXXXXXXXXXXXXXXXXXX",
  },
  email: { label: "Email", Icon: Mail, field: "Address", placeholder: "oncall@company.com" },
  webhook: { label: "Webhook", Icon: Webhook, field: "URL", placeholder: "https://…" },
};

function AlertsPage() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<AlertRow | null | undefined>(undefined); // undefined=closed, null=new
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: rules, isLoading } = useQuery({
    queryKey: ["alert-rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("alert_rules")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as AlertRow[];
    },
  });

  const { data: apps } = useQuery({
    queryKey: ["alerts-apps"],
    queryFn: async () => {
      const [a, d] = await Promise.all([
        supabase.from("applications").select("id,name,environment"),
        supabase.from("deployments").select("id,name,application_id"),
      ]);
      return {
        apps: (a.data ?? []) as AppRow[],
        deploys: (d.data ?? []) as DeploymentRow[],
      };
    },
  });

  const appsById = useMemo(
    () => new Map((apps?.apps ?? []).map((a) => [a.id, a])),
    [apps],
  );
  const deploysById = useMemo(
    () => new Map((apps?.deploys ?? []).map((d) => [d.id, d])),
    [apps],
  );

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await supabase
        .from("alert_rules")
        .update({ enabled })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-rules"] }),
  });

  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("alert_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-rules"] });
      toast.success("Alert rule deleted");
    },
  });

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Get paged the moment a new exception class appears or error rates spike."
        actions={
          <Button size="sm" onClick={() => setEditing(null)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Create alert rule
          </Button>
        }
      />
      <div className="p-6">
        <div className="overflow-hidden rounded-lg border border-border bg-panel/40">
          <table className="w-full text-sm">
            <thead className="bg-panel/60 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="w-12 px-4 py-2"></th>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Condition</th>
                <th className="px-4 py-2 text-left font-medium">Scope</th>
                <th className="px-4 py-2 text-left font-medium">Channel</th>
                <th className="px-4 py-2 text-left font-medium">Last triggered</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-t border-border">
                    <td colSpan={7} className="px-4 py-2">
                      <Skeleton className="h-6 w-full" />
                    </td>
                  </tr>
                ))}
              {!isLoading && (rules?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center text-xs text-muted-foreground">
                    <BellRing className="mx-auto mb-2 h-5 w-5" />
                    No alert rules yet — create your first to get notified on new exceptions.
                  </td>
                </tr>
              )}
              {rules?.map((r) => {
                const scope =
                  r.application_id && appsById.get(r.application_id)
                    ? `App · ${appsById.get(r.application_id)!.name}`
                    : r.deployment_id && deploysById.get(r.deployment_id)
                      ? `Deploy · ${deploysById.get(r.deployment_id)!.name}`
                      : "All environments";
                const channelMeta = CHANNEL_META[r.channel] ?? {
                  label: r.channel ?? "Unknown",
                  Icon: Webhook,
                };
                const ChannelIcon = channelMeta.Icon;
                return (
                  <tr key={r.id} className="border-t border-border hover:bg-accent/30">
                    <td className="px-4 py-3">
                      <Switch
                        checked={r.enabled}
                        onCheckedChange={(v) =>
                          toggleEnabled.mutate({ id: r.id, enabled: v })
                        }
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{r.name}</div>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {TRIGGER_LABEL[r.trigger_type]}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{r.condition}</td>
                    <td className="px-4 py-3 text-xs text-foreground/80">{scope}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        <ChannelIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{channelMeta.label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {r.target}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {r.last_triggered_at ? relativeTime(r.last_triggered_at) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setEditing(r)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-[var(--severity-error)]"
                          onClick={() => setDeleteId(r.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit dialog */}
      <RuleDialog
        open={editing !== undefined}
        initial={editing ?? null}
        apps={apps?.apps ?? []}
        deployments={apps?.deploys ?? []}
        onClose={() => setEditing(undefined)}
      />

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete alert rule?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The rule will stop firing immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-[var(--severity-error)] text-white hover:bg-[var(--severity-error)]/90"
              onClick={() => {
                if (deleteId) deleteRule.mutate(deleteId);
                setDeleteId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------------- Rule Dialog ----------------

type FormState = {
  name: string;
  enabled: boolean;
  trigger_type: TriggerType;
  scope: "all" | "app" | "deployment";
  application_id: string;
  deployment_id: string;
  threshold: number;
  windowMinutes: number;
  eventName: string;
  channel: ChannelType;
  destination: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  enabled: true,
  trigger_type: "new_event",
  scope: "all",
  application_id: "",
  deployment_id: "",
  threshold: 50,
  windowMinutes: 5,
  eventName: "",
  channel: "slack",
  destination: "",
};

function fromRow(r: AlertRow): FormState {
  return {
    name: r.name,
    enabled: r.enabled,
    trigger_type: r.trigger_type,
    scope: r.application_id ? "app" : r.deployment_id ? "deployment" : "all",
    application_id: r.application_id ?? "",
    deployment_id: r.deployment_id ?? "",
    threshold: r.config?.threshold ?? 50,
    windowMinutes: r.config?.windowMinutes ?? 5,
    eventName: r.config?.eventName ?? "",
    channel: r.channel,
    destination: r.config?.destination ?? r.target ?? "",
  };
}

function describeCondition(f: FormState): string {
  switch (f.trigger_type) {
    case "new_event":
      return "When a new exception class first appears";
    case "volume_threshold":
      return `When occurrences exceed ${f.threshold} in ${f.windowMinutes}m`;
    case "deploy_regression":
      return "When a new error is introduced by a deployment";
    case "event_reoccurs":
      return `When "${f.eventName || "(any)"}" reoccurs`;
  }
}

function RuleDialog({
  open,
  initial,
  apps,
  deployments,
  onClose,
}: {
  open: boolean;
  initial: AlertRow | null;
  apps: AppRow[];
  deployments: DeploymentRow[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (open) setForm(initial ? fromRow(initial) : EMPTY_FORM);
  }, [open, initial]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      const config: AlertConfig = {
        destination: form.destination.trim() || undefined,
      };
      if (form.trigger_type === "volume_threshold") {
        config.threshold = form.threshold;
        config.windowMinutes = form.windowMinutes;
      }
      if (form.trigger_type === "event_reoccurs") {
        config.eventName = form.eventName.trim();
      }
      const target =
        form.destination.trim() ||
        (form.scope === "app"
          ? apps.find((a) => a.id === form.application_id)?.name ?? "all"
          : form.scope === "deployment"
            ? deployments.find((d) => d.id === form.deployment_id)?.name ?? "all"
            : "all");
      const payload = {
        name: form.name.trim(),
        enabled: form.enabled,
        trigger_type: form.trigger_type,
        application_id: form.scope === "app" ? form.application_id || null : null,
        deployment_id: form.scope === "deployment" ? form.deployment_id || null : null,
        channel: form.channel,
        target,
        condition: describeCondition(form),
        config: config as never,
      };
      if (initial) {
        const { error } = await supabase
          .from("alert_rules")
          .update(payload)
          .eq("id", initial.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("alert_rules").insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-rules"] });
      toast.success(initial ? "Alert rule updated" : "Alert rule created");
      onClose();
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Failed to save"),
  });

  const channelMeta = CHANNEL_META[form.channel];
  const canSave =
    form.name.trim().length > 0 &&
    form.destination.trim().length > 0 &&
    (form.scope !== "app" || form.application_id) &&
    (form.scope !== "deployment" || form.deployment_id);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit alert rule" : "Create alert rule"}</DialogTitle>
          <DialogDescription>
            Configure when this rule fires and where it sends the notification.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <Field label="Rule name">
            <Input
              value={form.name}
              maxLength={120}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Production NPE spike"
            />
          </Field>

          <Field label="Trigger">
            <Select
              value={form.trigger_type}
              onValueChange={(v) => set("trigger_type", v as TriggerType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(TRIGGER_LABEL) as TriggerType[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {TRIGGER_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {form.trigger_type === "volume_threshold" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Occurrences (N)">
                <Input
                  type="number"
                  min={1}
                  value={form.threshold}
                  onChange={(e) => set("threshold", Number(e.target.value) || 0)}
                />
              </Field>
              <Field label="Window (minutes)">
                <Input
                  type="number"
                  min={1}
                  value={form.windowMinutes}
                  onChange={(e) => set("windowMinutes", Number(e.target.value) || 0)}
                />
              </Field>
            </div>
          )}

          {form.trigger_type === "event_reoccurs" && (
            <Field label="Event name">
              <Input
                value={form.eventName}
                maxLength={200}
                placeholder="NullPointerException"
                className="font-mono"
                onChange={(e) => set("eventName", e.target.value)}
              />
            </Field>
          )}

          <Field label="Scope">
            <Select value={form.scope} onValueChange={(v) => set("scope", v as FormState["scope"])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All environments</SelectItem>
                <SelectItem value="app">Specific application</SelectItem>
                <SelectItem value="deployment">Specific deployment</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {form.scope === "app" && (
            <Field label="Application">
              <Select
                value={form.application_id}
                onValueChange={(v) => set("application_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose an application" />
                </SelectTrigger>
                <SelectContent>
                  {apps.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}{" "}
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {a.environment}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          {form.scope === "deployment" && (
            <Field label="Deployment">
              <Select
                value={form.deployment_id}
                onValueChange={(v) => set("deployment_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Choose a deployment" />
                </SelectTrigger>
                <SelectContent>
                  {deployments.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          <Field label="Channel">
            <div className="grid grid-cols-4 gap-2">
              {(Object.keys(CHANNEL_META) as ChannelType[]).map((k) => {
                const Icon = CHANNEL_META[k].Icon;
                const active = form.channel === k;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => set("channel", k)}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs transition-colors",
                      active
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border bg-background hover:bg-accent/30",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {CHANNEL_META[k].label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={channelMeta.field}>
            <Input
              value={form.destination}
              onChange={(e) => set("destination", e.target.value)}
              placeholder={channelMeta.placeholder}
              className="font-mono"
              maxLength={500}
            />
          </Field>

          <div className="flex items-center justify-between rounded-md border border-border bg-background/40 px-3 py-2">
            <div>
              <Label className="text-sm">Enabled</Label>
              <p className="text-[11px] text-muted-foreground">
                Rule will fire as soon as conditions match.
              </p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => set("enabled", v)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : initial ? "Save changes" : "Create rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}
