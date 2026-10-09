import type { ScreenerAlert } from '../api/scripting-api.types';
import { NA, formatDateTime } from '../report/report-format';
import { toCsv } from '../shared/download';
import { MAX_SCREENER_BARS, MAX_SCREENER_SYMBOLS, normalizeScreenerRows } from './screener.model';
import type {
  SaveScreenRequest,
  ScreenFilter,
  ScreenFilterOp,
  ScreenRowDto,
  ScreenRunDto,
  ScreenVerdict,
  ScreenerResultRow,
  ScreenerTimeframeResult,
  ScriptScreenDto,
} from './screens.types';

/**
 * Saved screens and the screener's v2 results (scripting API §6, §6a): the timeframe names, the strategy figures, the
 * grid's column model across timeframes, the filters, and the save request built from the page's form. Pure — the
 * engine decides every match; nothing here guesses one.
 */

/** The screener's timeframes, in the engine's names. */
export const SCREENER_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;
/** At most this many extra timeframes per screen (engine `ScriptScreenerEngine.MaxExtraTimeframes`). */
export const MAX_EXTRA_TIMEFRAMES = 3;
/** At most this many filters per screen (engine `ScreenDefinition.MaxFilters`). */
export const MAX_SCREEN_FILTERS = 20;
export const MAX_SCREEN_NAME = 120;
/** The channels a screen can alert on (engine `ScreenChannels.Supported`). */
export const SCREEN_CHANNELS = ['InApp', 'Telegram', 'Email', 'Webhook'] as const;
export const SCREEN_SEVERITIES = ['Info', 'Medium', 'High', 'Critical'] as const;

const PINE_TO_NAME: Record<string, string> = {
  '1': 'M1',
  '5': 'M5',
  '15': 'M15',
  '60': 'H1',
  '240': 'H4',
  '1D': 'D1',
  D: 'D1',
};

/** "240" → "H4": the engine answers timeframes as Pine strings; the page shows the engine's names when there is one. */
export function timeframeName(tf: string | null | undefined): string {
  const t = (tf ?? '').trim();
  if (!t) return '';
  const upper = t.toUpperCase();
  if ((SCREENER_TIMEFRAMES as readonly string[]).includes(upper)) return upper;
  return PINE_TO_NAME[t] ?? PINE_TO_NAME[upper] ?? t;
}

export function sameTimeframe(a: string | null | undefined, b: string | null | undefined): boolean {
  return timeframeName(a) === timeframeName(b);
}

/** A strategy() script's report figures the screener returns (engine `ScriptScreenerEngine.MetricKeys`). */
export interface MetricColumn {
  key: string;
  label: string;
  kind: 'money' | 'percent' | 'count' | 'ratio' | 'units' | 'r';
}

export const METRIC_COLUMNS: readonly MetricColumn[] = [
  { key: 'netProfit', label: 'Net profit', kind: 'money' },
  { key: 'netProfitPercent', label: 'Net profit %', kind: 'percent' },
  { key: 'closedTrades', label: 'Closed trades', kind: 'count' },
  { key: 'percentProfitable', label: 'Profitable %', kind: 'percent' },
  { key: 'profitFactor', label: 'Profit factor', kind: 'ratio' },
  { key: 'maxDrawdownPercent', label: 'Max drawdown %', kind: 'percent' },
  { key: 'openPnL', label: 'Open P&L', kind: 'money' },
  { key: 'positionSize', label: 'Position size', kind: 'units' },
  { key: 'expectancyR', label: 'Expectancy (R)', kind: 'r' },
  { key: 'rTrades', label: 'Trades with an R', kind: 'count' },
];

const METRIC_BY_KEY = new Map(METRIC_COLUMNS.map((m) => [m.key, m]));

export function metricLabel(key: string): string {
  return METRIC_BY_KEY.get(key)?.label ?? key;
}

/** A strategy figure as the Strategy report shows it. */
export function formatMetric(key: string, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return NA;
  const kind = METRIC_BY_KEY.get(key)?.kind ?? 'ratio';
  const fmt = (min: number, max: number) =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
    }).format(v);
  switch (kind) {
    case 'count':
      return fmt(0, 0);
    case 'percent':
      return `${fmt(2, 2)}%`;
    case 'money':
      return fmt(2, 2);
    case 'r':
      return `${fmt(2, 2)}R`;
    case 'units':
      return fmt(0, 4);
    default:
      return fmt(2, 2);
  }
}

