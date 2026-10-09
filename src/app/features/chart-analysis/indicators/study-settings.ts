/**
 * A built-in study's settings beyond its inputs (DR-I4 / DR-I5) — what the indicator settings dialog edits and the
 * chart applies:
 *
 * - **Style**: per plot its colour, width, whether it is drawn and how (line, dots, histogram); the reference
 *   levels; the band / cloud fill.
 * - **Visibility**: the timeframes it shows on, as the drawings' Visibility tab sets them (unit ranges).
 * - **Source = another study** (indicators on indicators): a `source` input of `study:<uid>:<plot>` takes that
 *   study's plot as its series, computed first (dependency order).
 * - **Timeframe** (multi-timeframe built-ins): computed on a higher timeframe's bars and joined onto the chart's on
 *   CLOSED bars only — a chart bar shows the value of the latest higher-timeframe bar that had closed by its own
 *   close, never one still forming (no repaint).
 *
 * Pure: no Angular, no chart; unit-tested directly.
 */
import { resolutionMs } from '../datafeed/resolution';
import type { Maybe, Ohlc } from './math';
import type { IndicatorDef, IndicatorInput, PlotKind, PlotSpec } from './registry';

export interface PlotStyle {
  color?: string;
  width?: number;
  /** False hides the plot (TradingView's plot checkbox). */
  visible?: boolean;
  /** Draw it another way: a line as dots, a histogram as a line… */
  kind?: PlotKind;
}

export interface StudyLevelStyle {
  value: number;
  color: string;
  visible?: boolean;
}

export interface StudyStyle {
  plots?: Record<string, PlotStyle>;
  /** Replaces the catalogue's levels when set. */
  levels?: StudyLevelStyle[];
  /** The band / cloud fill (on by default where the study has one). */
  fill?: boolean;
}

/** The settings a study carries next to its inputs (all optional; absent = the catalogue's). */
export interface StudySettings {
  style?: StudyStyle;
  /** Timeframes it shows on — the drawings' tokens (`hours:1-4`, a resolution, `none`); absent = all. */
  visibleOn?: string[];
  /** Computed on this (higher) timeframe's closed bars; absent = the chart's own bars. */
  timeframe?: string;
}

/** A plot as drawn: the catalogue's spec with the study's overrides. */
export function effectivePlot(spec: PlotSpec, style?: StudyStyle): PlotSpec & { visible: boolean } {
  const o = style?.plots?.[spec.key];
  return {
    ...spec,
    color: o?.color ?? spec.color,
    lineWidth: o?.width ?? spec.lineWidth,
    kind: o?.kind ?? spec.kind,
    visible: o?.visible ?? true,
  };
}

// ── Source = another study ──────────────────────────────────────────────────

const STUDY_SOURCE = /^study:([^:]+):(.+)$/;

/** `study:<uid>:<plot>` → its parts; null for a price source (close, hl2…). */
export function parseStudySource(source: unknown): { uid: string; plot: string } | null {
  const m = typeof source === 'string' ? STUDY_SOURCE.exec(source) : null;
  return m ? { uid: m[1], plot: m[2] } : null;
}

export function studySource(uid: string, plot: string): string {
  return `study:${uid}:${plot}`;
}

/**
 * The studies in an order that computes every source before the study reading it. A reference to a study that is
 * gone, or one that would close a loop, is dropped (that study reads `close` again), so a broken chain never stops
 * the chart.
 */
