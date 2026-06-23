import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import {
  LayoutDashboard,
  AlertOctagon,
  Rocket,
  Boxes,
  BellRing,
  Settings as SettingsIcon,
  ChevronLeft,
  Search,
  Moon,
  Sun,
  LogOut,
  Activity,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { useAppContext, type Environment, type TimeRange } from "@/lib/app-context";
import { useLiveUpdates } from "@/lib/use-live-updates";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/events", label: "Events", icon: AlertOctagon },
  { to: "/deployments", label: "Deployments", icon: Rocket },
  { to: "/applications", label: "Applications", icon: Boxes },
  { to: "/alerts", label: "Alerts", icon: BellRing },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

const ENV_DOT: Record<Environment, string> = {
  production: "bg-[var(--severity-error)]",
  staging: "bg-[var(--severity-warning)]",
  development: "bg-[var(--severity-info)]",
};

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { theme, toggle } = useTheme();
  const { user, logout } = useAuth();
  const { environment, setEnvironment, timeRange, setTimeRange } = useAppContext();
  const navigate = useNavigate();

  // Live event stream: refetch active screens as exceptions land.
  useLiveUpdates();

  const initials = (user?.name || "?").slice(0, 2).toUpperCase();

  return (
    <div className="flex min-h-screen w-full bg-background text-foreground">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col border-r border-border bg-sidebar transition-[width] duration-200",
          collapsed ? "w-[60px]" : "w-[220px]",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Activity className="h-4 w-4" />
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight">
              <span className="text-[13px] font-semibold tracking-tight">Stackline</span>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                jvm reliability
              </span>
            </div>
          )}
        </div>

        <nav className="flex-1 px-2 py-3">
          <ul className="space-y-0.5">
            {nav.map((item) => {
              const active = pathname === item.to || pathname.startsWith(item.to + "/");
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={cn(
                      "group flex h-8 items-center gap-3 rounded-md px-2 text-[13px] transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {!collapsed && active && (
                      <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-sidebar-border p-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed((v) => !v)}
            className="h-8 w-full justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft
              className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")}
            />
            {!collapsed && <span className="text-xs">Collapse</span>}
          </Button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar */}
        <header className="flex h-14 items-center gap-3 border-b border-border bg-panel px-4">
          <Select value={environment} onValueChange={(v) => setEnvironment(v as Environment)}>
            <SelectTrigger className="h-8 w-[150px] border-border bg-background text-xs">
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", ENV_DOT[environment])} />
                <SelectValue />
              </div>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="production">Production</SelectItem>
              <SelectItem value="staging">Staging</SelectItem>
              <SelectItem value="development">Development</SelectItem>
            </SelectContent>
          </Select>

          <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
            <SelectTrigger className="h-8 w-[130px] border-border bg-background text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last 1 hour</SelectItem>
              <SelectItem value="24h">Last 24 hours</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="custom">Custom range…</SelectItem>
            </SelectContent>
          </Select>

          <div className="relative ml-2 max-w-xl flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search errors, classes, threads, deploys…"
              className="h-8 border-border bg-background pl-8 font-mono text-xs placeholder:text-muted-foreground/70"
            />
            <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline-block">
              ⌘K
            </kbd>
          </div>

          <Button
            variant="ghost"
            size="icon"
            onClick={toggle}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            aria-label="Toggle theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent">
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="bg-primary/15 text-[11px] font-medium text-primary">
                    {initials}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span className="text-sm">{user?.name || "Signed in"}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {user?.email}
                  </span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate({ to: "/settings" })}>
                <SettingsIcon className="mr-2 h-4 w-4" /> Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  logout();
                  navigate({ to: "/login" });
                }}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
