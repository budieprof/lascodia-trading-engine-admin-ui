import type {
  PineBar,
  PineBoxOutput,
  PineCandleOutput,
  PineColorSeriesOutput,
  PineCompileResult,
  PineDeclaration,
  PineFillOutput,
  PineHlineOutput,
  PineLabelOutput,
  PineLineOutput,
  PineLinefillOutput,
  PineLogOutput,
  PineMarkerOutput,
  PineOutputX,
  PinePlotOutput,
  PinePolylineOutput,
  PineProfileLine,
  PineReplayFrame,
  PineReplayPosition,
  PineReplayStartResponse,
  PineReportTrade,
  PineRunResult,
  PineRuntimeError,
  PineScriptOutputs,
  PineStrategyReport,
  PineTableCellOutput,
  PineTableOutput,
  PineTraceBar,
} from './pine-outputs.types';

/**
 * Defensive normalisation of engine payloads.
 *
 * The scripting endpoints are built in parallel to this renderer and every stream will extend the
 * payloads additively, so the chart treats each field as optional: arrays default to empty, flags to
 * Pine's defaults, colors to na. Large per-bar arrays are passed through by reference — this runs on
 * every run result and must stay O(outputs), not O(bars × outputs).
 */

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : dflt;
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown, dflt: string): string => (typeof v === 'string' ? v : dflt);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const display = (v: unknown): string[] => {
  const a = arr<unknown>(v).filter((x): x is string => typeof x === 'string');
  return a.length ? a : ['all'];
};
const colorArr = (v: unknown): (string | null)[] | null => (Array.isArray(v) ? (v as (string | null)[]) : null);
const numArr = (v: unknown): (number | null)[] => (Array.isArray(v) ? (v as (number | null)[]) : []);

/** Accepts the §3 `data`, the whole `ResponseData` envelope, or UI-IDE's `ScriptRunResult`. */
export function normalizeRunResult(raw: unknown): PineRunResult | null {
  if (!isObj(raw)) return null;
  // A whole envelope was passed: unwrap it.
  if ('status' in raw && 'data' in raw && isObj(raw['data'])) return normalizeRunResult(raw['data']);
  return {
    compile: normalizeCompile(raw['compile']),
    bars: normalizeBars(raw['bars']),
    outputs: normalizeOutputs(raw['outputs']),
    report: normalizeReport(raw['report']),
    trace: normalizeTrace(raw['trace']),
    profile: arr<Obj>(raw['profile'])
      .filter(isObj)
      .map(
        (p): PineProfileLine => ({
          line: num(p['line'], 0),
          executions: num(p['executions'], 0),
          totalMicros: num(p['totalMicros'], 0),
        }),
      ),
    runtimeError: normalizeRuntimeError(raw['runtimeError']),
    elapsedMs: numOrNull(raw['elapsedMs']),
  };
}

/** A §5 replay frame. */
export function normalizeReplayFrame(raw: unknown): PineReplayFrame {
  const o = isObj(raw) ? raw : {};
  return {
    barIndex: num(o['barIndex'], -1),
    bars: normalizeBars(o['bars']),
    outputsDelta: normalizeOutputs(o['outputsDelta']),
    report: normalizeReport(o['report']),
    position: isObj(o['position']) ? (o['position'] as PineReplayPosition) : null,
  };
}

/** The §5 start response `{ sessionId, frame }`. */
export function normalizeReplayStart(raw: unknown): PineReplayStartResponse | null {
  if (!isObj(raw)) return null;
  const id = raw['sessionId'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  return { sessionId: String(id), frame: normalizeReplayFrame(raw['frame']) };
}

export function normalizeBars(raw: unknown): PineBar[] {
  const bars = arr<unknown>(raw);
  if (bars.length === 0) return [];
  // Fast path: already the wire shape.
  const first = bars[0];
  if (isObj(first) && typeof first['t'] === 'number' && typeof first['c'] === 'number') {
    return bars.filter(
      (b): b is PineBar => isObj(b) && typeof b['t'] === 'number' && typeof b['c'] === 'number',
    );
  }
  // Tolerate { time, open, high, low, close, volume } too.
  return bars.filter(isObj).map((b) => ({
    t: num(b['t'] ?? b['time'], NaN),
    o: num(b['o'] ?? b['open'], NaN),
    h: num(b['h'] ?? b['high'], NaN),
    l: num(b['l'] ?? b['low'], NaN),
    c: num(b['c'] ?? b['close'], NaN),
    v: num(b['v'] ?? b['volume'], 0),
  })).filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c));
}

