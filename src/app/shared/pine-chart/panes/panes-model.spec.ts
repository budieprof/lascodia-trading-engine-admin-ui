import { describe, expect, it } from 'vitest';
import type { PineLogOutput, PineTraceBar } from '../model/pine-outputs.types';
import { DEFAULT_LOG_FILTER, buildMatcher, filterLogs, type LogFilter } from './logs-filter';
import { formatMicros, heatColor, profilerRows, sortProfilerRows } from './profiler-model';
import { TraceNavigator, traceValueKind, traceWindowAround } from './trace-model';

const T = Date.UTC(2026, 8, 1, 9, 0);
const log = (
  level: string,
  message: string,
  i: number,
  line: number | null = null,
): PineLogOutput => ({
  level,
  message,
  barIndex: i,
  time: T + i * 3_600_000,
  isRealtime: false,
  line,
});

const logs: PineLogOutput[] = [
  log('info', 'Confirmed bar: average: 0.73', 0, 12),
  log('warning', 'Unconfirmed bar: average: 0.41', 1),
  log('error', 'Range is zero; ratio undefined', 2, 14),
  log('info', 'multi\nline message', 3),
  log('info', 'confirmed again', 4),
];
const filter = (p: Partial<LogFilter>): LogFilter => ({
  ...DEFAULT_LOG_FILTER,
  levels: { ...DEFAULT_LOG_FILTER.levels },
  ...p,
});

describe('Pine Logs filtering', () => {
  it('counts levels and filters them out by checkbox', () => {
    const r = filterLogs(logs, filter({ levels: { info: false, warning: true, error: true } }));
    expect(r.counts).toEqual({ info: 3, warning: 1, error: 1 });
    expect(r.rows.map((x) => x.level)).toEqual(['warning', 'error']);
  });

  it('searches case-insensitively by default and highlights the match', () => {
    const r = filterLogs(logs, filter({ query: 'confirmed' }));
    // "Confirmed", "Unconfirmed", "confirmed again": case-insensitive, not whole-word.
    expect(r.rows.map((x) => x.index)).toEqual([0, 1, 4]);
    expect(r.rows[0].segments).toEqual([
      { text: 'Confirmed', match: true },
      { text: ' bar: average: 0.73', match: false },
    ]);
  });

  it('match case and whole word narrow the search as in the Pine Logs pane', () => {
    expect(
      filterLogs(logs, filter({ query: 'Confirmed', matchCase: true })).rows.map((x) => x.index),
    ).toEqual([0]);
    expect(
      filterLogs(logs, filter({ query: 'confirmed', wholeWord: true })).rows.map((x) => x.index),
    ).toEqual([0, 4]);
    // ":" is a word separator: "average" matches as a whole word before it.
    expect(filterLogs(logs, filter({ query: 'average', wholeWord: true })).rows).toHaveLength(2);
  });

  it('supports regular expressions and reports an invalid one', () => {
    const r = filterLogs(logs, filter({ query: 'average:\\s*0\\.[5-9]', regex: true }));
    expect(r.rows.map((x) => x.index)).toEqual([0]);
    const bad = filterLogs(logs, filter({ query: '(unclosed', regex: true }));
    expect(bad.error).toBeTruthy();
    expect(bad.rows).toEqual([]);
    expect(bad.counts.info).toBe(3);
  });

  it('treats special characters literally without the regex option', () => {
    expect(filterLogs(logs, filter({ query: '0.4' })).rows.map((x) => x.index)).toEqual([1]);
    expect(filterLogs(logs, filter({ query: '(' })).rows).toEqual([]);
  });

  it('filters by start time and prefixes rows with the ISO time in the zone', () => {
    const r = filterLogs(logs, filter({ fromTime: T + 2 * 3_600_000 }), 'America/New_York');
    expect(r.rows.map((x) => x.index)).toEqual([2, 3, 4]);
    expect(r.rows[0].timeText).toBe('2026-09-01T07:00:00.000-04:00');
  });

  it('shows the first line of a multi-line message and carries the source line', () => {
    const r = filterLogs(logs, DEFAULT_LOG_FILTER);
    expect(r.rows[3]).toMatchObject({
      multiline: true,
      segments: [{ text: 'multi', match: false }],
    });
    expect(r.rows[0].line).toBe(12);
    expect(r.rows[1].line).toBeNull();
  });

  it('a null matcher means no search', () => {
    expect(
      buildMatcher({ query: '', matchCase: false, wholeWord: false, regex: false }),
    ).toBeNull();
  });
});

