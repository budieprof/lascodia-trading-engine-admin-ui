import type { TradeSignalDto } from '@core/api/api.types';

export interface DaySummary {
  total: number;
  byStatus: Array<{ status: string; count: number }>;
  bySource: Array<{ source: string; count: number }>;
  symbols: number;
  withOrder: number;
  pickedUp: number;
}

const sorted = (m: Map<string, number>) =>
  [...m.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));

/** Counts of the signals generated today: by status, by source, how many reached an account. */
export function daySummary(rows: readonly TradeSignalDto[]): DaySummary {
  const st = new Map<string, number>();
  const src = new Map<string, number>();
  const sym = new Set<string>();
  let withOrder = 0;
  let pickedUp = 0;
  for (const r of rows) {
    st.set(r.status, (st.get(r.status) ?? 0) + 1);
    const s = sourceText(r);
    src.set(s, (src.get(s) ?? 0) + 1);
    if (r.symbol) sym.add(r.symbol);
    if (r.orderId != null) withOrder++;
    if ((r.accountsPickedUpCount ?? 0) > 0) pickedUp++;
  }
  return {
    total: rows.length,
    byStatus: sorted(st).map(({ k, n }) => ({ status: k, count: n })),
    bySource: sorted(src).map(({ k, n }) => ({ source: k, count: n })),
    symbols: sym.size,
    withOrder,
    pickedUp,
  };
}

/** UTC midnight of the given instant, as ISO. */
export function utcMidnightIso(now: number = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Which neighbours to show for a missing id: below the oldest → the first signals; above the
 * newest → the newest; in a gap → the ids either side.
 */
export function nearestPlan(
  id: number,
  earliestId: number | null,
  latestId: number | null,
): 'oldest' | 'newest' | 'around' | 'none' {
  if (earliestId == null || latestId == null) return 'none';
  if (id < earliestId) return 'oldest';
  if (id > latestId) return 'newest';
  return 'around';
}

/** Plain-language source: "LLM analysis", "Manual", "Patient Trader" (CamelCase split). */
export function sourceText(r: Pick<TradeSignalDto, 'source' | 'isManual'>): string {
  if (r.source === 'SpotAnalysis') return 'LLM analysis';
  if (r.source === 'Manual' || r.isManual) return 'Manual';
  return String(r.source ?? 'Strategy').replace(/([a-z])([A-Z])/g, '$1 $2');
}