// ── Results ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Either casing of a key (the screener answers camelCase; stored rows may not). */
function pick(o: Json, key: string): unknown {
  if (key in o) return o[key];
  const pascal = key.charAt(0).toUpperCase() + key.slice(1);
  return o[pascal];
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numberMap(v: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (isObject(v)) for (const [k, x] of Object.entries(v)) out[k] = num(x);
  return out;
}

function metricsOf(v: unknown): Record<string, number | null> | null {
  return isObject(v) ? numberMap(v) : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function alertsOf(v: unknown): ScreenerAlert[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).map((a) => ({
    title: typeof pick(a, 'title') === 'string' ? (pick(a, 'title') as string) : '',
    message: typeof pick(a, 'message') === 'string' ? (pick(a, 'message') as string) : '',
    barIndex: num(pick(a, 'barIndex')) ?? -1,
  }));
}

function errorOf(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** The screener's rows with their strategy figures and extra timeframes (§6). */
export function normalizeResultRows(raw: unknown): ScreenerResultRow[] {
  if (!Array.isArray(raw)) return [];
  const objects = raw.filter(isObject);
  const base = normalizeScreenerRows(objects);
  return base.map((row, i) => {
    const o = objects[i];
    const timeframes: ScreenerTimeframeResult[] = Array.isArray(pick(o, 'timeframes'))
      ? (pick(o, 'timeframes') as unknown[]).filter(isObject).map((t) => ({
          timeframe: String(pick(t, 'timeframe') ?? ''),
          lastBarTimeMs: num(pick(t, 'lastBarTimeMs')),
          lastBarForming: pick(t, 'lastBarForming') === true,
          values: numberMap(pick(t, 'values')),
          metrics: metricsOf(pick(t, 'metrics')),
          alerts: alertsOf(pick(t, 'alerts')),
          error: errorOf(pick(t, 'error')),
          notes: strings(pick(t, 'notes')),
        }))
      : [];
    return {
      ...row,
      error: row.error ?? null,
      lastBarForming: pick(o, 'lastBarForming') === true,
      metrics: metricsOf(pick(o, 'metrics')),
      timeframes,
      notes: strings(pick(o, 'notes')),
    };
  });
}

/** A run's rows with the screen's verdicts. */
export function normalizeScreenRows(raw: unknown): ScreenRowDto[] {
  if (!Array.isArray(raw)) return [];
  const objects = raw.filter(isObject);
  const rows = normalizeResultRows(
    objects.map((o) => (isObject(pick(o, 'row')) ? pick(o, 'row') : {})),
  );
  return rows.map((row, i) => {
    const o = objects[i];
    const status = String(pick(o, 'status') ?? 'unknown').toLowerCase();
    return {
      row,
      status: (['matched', 'unmatched', 'unknown'].includes(status)
        ? status
        : 'unknown') as ScreenVerdict,
      reason: errorOf(pick(o, 'reason')),
      entered: pick(o, 'entered') === true,
      left: pick(o, 'left') === true,
    };
  });
}

export function verdictLabel(v: ScreenVerdict | null | undefined): string {
  switch (v) {
    case 'matched':
      return 'Match';
    case 'unmatched':
      return 'No match';
    case 'unknown':
      return 'Unknown';
    default:
      return '';
  }
}

/** One extra timeframe's columns: the plots and strategy figures any row has on it. */
export interface TimeframeColumns {
  /** The timeframe as the engine answers it (the key into a row's `timeframes`). */
  key: string;
  label: string;
  plots: string[];
  metrics: string[];
}

export interface ResultColumns {
  plots: string[];
  metrics: string[];
  timeframes: TimeframeColumns[];
}

function pushNew(list: string[], seen: Set<string>, keys: Iterable<string>): void {
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      list.push(k);
    }
  }
}

function orderedMetrics(present: Set<string>): string[] {
  const known = METRIC_COLUMNS.map((m) => m.key).filter((k) => present.has(k));
  const unknown = [...present].filter((k) => !METRIC_BY_KEY.has(k)).sort();
  return [...known, ...unknown];
}

