import type {
  PineCandleOutput,
  PineColorSeriesOutput,
  PineFillOutput,
  PineMarkerOutput,
  PinePlotOutput,
  PineScriptOutputs,
} from './pine-outputs.types';

/**
 * Folds a Bar Replay frame's `outputsDelta` into the outputs accumulated so far.
 *
 * The engine exports a delta with `OutputCollector.Export(fromBar, toBar)`: per-bar series are cut to
 * the new bar window, while drawings, tables, alerts and logs are exported whole (they are bounded by
 * Pine's object limits). So per-bar arrays are spliced into the union window by bar index — a bar
 * present in both keeps the delta's value, which is how a re-exported forming bar is corrected — and
 * everything exported whole is taken from the delta as the current state.
 */
export function mergeOutputs(
  base: PineScriptOutputs | null,
  delta: PineScriptOutputs | null,
): PineScriptOutputs | null {
  if (!base) return delta;
  if (!delta) return base;
  const bFirst = base.bars.firstIndex;
  const dFirst = delta.bars.firstIndex;
  const bLen = base.bars.times.length;
  const dLen = delta.bars.times.length;
  if (dLen === 0) {
    // Nothing per-bar is new; whole-exported state still is.
    return { ...wholeState(base, delta), bars: base.bars };
  }
  if (bLen === 0) return delta;

  const first = Math.min(bFirst, dFirst);
  const last = Math.max(bFirst + bLen - 1, dFirst + dLen - 1);
  const n = last - first + 1;
  const bShift = bFirst - first;
  const dShift = dFirst - first;

  const times = new Array<number>(n);
  for (let i = 0; i < n; i++) times[i] = NaN;
  for (let i = 0; i < bLen; i++) times[i + bShift] = base.bars.times[i];
  for (let i = 0; i < dLen; i++) times[i + dShift] = delta.bars.times[i];

  const splice = <T>(
    a: readonly T[] | null | undefined,
    b: readonly T[] | null | undefined,
    fill: T,
  ): T[] => {
    const out = new Array<T>(n).fill(fill);
    if (a) for (let i = 0; i < a.length && i < bLen; i++) out[i + bShift] = a[i];
    if (b) for (let i = 0; i < b.length && i < dLen; i++) out[i + dShift] = b[i];
    return out;
  };

  /** Uniform color when both sides agree on one, else a per-bar array. */
  const mergeColors = (
    aColor: string | null | undefined,
    aColors: readonly (string | null)[] | null | undefined,
    bColor: string | null | undefined,
    bColors: readonly (string | null)[] | null | undefined,
  ): { color: string | null; colors: (string | null)[] | null } => {
    if (!aColors && !bColors && (aColor ?? null) === (bColor ?? null)) {
      return { color: aColor ?? null, colors: null };
    }
    const expandA = aColors ?? new Array<string | null>(bLen).fill(aColor ?? null);
    const expandB = bColors ?? new Array<string | null>(dLen).fill(bColor ?? null);
    return { color: null, colors: splice(expandA, expandB, null) };
  };

  const byId = <T extends { id: number }>(items: readonly T[]) =>
    new Map(items.map((x) => [x.id, x]));

  const mergeList = <T extends { id: number }>(
    a: readonly T[],
    b: readonly T[],
    merge: (x: T | undefined, y: T | undefined) => T,
  ): T[] => {
    const am = byId(a);
    const bm = byId(b);
    const ids = [...new Set([...am.keys(), ...bm.keys()])].sort((x, y) => x - y);
    return ids.map((id) => merge(am.get(id), bm.get(id)));
  };

  const plots = mergeList<PinePlotOutput>(base.plots, delta.plots, (a, b) => {
    const src = (b ?? a)!;
    const colors = mergeColors(
      a?.color,
      a ? (a.colors ?? null) : [],
      b?.color,
      b ? (b.colors ?? null) : [],
    );
    return {
      ...src,
      values: splice(a?.values, b?.values, null),
      ...colors,
    };
  });

  const candles = mergeList<PineCandleOutput>(base.candles, delta.candles, (a, b) => {
    const src = (b ?? a)!;
    const colors = mergeColors(
      a?.color,
      a ? (a.colors ?? null) : [],
      b?.color,
      b ? (b.colors ?? null) : [],
    );
    const optional = (
      x: readonly (string | null)[] | null | undefined,
      y: readonly (string | null)[] | null | undefined,
    ) => (x || y ? splice(x ?? null, y ?? null, null) : null);
    return {
      ...src,
      open: splice(a?.open, b?.open, null),
      high: splice(a?.high, b?.high, null),
      low: splice(a?.low, b?.low, null),
      close: splice(a?.close, b?.close, null),
      ...colors,
      wickColors: optional(a?.wickColors, b?.wickColors),
      borderColors: optional(a?.borderColors, b?.borderColors),
    };
  });

  const colorSeries = (
    a: PineColorSeriesOutput | undefined,
    b: PineColorSeriesOutput | undefined,
  ) => ({
    ...(b ?? a)!,
    colors: splice(a?.colors, b?.colors, null),
  });

  const fills = mergeList<PineFillOutput>(base.fills, delta.fills, (a, b) => {
    const src = (b ?? a)!;
    const gradient = src.kind === 'gradient';
    const opt = <T>(
      x: readonly T[] | null | undefined,
      y: readonly T[] | null | undefined,
      fill: T,
    ) => (x || y ? splice(x ?? null, y ?? null, fill) : null);
    const colors = gradient
      ? { color: null, colors: null }
      : mergeColors(a?.color, a ? (a.colors ?? null) : [], b?.color, b ? (b.colors ?? null) : []);
    return {
      ...src,
      ...colors,
      topValues: opt(a?.topValues, b?.topValues, null),
      bottomValues: opt(a?.bottomValues, b?.bottomValues, null),
      topColors: opt(a?.topColors, b?.topColors, null),
      bottomColors: opt(a?.bottomColors, b?.bottomColors, null),
    };
  });

  const markers = mergeList<PineMarkerOutput>(base.markers, delta.markers, (a, b) => {
    const src = (b ?? a)!;
    const dStart = dFirst;
    const dEnd = dFirst + dLen - 1;
    // Keep base points outside the delta's window; the delta is authoritative inside it.
    const kept = (a?.points ?? []).filter((p) => p.barIndex < dStart || p.barIndex > dEnd);
    const points = [...kept, ...(b?.points ?? [])].sort((x, y) => x.barIndex - y.barIndex);
    return { ...src, points };
  });

  return {
    ...wholeState(base, delta),
    schemaVersion: delta.schemaVersion,
    bars: { firstIndex: first, times, timeframe: delta.bars.timeframe || base.bars.timeframe },
    plots,
    markers,
    candles,
    backgrounds: mergeList(base.backgrounds, delta.backgrounds, colorSeries),
    barColors: mergeList(base.barColors, delta.barColors, colorSeries),
    fills,
  };
}

/** Outputs exported whole: the delta's copy is the current state; static definitions keep the base's when the delta has none. */
function wholeState(base: PineScriptOutputs, delta: PineScriptOutputs): PineScriptOutputs {
  return {
    ...base,
    hlines: delta.hlines.length ? delta.hlines : base.hlines,
    alertConditions: delta.alertConditions.length ? delta.alertConditions : base.alertConditions,
    labels: delta.labels,
    lines: delta.lines,
    boxes: delta.boxes,
    polylines: delta.polylines,
    linefills: delta.linefills,
    tables: delta.tables,
    alerts: delta.alerts,
    droppedAlerts: delta.droppedAlerts,
    logs: delta.logs,
    droppedLogs: delta.droppedLogs,
  };
}
