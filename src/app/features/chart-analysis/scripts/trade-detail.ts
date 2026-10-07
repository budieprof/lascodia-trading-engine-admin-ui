import type { ChartScriptResult, ChartTrade } from './chart-script.model';
import type { ScriptInputValues } from '@core/api/scripting.types';
import { tradingDateLabel } from '../chart/trading-date';

/**
 * Everything the Strategy Tester knows about one trade, assembled for the trade-detail popup:
 * the fills, the outcome and its excursions (run-up / drawdown, as TradingView's List of trades
 * shows), and the evidence — every series the strategy plots, read at the entry bar and at the
 * exit bar, beside that bar's OHLC — plus the inputs the run used.
 */

export interface DetailRow {
  label: string;
  value: string;
  tone?: 'pos' | 'neg';
}

export interface SeriesAtBars {
  title: string;
  color: string;
  entry: number | null;
  exit: number | null;
}

export interface TradeDetail {
  title: string;
  side: 'long' | 'short';
  trade: DetailRow[];
  outcome: DetailRow[];
  series: SeriesAtBars[];
  bars: { label: string; entry: string | null; exit: string | null }[];
  inputs: DetailRow[];
}

/** Loose view of a report trade: the engine sends more than ChartTrade keeps. */
interface ReportTradeLike {
  number?: number;
  entryBarIndex?: number;
  exitBarIndex?: number;
  exitLeg?: string;
  positionValue?: number;
  runUp?: number;
  runUpPercent?: number;
  drawdown?: number;
  drawdownPercent?: number;
  barsHeld?: number;
  commission?: number;
  swap?: number;
  executionCost?: number;
  cumulativeProfitPercent?: number;
}

const fmt = (v: number | null | undefined, d: number): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