/** The grid's dynamic columns: plots in first-seen order, figures in the report's order, then each extra timeframe. */
export function resultColumns(rows: readonly ScreenerResultRow[]): ResultColumns {
  const plots: string[] = [];
  const seenPlots = new Set<string>();
  const metricKeys = new Set<string>();
  const tfOrder: string[] = [];
  const tfPlots = new Map<string, { plots: string[]; seen: Set<string>; metrics: Set<string> }>();
  for (const r of rows) {
    pushNew(plots, seenPlots, Object.keys(r.values));
    if (r.metrics) for (const k of Object.keys(r.metrics)) metricKeys.add(k);
    for (const t of r.timeframes) {
      let entry = tfPlots.get(t.timeframe);
      if (!entry) {
        entry = { plots: [], seen: new Set(), metrics: new Set() };
        tfPlots.set(t.timeframe, entry);
        tfOrder.push(t.timeframe);
      }
      pushNew(entry.plots, entry.seen, Object.keys(t.values));
      if (t.metrics) for (const k of Object.keys(t.metrics)) entry.metrics.add(k);
    }
  }
  return {
    plots,
    metrics: orderedMetrics(metricKeys),
    timeframes: tfOrder.map((key) => {
      const e = tfPlots.get(key)!;
      return { key, label: timeframeName(key), plots: e.plots, metrics: orderedMetrics(e.metrics) };
    }),
  };
}

/** A row's results on one extra timeframe (null when it has none there). */
export function onTimeframe(row: ScreenerResultRow, key: string): ScreenerTimeframeResult | null {
  return row.timeframes.find((t) => t.timeframe === key) ?? null;
}

/** "2026-10-09 12:00 (forming)" — the forming bar's values still move. */
export function lastBarLabel(ms: number | null, forming: boolean): string {
  if (ms === null) return NA;
  return forming ? `${formatDateTime(ms)} (forming)` : formatDateTime(ms);
}

/** The error a row shows: its own, else the first extra timeframe that failed. */
export function rowError(row: ScreenerResultRow): string | null {
  if (row.error) return row.error;
  const failed = row.timeframes.find((t) => t.error);
  return failed ? `${timeframeName(failed.timeframe)}: ${failed.error}` : null;
}

/** The CSV export: what the grid shows, one column per plot and figure on each timeframe. */
export function resultsCsv(
  rows: readonly ScreenerResultRow[],
  cols: ResultColumns,
  verdicts?: ReadonlyMap<string, ScreenRowDto> | null,
): string {
  const headers = [
    'Symbol',
    ...(verdicts ? ['Status', 'Status reason', 'Change'] : []),
    'Last bar (UTC)',
    ...cols.plots,
    ...cols.metrics.map(metricLabel),
    ...cols.timeframes.flatMap((t) => [
      ...t.plots.map((p) => `${p} · ${t.label}`),
      ...t.metrics.map((m) => `${metricLabel(m)} · ${t.label}`),
    ]),
    'Alerts',
    'Alert messages',
    'Error',
  ];
  const body = rows.map((r) => {
    const v = verdicts?.get(r.symbol) ?? null;
    return [
      r.symbol,
      ...(verdicts ? [verdictLabel(v?.status), v?.reason ?? '', changeLabel(v)] : []),
      r.lastBarTimeMs === null ? '' : new Date(r.lastBarTimeMs).toISOString(),
      ...cols.plots.map((p) => r.values[p] ?? null),
      ...cols.metrics.map((m) => r.metrics?.[m] ?? null),
      ...cols.timeframes.flatMap((t) => {
        const x = onTimeframe(r, t.key);
        return [
          ...t.plots.map((p) => x?.values[p] ?? null),
          ...t.metrics.map((m) => x?.metrics?.[m] ?? null),
        ];
      }),
      r.alerts.map((a) => a.title || 'alert()').join('; '),
      r.alerts
        .map((a) => a.message)
        .filter(Boolean)
        .join(' | '),
      rowError(r) ?? '',
    ];
  });
  return toCsv(headers, body);
}

/** "Entered" / "Left" / "" — a scheduled run's change for the symbol. */
export function changeLabel(v: ScreenRowDto | null | undefined): string {
  if (!v) return '';
  if (v.entered) return 'Entered';
  if (v.left) return 'Left';
  return '';
}

// ── Filters ──────────────────────────────────────────────────────────────────

