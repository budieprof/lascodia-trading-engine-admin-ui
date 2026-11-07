import type { ScheduledMarketEventRow } from '@features/news-intel/news-intel.types';
import type { EventImpact, EventMark } from './chart-events';

/**
 * The non-economic marks on the chart's time axis (UA01), each from a real engine row — never a placeholder:
 * - scheduled market events (`news-intel/scheduled-events`): earnings, inventories, rig counts, OPEC+, options expiry,
 *   index rebalances, token unlocks;
 * - a dated future's last trading day (the instrument's own `future.lastTradeDate`);
 * - a crypto perpetual's funding times (the distinct `nextFundingT` instants the derivatives feed reported);
 * - an equity's ex-dividend dates and splits (`instrument-fundamentals/equity` corporate actions; none are stored today,
 *   so none are drawn).
 * Pure.
 */

const DAY = 86_400_000;

/** The flag's text per scheduled-event kind. */
const KIND_BADGE: Record<string, string> = {
  Earnings: 'ERN',
  Inventories: 'INV',
  RigCount: 'RIG',
  OpecMeeting: 'OPC',
  OptionsExpiry: 'EXP',
  IndexRebalance: 'RBL',
  TokenUnlock: 'UNL',
  CentralBankDecision: 'CB',
};

const KIND_TEXT: Record<string, string> = {
  Earnings: 'Earnings',
  Inventories: 'Inventories report',
  RigCount: 'Rig count',
  OpecMeeting: 'OPEC+ meeting',
  OptionsExpiry: 'Options expiry',
  IndexRebalance: 'Index rebalance',
  TokenUnlock: 'Token unlock',
  CentralBankDecision: 'Central-bank decision',
};

function impactOf(raw: string | null | undefined): EventImpact {
  const s = String(raw ?? '').toLowerCase();
  return s === 'high' ? 'High' : s === 'medium' ? 'Medium' : 'Low';
}

/** A scheduled market event as a chart mark; null when its time cannot be read. */
export function marketMarkOf(row: ScheduledMarketEventRow): EventMark | null {
  const time = Date.parse(row.scheduledAtUtc ?? '');
  if (!Number.isFinite(time)) return null;
  const kind = String(row.kind ?? 'Other');
  const detail = [
    { label: 'Kind', value: KIND_TEXT[kind] ?? kind },
    { label: 'For', value: row.exposureKey },
    { label: 'Source', value: row.source },
  ];
  if (row.actual) detail.push({ label: 'Actual', value: row.actual });
  if (row.notes) detail.push({ label: 'Note', value: row.notes });
  return {
    id: row.id,
    time,
    title: row.title,
    currency: row.exposureKey,
    impact: impactOf(row.impact),
    kind: 'market',
    badge: KIND_BADGE[kind] ?? row.exposureKey.replace(/^[A-Z]+:/, '').slice(0, 3),
    detail,
  };
}

/** A dated future's last trading day as a mark (High: positions must be rolled or closed before it). */
export function expiryMark(symbol: string, lastTradeMs: number): EventMark {
  return {
    id: Math.floor(lastTradeMs / DAY),
    time: lastTradeMs,
    title: `${symbol.toUpperCase()} last trading day`,
    currency: symbol.toUpperCase(),
    impact: 'High',
    kind: 'expiry',
    badge: 'EXP',
    detail: [{ label: 'Kind', value: 'Contract expiry (from the instrument)' }],
  };
}

/** One minute of the derivatives feed, as far as funding marks need it. */
export interface FundingMinute {
  t: number;
  funding: number | null;
  nextFundingT: number | null;
}

/**
 * A perpetual's funding instants: every distinct `nextFundingT` the feed reported (the venue's own schedule, so an
 * hourly venue gets hourly marks), plus the next one from the latest reading. The rate shown is the last one the feed
 * reported before that instant (the rate that was charged), as a percent per interval. Low importance: funding recurs
 * all day, so the default Medium+ filter hides it; the Funding times pane (UA08) draws each one as a bar.
 */
export function fundingMarks(
  symbol: string,
  minutes: readonly FundingMinute[],
  nextFundingMs: number | null,
): EventMark[] {
  const at = new Map<number, number | null>();
  for (const m of minutes) {
    const t = m.nextFundingT;
    if (t === null || !Number.isFinite(t)) continue;
    if (m.t < t) at.set(t, m.funding ?? at.get(t) ?? null);
  }
  if (nextFundingMs !== null && Number.isFinite(nextFundingMs) && !at.has(nextFundingMs))
    at.set(nextFundingMs, null);
  return [...at.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, rate]) => ({
      id: Math.floor(time / 60_000),
      time,
      title: `${symbol.toUpperCase()} funding`,
      currency: symbol.toUpperCase(),
      impact: 'Low' as EventImpact,
      kind: 'funding' as const,
      badge: 'FND',
      detail: [
        {
          label: 'Rate',
          value: rate === null ? 'not reported yet' : `${(rate * 100).toFixed(4)}% per interval`,
        },
      ],
    }));
}

/** An equity corporate action (`instrument-fundamentals/equity` `actions`). */
export interface CorporateActionRow {
  kind: string;
  exDate: string;
  ratio: number | null;
  cashAmount: number | null;
  currency: string | null;
  source: string;
}

/** Ex-dividend dates and splits as marks; only real rows (the engine stores none today). */
export function corporateActionMarks(
  symbol: string,
  actions: readonly CorporateActionRow[],
): EventMark[] {
  const out: EventMark[] = [];
  actions.forEach((a, i) => {
    const time = Date.parse(a.exDate ?? '');
    if (!Number.isFinite(time)) return;
    const split = /split/i.test(a.kind);
    const value = split
      ? a.ratio !== null
        ? `ratio ${a.ratio}`
        : 'ratio not stated'
      : a.cashAmount !== null
        ? `${a.cashAmount} ${a.currency ?? ''}`.trim()
        : 'amount not stated';
    out.push({
      id: Math.floor(time / DAY) * 10 + i,
      time,
      title: `${symbol.toUpperCase()} ${split ? 'split' : 'ex-dividend'}`,
      currency: symbol.toUpperCase(),
      impact: 'Medium',
      kind: 'corporate',
      badge: split ? 'SPL' : 'DIV',
      detail: [
        { label: split ? 'Split' : 'Dividend', value },
        { label: 'Source', value: a.source },
      ],
    });
  });
  return out;
}