export function normalizeCompile(raw: unknown): PineCompileResult | null {
  if (!isObj(raw)) return null;
  return {
    ...raw,
    success: bool(raw['success'], true),
    diagnostics: arr<Obj>(raw['diagnostics']).filter(isObj).map((d) => ({
      code: str(d['code'], ''),
      severity: str(d['severity'], 'error'),
      message: str(d['message'], ''),
      line: num(d['line'], 0),
      column: num(d['column'], 0),
      endLine: numOrNull(d['endLine']) ?? undefined,
      endColumn: numOrNull(d['endColumn']) ?? undefined,
    })),
    declaration: normalizeDeclaration(raw['declaration']),
  };
}

export function normalizeDeclaration(raw: unknown): PineDeclaration | null {
  if (!isObj(raw)) return null;
  return {
    ...raw,
    kind: str(raw['kind'], 'indicator'),
    title: str(raw['title'], ''),
    shortTitle: strOrNull(raw['shortTitle']),
    overlay: bool(raw['overlay'], false),
    format: strOrNull(raw['format']),
    precision: numOrNull(raw['precision']),
  };
}

export function normalizeRuntimeError(raw: unknown): PineRuntimeError | null {
  if (!isObj(raw)) return null;
  return {
    code: str(raw['code'], ''),
    message: str(raw['message'], 'Runtime error'),
    line: numOrNull(raw['line']),
    column: numOrNull(raw['column']),
    barIndex: numOrNull(raw['barIndex']),
  };
}

export function normalizeTrace(raw: unknown): PineTraceBar[] {
  return arr<Obj>(raw)
    .filter(isObj)
    .map((t) => ({
      bar: num(t['bar'], 0),
      timeMs: num(t['timeMs'], 0),
      items: arr<Obj>(t['items'])
        .filter(isObj)
        .map((i) => ({
          line: num(i['line'], 0),
          column: num(i['column'], 0),
          endLine: num(i['endLine'], num(i['line'], 0)),
          endColumn: num(i['endColumn'], num(i['column'], 0)),
          text: str(i['text'], ''),
          value: i['value'] === null || i['value'] === undefined ? 'na' : String(i['value']),
        })),
    }))
    .sort((a, b) => a.bar - b.bar);
}

export function normalizeReport(raw: unknown): PineStrategyReport | null {
  if (!isObj(raw)) return null;
  return {
    ...raw,
    meta: isObj(raw['meta']) ? (raw['meta'] as PineStrategyReport['meta']) : null,
    trades: arr<Obj>(raw['trades']).filter(isObj).map(normalizeTrade),
  };
}

function normalizeTrade(t: Obj): PineReportTrade {
  return {
    ...t,
    number: num(t['number'], 0),
    isOpen: bool(t['isOpen'], false),
    direction: str(t['direction'], 'long').toLowerCase(),
    entryId: str(t['entryId'], ''),
    entrySignal: str(t['entrySignal'], str(t['entryId'], '')),
    entryTime: num(t['entryTime'], NaN),
    entryBarIndex: num(t['entryBarIndex'], NaN),
    entryPrice: num(t['entryPrice'], NaN),
    exitId: strOrNull(t['exitId']),
    exitSignal: strOrNull(t['exitSignal']) ?? strOrNull(t['exitId']),
    exitTime: numOrNull(t['exitTime']),
    exitBarIndex: numOrNull(t['exitBarIndex']),
    exitPrice: numOrNull(t['exitPrice']),
    qty: num(t['qty'], 0),
    profit: num(t['profit'], 0),
    profitPercent: numOrNull(t['profitPercent']),
  } as PineReportTrade;
}

