import type { Time, UTCTimestamp } from 'lightweight-charts';
import type { Bar } from '../datafeed/candle-feed.service';
import type { Maybe } from '../indicators/math';
import { withBarColor, type BarPaint } from '../scripts/run-on-host';
import type { ChartStyle } from './chart-host.component';
import type { OhlcvData } from './custom-series';
import type { KagiSegment, PnfColumn } from './price-transforms';

/**
 * The rows each chart series is given, built from the plotted bars (CC-I1). Pure — no chart, no
 * Angular — so the per-tick cost is measured in a test (`chart-rows.spec.ts`), and every builder can
 * start at the first bar that changed: the rows before it are the previous call's, reused by
 * reference, which is what lets `SeriesSync` find the changed tail in a few comparisons.
 */

/** Lightweight Charts takes seconds; our bars carry milliseconds. */
export function asTime(ms: number): Time {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

/** The plotted bars' times as the time scale holds them (zone-shifted seconds). */
export function plottedSeconds(bars: readonly Bar[]): number[] {
  return bars.map((b) => Math.floor(b.time / 1000));
}

export function toOhlcData(b: Bar) {
  return { time: asTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close };
}

/** How a script's colour paints a bar of `style` (one of BAR_COLOR_STYLES). */
export function barPaint(style: ChartStyle): BarPaint {
  if (style === 'hollow') return 'hollow';
  return style === 'candles' || style === 'heikin-ashi' ? 'candle' : 'bar';
}

/** Candle / bar rows, each bar a script coloured painted per `paint` (body, border, wick…). */
export function ohlcRows(
  source: readonly Bar[],
  colors: readonly (string | null)[] | null,
  paint: BarPaint,
) {
  return source.map((b, i) => withBarColor(toOhlcData(b), colors?.[i], paint));
}

/** Rows of the HiLo, volume-candle and HLC-area custom series; a script's colour is the bar's one colour. */
export function ohlcvRows(
  source: readonly Bar[],
  colors: readonly (string | null)[] | null,
): OhlcvData[] {
  return source.map((b, i) =>
    withBarColor<OhlcvData>(
      {
        time: asTime(b.time),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      },
      colors?.[i],
      'bar',
    ),
  );
}

/** Any row of the price series: a candle / bar, a custom series' bar, or a single value. */
export type PriceRow = {
  time: Time;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  value?: number;
  color?: string;
  borderColor?: string;
  wickColor?: string;
  /** Point & Figure: the box size and the column's direction (X up / O down). */
  box?: number;
  up?: boolean;
  /** Kagi: thick where the segment starts, and where it changes thickness. */
  thickStart?: boolean;
  switchAt?: number | null;
};

/** Equality of price rows of any kind, script colours included. */
export function samePriceRow(a: PriceRow, b: PriceRow): boolean {
  return (
    a === b ||
    (a.time === b.time &&
      a.open === b.open &&
      a.high === b.high &&
      a.low === b.low &&
      a.close === b.close &&
      a.volume === b.volume &&
      a.value === b.value &&
      a.color === b.color &&
      a.borderColor === b.borderColor &&
      a.wickColor === b.wickColor &&
      a.box === b.box &&
      a.up === b.up &&
      a.thickStart === b.thickStart &&
      a.switchAt === b.switchAt)
  );
}

/** The colours the price and volume rows are drawn in (the palette's, theme-independent). */
export interface RowPalette {
  up: string;
  down: string;
  volumeUp: string;
  volumeDown: string;
}

/** Which kind of rows a style's price series takes. */
export type PriceRowKind = 'value' | 'column' | 'ohlc' | 'ohlcv' | 'pnf' | 'kagi';

export function priceRowKind(style: ChartStyle): PriceRowKind {
  switch (style) {
    case 'line':
    case 'area':
    case 'baseline':
    case 'stepline':
    case 'line-markers':
      return 'value';
    case 'pnf':
      return 'pnf';
    case 'kagi':
      return 'kagi';
    case 'column':
      return 'column';
    case 'hilo':
    case 'vol-candle':
    case 'hlc-area':
      return 'ohlcv';
    default:
      return 'ohlc';
  }
}

/**
 * The price series' rows for `plotted`, from bar `from` on — `prev` (the rows built for the previous
 * plotted bars, with the same colours) kept before it, by reference. A script's `barcolor()` goes
 * into the rows themselves (`colors`, one per plotted bar), so a tick that rewrites the forming bar
 * keeps its colour: `series.update()` replaces the whole row.
 *
 * The candle and bar rows are exactly the ones `ohlcRows` / `ohlcvRows` build for the scripts'
 * colour refresh, so a refresh and a tick never disagree about what a row is.
 */
export function priceRowsFrom(
  style: ChartStyle,
  plotted: readonly Bar[],
  colors: readonly (string | null)[] | null,
  palette: RowPalette,
  from: number,
  prev: readonly PriceRow[],
): PriceRow[] {
  const start = Math.max(0, Math.min(from, prev.length, plotted.length));
  const head = prev.slice(0, start);
  const tail = plotted.slice(start);
  const colorsFrom = colors ? colors.slice(start) : null;
  let built: PriceRow[];
  switch (priceRowKind(style)) {
    case 'value':
      built = tail.map((b) => ({ time: asTime(b.time), value: b.close }));
      break;
    case 'column':
      built = tail.map((b) => ({
        time: asTime(b.time),
        value: b.close,
        color: b.close >= b.open ? palette.up : palette.down,
      }));
      break;
    case 'ohlcv':
      built = ohlcvRows(tail, colorsFrom);
      break;
    case 'pnf':
      // X / O columns (custom series): the box grid and the column's direction ride along.
      built = tail.map((b) => {
        const p = (b as Partial<PnfColumn>).pnf;
        return { time: asTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, box: p?.box ?? 0, up: p?.up ?? b.close >= b.open };
      });
      break;
    case 'kagi':
      // The line's segments (custom series), thick or thin, and where they change.
      built = tail.map((b) => {
        const k = (b as Partial<KagiSegment>).kagi;
        return { time: asTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close, thickStart: k?.thickStart ?? b.close >= b.open, switchAt: k?.switchAt ?? null };
      });
      break;
    default:
      built = ohlcRows(tail, colorsFrom, barPaint(style));
  }
  return head.concat(built);
}

/** Rows of the volume overlay. */
export type VolumeRow = { time: Time; value: number; color: string };

export function volumeRowsFrom(
  plotted: readonly Bar[],
  palette: RowPalette,
  from: number,
  prev: readonly VolumeRow[],
): VolumeRow[] {
  const start = Math.max(0, Math.min(from, prev.length, plotted.length));
  return prev.slice(0, start).concat(
    plotted.slice(start).map((b) => ({
      time: asTime(b.time),
      value: b.volume,
      color: b.close >= b.open ? palette.volumeUp : palette.volumeDown,
    })),
  );
}

/** A row of a single-value series; no `value` is whitespace — a gap in a line. */
export type ValueRow = { time: Time; value?: number };

/**
 * How a plot treats the bars where it has no value: `join` draws its line straight across them (a
 * zig zag connects its pivots); `break` leaves a gap (a session's high and low end with the session
 * and must not bridge the night — DR-17).
 */
export type GapPolicy = 'join' | 'break';

/** Index of the first value that differs between two runs of a study (`next.length` when none does). */
export function firstChangedValue(prev: readonly Maybe[], next: readonly Maybe[]): number {
  const common = Math.min(prev.length, next.length);
  let i = 0;
  while (i < common && sameValue(prev[i], next[i])) i++;
  return i;
}

function sameValue(a: Maybe, b: Maybe): boolean {
  const an = a === null || a === undefined || Number.isNaN(a);
  const bn = b === null || b === undefined || Number.isNaN(b);
  return an || bn ? an === bn : a === b;
}

/**
 * A study plot's rows on the plotted bars, from bar `from` on, reusing `prev` for the bars before it.
 * `join` leaves out the bars without a value; `break` writes them as whitespace. `prev` must have
 * been built with the same policy over the same bar times up to `from`.
 */
export function valueRowsFrom(
  plotted: readonly { time: number }[],
  values: readonly Maybe[],
  gaps: GapPolicy,
  from: number,
  prev: readonly ValueRow[],
): ValueRow[] {
  const start = Math.max(0, Math.min(from, plotted.length));
  // From the first bar, nothing of `prev` is kept: after a rebuild its times may be another time
  // zone's, and some of them could fall before the new first bar.
  const kept: readonly ValueRow[] = start === 0 ? [] : prev;
  // The rows of the bars before `start`: every row whose time is before that bar's — or, when every
  // bar is kept, up to the last one (bars taken off the end, as replay stepping back does, take
  // their rows with them).
  const cutTime =
    start < plotted.length
      ? (asTime(plotted[start].time) as number)
      : plotted.length
        ? (asTime(plotted[plotted.length - 1].time) as number) + 1
        : -Infinity;
  let cut = 0;
  let hi = kept.length;
  while (cut < hi) {
    const mid = (cut + hi) >> 1;
    if ((kept[mid].time as number) < cutTime) cut = mid + 1;
    else hi = mid;
  }
  const out = kept.slice(0, cut);
  for (let i = start; i < plotted.length; i++) {
    const v = values[i];
    const time = asTime(plotted[i].time);
    if (v === null || v === undefined || !Number.isFinite(v)) {
      if (gaps === 'break') out.push({ time });
    } else {
      out.push({ time, value: v });
    }
  }
  return out;
}

/** The bars a study is computed on, as the indicator maths takes them. */
export function ohlcOf(bars: readonly Bar[]) {
  return bars.map((b) => ({
    time: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}