const money = (v: number | null | undefined, ccy: string): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${fmt(v, 2)} ${ccy}`.trim();

const pct = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '' : ` (${v >= 0 ? '+' : ''}${fmt(v, 2)}%)`;

/**
 * A trade's entry or exit time (Lightweight Charts seconds — the open of the bar it filled on). On
 * 1D/1W/1M that bar is named by its trading date, as the chart names it; elsewhere the instant is
 * printed in UTC.
 */
export function tradeTimeLabel(sec: number | null, resolution = ''): string {
  if (sec === null) return '—';
  return (
    tradingDateLabel({ time: sec * 1000 }, resolution) ??
    new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  );
}

function duration(fromSec: number, toSec: number): string {
  const m = Math.max(0, Math.round((toSec - fromSec) / 60));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  return [d ? `${d}d` : '', h ? `${h}h` : '', !d && mm ? `${mm}m` : ''].filter(Boolean).join(' ') || '0m';
}

/** Value of a plot at a chart time (seconds), or null when the plot is na there. */
function valueAt(data: readonly { time: number; value?: number }[], sec: number | null): number | null {
  if (sec === null) return null;
  let lo = 0;
  let hi = data.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = data[mid].time;
    if (t === sec) {
      const v = data[mid].value;
      return v === undefined || !Number.isFinite(v) ? null : v;
    }
    if (t < sec) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

export function tradeDetail(
  result: ChartScriptResult,
  t: ChartTrade,
  values: ScriptInputValues = {},
  precision = 5,
  /** The run's resolution: on 1D/1W/1M the entry and exit bars are named by trading date. */
  resolution = '',
): TradeDetail {
  const when = (sec: number | null) => tradeTimeLabel(sec, resolution);
  const ccy = result.strategy?.metrics.currency ?? '';
  const raw = ((result.strategy?.report as { trades?: ReportTradeLike[] } | undefined)?.trades ?? []).find(
    (x) => Number(x.number) === t.number,
  );
  const long = t.side === 'long';
  const exitLegs: Record<string, string> = { TakeProfit: 'take profit', StopLoss: 'stop loss', Trailing: 'trailing stop' };

  const trade: DetailRow[] = [
    { label: 'Direction', value: long ? 'Long' : 'Short', tone: long ? 'pos' : 'neg' },
    { label: 'Entry signal', value: t.entrySignal || '—' },
    { label: 'Entry', value: `${fmt(t.entryPrice, precision)} · ${when(t.entryTime)}` },
    {
      label: 'Exit signal',
      value: t.isOpen ? 'Open' : `${t.exitSignal ?? '—'}${raw?.exitLeg && exitLegs[raw.exitLeg] ? ` (${exitLegs[raw.exitLeg]})` : ''}`,
    },
    { label: 'Exit', value: t.isOpen ? 'Still open' : `${fmt(t.exitPrice, precision)} · ${when(t.exitTime)}` },
    { label: 'Quantity', value: `${fmt(t.qty, 0)} units` },
  ];
  if (raw?.positionValue !== undefined) trade.push({ label: 'Position value', value: `${fmt(raw.positionValue, 2)} ${ccy}`.trim() });
  if (t.exitTime !== null)
    trade.push({
      label: 'Held',
      value: `${raw?.barsHeld !== undefined ? `${raw.barsHeld} bars · ` : ''}${duration(t.entryTime, t.exitTime)}`,
    });

  const tone = (v: number | null | undefined): 'pos' | 'neg' | undefined =>
    v === null || v === undefined ? undefined : v >= 0 ? 'pos' : 'neg';
  const priceMove = t.exitPrice !== null ? (t.exitPrice - t.entryPrice) * (long ? 1 : -1) : null;
  const outcome: DetailRow[] = [
    { label: t.isOpen ? 'Open P&L' : 'Net profit', value: money(t.profit, ccy) + pct(t.profitPercent), tone: tone(t.profit) },
    { label: 'Price move', value: priceMove === null ? '—' : `${priceMove >= 0 ? '+' : ''}${fmt(priceMove, precision)}`, tone: tone(priceMove) },
    { label: 'Run-up (MFE)', value: money(raw?.runUp, ccy) + pct(raw?.runUpPercent), tone: raw?.runUp !== undefined ? 'pos' : undefined },
    {
      label: 'Drawdown (MAE)',
      value: raw?.drawdown !== undefined ? money(-Math.abs(raw.drawdown), ccy) + pct(raw.drawdownPercent !== undefined ? -Math.abs(raw.drawdownPercent) : undefined) : '—',
      tone: raw?.drawdown !== undefined ? 'neg' : undefined,
    },
    { label: 'Cumulative profit', value: money(t.cumulativeProfit, ccy) + pct(raw?.cumulativeProfitPercent), tone: tone(t.cumulativeProfit) },
  ];
  const costs = [raw?.commission, raw?.swap, raw?.executionCost].filter((v): v is number => typeof v === 'number');
  if (costs.length) outcome.push({ label: 'Costs (commission, swap, execution)', value: costs.map((c) => fmt(c, 2)).join(' / ') + (ccy ? ` ${ccy}` : '') });

  const series: SeriesAtBars[] = result.plots
    .map((p) => ({
      title: p.title || `Plot ${p.id}`,
      color: p.color,
      entry: valueAt(p.data as { time: number; value?: number }[], t.entryTime),
      exit: valueAt(p.data as { time: number; value?: number }[], t.exitTime),
    }))
    .filter((s) => s.entry !== null || s.exit !== null);

  const runBars = result.run?.bars ?? [];
  const barAt = (sec: number | null) => (sec === null ? null : (runBars.find((b) => b.t === sec * 1000) ?? null));
  const eb = barAt(t.entryTime);
  const xb = barAt(t.exitTime);
  const ohlc = (b: typeof eb, k: 'o' | 'h' | 'l' | 'c' | 'v') => (b ? fmt(b[k], k === 'v' ? 0 : precision) : null);
  const bars = (['o', 'h', 'l', 'c', 'v'] as const).map((k) => ({
    label: { o: 'Open', h: 'High', l: 'Low', c: 'Close', v: 'Volume' }[k],
    entry: ohlc(eb, k),
    exit: ohlc(xb, k),
  }));

  const inputs: DetailRow[] = result.inputs.map((i) => {
    const v = values[i.id] ?? i.defaultValue;
    return { label: i.title || i.id, value: v === null || v === undefined ? '—' : String(v) };
  });

  return { title: `Trade #${t.number}`, side: t.side, trade, outcome, series, bars, inputs };
}

/**
 * The window TradingView-style "go to trade" frames: the whole trade plus a margin of
 * max(10 bars, 30% of the trade's length) on each side, so a one-bar trade still has context.
 */
export function tradeWindow(t: ChartTrade, barSeconds: number, nowSec: number): { fromMs: number; toMs: number } {
  const end = t.exitTime ?? nowSec;
  const span = Math.max(0, end - t.entryTime);
  const pad = Math.max(10 * barSeconds, span * 0.3);
  return { fromMs: (t.entryTime - pad) * 1000, toMs: (end + pad) * 1000 };
}