export function studyOrder<T extends { uid: string; params: Record<string, number | string> }>(
  studies: readonly T[],
): { order: T[]; broken: Set<string> } {
  const byUid = new Map(studies.map((s) => [s.uid, s]));
  const order: T[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const broken = new Set<string>();
  const visit = (s: T): void => {
    if (done.has(s.uid)) return;
    if (visiting.has(s.uid)) return;
    visiting.add(s.uid);
    const ref = parseStudySource(s.params['source']);
    if (ref) {
      const dep = byUid.get(ref.uid);
      if (!dep || dep === s || visiting.has(dep.uid)) broken.add(s.uid);
      else visit(dep);
    }
    visiting.delete(s.uid);
    done.add(s.uid);
    order.push(s);
  };
  for (const s of studies) visit(s);
  return { order, broken };
}

/**
 * Bars made of another study's values, for a study computed on them: from the first bar the source has a value, each
 * bar's open/high/low/close the value (a gap holds the last one, as Pine's na-skipping averages do) and its volume
 * the chart's. `offset` is where they start in the chart's bars; the study's results are padded back by it.
 */
export function sourceBars(
  bars: readonly Ohlc[],
  values: readonly Maybe[],
): { offset: number; bars: Ohlc[] } {
  const first = values.findIndex((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (first < 0) return { offset: bars.length, bars: [] };
  const out: Ohlc[] = [];
  let last = values[first] as number;
  for (let i = first; i < bars.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) last = v;
    out.push({
      time: bars[i].time,
      open: last,
      high: last,
      low: last,
      close: last,
      volume: bars[i].volume,
    });
  }
  return { offset: first, bars: out };
}

/** A study's results over `sourceBars` back onto the chart's bars. */
export function padResults(
  results: Record<string, Maybe[]>,
  offset: number,
): Record<string, Maybe[]> {
  if (offset <= 0) return results;
  const pad = new Array<Maybe>(offset).fill(null);
  const out: Record<string, Maybe[]> = {};
  for (const [k, v] of Object.entries(results)) out[k] = k.endsWith(':ahead') ? v : [...pad, ...v];
  return out;
}

// ── Multi-timeframe ─────────────────────────────────────────────────────────

/**
 * A higher timeframe's values onto the chart's bars, on CLOSED bars only: chart bar i (closing at `chartClose[i]`)
 * takes the value of the latest higher-timeframe bar that had closed by then (`htfClose[j] <= chartClose[i]`). An
 * H4 value appears on the H1 bar that closes with it — the fourth — and holds until the next H4 bar closes; the bar
 * still forming is never shown, so nothing repaints.
 */
export function joinClosed(
  chartClose: readonly number[],
  htfClose: readonly number[],
  htfValues: readonly Maybe[],
): Maybe[] {
  const out: Maybe[] = new Array<Maybe>(chartClose.length).fill(null);
  let j = -1;
  for (let i = 0; i < chartClose.length; i++) {
    while (j + 1 < htfClose.length && htfClose[j + 1] <= chartClose[i]) j++;
    out[i] = j >= 0 ? (htfValues[j] ?? null) : null;
  }
  return out;
}

// ── Per-bar colours ─────────────────────────────────────────────────────────

/**
 * Colour each bar of a plot by its value: `rising` green / red by the change from the previous value (Awesome
 * Oscillator), `sign` by its side of zero, `macd` TradingView's four histogram shades (above / below zero, growing /
 * fading), `candle` by the bar's own direction (volume).
 */
export type ColorBy = 'rising' | 'sign' | 'macd' | 'candle';

const UP = '#26A69A';
const DOWN = '#EF5350';

export function plotColors(
  by: ColorBy,
  values: readonly Maybe[],
  bars: readonly Pick<Ohlc, 'open' | 'close'>[],
): (string | undefined)[] {
  return values.map((v, i) => {
    if (v === null || v === undefined) return undefined;
    const prev = i > 0 ? values[i - 1] : null;
    switch (by) {
      case 'sign':
        return v >= 0 ? UP : DOWN;
      case 'candle':
        return bars[i] && bars[i].close < bars[i].open ? DOWN : UP;
      case 'macd': {
        // TradingView's: `hist[1] < hist` is "growing"; on the first bar (no previous) it is not.
        const growing = prev !== null && prev !== undefined && prev < v;
        if (v >= 0) return growing ? UP : '#B2DFDB';
        return growing ? '#FFCDD2' : '#FF5252';
      }
      default:
        // TradingView's AO: `diff <= 0` is red; the first bar (no diff) is green.
        return prev === null || prev === undefined || v > prev ? UP : DOWN;
    }
  });
}

// ── The settings dialog's choices ───────────────────────────────────────────

/** The price sources a `source` input offers (Pine's). */
export const PRICE_SOURCES: readonly string[] = [
  'open',
  'high',
  'low',
  'close',
  'hl2',
  'hlc3',
  'ohlc4',
  'hlcc4',
];

export interface SourceChoice {
  /** A price source, or `study:<uid>:<plot>`. */
  value: string;
  label: string;
}

export interface SourceGroup {
  label: string;
  choices: SourceChoice[];
}

type StudyRef = { uid: string; defId: string; params: Record<string, number | string> };

/**
 * The Source dropdown (DR-16 / DR-I5): the price sources, then the plots of every other study — except those that
 * read this one, directly or through others (choosing one would close a loop), and marker plots (a value per signal,
 * not a series).
 */
export function sourceGroups(
  self: StudyRef,
  studies: readonly StudyRef[],
  describe: (
    s: StudyRef,
  ) => { label: string; plots: readonly Pick<PlotSpec, 'key' | 'title' | 'kind'>[] } | null,
): SourceGroup[] {
  const byUid = new Map(studies.map((s) => [s.uid, s]));
  const readsSelf = (s: StudyRef): boolean => {
    const seen = new Set<string>();
    let cur: StudyRef | undefined = s;
    while (cur && !seen.has(cur.uid)) {
      if (cur.uid === self.uid) return true;
      seen.add(cur.uid);
      const ref = parseStudySource(cur.params['source']);
      cur = ref ? byUid.get(ref.uid) : undefined;
    }
    return false;
  };
  const groups: SourceGroup[] = [
    { label: 'Price', choices: PRICE_SOURCES.map((v) => ({ value: v, label: v })) },
  ];
  for (const s of studies) {
    if (readsSelf(s)) continue;
    const d = describe(s);
    if (!d) continue;
    const choices = d.plots
      .filter((p) => p.kind !== 'markers')
      .map((p) => ({ value: studySource(s.uid, p.key), label: `${d.label}: ${p.title}` }));
    if (choices.length) groups.push({ label: d.label, choices });
  }
  return groups;
}

/**
 * Whether a built-in takes a Timeframe (DR-I5): not the compare studies (another symbol's bars), the session / VWAP
 * / pivot / structure ones (they read the clock or their own periods), those with marker plots (one shape per
 * higher bar would repeat on every chart bar) or values past the last bar (Ichimoku's cloud ahead, the Alligator).
 */
export function mtfCapable(def: IndicatorDef): boolean {
  if (def.needsCompare || def.ahead) return false;
  if (
    def.category === 'Sessions' ||
    def.category === 'Structure' ||
    def.category === 'Multi-symbol'
  )
    return false;
  if (def.plots.some((p) => p.kind === 'markers')) return false;
  if (def.inputs.some((i) => i.type === 'time' || i.type === 'session')) return false;
  return !/vwap|pivot/i.test(def.id);
}

/** The timeframes a study can be computed on: those above the chart's (and the one it has, if not among them). */
export function timeframeChoices(
  resolutions: readonly string[],
  chartResolution: string,
  current?: string,
): string[] {
  const chartMs = resolutionMs(chartResolution) ?? 0;
  const ms = (r: string) => resolutionMs(r) ?? 0;
  const out = resolutions.filter((r) => ms(r) > chartMs);
  if (current && !out.includes(current)) out.push(current);
  return out.sort((a, b) => ms(a) - ms(b));
}

/**
 * An input's typed value as the study keeps it, or null when it is not one (the edit is ignored): text for
 * select / symbol / source / session (DR-16: a source went through `Number` and became NaN), a session as
 * `HHMM-HHMM`, a time as UTC ms (0 = not set), a number within the input's range.
 */
export function parseStudyInput(
  input: IndicatorInput | undefined,
  raw: string,
): number | string | null {
  const text = String(raw ?? '').trim();
  switch (input?.type) {
    case 'select':
      return text && (!input.options || input.options.includes(text)) ? text : null;
    case 'symbol':
      return text ? text.toUpperCase() : null;
    case 'source':
      return PRICE_SOURCES.includes(text) || parseStudySource(text) ? text : null;
    case 'session':
      return sessionText(text);
    case 'time': {
      if (!text) return 0;
      const n = Number(text);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    }
    default: {
      if (!text) return null;
      const n = Number(text);
      if (!Number.isFinite(n)) return null;
      const lo = input?.min ?? -Infinity;
      const hi = input?.max ?? Infinity;
      return Math.min(hi, Math.max(lo, n));
    }
  }
}

/** `HHMM-HHMM` (a colon allowed) as `HHMM-HHMM`; null when it is not one — the rule of `sessions.ts` (not imported:
 * it reads the workspace's zone offsets, and the workspace reads this file). */
function sessionText(text: string): string | null {
  const m = /^(\d{2}):?(\d{2})\s*-\s*(\d{2}):?(\d{2})$/.exec(text);
  if (!m) return null;
  const ok = (h: string, mm: string) => Number(h) <= 24 && Number(mm) < 60;
  return ok(m[1], m[2]) && ok(m[3], m[4]) ? `${m[1]}${m[2]}-${m[3]}${m[4]}` : null;
}

/**
 * Studies copied under new ids (a template applied, a layout duplicated): a source naming a copied study names its
 * copy; one naming a study left behind falls back to `close`.
 */
export function remapStudySources<
  T extends { uid: string; params: Record<string, number | string> },
>(copies: readonly T[], newUidOf: ReadonlyMap<string, string>): T[] {
  return copies.map((s) => {
    const ref = parseStudySource(s.params['source']);
    if (!ref) return s;
    const to = newUidOf.get(ref.uid);
    return { ...s, params: { ...s.params, source: to ? studySource(to, ref.plot) : 'close' } };
  });
}
