import { useMemo } from "react";

export function Sparkline({
  data,
  trendUp,
  width = 96,
  height = 22,
}: {
  data: number[];
  trendUp?: boolean;
  width?: number;
  height?: number;
}) {
  const { path, area } = useMemo(() => {
    if (data.length === 0) return { path: "", area: "" };
    const min = Math.min(...data);
    const max = Math.max(...data);
    const span = max - min || 1;
    const step = width / (data.length - 1);
    const points = data.map((v, i) => {
      const x = i * step;
      const y = height - ((v - min) / span) * (height - 2) - 1;
      return [x, y] as const;
    });
    const path = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const area = `${path} L${width},${height} L0,${height} Z`;
    return { path, area };
  }, [data, width, height]);

  const stroke = trendUp ? "var(--severity-error)" : "var(--muted-foreground)";

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <path d={area} fill={stroke} fillOpacity={0.08} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
