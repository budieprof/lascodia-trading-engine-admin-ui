import { describe, expect, it } from 'vitest';

import type { MarketAnalysisResultDto } from '@core/api/api.types';

import {
  analysisOutcome,
  analysisTimeframe,
  planLines,
  stepChange,
  watchLines,
  watchMarkers,
  watchTimeframe,
} from './analysis-overlay';
import type { ChartAnalysisMonitors, ChartMonitor } from './chart-analysis.types';

const result = (over: Partial<MarketAnalysisResultDto>): MarketAnalysisResultDto => ({
  symbol: 'EURUSD',
  timeframe: 'H1',
  provider: 'p',
  model: 'm',
  llmInvocationId: 37445,
  latencyMs: 1,
  analysis: '',
  completedAt: '2026-10-09T10:00:00Z',
  recommendation: null,
  ...over,
});

const monitor = (over: Partial<ChartMonitor>): ChartMonitor => ({
  id: 1188,
  status: 'Active',
  origin: 'spot-watch',
  timeframe: 'H1',
  intentText: 'x',
  createdAtUtc: '2026-10-09T08:00:00Z',
  expiresAtUtc: '2026-10-10T08:00:00Z',
  isStructureWatch: false,
  levels: [],
  ...over,
});

describe('analysis-overlay', () => {
  it('analyses on the longest engine timeframe not longer than the chart bar', () => {
    expect(analysisTimeframe('1')).toBe('M1');
    expect(analysisTimeframe('30')).toBe('M15');
    expect(analysisTimeframe('60')).toBe('H1');
    expect(analysisTimeframe('120')).toBe('H1');
    expect(analysisTimeframe('240')).toBe('H4');
    expect(analysisTimeframe('1W')).toBe('D1');
    expect(analysisTimeframe('nonsense')).toBe('H1');
    expect(watchTimeframe('5')).toBe('M15');
    expect(watchTimeframe('1D')).toBe('H4');
    expect(watchTimeframe('60')).toBe('H1');
  });

  it('names the outcome: a trade, a watch, or standing aside', () => {
    const buy = { action: 'Buy' as const, entryPrice: 1.15, stopLoss: 1.14, takeProfit: 1.17, confidence: 0.6, rationale: '' };
    const hold = { ...buy, action: 'Hold' as const };
    expect(analysisOutcome(result({ recommendations: [buy] }))).toBe('TRADE NOW');
    expect(analysisOutcome(result({ recommendations: [hold], armedMonitorIds: [5] }))).toBe('WATCH');
    expect(analysisOutcome(result({ recommendations: [hold] }))).toBe('STAND ASIDE');
  });

  it('draws each proposed trade with the analysis id; holds draw nothing', () => {
    const lines = planLines(
      result({
        recommendations: [
          { action: 'Sell', entryPrice: 1.15, stopLoss: 1.16, takeProfit: 1.13, confidence: 0.6, rationale: '' },
          { action: 'Hold', entryPrice: 1.2, stopLoss: 1.1, takeProfit: 1.3, confidence: 0.2, rationale: '' },
        ],
      }),
    );
    expect(lines.map((l) => [l.label, l.price])).toEqual([
      ['#37445 Sell entry', 1.15],
      ['#37445 Sell stop — idea wrong here', 1.16],
      ['#37445 Sell target', 1.13],
    ]);
  });

  it('draws only live watches, tagging the ones the shown analysis armed', () => {
    const data: ChartAnalysisMonitors = {
      symbol: 'EURUSD',
      monitorsTruncated: false,
      eventsTruncated: false,
      events: [],
      monitors: [
        monitor({
          anchorLlmInvocationId: 37445,
          isStructureWatch: true,
          levels: [
            { price: 1.1495, kind: 'trigger', label: 'wakes when price goes above' },
            { price: 1.142, kind: 'invalidation', label: 'called off if a candle closes below' },
          ],
        }),
        monitor({ id: 9, status: 'Expired', levels: [{ price: 1.2, kind: 'trigger', label: 'x' }] }),
      ],
    };
    const lines = watchLines(data, 37445);
    expect(lines.map((l) => l.label)).toEqual([
      'Structure Watch W1188 (#37445): wakes when price goes above',
      'Structure Watch W1188 (#37445): called off if a candle closes below',
    ]);
    expect(lines.every((l) => l.dashed)).toBe(true);
  });

  it('places fires, touches, call-offs and script steps as markers', () => {
    const data: ChartAnalysisMonitors = {
      symbol: 'EURUSD',
      monitorsTruncated: false,
      eventsTruncated: false,
      monitors: [],
      events: [
        { monitorId: 7, kind: 'ScriptStep', occurredAtUtc: '2026-10-09T09:00:00Z', fired: false, note: '10-09 09:00Z step 0→1 close 1.149' },
        { monitorId: 7, kind: 'Fired', occurredAtUtc: '2026-10-09T10:00:00Z', fired: true },
        { monitorId: 7, kind: 'Invalidated', occurredAtUtc: '2026-10-09T11:00:00Z', fired: false },
        { monitorId: 7, kind: 'Evaluated', occurredAtUtc: '2026-10-09T11:00:00Z', fired: false },
      ],
    };
    const markers = watchMarkers(data);
    expect(markers.map((m) => [m.text, m.shape, m.time])).toEqual([
      ['W7 step 0→1', 'circle', Date.parse('2026-10-09T09:00:00Z')],
      ['W7 fired', 'arrowDown', Date.parse('2026-10-09T10:00:00Z')],
      ['W7 called off', 'square', Date.parse('2026-10-09T11:00:00Z')],
    ]);
    expect(stepChange('no step here')).toBeNull();
  });
});