export const FILTER_OPS: readonly { op: ScreenFilterOp; label: string }[] = [
  { op: 'gt', label: '>' },
  { op: 'gte', label: '≥' },
  { op: 'lt', label: '<' },
  { op: 'lte', label: '≤' },
  { op: 'eq', label: '=' },
  { op: 'ne', label: '≠' },
  { op: 'between', label: 'between' },
  { op: 'outside', label: 'outside' },
  { op: 'isna', label: 'is na' },
  { op: 'notna', label: 'is not na' },
];

export function opNeedsValue(op: ScreenFilterOp): boolean {
  return op !== 'isna' && op !== 'notna';
}

export function opNeedsRange(op: ScreenFilterOp): boolean {
  return op === 'between' || op === 'outside';
}

export const ALERTS_COLUMN = 'alerts';
export const METRIC_PREFIX = 'metric:';
export const ALERT_PREFIX = 'alert:';

/** What a filter column reads, in words. */
export function columnLabel(column: string): string {
  if (column === ALERTS_COLUMN) return 'Alerts fired (count)';
  if (column.startsWith(METRIC_PREFIX)) return metricLabel(column.slice(METRIC_PREFIX.length));
  if (column.startsWith(ALERT_PREFIX))
    return `Alert “${column.slice(ALERT_PREFIX.length)}” fired (1/0)`;
  return column;
}

export interface FilterColumnOption {
  value: string;
  label: string;
}

/**
 * The columns a filter can read: the plots and alertcondition titles of the results on screen, every strategy figure
 * (a strategy script has them all), and the alert count. A column typed by hand is fine too (the engine reads a plot
 * title as written).
 */
export function filterColumnOptions(
  rows: readonly ScreenerResultRow[],
  isStrategy: boolean,
): FilterColumnOption[] {
  const cols = resultColumns(rows);
  const plots = new Set(cols.plots);
  for (const t of cols.timeframes) for (const p of t.plots) plots.add(p);
  const alertTitles = new Set<string>();
  for (const r of rows) {
    for (const a of r.alerts) if (a.title) alertTitles.add(a.title);
    for (const t of r.timeframes) for (const a of t.alerts) if (a.title) alertTitles.add(a.title);
  }
  const metricKeys =
    isStrategy || cols.metrics.length > 0
      ? METRIC_COLUMNS.map((m) => m.key)
      : [...new Set(cols.timeframes.flatMap((t) => t.metrics))];
  return [
    ...[...plots].map((p) => ({ value: p, label: p })),
    ...metricKeys.map((k) => ({ value: METRIC_PREFIX + k, label: metricLabel(k) })),
    { value: ALERTS_COLUMN, label: columnLabel(ALERTS_COLUMN) },
    ...[...alertTitles].map((t) => ({
      value: ALERT_PREFIX + t,
      label: columnLabel(ALERT_PREFIX + t),
    })),
  ];
}

function fmtValue(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '?' : String(v);
}

/** "RSI on H4 > 70", "Net profit between 0 and 500". */
export function describeFilter(f: ScreenFilter): string {
  const col = columnLabel(f.column || '?');
  const on = f.timeframe ? ` on ${timeframeName(f.timeframe)}` : '';
  const op = FILTER_OPS.find((o) => o.op === f.op)?.label ?? f.op;
  if (!opNeedsValue(f.op)) return `${col}${on} ${op}`;
  if (opNeedsRange(f.op)) return `${col}${on} ${op} ${fmtValue(f.value)} and ${fmtValue(f.value2)}`;
  return `${col}${on} ${op} ${fmtValue(f.value)}`;
}

/** The first problem with the filters (as the engine would word it), or null. */
export function validateFilters(
  filters: readonly ScreenFilter[],
  mainTimeframe: string,
  extras: readonly string[],
): string | null {
  if (filters.length > MAX_SCREEN_FILTERS) {
    return `At most ${MAX_SCREEN_FILTERS} filters (${filters.length} set).`;
  }
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const label = `Filter ${i + 1}`;
    if (!f.column?.trim()) return `${label}: choose a column.`;
    if (
      f.timeframe &&
      !sameTimeframe(f.timeframe, mainTimeframe) &&
      !extras.some((e) => sameTimeframe(e, f.timeframe))
    ) {
      return `${label}: ${timeframeName(f.timeframe)} is not one of the screen's timeframes.`;
    }
    if (!opNeedsValue(f.op)) continue;
    if (f.value === null || f.value === undefined || !Number.isFinite(f.value)) {
      return `${label}: enter a value.`;
    }
    if (opNeedsRange(f.op)) {
      if (f.value2 === null || f.value2 === undefined || !Number.isFinite(f.value2)) {
        return `${label}: enter the upper bound.`;
      }
      if (f.value2 < f.value) return `${label}: the upper bound is below the lower one.`;
    }
  }
  return null;
}