export function normalizeOutputs(raw: unknown): PineScriptOutputs | null {
  if (!isObj(raw)) return null;
  const bars = isObj(raw['bars']) ? raw['bars'] : {};
  const base = baseShape;
  return {
    schemaVersion: num(raw['schemaVersion'], 1),
    bars: {
      firstIndex: num(bars['firstIndex'], 0),
      times: arr<number>(bars['times']),
      timeframe: str(bars['timeframe'], ''),
    },
    plots: arr<Obj>(raw['plots']).filter(isObj).map(
      (p): PinePlotOutput => ({
        ...base(p),
        plotNumber: num(p['plotNumber'], 0),
        style: str(p['style'], 'line'),
        lineStyle: str(p['lineStyle'], 'solid'),
        lineWidth: Math.max(1, num(p['lineWidth'], 1)),
        trackPrice: bool(p['trackPrice'], false),
        histBase: num(p['histBase'], 0),
        join: bool(p['join'], false),
        format: strOrNull(p['format']),
        precision: numOrNull(p['precision']),
        color: strOrNull(p['color']),
        colors: colorArr(p['colors']),
        values: numArr(p['values']),
      }),
    ),
    markers: arr<Obj>(raw['markers']).filter(isObj).map(
      (m): PineMarkerOutput => ({
        ...base(m),
        plotNumber: num(m['plotNumber'], 0),
        kind: str(m['kind'], 'shape'),
        shape: strOrNull(m['shape']),
        char: strOrNull(m['char']),
        location: strOrNull(m['location']),
        size: strOrNull(m['size']),
        text: strOrNull(m['text']),
        minHeight: numOrNull(m['minHeight']),
        maxHeight: numOrNull(m['maxHeight']),
        format: strOrNull(m['format']),
        precision: numOrNull(m['precision']),
        points: arr<Obj>(m['points'])
          .filter(isObj)
          .map((pt) => ({
            barIndex: num(pt['barIndex'], NaN),
            time: num(pt['time'], NaN),
            value: numOrNull(pt['value']),
            color: strOrNull(pt['color']),
            textColor: strOrNull(pt['textColor']),
            direction: strOrNull(pt['direction']),
          }))
          .filter((pt) => Number.isFinite(pt.barIndex)),
      }),
    ),
    candles: arr<Obj>(raw['candles']).filter(isObj).map(
      (c): PineCandleOutput => ({
        ...base(c),
        plotNumber: num(c['plotNumber'], 0),
        kind: str(c['kind'], 'candle'),
        format: strOrNull(c['format']),
        precision: numOrNull(c['precision']),
        open: numArr(c['open']),
        high: numArr(c['high']),
        low: numArr(c['low']),
        close: numArr(c['close']),
        color: strOrNull(c['color']),
        colors: colorArr(c['colors']),
        wickColors: colorArr(c['wickColors']),
        borderColors: colorArr(c['borderColors']),
      }),
    ),
    backgrounds: arr<Obj>(raw['backgrounds']).filter(isObj).map(colorSeries),
    barColors: arr<Obj>(raw['barColors']).filter(isObj).map(colorSeries),
    hlines: arr<Obj>(raw['hlines']).filter(isObj).map(
      (h): PineHlineOutput => ({
        id: num(h['id'], 0),
        title: strOrNull(h['title']),
        price: numOrNull(h['price']),
        color: strOrNull(h['color']),
        lineStyle: str(h['lineStyle'], 'dashed'),
        lineWidth: Math.max(1, num(h['lineWidth'], 1)),
        editable: bool(h['editable'], true),
        display: display(h['display']),
      }),
    ),
    fills: arr<Obj>(raw['fills']).filter(isObj).map(
      (f): PineFillOutput => ({
        id: num(f['id'], 0),
        kind: str(f['kind'], 'plots'),
        from: num(f['from'], -1),
        to: num(f['to'], -1),
        title: strOrNull(f['title']),
        editable: bool(f['editable'], true),
        showLast: numOrNull(f['showLast']),
        fillGaps: bool(f['fillGaps'], false),
        display: display(f['display']),
        color: strOrNull(f['color']),
        colors: colorArr(f['colors']),
        topValues: Array.isArray(f['topValues']) ? (f['topValues'] as (number | null)[]) : null,
        bottomValues: Array.isArray(f['bottomValues']) ? (f['bottomValues'] as (number | null)[]) : null,
        topColors: colorArr(f['topColors']),
        bottomColors: colorArr(f['bottomColors']),
      }),
    ),
    labels: arr<Obj>(raw['labels']).filter(isObj).map(
      (l): PineLabelOutput => ({
        id: num(l['id'], 0),
        x: outputX(l['x']),
        y: numOrNull(l['y']),
        xloc: str(l['xloc'], 'bar_index'),
        yloc: str(l['yloc'], 'price'),
        text: str(l['text'], ''),
        color: strOrNull(l['color']),
        style: str(l['style'], 'label_down'),
        textColor: strOrNull(l['textColor']),
        size: strOrNull(l['size']),
        sizePoints: num(l['sizePoints'], 0),
        textAlign: str(l['textAlign'], 'center'),
        tooltip: strOrNull(l['tooltip']),
        fontFamily: str(l['fontFamily'], 'default'),
        bold: bool(l['bold'], false),
        italic: bool(l['italic'], false),
        forceOverlay: bool(l['forceOverlay'], false),
        createdBar: num(l['createdBar'], 0),
      }),
    ),
    lines: arr<Obj>(raw['lines']).filter(isObj).map(
      (l): PineLineOutput => ({
        id: num(l['id'], 0),
        x1: outputX(l['x1']),
        y1: numOrNull(l['y1']),
        x2: outputX(l['x2']),
        y2: numOrNull(l['y2']),
        xloc: str(l['xloc'], 'bar_index'),
        extend: str(l['extend'], 'none'),
        color: strOrNull(l['color']),
        style: str(l['style'], 'solid'),
        width: Math.max(1, num(l['width'], 1)),
        forceOverlay: bool(l['forceOverlay'], false),
        createdBar: num(l['createdBar'], 0),
      }),
    ),
    boxes: arr<Obj>(raw['boxes']).filter(isObj).map(
      (b): PineBoxOutput => ({
        id: num(b['id'], 0),
        left: outputX(b['left']),
        top: numOrNull(b['top']),
        right: outputX(b['right']),
        bottom: numOrNull(b['bottom']),
        xloc: str(b['xloc'], 'bar_index'),
        borderColor: strOrNull(b['borderColor']),
        borderWidth: num(b['borderWidth'], 1),
        borderStyle: str(b['borderStyle'], 'solid'),
        extend: str(b['extend'], 'none'),
        bgColor: strOrNull(b['bgColor']),
        text: str(b['text'], ''),
        textSize: strOrNull(b['textSize']),
        textSizePoints: num(b['textSizePoints'], 0),
        textColor: strOrNull(b['textColor']),
        textHAlign: str(b['textHAlign'], 'center'),
        textVAlign: str(b['textVAlign'], 'center'),
        textWrap: str(b['textWrap'], 'none'),
        fontFamily: str(b['fontFamily'], 'default'),
        bold: bool(b['bold'], false),
        italic: bool(b['italic'], false),
        forceOverlay: bool(b['forceOverlay'], false),
        createdBar: num(b['createdBar'], 0),
      }),
    ),
    polylines: arr<Obj>(raw['polylines']).filter(isObj).map(
      (p): PinePolylineOutput => ({
        id: num(p['id'], 0),
        points: arr<Obj>(p['points'])
          .filter(isObj)
          .map((pt) => ({
            time: numOrNull(pt['time']),
            barIndex: numOrNull(pt['barIndex']),
            price: numOrNull(pt['price']),
          })),
        curved: bool(p['curved'], false),
        closed: bool(p['closed'], false),
        xloc: str(p['xloc'], 'bar_index'),
        lineColor: strOrNull(p['lineColor']),
        fillColor: strOrNull(p['fillColor']),
        lineStyle: str(p['lineStyle'], 'solid'),
        lineWidth: Math.max(1, num(p['lineWidth'], 1)),
        forceOverlay: bool(p['forceOverlay'], false),
        createdBar: num(p['createdBar'], 0),
      }),
    ),
    linefills: arr<Obj>(raw['linefills']).filter(isObj).map(
      (f): PineLinefillOutput => ({
        id: num(f['id'], 0),
        line1: num(f['line1'], -1),
        line2: num(f['line2'], -1),
        color: strOrNull(f['color']),
      }),
    ),
    tables: arr<Obj>(raw['tables']).filter(isObj).map(normalizeTable),
    alertConditions: arr<Obj>(raw['alertConditions']).filter(isObj).map((a) => ({
      id: num(a['id'], 0),
      title: str(a['title'], 'Alert'),
      message: str(a['message'], ''),
    })),
    alerts: arr<Obj>(raw['alerts']).filter(isObj).map((a) => ({
      source: str(a['source'], 'alert'),
      conditionId: numOrNull(a['conditionId']),
      title: strOrNull(a['title']),
      message: str(a['message'], ''),
      frequency: strOrNull(a['frequency']),
      barIndex: num(a['barIndex'], 0),
      barTime: num(a['barTime'], 0),
      time: num(a['time'], 0),
      isRealtime: bool(a['isRealtime'], false),
      isConfirmed: bool(a['isConfirmed'], true),
    })),
    droppedAlerts: num(raw['droppedAlerts'], 0),
    logs: arr<Obj>(raw['logs']).filter(isObj).map(
      (l): PineLogOutput => ({
        level: str(l['level'], 'info').toLowerCase(),
        message: str(l['message'], ''),
        barIndex: num(l['barIndex'], -1),
        time: num(l['time'], 0),
        isRealtime: bool(l['isRealtime'], false),
        line: numOrNull(l['line']),
      }),
    ),
    droppedLogs: num(raw['droppedLogs'], 0),
  };
}

