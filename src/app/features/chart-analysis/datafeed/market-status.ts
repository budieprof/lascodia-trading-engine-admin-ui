import type { SessionStateDto } from '@core/instruments/instrument.types';
import type { SessionClosure } from './session-calendar';

/**
 * Where a symbol's market stands, for the legend and the symbol details (multi-asset chart program UD08). Pure.
 *
 * The ENGINE says it (`GET instruments/{symbol}/session-state`: open or not, the session kind — Pre / Regular / Post —
 * and the next open / close, from the instrument's trading calendar, holidays included). The chart used to guess it
 * from the age of the newest bar with FX's rules: crypto read "market closed" on a quiet minute, an equity CFD "live"
 * in the middle of the night. What the chart adds to the engine's answer:
 * - a daily break or a holiday from chart-bars' C1 closures names the reason ("Break", "Closed: Thanksgiving");
 * - "Feed stale" when the market is open and nothing has arrived for {@link STALE_MS} (no tick, no new bar);
 * - "Trading outside the calendar's hours" when the engine's calendar says closed but prices are arriving (a broker CFD
 *   that trades beyond its exchange's session, DE40 at night) — never a confident "closed" over a moving chart.
 * Without an engine answer (an engine without calendars, a symbol it has no calendar for) the old reading from the data
 * stays, and says it is one: "live (from the data)".
 */

export type MarketKind =
  | 'pre'
  | 'regular'
  | 'post'
  | 'break'
  | 'closed'
  | 'outside'
  | 'stale'
  | 'unknown';

export interface MarketView {
  kind: MarketKind;
  /** The short word on the chip: "Pre-market", "Market open", "Break", "Market closed", … */
  label: string;
  /** The next change the countdown runs to (UTC ms), and what happens then; null: none known. */
  nextAt: number | null;
  nextVerb: 'opens' | 'closes' | null;
  /** The chip's tooltip: where the answer came from. */
  title: string;
  /** The legend's three-state class (CSS): open / closed / stale. */
  tone: 'open' | 'closed' | 'stale';
}

/** Nothing (no tick, no new bar) for this long while the market is open: the feed is stale. */
export const STALE_MS = 10 * 60_000;
/** A tick this recent while the calendar says closed: the instrument is trading outside its calendar's hours. */
export const OUTSIDE_TICK_MS = 2 * 60_000;

export interface MarketInputs {
  /** The engine's answer; null: not served / no calendar for the symbol; undefined: not answered yet. */
  state: SessionStateDto | null | undefined;
  /** The symbol's calendar code, for the tooltip. */
  calendarCode?: string | null;
  /** C1 closures the chart knows for the symbol. */
  closures?: readonly SessionClosure[] | null;
  /** The newest live price (ms; 0 = none since the chart opened). */
  liveAt: number;
  /** When the newest bar ends (its close, or its open + one bar), ms; null: no bars. */
  lastBarEnd: number | null;
  nowMs: number;
}

const iso = (v: string | null | undefined): number | null => {
  const t = v ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

/** The view of {@link MarketInputs}. */
export function marketView(i: MarketInputs): MarketView {
  const freshest = Math.max(i.liveAt || 0, i.lastBarEnd ?? 0);
  const cal = i.calendarCode ? ` (${i.calendarCode} calendar)` : '';
  if (i.state === undefined) {
    return {
      kind: 'unknown',
      label: 'Market status…',
      nextAt: null,
      nextVerb: null,
      title: 'Asking the engine for the session state',
      tone: 'closed',
    };
  }
  if (i.state === null) {
    // No engine answer: read it from the data, and say so.
    if (i.lastBarEnd === null && !i.liveAt)
      return {
        kind: 'unknown',
        label: 'No data',
        nextAt: null,
        nextVerb: null,
        title: 'No bars and no live price for this symbol',
        tone: 'closed',
      };
    const age = i.nowMs - freshest;
    const live = age <= 5 * 60_000;
    return {
      kind: live ? 'regular' : age <= 3 * 86_400_000 ? 'closed' : 'stale',
      label: live
        ? 'live (from the data)'
        : age <= 3 * 86_400_000
          ? 'quiet (from the data)'
          : 'feed stale',
      nextAt: null,
      nextVerb: null,
      title:
        'The engine has no trading calendar for this symbol: read from the newest bar and price',
      tone: live ? 'open' : age <= 3 * 86_400_000 ? 'closed' : 'stale',
    };
  }
  const s = i.state;
  const nextOpen = iso(s.nextOpen);
  const nextClose = iso(s.nextClose);
  if (s.open) {
    if (i.nowMs - freshest > STALE_MS && freshest > 0)
      return {
        kind: 'stale',
        label: 'Feed stale',
        nextAt: null,
        nextVerb: null,
        title: `The market is open${cal} but nothing has arrived for ${countdown(i.nowMs - freshest)}`,
        tone: 'stale',
      };
    const kind: MarketKind =
      s.sessionKind === 'Pre' ? 'pre' : s.sessionKind === 'Post' ? 'post' : 'regular';
    return {
      kind,
      label: kind === 'pre' ? 'Pre-market' : kind === 'post' ? 'Post-market' : 'Market open',
      nextAt: nextClose,
      nextVerb: nextClose !== null ? 'closes' : null,
      title: `Engine session state${cal}`,
      tone: 'open',
    };
  }
  if (i.liveAt && i.nowMs - i.liveAt <= OUTSIDE_TICK_MS)
    return {
      kind: 'outside',
      label: 'Trading outside calendar hours',
      nextAt: nextOpen,
      nextVerb: nextOpen !== null ? 'opens' : null,
      title: `The calendar${cal} says closed, but prices are arriving (the broker trades beyond the exchange's session)`,
      tone: 'open',
    };
  const closure = (i.closures ?? []).find((c) => i.nowMs >= c.fromMs && i.nowMs < c.toMs);
  if (closure?.kind === 'Break')
    return {
      kind: 'break',
      label: 'Break',
      nextAt: nextOpen,
      nextVerb: nextOpen !== null ? 'opens' : null,
      title: closure.label || `Daily break${cal}`,
      tone: 'closed',
    };
  const why = closure && closure.label ? `: ${closure.label}` : '';
  return {
    kind: 'closed',
    label: `Market closed${why}`,
    nextAt: nextOpen,
    nextVerb: nextOpen !== null ? 'opens' : null,
    title: `Engine session state${cal}`,
    tone: 'closed',
  };
}

/** A duration as the countdown prints it: `45s`, `12m 05s`, `2h 05m`, `3d 4h`. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${p(m)}m`;
  if (m > 0) return `${m}m ${p(sec)}s`;
  return `${sec}s`;
}

/** "closes in 2h 05m" / "opens in 3d 4h"; null without a next change (or one already past). */
export function nextChangeText(view: MarketView, nowMs: number): string | null {
  if (view.nextAt === null || view.nextVerb === null || view.nextAt <= nowMs) return null;
  return `${view.nextVerb} in ${countdown(view.nextAt - nowMs)}`;
}
