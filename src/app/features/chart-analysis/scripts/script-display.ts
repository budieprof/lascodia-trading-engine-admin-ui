import type { ColorTrack } from '@shared/pine-chart/core/color';
import type { DisplayFlags } from '@shared/pine-chart/core/display';
import type { ValueFormat } from '@shared/pine-chart/core/format';
import type { PinePlotStyle } from '@shared/pine-chart/model/pine-outputs.types';
import type {
  BackgroundLayer,
  CandleLayer,
  FillLayer,
  HlineLayer,
  MarkerLayer,
  PaneModel,
  PineRenderModel,
  PlotLayer,
} from '@shared/pine-chart/render/render-model';

/**
 * How one Pine script on the chart is shown — everything its chip's eye and its Settings dialog's
 * Style and Visibility tabs set (PC-01, PC-I4, PC-13). Applied on the client to the run's render
 * model: changing any of it never re-runs the script. Saved with the layout as the fields that
 * differ from the defaults.
 */
export interface ScriptDisplaySettings {
  /** The eye: a hidden script draws nothing; its status line stays, to show it again. */
  visible: boolean;
  /** Strategy fills on the chart (TradingView's "Trades on chart"). */
  showTrades: boolean;
  /**
   * Paint the script's main-pane visuals behind the bars (`behind_chart`); null: as the script
   * declares (Pine's default is behind).
   */
  behindChart: boolean | null;
  /**
   * Decimals of every value it prints — price-scale labels, status line, data window — 0…8; null:
   * as declared, else the symbol's on the price pane and automatic in a pane of its own.
   */
  precision: number | null;
  /** The last-value labels of its plots on the price scale ("Labels on price scale"). */
  labelsOnScale: boolean;
  /** Its values in the status line ("Values in status line"). */
  valuesInStatusLine: boolean;
  /** Its tables over the panes. */
  showTables: boolean;
  /**
   * Keep its tables' text readable (PC-I11): text that reads under 3:1 on its cell (blended over
   * the table and the chart) flips to black or white. Off: the script's colours exactly.
   */
  tableContrast: boolean;
  /** Per-output style by the output's key (`plot:3`, `hline:0`, `fill:1`, `marker:4`, …). */
  outputs: Record<string, OutputStyle>;
  /** The timeframes it shows on (TradingView's Visibility tab); null: all of them. */
  timeframes: TimeframeVisibility | null;
}

/** One output's Style-tab settings; absent fields keep the script's own. */
export interface OutputStyle {
  /** Shown at all (TradingView's checkbox before each output). */
  visible?: boolean;
  /** Colour replacements: the script's colour (CSS) → the operator's. */
  colors?: Record<string, string>;
  /** Plots and hlines: line width, 1…4. */
  lineWidth?: number;
  /** Plots: how it is drawn. */
  plotStyle?: PinePlotStyle;
}

export type TimeframeUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

/** One row of the Visibility tab: shown on these intervals of the unit. */
export interface TimeframeRange {
  on: boolean;
  from: number;
  to: number;
}

/** The Visibility tab; a unit left out shows on all its intervals. */
export type TimeframeVisibility = Partial<Record<TimeframeUnit, TimeframeRange>>;

/** The Visibility tab's rows and their bounds, as TradingView's. */
export const TIMEFRAME_UNITS: readonly { unit: TimeframeUnit; label: string; max: number }[] = [
  { unit: 'minutes', label: 'Minutes', max: 59 },
  { unit: 'hours', label: 'Hours', max: 24 },
  { unit: 'days', label: 'Days', max: 366 },
  { unit: 'weeks', label: 'Weeks', max: 52 },
  { unit: 'months', label: 'Months', max: 12 },
];

export const DEFAULT_DISPLAY: Readonly<ScriptDisplaySettings> = Object.freeze({
  visible: true,
  showTrades: true,
  behindChart: null,
  precision: null,
  labelsOnScale: true,
  valuesInStatusLine: true,
  showTables: true,
  tableContrast: true,
  outputs: {},
  timeframes: null,
});

/** A layout's (or a chip's) partial settings with the defaults for everything it leaves out. */
export function resolveDisplay(
  d: Partial<ScriptDisplaySettings> | null | undefined,
): ScriptDisplaySettings {
  return { ...DEFAULT_DISPLAY, ...(d ?? {}) };
}

