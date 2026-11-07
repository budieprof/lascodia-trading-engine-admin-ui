import type { CmeBasisPoint } from '@core/realtime/marketdata.types';
import type { CotRow, DerivativesMinute, FutureStatistic } from './derivatives-data.service';
import type { FundamentalPaneId, PanePoint } from './fx-fundamentals';
import type { RelevanceKind } from './event-relevance';

/**
 * Which fundamentals panes a symbol is offered, and the pure series of the non-FX ones (UA03).
 *
 * The FX panes (rate differential, swap / carry, news pressure, economic surprise) are about a currency PAIR: they are
 * offered for FX and metals only (they used to be offered for every symbol, read off its first six letters). The
 * market panes are offered where their data can exist: funding rate, open interest (+ change), liquidations for crypto
 * perpetuals (`md/crypto/derivatives`); basis for perpetuals (mark − index) and for the FX majors CME quotes
 * (`md/basis`); term structure / roll yield for futures (`futures/statistics` settlements); COT positioning for FX and
 * currency futures (`sentiment/cot/list`). An offered pane with no data says so with the engine's reason — never zeros.
 */

/** What decides a symbol's panes, from the instrument and the chart's candle source. */
export interface PaneScope {
  symbol: string;
  kind: RelevanceKind;
  /** A crypto perpetual (funding, OI, liquidations exist for it). */
  perpetual: boolean;
  /** The venue the derivatives are read from (C1 `source.id`), when it is one. */
  sourceId: string | null;
  /** A future's root (`ES`, `6E`). */
  futureRoot: string | null;
  /** Currencies of an FX pair or currency future (COT). */
  currencies: string[];
}

/** FX spot symbols the CME FX futures (6A 6B 6C 6E 6J 6N 6S) quote a basis for (`md/basis`). */
const CME_FX_SPOT = new Set(['AUDUSD', 'GBPUSD', 'USDCAD', 'EURUSD', 'USDJPY', 'NZDUSD', 'USDCHF']);

export const FX_PANES: readonly FundamentalPaneId[] = [
  'rate-differential',
  'swap-carry',
  'news-pressure',
  'economic-surprise',
];

export function cmeBasisSymbol(symbol: string): boolean {
  return CME_FX_SPOT.has(
    symbol
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 6),
  );
}

/** Whether a pane is offered for the symbol. */
export function paneApplies(id: FundamentalPaneId, scope: PaneScope): boolean {
  switch (id) {
    case 'rate-differential':
    case 'swap-carry':
    case 'news-pressure':
    case 'economic-surprise':
      return scope.kind === 'fx';
    case 'funding-rate':
    case 'funding-times':
    case 'open-interest':
    case 'liquidations':
      return scope.perpetual;
    case 'basis':
      return scope.perpetual || (scope.kind === 'fx' && cmeBasisSymbol(scope.symbol));
    case 'term-structure':
      return scope.kind === 'future' && !!scope.futureRoot;
    case 'cot':
      return (scope.kind === 'fx' || scope.kind === 'future') && scope.currencies.length > 0;
  }
}

/** Why a pane saved with a layout draws nothing on this symbol. */
export function notApplicable(id: FundamentalPaneId, scope: PaneScope): string {
  const s = scope.symbol.toUpperCase();
  if (FX_PANES.includes(id)) return `FX pairs only: ${s} is not a currency pair.`;
  if (id === 'term-structure') return `Futures only: ${s} is not a futures contract.`;
  if (id === 'cot') return `COT is reported per currency: ${s} has no currency it is reported for.`;
  if (id === 'basis')
    return `No basis series exists for ${s} (crypto perpetuals and CME-quoted FX pairs only).`;
  return `Crypto perpetuals only: ${s} has no funding, open interest or liquidations.`;
}

const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Funding rate, percent per funding interval, per minute it was reported. */
export function fundingSeries(minutes: readonly DerivativesMinute[]): PanePoint[] {
  return minutes
    .filter((m) => finite(m.funding))
    .map((m) => ({ time: m.t, value: m.funding! * 100 }));
}

/**
 * The funding instants the feed has passed (each distinct `nextFundingT` once a later minute exists), valued at the
 * rate reported in the minute before it, percent per interval.
 */
