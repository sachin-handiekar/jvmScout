import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { Activity, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — Stackline" },
      { name: "description", content: "Connect to your JVMTI exception collector." },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(apiKey.trim());
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not reach the collector. Check that it is running.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Activity className="h-4 w-4" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Stackline</div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              jvm reliability
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-panel p-6">
          <h1 className="text-base font-semibold">Connect to collector</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Enter the collector API key (the value of <span className="font-mono">COLLECTOR_API_KEY</span>).
            Leave blank if the collector runs without authentication.
          </p>

          <form onSubmit={onSubmit} className="mt-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="apiKey" className="text-xs">API key</Label>
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="leave blank for open collector"
                className="h-9 border-border bg-background font-mono text-xs"
                autoFocus
              />
            </div>
            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="h-9 w-full" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Connect
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          v0.1.0 · jvmscout
        </p>
      </div>
    </div>
  );
}