/** Only the fields that differ from the defaults: what a layout saves. */
export function displayOverrides(d: ScriptDisplaySettings): Partial<ScriptDisplaySettings> {
  const out: Partial<ScriptDisplaySettings> = {};
  for (const k of Object.keys(DEFAULT_DISPLAY) as (keyof ScriptDisplaySettings)[]) {
    if (JSON.stringify(d[k]) !== JSON.stringify(DEFAULT_DISPLAY[k]))
      (out as Record<string, unknown>)[k] = d[k];
  }
  return out;
}

// ── Visibility tab ────────────────────────────────────────────────────────────────────────────

/** A chart resolution as the Visibility tab counts it: `60` is 1 hour, `1D` 1 day. */
export function timeframeOf(resolution: string): { unit: TimeframeUnit; n: number } | null {
  const m = /^(\d*)([DWM])$/.exec(resolution);
  if (m) {
    const n = m[1] === '' ? 1 : Number(m[1]);
    return { unit: m[2] === 'D' ? 'days' : m[2] === 'W' ? 'weeks' : 'months', n };
  }
  if (!/^\d+$/.test(resolution)) return null;
  const minutes = Number(resolution);
  return minutes % 60 === 0 ? { unit: 'hours', n: minutes / 60 } : { unit: 'minutes', n: minutes };
}

/** Whether the Visibility tab shows the script on `resolution` (always, for one it cannot read). */
export function visibleOnTimeframe(v: TimeframeVisibility | null, resolution: string): boolean {
  if (!v) return true;
  const tf = timeframeOf(resolution);
  const row = tf ? v[tf.unit] : undefined;
  if (!tf || !row) return true;
  return row.on && tf.n >= row.from && tf.n <= row.to;
}

// ── Style tab: what the render model draws ──────────────────────────────────────────────────

/** An output the Style tab lists, with what it draws in now. */
export interface StyleOutput {
  key: string;
  title: string;
  kind: 'plot' | 'candle' | 'marker' | 'hline' | 'fill' | 'background' | 'barcolor';
  /** Its distinct colours (CSS), in the order it first uses them — one swatch each (≤ 8). */
  colors: string[];
  /** Plots and hlines. */
  lineWidth: number | null;
  /** Plots. */
  plotStyle: PinePlotStyle | null;
}

/** At most this many swatches per output: a gradient's hundreds of colours are not a palette. */
const MAX_SWATCHES = 8;

function trackColors(t: ColorTrack): string[] {
  if (!t.indexes) return t.uniform ? [t.uniform] : [];
  return t.palette.slice(1, 1 + MAX_SWATCHES);
}

function distinct(list: readonly (string | null)[]): string[] {
  const out: string[] = [];
  for (const c of list) {
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= MAX_SWATCHES) break;
  }
  return out;
}

/** The outputs of a run's render model the Style tab lists, price pane first. */
export function styleOutputsOf(model: PineRenderModel): StyleOutput[] {
  const out: StyleOutput[] = [];
  for (const pane of [model.panes.main, model.panes.script]) {
    if (!pane) continue;
    for (const s of pane.series)
      out.push(
        s.type === 'plot'
          ? {
              key: s.key,
              title: s.title,
              kind: 'plot',
              colors: trackColors(s.colors),
              lineWidth: s.lineWidth,
              plotStyle: s.style,
            }
          : {
              key: s.key,
              title: s.title,
              kind: 'candle',
              colors: trackColors(s.colors),
              lineWidth: null,
              plotStyle: null,
            },
      );
    for (const m of pane.markers)
      out.push({
        key: m.key,
        title: m.title,
        kind: 'marker',
        colors: distinct(m.colors),
        lineWidth: null,
        plotStyle: null,
      });
    for (const h of pane.hlines)
      out.push({
        key: h.key,
        title: h.title,
        kind: 'hline',
        colors: h.color ? [h.color] : [],
        lineWidth: h.lineWidth,
        plotStyle: null,
      });
    for (const f of pane.fills)
      out.push({
        key: f.key,
        title: f.title,
        kind: 'fill',
        colors: f.gradient ? [] : trackColors(f.colors),
        lineWidth: null,
        plotStyle: null,
      });
    for (const b of pane.backgrounds)
      out.push({
        key: b.key,
        title: b.title,
        kind: 'background',
        colors: trackColors(b.colors),
        lineWidth: null,
        plotStyle: null,
      });
  }
  if (model.bars.colors)
    out.push({
      key: 'barcolor',
      title: 'Bar colour',
      kind: 'barcolor',
      colors: distinct(model.bars.colors),
      lineWidth: null,
      plotStyle: null,
    });
  return out;
}

// ── Applying the settings ────────────────────────────────────────────────────────────────────