export function fundingInstants(minutes: readonly DerivativesMinute[]): PanePoint[] {
  const rate = new Map<number, number>();
  const lastT = minutes.length ? minutes[minutes.length - 1].t : -Infinity;
  for (const m of minutes) {
    const t = m.nextFundingT;
    if (!finite(t) || t > lastT || m.t >= t || !finite(m.funding)) continue;
    rate.set(t, m.funding * 100);
  }
  return [...rate.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

/** Open interest in the venue's unit. */
export function openInterestSeries(minutes: readonly DerivativesMinute[]): PanePoint[] {
  return minutes.filter((m) => finite(m.oi)).map((m) => ({ time: m.t, value: m.oi! }));
}

/**
 * Open-interest change, percent, against the reading `windowMinutes` earlier (the newest reading at or before it); no
 * point until a full window of history exists.
 */
export function openInterestChange(
  minutes: readonly DerivativesMinute[],
  windowMinutes: number,
): PanePoint[] {
  const pts = openInterestSeries(minutes);
  const span = Math.max(1, windowMinutes) * 60_000;
  const out: PanePoint[] = [];
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    const target = pts[i].time - span;
    if (pts[0].time > target) continue;
    while (j + 1 < i && pts[j + 1].time <= target) j++;
    const ref = pts[j].value;
    if (ref !== 0) out.push({ time: pts[i].time, value: ((pts[i].value - ref) / ref) * 100 });
  }
  return out;
}

/** Perpetual premium: (mark − index) / index, percent. */
export function premiumSeries(minutes: readonly DerivativesMinute[]): PanePoint[] {
  return minutes
    .filter((m) => finite(m.mark) && finite(m.index) && m.index !== 0)
    .map((m) => ({ time: m.t, value: ((m.mark! - m.index!) / m.index!) * 100 }));
}

/** CME future − spot basis in price (`md/basis`), the per-minute value (rolling median where the minute has none). */
export function cmeBasisSeries(points: readonly CmeBasisPoint[]): PanePoint[] {
  return points
    .map((p) => ({ time: p.t, value: finite(p.basis) ? p.basis : p.rolling }))
    .filter((p): p is PanePoint => finite(p.value));
}

/** Liquidations per minute in quote notional, buy (shorts liquidated) and sell (longs liquidated) side. */
export function liquidationSeries(minutes: readonly DerivativesMinute[]): {
  buy: PanePoint[];
  sell: PanePoint[];
} {
  return {
    buy: minutes.map((m) => ({ time: m.t, value: m.liqBuyNotional })),
    sell: minutes.map((m) => ({ time: m.t, value: m.liqSellNotional })),
  };
}

/**
 * Roll yield of the curve's front two contracts per trading date, annualised percent: (front − next) / next ×
 * 365 / days between their last trading days — positive in backwardation, negative in contango. `lastTrade` gives each
 * contract's last trading instant (from the term structure); a date where either settlement is missing is skipped.
 */
export function rollYieldSeries(
  stats: readonly FutureStatistic[],
  lastTrade: ReadonlyMap<string, number>,
): PanePoint[] {
  const byDate = new Map<string, FutureStatistic[]>();
  for (const s of stats) {
    if (!finite(s.settlement)) continue;
    const list = byDate.get(s.tradeDate) ?? [];
    list.push(s);
    byDate.set(s.tradeDate, list);
  }
  const out: PanePoint[] = [];
  for (const [date, rows] of byDate) {
    const day = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(day)) continue;
    const live = rows
      .map((r) => ({ r, last: lastTrade.get(r.contract.toUpperCase()) }))
      .filter(
        (x): x is { r: FutureStatistic; last: number } => x.last !== undefined && x.last >= day,
      )
      .sort((a, b) => a.last - b.last);
    if (live.length < 2) continue;
    const [front, next] = live;
    const days = (next.last - front.last) / 86_400_000;
    if (days <= 0 || !next.r.settlement) continue;
    out.push({
      time: day,
      value: ((front.r.settlement! - next.r.settlement!) / next.r.settlement!) * (365 / days) * 100,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Net non-commercial (speculative) positioning per weekly report, ascending. */
export function cotSeries(rows: readonly CotRow[]): PanePoint[] {
  return rows
    .map((r) => ({ time: Date.parse(r.reportDate), value: r.netNonCommercialPositioning }))
    .filter((p) => Number.isFinite(p.time) && finite(p.value))
    .sort((a, b) => a.time - b.time);
}

/** The note under a pane that drew nothing (the engine's reason, else the generic one). */
export function emptyNote(
  what: string,
  symbol: string,
  engineMessage: string | null | undefined,
): string {
  const why = (engineMessage ?? '').trim();
  return `No ${what} for ${symbol.toUpperCase()}${why && !/^(ok|successful)$/i.test(why) ? `: ${why}` : '.'}`;
}
