import { describe, expect, it } from 'vitest';

import { screenerCsv } from './screener.model';
import {
  buildSaveRequest,
  cleanExtras,
  cleanFilters,
  describeFilter,
  emptySettings,
  filterColumnOptions,
  formatMetric,
  lastBarLabel,
  modeOfScreen,
  normalizeResultRows,
  normalizeScreenRows,
  resultColumns,
  resultsCsv,
  rowError,
  runSummary,
  scheduleText,
  screenSourceText,
  settingsOfScreen,
  timeframeName,
  validateFilters,
  type ScreenSaveForm,
} from './screens.model';
import type { ScriptScreenDto } from './screens.types';

const H = Date.UTC(2026, 9, 9, 12);

const raw = [
  {
    symbol: 'EURUSD',
    lastBarTimeMs: H,
    lastBarForming: true,
    values: { RSI: 71.5, Basis: 1.1 },
    alerts: [{ title: 'Overbought', message: 'RSI high', barIndex: 199 }],
    metrics: { netProfit: 120.5, closedTrades: 4, profitFactor: 1.8 },
    timeframes: [
      {
        timeframe: '240',
        lastBarTimeMs: H - 3_600_000,
        lastBarForming: false,
        values: { RSI: 64 },
        metrics: { netProfit: 80 },
        alerts: [{ title: 'Trend', message: 'up', barIndex: 99 }],
        error: null,
        notes: [],
      },
    ],
    notes: ['short of intrabars'],
  },
  {
    // A stored row may arrive PascalCase.
    Symbol: 'GBPUSD',
    LastBarTimeMs: null,
    Values: {},
    Alerts: [],
    Error: null,
    Metrics: null,
    Timeframes: [{ Timeframe: '240', Values: {}, Error: 'No candles for GBPUSD H4' }],
  },
];

describe('timeframeName', () => {
  it('shows the engine names for the Pine strings the engine answers with', () => {
    expect(timeframeName('240')).toBe('H4');
    expect(timeframeName('60')).toBe('H1');
    expect(timeframeName('1D')).toBe('D1');
    expect(timeframeName('h4')).toBe('H4');
    expect(timeframeName('1W')).toBe('1W');
    expect(timeframeName(null)).toBe('');
  });
});

describe('normalizeResultRows', () => {
  it('keeps figures, extra timeframes and the forming flag in either casing', () => {
    const rows = normalizeResultRows(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0].lastBarForming).toBe(true);
    expect(rows[0].metrics).toEqual({ netProfit: 120.5, closedTrades: 4, profitFactor: 1.8 });
    expect(rows[0].timeframes[0]).toMatchObject({ timeframe: '240', values: { RSI: 64 } });
    expect(rows[0].notes).toEqual(['short of intrabars']);
    expect(rows[1].symbol).toBe('GBPUSD');
    expect(rows[1].metrics).toBeNull();
    expect(rows[1].timeframes[0].error).toBe('No candles for GBPUSD H4');
    expect(rowError(rows[1])).toBe('H4: No candles for GBPUSD H4');
    expect(normalizeResultRows('nope')).toEqual([]);
  });

  it('reads a run’s verdicts', () => {
    const rows = normalizeScreenRows([
      { row: raw[0], status: 'matched', reason: null, entered: true, left: false },
      { row: raw[1], status: 'weird', reason: 'H4 failed' },
    ]);
    expect(rows[0]).toMatchObject({ status: 'matched', entered: true, left: false });
    expect(rows[0].row.symbol).toBe('EURUSD');
    expect(rows[1]).toMatchObject({ status: 'unknown', reason: 'H4 failed' });
  });
});