/**
 * Decimals for a pane of the script's own whose script declares no format or precision (PC-01):
 * from its values' range — three significant digits of the span (an RSI prints 2 decimals, a
 * MACD on EURUSD 6) — between 2 and 8. A flat pane goes by its magnitude; an empty one, 2.
 */
export function autoPrecision(values: Iterable<number>): number {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) return 2;
  const span = max - min;
  const ref = span > 0 ? span : Math.max(Math.abs(min), Math.abs(max));
  if (!(ref > 0)) return 2;
  return Math.max(2, Math.min(8, Math.ceil(-Math.log10(ref)) + 2));
}

/** Every finite value a pane draws on its scale (plots and plotcandles). */
function* paneValues(pane: PaneModel): Iterable<number> {
  for (const s of pane.series) {
    if (s.type === 'plot') {
      for (let i = 0; i < s.valid.length; i++) yield s.values[s.valid[i]];
    } else {
      for (let i = 0; i < s.close.length; i++) {
        if (s.close[i] === s.close[i]) {
          yield s.high[i];
          yield s.low[i];
        }
      }
    }
  }
}

/**
 * Whether the script declares how its values print (a format or a precision) — on the declaration,
 * or on any of its outputs — in which case its own pane keeps that rather than an automatic one.
 */
export function declaresFormat(model: PineRenderModel, outputs: unknown): boolean {
  const d = model.declaration;
  const named = (f: unknown) => typeof f === 'string' && f !== '' && f.toLowerCase() !== 'inherit';
  if (named(d?.format) || (d?.precision !== null && d?.precision !== undefined)) return true;
  const o = outputs as Record<string, unknown> | null;
  for (const list of ['plots', 'markers', 'candles']) {
    for (const x of (o?.[list] as Record<string, unknown>[] | undefined) ?? []) {
      if (named(x['format']) || (x['precision'] !== null && x['precision'] !== undefined))
        return true;
    }
  }
  return false;
}

const remap = (c: string | null, colors: Record<string, string> | undefined): string | null =>
  c && colors?.[c] ? colors[c] : c;

function remapTrack(t: ColorTrack, colors: Record<string, string> | undefined): ColorTrack {
  if (!colors || !Object.keys(colors).length) return t;
  if (!t.indexes) return { ...t, uniform: remap(t.uniform, colors) };
  return { ...t, palette: t.palette.map((c, i) => (i === 0 ? c : (remap(c, colors) ?? c))) };
}

/** The output's flags with the script-wide toggles and its own checkbox applied. */
function flags(d: DisplayFlags, own: OutputStyle | undefined, s: ScriptDisplaySettings): DisplayFlags {
  const shown = own?.visible !== false;
  return {
    pane: d.pane && shown,
    dataWindow: d.dataWindow,
    priceScale: d.priceScale && shown && s.labelsOnScale,
    statusLine: d.statusLine && shown && s.valuesInStatusLine,
  };
}

const withPrecision = (f: ValueFormat, precision: number | null): ValueFormat =>
  precision === null ? f : { ...f, precision };

/** Plot styles whose histogram base counts toward the pane's scale. */
const BASED = new Set<PinePlotStyle>(['area', 'columns', 'histogram']);

function stylePlot(
  p: PlotLayer,
  own: OutputStyle | undefined,
  s: ScriptDisplaySettings,
  precision: number | null,
): PlotLayer {
  const colors = remapTrack(p.colors, own?.colors);
  const style = own?.plotStyle ?? p.style;
  return {
    ...p,
    display: flags(p.display, own, s),
    colors,
    style,
    includeBaseInScale: BASED.has(style),
    lineWidth: own?.lineWidth ?? p.lineWidth,
    format: withPrecision(p.format, precision),
    last: p.last ? { ...p.last, color: remap(p.last.color, own?.colors) } : null,
  };
}

function styleCandle(
  c: CandleLayer,
  own: OutputStyle | undefined,
  s: ScriptDisplaySettings,
  precision: number | null,
): CandleLayer {
  return {
    ...c,
    display: flags(c.display, own, s),
    colors: remapTrack(c.colors, own?.colors),
    format: withPrecision(c.format, precision),
  };
}

function styleMarker(
  m: MarkerLayer,
  own: OutputStyle | undefined,
  s: ScriptDisplaySettings,
  precision: number | null,
): MarkerLayer {
  const colors = own?.colors;
  return {
    ...m,
    display: flags(m.display, own, s),
    colors: colors ? m.colors.map((c) => remap(c, colors)) : m.colors,
    format: withPrecision(m.format, precision),
  };
}

