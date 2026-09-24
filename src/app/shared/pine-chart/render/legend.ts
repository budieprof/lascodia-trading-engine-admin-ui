import { trackColor } from '../core/color';
import { formatBarTime, formatValue, formatVolume, NA_TEXT, type ValueFormat } from '../core/format';
import type {
  CandleLayer,
  MarkerLayer,
  PaneKey,
  PaneModel,
  PineRenderModel,
  PlotLayer,
} from './render-model';

/** One value in a status line or the data window. */
export interface LegendValue {
  key: string;
  title: string;
  text: string;
  /** The output's color at that bar (null = na, show in the default text color). */
  color: string | null;
}

export interface DataWindowRow {
  label: string;
  value: string;
  color: string | null;
}

export interface DataWindowSection {
  title: string;
  rows: DataWindowRow[];
}

/** The bar a legend describes: the hovered one, else the last bar (TradingView's resting state). */
export function legendLogical(model: PineRenderModel, hovered: number | null): number {
  const last = model.timeline.length - 1;
  if (hovered === null || !Number.isFinite(hovered)) return last;
  return Math.round(hovered);
}

export function plotValueAt(layer: PlotLayer, logical: number): number {
  const slot = logical - layer.start;
  return slot >= 0 && slot < layer.values.length ? layer.values[slot] : NaN;
}

export function plotColorAt(layer: PlotLayer, logical: number): string | null {
  const slot = logical - layer.start;
  const c = trackColor(layer.colors, slot);
  return c ?? layer.last?.color ?? null;
}

/** Index of the marker point exactly at `logical`, or -1. */
export function markerIndexAt(layer: MarkerLayer, logical: number): number {
  const xs = layer.logicals;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = xs[mid];
    if (v === logical) return mid;
    if (v < logical) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function candleText(layer: CandleLayer, logical: number, fmt: ValueFormat): { text: string; color: string | null } {
  const s = logical - layer.start;
  if (s < 0 || s >= layer.open.length || !(layer.close[s] === layer.close[s])) {
    return { text: `O${NA_TEXT} H${NA_TEXT} L${NA_TEXT} C${NA_TEXT}`, color: null };
  }
  const f = (v: number) => formatValue(v, fmt);
  return {
    text: `O${f(layer.open[s])} H${f(layer.high[s])} L${f(layer.low[s])} C${f(layer.close[s])}`,
    color: trackColor(layer.colors, s),
  };
}

/** Values for a pane's status line at a bar. */
export function statusLineValues(pane: PaneModel, logical: number): LegendValue[] {
  const out: LegendValue[] = [];
  const items: Array<{ id: number; value: LegendValue }> = [];
  for (const s of pane.series) {
    if (!s.display.statusLine) continue;
    if (s.type === 'plot') {
      items.push({
        id: s.id,
        value: {
          key: s.key,
          title: s.title,
          text: formatValue(plotValueAt(s, logical), s.format),
          color: plotColorAt(s, logical),
        },
      });
    } else {
      const { text, color } = candleText(s, logical, s.format);
      items.push({ id: s.id, value: { key: s.key, title: s.title, text, color } });
    }
  }
  for (const m of pane.markers) {
    if (!m.display.statusLine) continue;
    // Markers are exported only where drawn: a bar without one says nothing in the status line
    // (the data window still lists it, as ∅), so twenty plotshape() calls do not bury the plots.
    const i = markerIndexAt(m, logical);
    if (i < 0) continue;
    items.push({
      id: m.id,
      value: { key: m.key, title: m.title, text: formatValue(m.values[i], m.format), color: m.colors[i] },
    });
  }
  items.sort((a, b) => a.id - b.id);
  for (const it of items) out.push(it.value);
  return out;
}

/** The data window at a bar: the bar itself, then every output shown in the data window. */
export function dataWindowAt(
  model: PineRenderModel,
  logical: number,
  timeZone = 'UTC',
): DataWindowSection[] {
  const sections: DataWindowSection[] = [];
  const b = model.bars;
  const n = b.time.length;
  const priceFmt: ValueFormat = { format: 'price', precision: model.pricePrecision };
  if (n > 0) {
    const i = Math.max(0, Math.min(n - 1, logical));
    const inRange = logical >= 0 && logical < n;
    const t = inRange ? b.time[i] : model.timeline.timeOfLogical(logical);
    const [date, time] = formatBarTime(t, timeZone).split(' ');
    const rows: DataWindowRow[] = [
      { label: 'Date', value: date ?? '', color: null },
      { label: 'Time', value: time ?? '', color: null },
    ];
    if (inRange) {
      const prev = i > 0 ? b.close[i - 1] : NaN;
      const change = prev === prev && prev !== 0 ? ((b.close[i] - prev) / prev) * 100 : NaN;
      rows.push(
        { label: 'Open', value: formatValue(b.open[i], priceFmt), color: null },
        { label: 'High', value: formatValue(b.high[i], priceFmt), color: null },
        { label: 'Low', value: formatValue(b.low[i], priceFmt), color: null },
        { label: 'Close', value: formatValue(b.close[i], priceFmt), color: null },
        { label: 'Change', value: change === change ? `${change.toFixed(2)}%` : NA_TEXT, color: null },
        { label: 'Volume', value: formatVolume(b.volume[i]), color: null },
      );
    }
    sections.push({ title: 'Bar', rows });
  }

  const rows: Array<{ id: number; rows: DataWindowRow[] }> = [];
  for (const pane of [model.panes.main, model.panes.script]) {
    if (!pane) continue;
    for (const s of pane.series) {
      if (!s.display.dataWindow) continue;
      if (s.type === 'plot') {
        rows.push({
          id: s.id,
          rows: [
            {
              label: s.title,
              value: formatValue(plotValueAt(s, logical), s.format),
              color: plotColorAt(s, logical),
            },
          ],
        });
      } else {
        const slot = logical - s.start;
        const has = slot >= 0 && slot < s.open.length && s.close[slot] === s.close[slot];
        const v = (arr: Float64Array) => (has ? formatValue(arr[slot], s.format) : NA_TEXT);
        const color = has ? trackColor(s.colors, slot) : null;
        rows.push({
          id: s.id,
          rows: [
            { label: `${s.title} (open)`, value: v(s.open), color },
            { label: `${s.title} (high)`, value: v(s.high), color },
            { label: `${s.title} (low)`, value: v(s.low), color },
            { label: `${s.title} (close)`, value: v(s.close), color },
          ],
        });
      }
    }
    for (const m of pane.markers) {
      if (!m.display.dataWindow) continue;
      const i = markerIndexAt(m, logical);
      rows.push({
        id: m.id,
        rows: [
          {
            label: m.title,
            value: i >= 0 ? formatValue(m.values[i], m.format) : NA_TEXT,
            color: i >= 0 ? m.colors[i] : null,
          },
        ],
      });
    }
  }
  rows.sort((a, b) => a.id - b.id);
  const flat = rows.flatMap((r) => r.rows);
  if (flat.length) sections.push({ title: model.title, rows: flat });
  return sections;
}

/** Status-line groups per pane (main first). */
export function statusLines(
  model: PineRenderModel,
  logical: number,
): Array<{ pane: PaneKey; values: LegendValue[] }> {
  const out: Array<{ pane: PaneKey; values: LegendValue[] }> = [
    { pane: 'main', values: statusLineValues(model.panes.main, logical) },
  ];
  if (model.panes.script) out.push({ pane: 'script', values: statusLineValues(model.panes.script, logical) });
  return out;
}