describe('resultColumns and the CSV', () => {
  it('lists plots, figures in the report’s order, then each extra timeframe', () => {
    const cols = resultColumns(normalizeResultRows(raw));
    expect(cols.plots).toEqual(['RSI', 'Basis']);
    expect(cols.metrics).toEqual(['netProfit', 'closedTrades', 'profitFactor']);
    expect(cols.timeframes).toEqual([
      { key: '240', label: 'H4', plots: ['RSI'], metrics: ['netProfit'] },
    ]);
  });

  it('exports exactly the v1 columns for a plain run', () => {
    const rows = normalizeResultRows([
      { symbol: 'EURUSD', lastBarTimeMs: null, values: { RSI: 55.5 }, alerts: [] },
    ]);
    const cols = resultColumns(rows);
    expect(resultsCsv(rows, cols)).toBe(screenerCsv(rows, cols.plots));
  });

  it('exports verdicts, figures and timeframe columns', () => {
    const rows = normalizeResultRows(raw);
    const verdicts = new Map(
      normalizeScreenRows([{ row: raw[0], status: 'matched', entered: true }]).map((v) => [
        v.row.symbol,
        v,
      ]),
    );
    const csv = resultsCsv(rows, resultColumns(rows), verdicts);
    const bom = String.fromCharCode(0xfeff);
    const [header, first] = (csv.startsWith(bom) ? csv.slice(1) : csv).split(/\r?\n/);
    expect(header).toBe(
      'Symbol,Status,Status reason,Change,Last bar (UTC),RSI,Basis,Net profit,Closed trades,Profit factor,' +
        'RSI · H4,Net profit · H4,Alerts,Alert messages,Error',
    );
    expect(first.startsWith('EURUSD,Match,,Entered,')).toBe(true);
    expect(first).toContain(',71.5,1.1,120.5,4,1.8,64,80,Overbought,RSI high,');
  });

  it('labels the forming bar', () => {
    expect(lastBarLabel(H, true)).toBe('2026-10-09 12:00 (forming)');
    expect(lastBarLabel(H, false)).toBe('2026-10-09 12:00');
    expect(lastBarLabel(null, true)).toBe('—');
  });

  it('formats figures as the report does', () => {
    expect(formatMetric('closedTrades', 4)).toBe('4');
    expect(formatMetric('percentProfitable', 55.555)).toBe('55.56%');
    expect(formatMetric('expectancyR', 0.4)).toBe('0.40R');
    expect(formatMetric('netProfit', null)).toBe('—');
  });
});

