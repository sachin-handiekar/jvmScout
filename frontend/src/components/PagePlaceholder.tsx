import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border bg-panel/40 px-6 py-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <div className="m-6 flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-panel/40 px-6 py-16 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 text-sm font-medium">{title}</h3>
      <p className="mt-1 max-w-md text-xs text-muted-foreground">{hint}</p>
      <code className="mt-4 rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground">
        // hook up the agent — data will appear here
      </code>
    </div>
  );
}
