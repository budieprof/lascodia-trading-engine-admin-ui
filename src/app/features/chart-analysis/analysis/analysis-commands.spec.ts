import { describe, expect, it, vi } from 'vitest';

import type { MarketAnalysisResultDto } from '@core/api/api.types';

import type { ChartAlertDto } from '../alerts/chart-alerts.types';
import {
  MAX_READ_BARS,
  analysisCommands,
  proposeProblem,
  readValues,
  type AnalysisCommandHost,
} from './analysis-commands';

const HEADER = [
  'time (UTC)',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'RSI 14 · RSI',
  'My script · signal',
];
const rows = (n: number) => [
  HEADER,
  ...Array.from({ length: n }, (_, i) => [
    new Date(Date.UTC(2026, 9, 9, i)).toISOString(),
    1.1,
    1.2,
    1.0,
    1.1 + i / 1000,
    100,
    50 + i / 3,
    i % 2,
  ]),
];

const ALERT = {
  id: 7,
  symbol: 'EURUSD',
  timeframe: '60',
  kind: 'Price',
  side: 'Bid',
  condition: 'CrossingUp',
  price: 1.15,
  frequency: 'once',
  channels: ['InApp'],
  severity: 'Medium',
  status: 'Active',
  statusReason: null,
  createdAt: '',
  updatedAt: '',
  lastFiredAt: null,
  fireCount: 0,
} as ChartAlertDto;

function host(over: Partial<AnalysisCommandHost> = {}): AnalysisCommandHost {
  return {
    symbol: () => 'EURUSD',
    resolution: () => '60',
    precision: () => 5,
    lastPrice: () => 1.15,
    valueRows: () => rows(30),
    listAlerts: async () => [ALERT, { ...ALERT, id: 8, symbol: 'GBPUSD' }],
    createAlert: async (input) => ({
      ok: true,
      message: 'ok',
      alert: { ...ALERT, ...input, id: 9 } as ChartAlertDto,
    }),
    deleteAlert: async (id) => ({ ok: true, message: `Deleted alert ${id}.` }),
    watchlist: async () => ({ name: 'Majors', symbols: ['EURUSD'], otherLists: [] }),
    addToWatchlist: async (s) => ({ ok: true, message: `Added ${s}` }),
    removeFromWatchlist: async (s) => ({ ok: true, message: `Removed ${s}` }),
    analyse: async () => ({ ok: false, message: 'not used' }),
    proposeTrade: () => undefined,
    ...over,
  };
}

const cmd = (h: AnalysisCommandHost, id: string) => analysisCommands(h).find((c) => c.id === id)!;

describe('analysis-commands (assistant chart tools)', () => {
  it('every write is behind a confirmation card; reads and the ticket fill are not', () => {
    const confirm = Object.fromEntries(
      analysisCommands(host()).map((c) => [c.id, c.confirm === true]),
    );
    expect(confirm).toEqual({
      'chart.readValues': false,
      'chart.alerts.list': false,
      'chart.alerts.create': true,
      'chart.alerts.delete': true,
      'chart.watchlist.list': false,
      'chart.watchlist.add': true,
      'chart.watchlist.remove': true,
      'chart.analyse': true,
      'chart.proposeTrade': false,
    });
  });

  it('chart.readValues returns the last N bars of study and script values, bounded', () => {
    const r = readValues(rows(30), { bars: 3 });
    expect(r.ok).toBe(true);
    const data = r.data as { columns: string[]; rows: unknown[][] };
    expect(data.columns).toEqual(['time (UTC)', 'close', 'RSI 14 · RSI', 'My script · signal']);
    expect(data.rows).toHaveLength(3);
    expect(data.rows[2][0]).toBe(new Date(Date.UTC(2026, 9, 9, 29)).toISOString());

    const filtered = readValues(rows(30), { bars: 500, match: 'rsi' });
    expect((filtered.data as { columns: string[] }).columns).toEqual([
      'time (UTC)',
      'close',
      'RSI 14 · RSI',
    ]);
    expect((filtered.data as { rows: unknown[] }).rows).toHaveLength(30);
    expect(filtered.message).toContain('Only 30 bars are loaded.');
    expect(MAX_READ_BARS).toBe(100);

    expect(readValues([HEADER.slice(0, 6), [1, 1, 1, 1, 1, 1]], {}).message).toMatch(
      /No studies or scripts/,
    );
    expect(readValues(rows(3), { match: 'macd' }).message).toMatch(/No value matches "macd"/);
    expect(readValues(null, {}).ok).toBe(false);
  });

  it('chart.alerts.list keeps to the chart symbol; create sends a once-only in-app price alert', async () => {
    const list = await cmd(host(), 'chart.alerts.list').run({});
    expect((list.data as { id: number }[]).map((a) => a.id)).toEqual([7]);

    const createAlert = vi.fn(host().createAlert);
    const res = await cmd(host({ createAlert }), 'chart.alerts.create').run({
      price: 1.16,
      direction: 'below',
    });
    expect(res.ok).toBe(true);
    expect(createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'EURUSD',
        timeframe: '60',
        kind: 'Price',
        side: 'Bid',
        condition: 'CrossingDown',
        price: 1.16,
        frequency: 'once',
        channels: ['InApp'],
      }),
    );
  });

  it('chart.analyse returns a bounded summary of what the analysis decided', async () => {
    const result: MarketAnalysisResultDto = {
      symbol: 'EURUSD',
      timeframe: 'H1',
      provider: 'p',
      model: 'm',
      llmInvocationId: 5,
      latencyMs: 1,
      analysis: 'x'.repeat(5000),
      completedAt: '',
      recommendation: null,
      recommendations: [
        {
          action: 'Hold',
          entryPrice: null,
          stopLoss: null,
          takeProfit: null,
          confidence: 0.3,
          rationale: '',
        },
      ],
      armedMonitorIds: [44],
    };
    const res = await cmd(
      host({ analyse: async () => ({ ok: true, message: 'done', result }) }),
      'chart.analyse',
    ).run({
      mode: 'spot',
    });
    expect(res.data).toMatchObject({
      analysisId: 5,
      outcome: 'WATCH',
      trades: [],
      holds: 1,
      armedWatchIds: [44],
    });
    expect((res.data as { text: string }).text.length).toBe(1500);
  });

  it('chart.proposeTrade fills the ticket and never submits; wrong-side levels are refused', () => {
    const proposeTrade = vi.fn();
    const ok = cmd(host({ proposeTrade }), 'chart.proposeTrade').run({
      side: 'Sell',
      stop: 1.16,
      target: 1.13,
    });
    expect((ok as { ok: boolean }).ok).toBe(true);
    expect((ok as { message: string }).message).toContain('Nothing has been sent');
    expect(proposeTrade).toHaveBeenCalledWith({
      direction: 'Sell',
      entry: null,
      stop: 1.16,
      target: 1.13,
    });

    const bad = cmd(host({ proposeTrade }), 'chart.proposeTrade').run({ side: 'Buy', stop: 1.16 });
    expect((bad as { ok: boolean }).ok).toBe(false);
    expect(proposeTrade).toHaveBeenCalledTimes(1);
    expect(proposeProblem('Buy', 1.14, 1.13, 1.16, 1.15)).toBeNull();
    expect(proposeProblem('Sell', null, 1.17, 1.16, 1.15)).toMatch(/target must be below/);
  });
});