describe('filters', () => {
  it('describes a filter in words', () => {
    expect(describeFilter({ column: 'RSI', timeframe: '240', op: 'gt', value: 70 })).toBe(
      'RSI on H4 > 70',
    );
    expect(
      describeFilter({ column: 'metric:netProfit', op: 'between', value: 0, value2: 500 }),
    ).toBe('Net profit between 0 and 500');
    expect(describeFilter({ column: 'alert:Cross', op: 'eq', value: 1 })).toBe(
      'Alert “Cross” fired (1/0) = 1',
    );
    expect(describeFilter({ column: 'Basis', op: 'isna' })).toBe('Basis is na');
  });

  it('refuses what the engine would refuse', () => {
    expect(validateFilters([{ column: 'RSI', op: 'gt', value: 70 }], 'H1', [])).toBeNull();
    expect(validateFilters([{ column: ' ', op: 'gt', value: 1 }], 'H1', [])).toMatch(/column/);
    expect(validateFilters([{ column: 'RSI', op: 'gt', value: null }], 'H1', [])).toMatch(
      /enter a value/,
    );
    expect(
      validateFilters([{ column: 'RSI', op: 'between', value: 5, value2: 1 }], 'H1', []),
    ).toMatch(/upper bound is below/);
    expect(
      validateFilters([{ column: 'RSI', timeframe: 'H4', op: 'gt', value: 1 }], 'H1', []),
    ).toMatch(/H4 is not one of the screen's timeframes/);
    expect(
      validateFilters([{ column: 'RSI', timeframe: '240', op: 'gt', value: 1 }], 'H1', ['H4']),
    ).toBeNull();
    expect(validateFilters([{ column: 'RSI', op: 'notna' }], 'H1', [])).toBeNull();
  });

  it('sends the screen’s own timeframe as null and drops values that do not count', () => {
    expect(
      cleanFilters(
        [
          { column: ' RSI ', timeframe: 'H1', op: 'gt', value: 70, value2: 99 },
          { column: 'RSI', timeframe: '240', op: 'isna', value: 3 },
        ],
        'H1',
      ),
    ).toEqual([
      { column: 'RSI', timeframe: null, op: 'gt', value: 70 },
      { column: 'RSI', timeframe: 'H4', op: 'isna' },
    ]);
  });

  it('offers the plots, figures, alert count and alert titles on screen', () => {
    const opts = filterColumnOptions(normalizeResultRows(raw), false).map((o) => o.value);
    expect(opts.slice(0, 2)).toEqual(['RSI', 'Basis']);
    expect(opts).toContain('metric:expectancyR');
    expect(opts).toContain('alerts');
    expect(opts).toContain('alert:Overbought');
    expect(opts).toContain('alert:Trend');
    const indicatorOnly = filterColumnOptions(
      normalizeResultRows([{ symbol: 'X', values: { RSI: 1 }, alerts: [] }]),
      false,
    ).map((o) => o.value);
    expect(indicatorOnly.some((v) => v.startsWith('metric:'))).toBe(false);
  });
});

describe('buildSaveRequest', () => {
  const form = (over: Partial<ScreenSaveForm> = {}): ScreenSaveForm => ({
    script: { kind: 'strategy', strategyId: 43 },
    inputs: { in_len: 21 },
    symbols: ['GBPUSD', 'EURUSD'],
    timeframe: 'H1',
    extraTimeframes: ['H4', 'H1', '240', 'D1'],
    lastBars: '300',
    formingBar: false,
    settings: {
      ...emptySettings(),
      name: '  RSI hot  ',
      filters: [{ column: 'RSI', op: 'gt', value: 70 }],
      scheduleEnabled: true,
    },
    ...over,
  });

  it('names the origin by id and sends the whole definition', () => {
    expect(buildSaveRequest(form())).toEqual({
      name: 'RSI hot',
      strategyId: 43,
      inputs: { in_len: 21 },
      symbols: ['EURUSD', 'GBPUSD'],
      timeframe: 'H1',
      timeframes: ['H4', 'D1'],
      lastBars: 300,
      formingBar: false,
      filters: [{ column: 'RSI', timeframe: null, op: 'gt', value: 70 }],
      scheduleEnabled: true,
      alertOnEnter: true,
      alertOnLeave: false,
      channels: ['InApp'],
      severity: 'Medium',
    });
    expect(
      buildSaveRequest(form({ script: { kind: 'chart', chartScriptId: 9 }, refreshSource: true })),
    ).toMatchObject({ chartScriptId: 9, refreshSource: true });
    const lib = buildSaveRequest(form({ script: { kind: 'library', libraryId: 2 } }));
    expect(lib).toMatchObject({ libraryId: 2 });
    expect(lib).not.toHaveProperty('inputs');
    expect(buildSaveRequest(form({ script: { kind: 'source', source: 'x' } }))).toMatchObject({
      source: 'x',
    });
  });

  it('refuses an incomplete definition', () => {
    const settings = form().settings;
    expect(buildSaveRequest(form({ settings: { ...settings, name: ' ' } }))).toMatch(/name/);
    expect(buildSaveRequest(form({ script: null }))).toMatch(/script/);
    expect(buildSaveRequest(form({ symbols: [] }))).toMatch(/at least one symbol/);
    expect(buildSaveRequest(form({ extraTimeframes: ['M1', 'M5', 'M15', 'H4'] }))).toMatch(
      /at most 3 extra/,
    );
    expect(buildSaveRequest(form({ lastBars: 0 }))).toMatch(/1 to 500/);
    expect(buildSaveRequest(form({ settings: { ...settings, filters: [] } }))).toMatch(
      /Alerts need at least one filter/,
    );
    // Without a schedule a screen needs no filter (it is a saved screener).
    expect(
      typeof buildSaveRequest(
        form({ settings: { ...settings, filters: [], scheduleEnabled: false } }),
      ),
    ).toBe('object');
  });

  it('keeps extra timeframes distinct and off the main one', () => {
    expect(cleanExtras(['240', 'H4', 'H1', 'D1'], 'H1')).toEqual(['H4', 'D1']);
  });
});

describe('a saved screen on the page', () => {
  const screen = {
    id: 5,
    name: 'RSI hot',
    sourceKind: 'Strategy',
    sourceId: 43,
    sourceName: 'RSI screen',
    filters: [{ column: 'RSI', timeframe: '240', op: 'gt', value: 70, value2: null }],
    scheduleEnabled: true,
    alertOnEnter: true,
    alertOnLeave: true,
    channels: ['InApp', 'Telegram'],
    severity: 'High',
    statusReason: null,
    scheduleNote: null,
    nextRunAtUtc: '2026-10-09T13:00:00Z',
  } as unknown as ScriptScreenDto;

  it('maps the origin to the page’s mode and the settings to the form', () => {
    expect(modeOfScreen(screen)).toBe('saved');
    expect(modeOfScreen({ sourceKind: 'ChartScript' })).toBe('chart');
    expect(modeOfScreen({ sourceKind: 'Library' })).toBe('library');
    expect(modeOfScreen({ sourceKind: 'Source' })).toBe('source');
    expect(settingsOfScreen(screen)).toEqual({
      name: 'RSI hot',
      filters: [{ column: 'RSI', timeframe: 'H4', op: 'gt', value: 70, value2: null }],
      scheduleEnabled: true,
      alertOnEnter: true,
      alertOnLeave: true,
      channels: ['InApp', 'Telegram'],
      severity: 'High',
    });
    expect(screenSourceText(screen)).toBe('Strategy · RSI screen');
  });

  it('says what the schedule does', () => {
    expect(scheduleText(screen)).toBe('On — next run 2026-10-09 13:00 UTC');
    expect(
      scheduleText({
        ...screen,
        scheduleEnabled: false,
        statusReason: 'The script no longer compiles.',
      }),
    ).toBe('Off — The script no longer compiles.');
    expect(scheduleText({ ...screen, scheduleNote: 'Scheduled screens are switched off.' })).toBe(
      'On — Scheduled screens are switched off.',
    );
    expect(runSummary({ symbols: 10, matched: 3, entered: 2, left: 0, errors: 1 })).toBe(
      '3 of 10 matched · 2 entered · 1 error',
    );
  });
});
