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