/** The filters as the engine stores them: trimmed, the screen's own timeframe as null, values only where they count. */
export function cleanFilters(
  filters: readonly ScreenFilter[],
  mainTimeframe: string,
): ScreenFilter[] {
  return filters.map((f) => {
    const tf =
      f.timeframe && !sameTimeframe(f.timeframe, mainTimeframe) ? timeframeName(f.timeframe) : null;
    const out: ScreenFilter = { column: f.column.trim(), timeframe: tf, op: f.op };
    if (opNeedsValue(f.op)) out.value = f.value ?? null;
    if (opNeedsRange(f.op)) out.value2 = f.value2 ?? null;
    return out;
  });
}

// ── The save request ─────────────────────────────────────────────────────────

/** Where the screen's script comes from: one of the four. */
export type ScreenScriptRef =
  | { kind: 'strategy'; strategyId: number }
  | { kind: 'chart'; chartScriptId: number }
  | { kind: 'library'; libraryId: number }
  | { kind: 'source'; source: string };

export interface ScreenSettingsDraft {
  name: string;
  filters: ScreenFilter[];
  scheduleEnabled: boolean;
  alertOnEnter: boolean;
  alertOnLeave: boolean;
  channels: string[];
  severity: string;
}

export function emptySettings(): ScreenSettingsDraft {
  return {
    name: '',
    filters: [],
    scheduleEnabled: false,
    alertOnEnter: true,
    alertOnLeave: false,
    channels: ['InApp'],
    severity: 'Medium',
  };
}

export interface ScreenSaveForm {
  script: ScreenScriptRef | null;
  inputs: Record<string, unknown>;
  symbols: readonly string[];
  timeframe: string;
  extraTimeframes: readonly string[];
  lastBars: number | string;
  formingBar: boolean;
  settings: ScreenSettingsDraft;
  refreshSource?: boolean;
}

