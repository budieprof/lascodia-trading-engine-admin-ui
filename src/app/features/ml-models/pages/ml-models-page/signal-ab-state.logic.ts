/**
 * Collapses a shadow evaluation's decision reason into a category so repeated reasons count as
 * one: numbers become "N" and the text stops at the first clause break.
 * "Closed unfinishable: challenger model 935 has no stored weights (a metrics-only row), …" →
 * "Closed early: challenger model N has no stored weights".
 */
export function shadowReasonCategory(reason: string | null | undefined): string {
  let t = (reason ?? '').trim();
  if (!t) return 'No reason recorded';
  t = t
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .replace(/^Closed unfinishable:/i, 'Closed early:');
  const cut = t.search(/[,(;]|\. | — /);
  if (cut > 15) t = t.slice(0, cut);
  t = t.replace(/\.$/, '').trim();
  return t.length > 80 ? t.slice(0, 79) + '…' : t;
}

/** Reason categories with counts, most frequent first. */
export function topReasons(
  reasons: readonly (string | null | undefined)[],
): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const r of reasons) {
    const c = shadowReasonCategory(r);
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return [...m]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/** Minimal shape of a shadow evaluation the A/B tab summarises. */
export interface ShadowLite {
  symbol: string | null;
  timeframe: string;
  startedAt: string;
  decisionReason: string | null;
  /** Normalised decision key: promoted | flagged | rejected | pending. */
  decision: string;
}

/** Shadow evaluations started per ISO week (Monday, UTC), oldest first, split by decision. */
export function shadowByWeek(
  rows: readonly ShadowLite[],
): { week: string; promoted: number; flagged: number; rejected: number; pending: number }[] {
  const m = new Map<
    string,
    { promoted: number; flagged: number; rejected: number; pending: number }
  >();
  for (const r of rows) {
    const d = new Date(r.startedAt);
    if (Number.isNaN(d.getTime())) continue;
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    const key = monday.toISOString().slice(0, 10);
    const b = m.get(key) ?? { promoted: 0, flagged: 0, rejected: 0, pending: 0 };
    const k = (
      ['promoted', 'flagged', 'rejected'].includes(r.decision) ? r.decision : 'pending'
    ) as 'promoted' | 'flagged' | 'rejected' | 'pending';
    b[k]++;
    m.set(key, b);
  }
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v }));
}

/** Per pair: how many evaluations, the newest start and the most common reason they ended. */
export function shadowByPair(
  rows: readonly ShadowLite[],
): { pair: string; count: number; promoted: number; latest: string; topReason: string }[] {
  const g = new Map<string, ShadowLite[]>();
  for (const r of rows) {
    const k = `${r.symbol ?? '—'} ${r.timeframe}`;
    g.set(k, [...(g.get(k) ?? []), r]);
  }
  return [...g]
    .map(([pair, list]) => ({
      pair,
      count: list.length,
      promoted: list.filter((x) => x.decision === 'promoted').length,
      latest: list.reduce((a, x) => (x.startedAt > a ? x.startedAt : a), ''),
      topReason: topReasons(list.map((x) => x.decisionReason))[0]?.reason ?? '—',
    }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair));
}
