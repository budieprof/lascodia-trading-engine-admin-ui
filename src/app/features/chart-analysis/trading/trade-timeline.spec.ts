import { describe, expect, it } from 'vitest';

import type {
  ParityTimelineFill,
  ScriptParityTimeline,
} from '@features/scripting/api/scripting-api.types';

import {
  TIMELINE_COLORS,
  slippageText,
  timelineMarkers,
  timelineSummary,
  timelineWindow,
} from './trade-timeline';

const fill = (over: Partial<ParityTimelineFill>): ParityTimelineFill => ({
  id: 'x',
  source: 'emulator',
  kind: 'entry',
  side: 'buy',
  direction: 'long',
  timeUtc: '2026-10-08T10:00:00Z',
  barTimeUtc: null,
  price: 1.1,
  lots: 1,
  tradeRef: 'emu:1:1',
  entryId: 'Long',
  orderKind: 'Market',
  sessionId: 1,
  accountId: null,
  orderId: null,
  positionId: null,
  signalId: null,
  paperExecutionId: null,
  outcome: null,
  ...over,
});

const timeline = (over: Partial<ScriptParityTimeline> = {}): ScriptParityTimeline => ({
  strategyId: 7,
  symbol: 'EURUSD',
  timeframe: 'H1',
  fromUtc: '2026-09-01T00:00:00Z',
  toUtc: '2026-10-09T00:00:00Z',
  pipSize: 0.0001,
  backtestRunId: 3301,
  truncated: false,
  notes: [],
  fills: [
    fill({ id: 'bt:3:entry', source: 'backtest', timeUtc: '2026-10-08T10:00:00Z' }),
    fill({ id: 'emu:8812', source: 'emulator', timeUtc: '2026-10-08T10:00:01Z' }),
    fill({
      id: 'acct:9001:entry',
      source: 'broker',
      timeUtc: '2026-10-08T10:00:03Z',
      accountId: 17,
    }),
    fill({
      id: 'acct:9001:exit',
      source: 'broker',
      kind: 'exit',
      side: 'sell',
      timeUtc: '2026-10-08T14:00:00Z',
    }),
    fill({
      id: 'pap:4',
      source: 'paper',
      direction: 'short',
      side: 'sell',
      timeUtc: '2026-10-08T12:00:00Z',
    }),
  ],
  pairs: [
    {
      kind: 'entry',
      fromFillId: 'bt:3:entry',
      toFillId: 'emu:8812',
      slippage: 0,
      slippagePips: 0,
      latencyMs: 1000,
    },
    {
      kind: 'entry',
      fromFillId: 'emu:8812',
      toFillId: 'acct:9001:entry',
      slippage: 0.0002,
      slippagePips: 2,
      latencyMs: 2000,
    },
    {
      kind: 'exit',
      fromFillId: 'emu:8813',
      toFillId: 'acct:9001:exit',
      slippage: -0.00004,
      slippagePips: -0.4,
      latencyMs: null,
    },
  ],
  ...over,
});

describe('trade timeline on the chart (BX-1)', () => {
  it('marks slippage worse with + and better with −, nothing when unknown', () => {
    expect(slippageText({ slippage: 0.0002, slippagePips: 2 })).toBe('+2.0p');
    expect(slippageText({ slippage: -0.00004, slippagePips: -0.4 })).toBe('−0.4p');
    expect(slippageText({ slippage: 0, slippagePips: 0 })).toBe('±0.0p');
    expect(slippageText({ slippage: 0.1, slippagePips: null })).toBe('');
  });

  it('draws every source’s entries and exits at their own times with the slippage of their pair', () => {
    const marks = timelineMarkers(timeline(), 'EURUSD');
    expect(marks.map((m) => m.text)).toEqual([
      'BT buy',
      'Live buy ±0.0p',
      'Acct buy +2.0p',
      'Paper sell',
      'Acct exit −0.4p',
    ]);
    const [bt, live, acct, paper, exit] = marks;
    expect(bt).toMatchObject({
      shape: 'square',
      position: 'belowBar',
      color: TIMELINE_COLORS.backtest,
    });
    expect(live).toMatchObject({ shape: 'arrowUp', color: TIMELINE_COLORS.emulator });
    // An account fill 2 pips worse than the session is red; a better exit is not.
    expect(acct.color).toBe(TIMELINE_COLORS.brokerWorse);
    expect(exit).toMatchObject({
      shape: 'circle',
      position: 'aboveBar',
      color: TIMELINE_COLORS.brokerOk,
    });
    expect(paper).toMatchObject({
      shape: 'arrowDown',
      position: 'aboveBar',
      color: TIMELINE_COLORS.paper,
    });
    expect(acct.time).toBe(Date.parse('2026-10-08T10:00:03Z'));
  });

  it('draws nothing for another symbol (a stale reply)', () =>
    expect(timelineMarkers(timeline(), 'GBPUSD')).toEqual([]));

  it('asks from the oldest loaded bar, never more than 366 days back', () => {
    const now = Date.parse('2026-10-09T00:00:00Z');
    expect(timelineWindow(Date.parse('2026-09-01T00:00:00Z'), now)).toEqual({
      fromUtc: '2026-09-01T00:00:00.000Z',
      toUtc: '2026-10-09T00:00:00.000Z',
    });
    const far = timelineWindow(Date.parse('2020-01-01T00:00:00Z'), now);
    expect(now - Date.parse(far.fromUtc)).toBeLessThan(366 * 86_400_000);
    expect(timelineWindow(null, now).fromUtc).toBe(far.fromUtc);
  });

  it('summarises the fills, the pairs and the accounts’ mean slippage', () => {
    expect(timelineSummary(timeline())).toBe('5 fills · 3 compared · mean account slippage +0.8p');
    expect(timelineSummary(timeline({ truncated: true, pairs: [] }))).toBe(
      '5 fills · 0 compared · oldest fills only (5,000 cap)',
    );
  });
});