/** The extra timeframes as sent: distinct, not the screen's own, in the order chosen. */
export function cleanExtras(extras: readonly string[], main: string): string[] {
  const out: string[] = [];
  for (const e of extras) {
    const name = timeframeName(e);
    if (!name || sameTimeframe(name, main) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** The body of a save, or the first reason it cannot be sent. */
export function buildSaveRequest(f: ScreenSaveForm): SaveScreenRequest | string {
  const name = f.settings.name.trim();
  if (!name) return 'Give the screen a name.';
  if (name.length > MAX_SCREEN_NAME)
    return `The name is longer than ${MAX_SCREEN_NAME} characters.`;
  if (!f.script) return 'Choose the script the screen runs.';
  if (f.script.kind === 'source' && !f.script.source.trim())
    return 'Write the script the screen runs.';
  if (f.symbols.length === 0) return 'Choose at least one symbol.';
  if (f.symbols.length > MAX_SCREENER_SYMBOLS) {
    return `Choose at most ${MAX_SCREENER_SYMBOLS} symbols (${f.symbols.length} selected).`;
  }
  if (!f.timeframe) return 'Choose a timeframe.';
  const extras = cleanExtras(f.extraTimeframes, f.timeframe);
  if (extras.length > MAX_EXTRA_TIMEFRAMES) {
    return `Choose at most ${MAX_EXTRA_TIMEFRAMES} extra timeframes.`;
  }
  const bars = Number(f.lastBars);
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_SCREENER_BARS) {
    return `Bars must be a whole number from 1 to ${MAX_SCREENER_BARS}.`;
  }
  const filterProblem = validateFilters(f.settings.filters, f.timeframe, extras);
  if (filterProblem) return filterProblem;
  const alerting = f.settings.alertOnEnter || f.settings.alertOnLeave;
  if (f.settings.scheduleEnabled && alerting && f.settings.filters.length === 0) {
    return 'Alerts need at least one filter: a symbol enters the screen when it passes them, and leaves when it stops.';
  }
  if (f.settings.scheduleEnabled && alerting && f.settings.channels.length === 0) {
    return 'Choose where the alerts go.';
  }
  const req: SaveScreenRequest = {
    name,
    symbols: [...f.symbols].sort(),
    timeframe: f.timeframe,
    timeframes: extras,
    lastBars: bars,
    formingBar: f.formingBar,
    filters: cleanFilters(f.settings.filters, f.timeframe),
    scheduleEnabled: f.settings.scheduleEnabled,
    alertOnEnter: f.settings.alertOnEnter,
    alertOnLeave: f.settings.alertOnLeave,
    channels: [...f.settings.channels],
    severity: f.settings.severity,
  };
  switch (f.script.kind) {
    case 'strategy':
      req.strategyId = f.script.strategyId;
      break;
    case 'chart':
      req.chartScriptId = f.script.chartScriptId;
      break;
    case 'library':
      req.libraryId = f.script.libraryId;
      break;
    default:
      req.source = f.script.source;
  }
  if (f.script.kind !== 'library' && Object.keys(f.inputs).length > 0) req.inputs = { ...f.inputs };
  if (f.refreshSource) req.refreshSource = true;
  return req;
}

/** The page's script mode for a saved screen's origin. */
export function modeOfScreen(
  s: Pick<ScriptScreenDto, 'sourceKind'>,
): 'saved' | 'chart' | 'library' | 'source' {
  switch (s.sourceKind) {
    case 'Strategy':
      return 'saved';
    case 'ChartScript':
      return 'chart';
    case 'Library':
      return 'library';
    default:
      return 'source';
  }
}

/** A saved screen's settings, as the page edits them. */
export function settingsOfScreen(s: ScriptScreenDto): ScreenSettingsDraft {
  return {
    name: s.name,
    filters: (s.filters ?? []).map((f) => ({
      column: f.column,
      timeframe: f.timeframe ? timeframeName(f.timeframe) : null,
      op: f.op,
      value: f.value ?? null,
      value2: f.value2 ?? null,
    })),
    scheduleEnabled: s.scheduleEnabled,
    alertOnEnter: s.alertOnEnter,
    alertOnLeave: s.alertOnLeave,
    channels: [...(s.channels ?? [])],
    severity: s.severity || 'Medium',
  };
}

/** "Strategy · Breakout", "My script · RSI screen", "Written source". */
export function screenSourceText(
  s: Pick<ScriptScreenDto, 'sourceKind' | 'sourceName' | 'sourceId'>,
): string {
  const name = s.sourceName || (s.sourceId ? `#${s.sourceId}` : '');
  switch (s.sourceKind) {
    case 'Strategy':
      return `Strategy · ${name}`;
    case 'ChartScript':
      return `My script · ${name}`;
    case 'Library':
      return `Library · ${name}`;
    default:
      return 'Written source';
  }
}

function isoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** The schedule in words: off, why it stopped, why it does not run now, or when it runs next. */
export function scheduleText(
  s: Pick<ScriptScreenDto, 'scheduleEnabled' | 'statusReason' | 'scheduleNote' | 'nextRunAtUtc'>,
): string {
  if (!s.scheduleEnabled) return s.statusReason ? `Off — ${s.statusReason}` : 'Off';
  if (s.scheduleNote) return `On — ${s.scheduleNote}`;
  const next = isoMs(s.nextRunAtUtc);
  return next === null ? 'On' : `On — next run ${formatDateTime(next)} UTC`;
}

/** "3 matched · 2 entered · 1 left · 1 error" for a run. */
export function runSummary(
  r: Pick<ScreenRunDto, 'symbols' | 'matched' | 'entered' | 'left' | 'errors'>,
): string {
  const parts = [`${r.matched} of ${r.symbols} matched`];
  if (r.entered) parts.push(`${r.entered} entered`);
  if (r.left) parts.push(`${r.left} left`);
  if (r.errors) parts.push(`${r.errors} error${r.errors === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export function isoText(iso: string | null | undefined): string {
  const ms = isoMs(iso);
  return ms === null ? NA : formatDateTime(ms);
}