function colorSeries(c: Obj): PineColorSeriesOutput {
  return { ...baseShape(c), colors: colorArr(c['colors']) ?? [] };
}

function baseShape(o: Obj) {
  return {
    id: num(o['id'], 0),
    title: strOrNull(o['title']),
    offset: num(o['offset'], 0),
    editable: bool(o['editable'], true),
    showLast: numOrNull(o['showLast']),
    display: display(o['display']),
    forceOverlay: bool(o['forceOverlay'], false),
  };
}

function outputX(raw: unknown): PineOutputX {
  if (!isObj(raw)) return { value: null, barIndex: null, time: null };
  return {
    value: numOrNull(raw['value']),
    barIndex: numOrNull(raw['barIndex']),
    time: numOrNull(raw['time']),
  };
}

function normalizeTable(t: Obj): PineTableOutput {
  return {
    id: num(t['id'], 0),
    position: str(t['position'], 'top_right'),
    columns: Math.max(0, num(t['columns'], 0)),
    rows: Math.max(0, num(t['rows'], 0)),
    bgColor: strOrNull(t['bgColor']),
    frameColor: strOrNull(t['frameColor']),
    frameWidth: num(t['frameWidth'], 0),
    borderColor: strOrNull(t['borderColor']),
    borderWidth: num(t['borderWidth'], 0),
    forceOverlay: bool(t['forceOverlay'], false),
    cells: arr<Obj>(t['cells'])
      .filter(isObj)
      .map(
        (c): PineTableCellOutput => ({
          column: num(c['column'], 0),
          row: num(c['row'], 0),
          columnSpan: Math.max(1, num(c['columnSpan'], 1)),
          rowSpan: Math.max(1, num(c['rowSpan'], 1)),
          text: str(c['text'], ''),
          width: num(c['width'], 0),
          height: num(c['height'], 0),
          textColor: strOrNull(c['textColor']),
          textHAlign: str(c['textHAlign'], 'center'),
          textVAlign: str(c['textVAlign'], 'center'),
          textSize: strOrNull(c['textSize']),
          textSizePoints: num(c['textSizePoints'], 0),
          bgColor: strOrNull(c['bgColor']),
          tooltip: strOrNull(c['tooltip']),
          fontFamily: str(c['fontFamily'], 'default'),
          bold: bool(c['bold'], false),
          italic: bool(c['italic'], false),
        }),
      ),
  };
}
