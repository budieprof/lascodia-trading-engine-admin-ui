import { describe, expect, it } from 'vitest';

import {
  alertsSummary,
  formatPlotValue,
  normalizeScreenerRows,
  plotColumns,
  screenerCsv,
  summarize,
  validateScreenerForm,
  type ScreenerForm,
} from './screener.model';

const form: ScreenerForm = {
  mode: 'source',
  source: 'indicator("x")',
  libraryId: null,
  symbols: ['EURUSD'],
  timeframe: 'H1',
  lastBars: 200,
};

describe('validateScreenerForm', () => {
  it('accepts a complete request', () => {
    expect(validateScreenerForm(form)).toBeNull();
    expect(
      validateScreenerForm({ ...form, mode: 'library', source: null, libraryId: 3 }),
    ).toBeNull();
  });

  it('enforces the contract’s limits', () => {
    expect(validateScreenerForm({ ...form, source: ' ' })).toMatch(/Paste a script/);
    expect(validateScreenerForm({ ...form, mode: 'saved', source: null })).toMatch(/saved script/);
    expect(validateScreenerForm({ ...form, mode: 'library', libraryId: null })).toMatch(/library/);
    expect(validateScreenerForm({ ...form, symbols: [] })).toMatch(/at least one symbol/);
    expect(
      validateScreenerForm({ ...form, symbols: Array.from({ length: 201 }, (_, i) => `S${i}`) }),
    ).toMatch(/at most 200/);
    expect(validateScreenerForm({ ...form, lastBars: 501 })).toMatch(/1 to 500/);
    expect(validateScreenerForm({ ...form, lastBars: 0 })).toMatch(/1 to 500/);
    expect(validateScreenerForm({ ...form, lastBars: '12.5' })).toMatch(/whole number/);
  });
});

describe('screener rows', () => {
  const rows = normalizeScreenerRows([
    {
      Symbol: 'EURUSD',
      LastBarTimeMs: Date.UTC(2026, 8, 24, 12),
      Values: { RSI: 71.2345, 'Upper.band': '1.17012' },
      Alerts: [{ Title: 'Overbought', Message: 'RSI high', BarIndex: 199 }],
    },
    {
      symbol: 'GBPUSD',
      lastBarTimeMs: null,
      values: { RSI: 'NaN', Signal: 1 },
      alerts: [],
      error: 'No candles',
    },
  ]);

  it('normalises casing but keeps plot titles exactly as written', () => {
    expect(rows[0]).toEqual({
      symbol: 'EURUSD',
      lastBarTimeMs: Date.UTC(2026, 8, 24, 12),
      values: { RSI: 71.2345, 'Upper.band': 1.17012 },
      alerts: [{ title: 'Overbought', message: 'RSI high', barIndex: 199 }],
      error: null,
    });
    expect(rows[1].values['RSI']).toBeNull();
    expect(rows[1].error).toBe('No candles');
    expect(normalizeScreenerRows(null)).toEqual([]);
  });

  it('derives the plot columns in first-seen order', () => {
    expect(plotColumns(rows)).toEqual(['RSI', 'Upper.band', 'Signal']);
  });

  it('formats plot values and alert summaries', () => {
    expect(formatPlotValue(71.2345)).toBe('71.2345');
    expect(formatPlotValue(1.170123)).toBe('1.1701');
    expect(formatPlotValue(0.000123456)).toBe('0.000123');
    expect(formatPlotValue(12345.678)).toBe('12,345.68');
    expect(formatPlotValue(null)).toBe('—');
    expect(alertsSummary(rows[0].alerts)).toBe('1 — Overbought');
    expect(alertsSummary([])).toBe('');
  });

  it('summarises and exports', () => {
    expect(summarize(rows)).toEqual({ symbols: 2, withAlerts: 1, errors: 1 });
    const csv = screenerCsv(rows, plotColumns(rows));
    const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines[0]).toBe(
      'Symbol,Last bar (UTC),RSI,Upper.band,Signal,Alerts,Alert messages,Error',
    );
    expect(lines[1]).toBe('EURUSD,2026-09-24T12:00:00.000Z,71.2345,1.17012,,Overbought,RSI high,');
    expect(lines[2]).toBe('GBPUSD,,,,1,,,No candles');
  });
});
