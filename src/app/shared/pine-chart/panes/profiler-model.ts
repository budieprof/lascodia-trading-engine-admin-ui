import type { PineProfileLine } from '../model/pine-outputs.types';

/**
 * Pine Profiler results: execution count and time per significant line, their share of the total,
 * a heat level for the bar next to each line, and the "flame" marks on the three costliest lines
 * (shown when at least four lines were profiled, as the Profiler does).
 */

export interface ProfilerRow {
  line: number;
  executions: number;
  totalMicros: number;
  avgMicros: number;
  /** Share of total time, 0..100. */
  percent: number;
  /** 0..1 relative to the costliest line. */
  heat: number;
  /** 1..3 for the three costliest lines (with ≥ 4 lines profiled), else 0. */
  flame: number;
  /** Trimmed source of the line when the script text is known. */
  source: string | null;
}

export type ProfilerSortKey = 'line' | 'executions' | 'total' | 'avg' | 'percent';

export interface ProfilerSort {
  key: ProfilerSortKey;
  dir: 'asc' | 'desc';
}

export function profilerRows(
  profile: readonly PineProfileLine[],
  source?: string | null,
): ProfilerRow[] {
  const lines = source ? source.split(/\r?\n/) : null;
  // One row per line even if the engine reports a line twice (e.g. a block header and its body).
  const byLine = new Map<number, { executions: number; totalMicros: number }>();
  for (const p of profile) {
    if (!Number.isFinite(p.line) || p.line <= 0) continue;
    const cur = byLine.get(p.line) ?? { executions: 0, totalMicros: 0 };
    cur.executions += Math.max(0, p.executions || 0);
    cur.totalMicros += Math.max(0, p.totalMicros || 0);
    byLine.set(p.line, cur);
  }
  let total = 0;
  let max = 0;
  for (const v of byLine.values()) {
    total += v.totalMicros;
    if (v.totalMicros > max) max = v.totalMicros;
  }
  const rows: ProfilerRow[] = [...byLine.entries()].map(([line, v]) => ({
    line,
    executions: v.executions,
    totalMicros: v.totalMicros,
    avgMicros: v.executions > 0 ? v.totalMicros / v.executions : 0,
    percent: total > 0 ? (v.totalMicros / total) * 100 : 0,
    heat: max > 0 ? v.totalMicros / max : 0,
    flame: 0,
    source: lines ? (lines[line - 1] ?? '').trim() || null : null,
  }));
  if (rows.length >= 4) {
    [...rows]
      .filter((r) => r.totalMicros > 0)
      .sort((a, b) => b.totalMicros - a.totalMicros || a.line - b.line)
      .slice(0, 3)
      .forEach((r, i) => (r.flame = i + 1));
  }
  return rows.sort((a, b) => a.line - b.line);
}

export function sortProfilerRows(rows: readonly ProfilerRow[], sort: ProfilerSort): ProfilerRow[] {
  const pick = (r: ProfilerRow): number => {
    switch (sort.key) {
      case 'line':
        return r.line;
      case 'executions':
        return r.executions;
      case 'avg':
        return r.avgMicros;
      case 'percent':
      case 'total':
        return r.totalMicros;
    }
  };
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => (pick(a) - pick(b)) * dir || a.line - b.line);
}

/** 812 µs · 1.23 ms · 2.51 s */
export function formatMicros(us: number): string {
  if (!Number.isFinite(us)) return '—';
  if (us < 1000) return `${us < 10 ? us.toFixed(1) : Math.round(us)} µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

/** Heat bar color: amber through red as a line's share of the costliest line grows. */
export function heatColor(heat: number): string {
  const h = Math.max(0, Math.min(1, heat));
  // hue 45 (amber) → 0 (red); alpha grows with heat so cold lines fade out.
  const hue = Math.round(45 * (1 - h));
  const alpha = 0.25 + 0.65 * h;
  return `hsla(${hue}, 90%, 50%, ${alpha.toFixed(2)})`;
}
