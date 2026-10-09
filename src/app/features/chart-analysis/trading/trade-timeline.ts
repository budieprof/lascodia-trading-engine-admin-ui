import type {
  ParityTimelineFill,
  ParityTimelinePair,
  ScriptParityTimeline,
} from '@features/scripting/api/scripting-api.types';

import type { ChartMarker } from '../chart/chart-host.component';

/**
 * BX-1: one trade timeline on the chart — the strategy's backtest trades, its live session's emulator and paper fills,
 * and the accounts' broker fills, each entry and exit at its own time, with the slippage of every paired fill marked
 * (from `GET strategy/{id}/parity/timeline`, the parity vertical's endpoint). Pure.
 */

/** Colour per source: backtest grey-blue, emulator teal, paper purple (as the trade layer's paper fills), broker by result. */
export const TIMELINE_COLORS = {
  backtest: '#78909C',
  emulator: '#26C6DA',
  paper: '#7E57C2',
  brokerOk: '#26A69A',
  brokerWorse: '#EF5350',
} as const;

const SOURCE_TAG: Record<string, string> = {
  backtest: 'BT',
  emulator: 'Live',
  paper: 'Paper',
  broker: 'Acct',
};

/** Slippage shown beside a fill: "+1.2p" (worse for the strategy), "−0.4p" (better). */
export function slippageText(pair: Pick<ParityTimelinePair, 'slippage' | 'slippagePips'>): string {
  const pips = pair.slippagePips;
  if (pips === null || !Number.isFinite(pips)) return '';
  const sign = pips > 0 ? '+' : pips < 0 ? '−' : '±';
  return `${sign}${Math.abs(pips).toFixed(1)}p`;
}

/** The pairs ending at each fill (the fill it is compared WITH is the pair's first): fill id → pairs. */
function pairsByTarget(pairs: readonly ParityTimelinePair[]): Map<string, ParityTimelinePair[]> {
  const out = new Map<string, ParityTimelinePair[]>();
  for (const p of pairs) {
    const list = out.get(p.toFillId) ?? [];
    list.push(p);
    out.set(p.toFillId, list);
  }
  return out;
}

const long = (f: ParityTimelineFill) =>
  String(f.direction).toLowerCase() === 'long' || String(f.side).toLowerCase() === 'buy';

/**
 * The timeline as chart markers, oldest first. An entry sits under (long) / over (short) its bar with an arrow, an
 * exit on the other side with a circle; a backtest fill is a square. A fill compared with another source's (the
 * session against the backtest, an account against the session or the backtest) carries its slippage; a broker fill
 * that came out worse by at least `worsePips` is drawn red. Fills of another symbol (a stale reply) are dropped.
 */
export function timelineMarkers(
  timeline: ScriptParityTimeline,
  chartSymbol: string,
  worsePips = 0.5,
): ChartMarker[] {
  if (timeline.symbol.toUpperCase() !== chartSymbol.toUpperCase()) return [];
  const byTarget = pairsByTarget(timeline.pairs);
  const out: ChartMarker[] = [];
  for (const f of timeline.fills) {
    const time = Date.parse(f.timeUtc);
    if (!Number.isFinite(time)) continue;
    const isLong = long(f);
    const entry = f.kind === 'entry';
    const source = f.source;
    const pairs = byTarget.get(f.id) ?? [];
    const slip = pairs.map(slippageText).filter((s) => s !== '');
    const worse = pairs.some((p) => p.slippagePips !== null && p.slippagePips >= worsePips);
    const color =
      source === 'broker'
        ? worse
          ? TIMELINE_COLORS.brokerWorse
          : TIMELINE_COLORS.brokerOk
        : source === 'paper'
          ? TIMELINE_COLORS.paper
          : source === 'emulator'
            ? TIMELINE_COLORS.emulator
            : TIMELINE_COLORS.backtest;
    const tag = SOURCE_TAG[source] ?? source;
    out.push({
      time,
      position: entry === isLong ? 'belowBar' : 'aboveBar',
      shape:
        source === 'backtest' ? 'square' : entry ? (isLong ? 'arrowUp' : 'arrowDown') : 'circle',
      color,
      text: `${tag} ${entry ? (isLong ? 'buy' : 'sell') : 'exit'}${slip.length ? ` ${slip.join(' ')}` : ''}`,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** The window the chart asks for: from its oldest loaded bar (at most 366 days back) to now. */
export function timelineWindow(
  oldestBarMs: number | null,
  nowMs: number,
): { fromUtc: string; toUtc: string } {
  const maxBack = nowMs - 366 * 86_400_000 + 60_000;
  const from =
    oldestBarMs !== null && Number.isFinite(oldestBarMs) ? Math.max(oldestBarMs, maxBack) : maxBack;
  return { fromUtc: new Date(from).toISOString(), toUtc: new Date(nowMs).toISOString() };
}

/** A one-line summary for the overlays menu: "38 fills · 12 compared · mean account slippage +0.6p". */
export function timelineSummary(timeline: ScriptParityTimeline): string {
  const accountPairs = timeline.pairs.filter(
    (p) => p.slippagePips !== null && p.toFillId.startsWith('acct:'),
  );
  const parts = [`${timeline.fills.length} fills`, `${timeline.pairs.length} compared`];
  if (accountPairs.length) {
    const mean = accountPairs.reduce((s, p) => s + (p.slippagePips ?? 0), 0) / accountPairs.length;
    parts.push(`mean account slippage ${slippageText({ slippage: 0, slippagePips: mean })}`);
  }
  if (timeline.truncated) parts.push('oldest fills only (5,000 cap)');
  return parts.join(' · ');
}