function styleHline(h: HlineLayer, own: OutputStyle | undefined, s: ScriptDisplaySettings): HlineLayer {
  return {
    ...h,
    display: flags(h.display, own, s),
    color: remap(h.color, own?.colors),
    lineWidth: own?.lineWidth ?? h.lineWidth,
  };
}

function styleFill(f: FillLayer, own: OutputStyle | undefined, s: ScriptDisplaySettings): FillLayer {
  return { ...f, display: flags(f.display, own, s), colors: remapTrack(f.colors, own?.colors) };
}

function styleBackground(
  b: BackgroundLayer,
  own: OutputStyle | undefined,
  s: ScriptDisplaySettings,
): BackgroundLayer {
  return { ...b, display: flags(b.display, own, s), colors: remapTrack(b.colors, own?.colors) };
}

function stylePane(
  pane: PaneModel,
  s: ScriptDisplaySettings,
  precision: number | null,
  plotsByKey: Map<string, PlotLayer>,
): PaneModel {
  const o = s.outputs;
  const series = pane.series.map((x) => {
    if (x.type === 'candle') return styleCandle(x, o[x.key], s, precision);
    const styled = stylePlot(x, o[x.key], s, precision);
    plotsByKey.set(x.key, styled);
    return styled;
  });
  // A fill reads its edges from the plots: they follow the plots' new values objects.
  const fills = pane.fills.map((f) => {
    const styled = styleFill(f, o[f.key], s);
    const edge = (e: FillLayer['upper']): FillLayer['upper'] =>
      e.kind === 'plot' ? { kind: 'plot', layer: plotsByKey.get(e.layer.key) ?? e.layer } : e;
    return { ...styled, upper: edge(styled.upper), lower: edge(styled.lower) };
  });
  return {
    ...pane,
    series,
    fills,
    markers: pane.markers.map((m) => styleMarker(m, o[m.key], s, precision)),
    hlines: pane.hlines.map((h) => styleHline(h, o[h.key], s)),
    backgrounds: pane.backgrounds.map((b) => styleBackground(b, o[b.key], s)),
    tables: s.showTables ? pane.tables : [],
  };
}

/** Whether `s` changes anything the render model draws (fast path: the run's own model). */
function styles(s: ScriptDisplaySettings): boolean {
  return (
    s.precision !== null ||
    !s.labelsOnScale ||
    !s.valuesInStatusLine ||
    !s.showTables ||
    Object.keys(s.outputs).length > 0
  );
}

const styled = new WeakMap<PineRenderModel, Map<string, PineRenderModel>>();

/**
 * The render model with a script's display settings applied (PC-01, PC-I4) — cached per model and
 * settings, so a crosshair move or a re-sync never restyles. `outputs` is the run's raw outputs:
 * whether the script declares its own number format, else a pane of its own prints at an
 * automatic precision.
 */
export function styleRenderModel(
  model: PineRenderModel,
  s: ScriptDisplaySettings,
  outputs: unknown,
): PineRenderModel {
  // The script pane's automatic precision, when the script declares none and the operator set none.
  const auto =
    s.precision === null && model.panes.script && !declaresFormat(model, outputs)
      ? autoPrecision(paneValues(model.panes.script))
      : null;
  if (!styles(s) && auto === null) return model;
  const key = `${JSON.stringify(s)}|${auto ?? ''}`;
  let byKey = styled.get(model);
  const hit = byKey?.get(key);
  if (hit) return hit;
  const plots = new Map<string, PlotLayer>();
  const main = stylePane(model.panes.main, s, s.precision, plots);
  const script = model.panes.script
    ? stylePane(model.panes.script, s, s.precision ?? auto, plots)
    : null;
  const paneFormat = s.precision ?? auto;
  const out: PineRenderModel = {
    ...model,
    bars: { ...model.bars, colors: styleBarColors(model.bars.colors, s) },
    format: paneFormat === null ? model.format : { ...model.format, precision: paneFormat },
    panes: { main, script },
  };
  if (!byKey) {
    byKey = new Map();
    styled.set(model, byKey);
  }
  // A handful of settings per model at most (each edit in the dialog is one).
  if (byKey.size > 16) byKey.clear();
  byKey.set(key, out);
  return out;
}

/** Bar colours (barcolor) with the operator's replacements. */
export function styleBarColors(
  colors: (string | null)[] | null,
  s: ScriptDisplaySettings,
): (string | null)[] | null {
  const own = s.outputs['barcolor'];
  if (!colors) return null;
  if (own?.visible === false) return null;
  const map = own?.colors;
  return map && Object.keys(map).length ? colors.map((c) => remap(c, map)) : colors;
}