describe('trace navigation', () => {
  const trace: PineTraceBar[] = [10, 11, 12, 15].map((bar) => ({
    bar,
    timeMs: T + bar,
    items: [
      {
        line: 9,
        column: 6,
        endLine: 9,
        endColumn: 30,
        text: 'ta.crossover(fast, slow)',
        value: bar === 12 ? 'true' : 'false',
      },
      {
        line: 5,
        column: 8,
        endLine: 5,
        endColumn: 30,
        text: 'ta.ema(close, 9)',
        value: bar === 15 ? 'na' : String(1 + bar / 100),
      },
    ],
  }));
  const nav = new TraceNavigator(trace);

  it('lists items in source order with value kinds and the previous bar value when it changed', () => {
    const rows = nav.rowsAt(12)!;
    expect(rows.map((r) => r.line)).toEqual([5, 9]);
    expect(rows[1]).toMatchObject({ kind: 'true', previous: 'false' });
    expect(rows[0]).toMatchObject({ kind: 'number', previous: '1.11' });
    expect(nav.rowsAt(11)![1].previous).toBeNull(); // unchanged
    expect(nav.rowsAt(15)![0].kind).toBe('na');
    expect(nav.rowsAt(13)).toBeNull();
  });

  it('steps through traced bars, clamped to the window, from any bar', () => {
    expect(nav.step(12, 1)).toBe(15);
    expect(nav.step(12, -5)).toBe(10);
    expect(nav.step(13, 1)).toBe(15); // from the nearest traced bar (12)
    expect(nav.nearest(14)).toBe(15);
    expect(nav.nearest(100)).toBe(15);
    expect(nav.covers(13)).toBe(true);
    expect(nav.covers(16)).toBe(false);
    expect(new TraceNavigator([]).step(3, 1)).toBeNull();
  });

  it('classifies values', () => {
    expect(['true', 'false', 'na', '1.5e-3', '-2', 'EURUSD'].map(traceValueKind)).toEqual([
      'true',
      'false',
      'na',
      'number',
      'number',
      'text',
    ]);
  });

  it('asks for a window centred on a bar', () => {
    expect(traceWindowAround(500, 100)).toEqual({ fromBar: 450, toBar: 549 });
    expect(traceWindowAround(10, 100)).toEqual({ fromBar: 0, toBar: 99 });
  });
});

describe('profiler', () => {
  const profile = [
    { line: 8, executions: 600, totalMicros: 4200 },
    { line: 5, executions: 600, totalMicros: 800 },
    { line: 6, executions: 600, totalMicros: 1000 },
    { line: 12, executions: 20, totalMicros: 600 },
    { line: 5, executions: 0, totalMicros: 200 },
  ];
  const source =
    'l1\nl2\nl3\nl4\nfast = ta.ema(close, 9)\n  slow = ta.ema(close, 21)\nl7\ndev = ta.stdev(close, 20)\n';

  it('merges repeated lines, computes shares, heat and flames on the top three', () => {
    const rows = profilerRows(profile, source);
    expect(rows.map((r) => r.line)).toEqual([5, 6, 8, 12]);
    const five = rows[0];
    expect(five).toMatchObject({
      executions: 600,
      totalMicros: 1000,
      source: 'fast = ta.ema(close, 9)',
    });
    expect(five.avgMicros).toBeCloseTo(1000 / 600);
    expect(rows.reduce((s, r) => s + r.percent, 0)).toBeCloseTo(100);
    expect(rows.find((r) => r.line === 8)).toMatchObject({ heat: 1, flame: 1 });
    expect(
      rows
        .filter((r) => r.flame > 0)
        .map((r) => r.line)
        .sort(),
    ).toEqual([5, 6, 8]);
  });

  it('shows no flames with fewer than four lines', () => {
    expect(profilerRows(profile.slice(0, 2)).every((r) => r.flame === 0)).toBe(true);
  });

  it('sorts by any column', () => {
    const rows = profilerRows(profile);
    expect(sortProfilerRows(rows, { key: 'total', dir: 'desc' }).map((r) => r.line)).toEqual([
      8, 5, 6, 12,
    ]);
    expect(sortProfilerRows(rows, { key: 'executions', dir: 'asc' }).map((r) => r.line)).toEqual([
      12, 5, 6, 8,
    ]);
    expect(sortProfilerRows(rows, { key: 'avg', dir: 'desc' })[0].line).toBe(12);
  });

  it('formats times and heat colors', () => {
    expect([
      formatMicros(5.25),
      formatMicros(812),
      formatMicros(1234),
      formatMicros(2_510_000),
    ]).toEqual(['5.3 µs', '812 µs', '1.23 ms', '2.51 s']);
    expect(heatColor(1)).toBe('hsla(0, 90%, 50%, 0.90)');
    expect(heatColor(0)).toBe('hsla(45, 90%, 50%, 0.25)');
  });
});
