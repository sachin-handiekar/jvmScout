export function compactNumber(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// Deterministic pseudo-random from string (xfnv1a + mulberry32)
function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed: number) {
  let s = seed;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a 24-point sparkline series deterministically from event id + hit_count. */
export function sparklineForEvent(id: string, hitCount: number, increasing: boolean): number[] {
  const r = rng(hashSeed(id));
  const points = 24;
  const out: number[] = [];
  const base = Math.max(1, Math.log10(hitCount + 1));
  for (let i = 0; i < points; i++) {
    const trend = increasing ? (i / points) * base * 0.8 : 0;
    out.push(Math.max(0, base * 0.4 + r() * base + trend));
  }
  return out;
}

/** Deterministic "is rate climbing" for an event (mock). */
export function isIncreasing(id: string, hitCount: number): boolean {
  // Hash-based, biased to true for higher-traffic events.
  const h = hashSeed(id);
  const bias = hitCount > 1000 ? 0.55 : 0.25;
  return (h % 1000) / 1000 < bias;
}
