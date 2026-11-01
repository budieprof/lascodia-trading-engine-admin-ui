/**
 * Pure presentation helpers shared by the two martingale pages. No data shaping: each one only
 * decides how an already-loaded row reads (its tone, its one-word verdict, whether it matches a
 * search over the rows already on screen).
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'info';

/** The fields of a chain row the helpers read — kept structural so specs need no full DTO. */
export interface ChainLike {
  id: number;
  tradingAccountId: number;
  accountName: string;
  symbol: string;
  status: string;
}

/** Next-rung fields that decide the verdict, in the same precedence the template applies. */
export interface NextRungLike {
  wouldAbandon: boolean;
  blockedBy: string | null;
  rungWillBeSkipped: boolean;
}

/**
 * Case-insensitive match of a free-text query against a chain's id, symbol, account name and
 * account id. "#44" and "44" both find chain 44 (and account 44); an empty query matches all.
 */
export function chainMatchesQuery(c: ChainLike, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  return (
    String(c.id) === q ||
    String(c.tradingAccountId) === q ||
    c.symbol.toLowerCase().includes(q) ||
    (c.accountName ?? '').toLowerCase().includes(q)
  );
}

/**
 * Tone of a chain's status. Open is amber (live, unresolved), Recovered green, Abandoned red — a
 * deliberate operator reset is a write-off chosen by a person, not a ladder that ran out of road,
 * so it reads neutral.
 */
export function chainStatusTone(status: string, operatorReset: boolean): Tone {
  if (status === 'Open') return 'warn';
  if (status === 'Recovered') return 'ok';
  if (status === 'Abandoned') return operatorReset ? 'muted' : 'bad';
  return 'muted';
}

/** One-word verdict for the next rung, mirroring the template's precedence of explanations. */
export function nextRungVerdict(r: NextRungLike): { tone: Tone; label: string } {
  if (r.wouldAbandon) return { tone: 'bad', label: 'Would not stake' };
  if (r.blockedBy) return { tone: 'warn', label: 'Blocked' };
  if (r.rungWillBeSkipped) return { tone: 'warn', label: 'Will not fit' };
  return { tone: 'ok', label: 'Clear to stake' };
}
