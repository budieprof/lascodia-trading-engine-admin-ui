import { describe, expect, it } from 'vitest';

import type { ScriptLiveOutputs } from '../api/scripting-api.types';
import { liveOutputsCaption, liveOutputsChartData, resolveMember } from './live-outputs.model';

const dto = (over: Partial<ScriptLiveOutputs> = {}): ScriptLiveOutputs => ({
  source: 'session',
  symbol: 'EURUSD',
  timeframe: '60',
  barIndex: 2,
  fromBar: 1,
  firstAvailableBar: 0,
  lastBarForming: true,
  bars: [
    { t: Date.UTC(2026, 10, 1, 0), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 },
    { t: Date.UTC(2026, 10, 1, 1), o: 1.5, h: 2, l: 1, c: 1.8, v: 12 },
  ],
  outputs: null,
  ...over,
});

describe('live session outputs (§8a, K2)', () => {
  it('feeds the bars to the Pine chart; no bars → nothing to draw', () => {
    expect(liveOutputsChartData(dto())!.bars).toHaveLength(2);
    expect(liveOutputsChartData(dto({ bars: [] }))).toBeNull();
    expect(liveOutputsChartData(null)).toBeNull();
  });

  it('says what answered: the running session or a snapshot (UTC)', () => {
    expect(liveOutputsCaption(dto())).toBe('EURUSD · 60 · running session · bar 2 (forming)');
    expect(
      liveOutputsCaption(
        dto({ source: 'snapshot', snapshotAtUtc: '2026-11-01T10:00:00', lastBarForming: false }),
      ),
    ).toBe('EURUSD · 60 · last bar-close snapshot of 2026-11-01 10:00 UTC · bar 2');
  });

  it('keeps a member that is still one, else the first; none for a single-symbol strategy', () => {
    expect(resolveMember(['EURUSD', 'GBPUSD'], 'GBPUSD')).toBe('GBPUSD');
    expect(resolveMember(['EURUSD', 'GBPUSD'], 'USDJPY')).toBe('EURUSD');
    expect(resolveMember(['EURUSD', 'GBPUSD'], null)).toBe('EURUSD');
    expect(resolveMember(null, 'EURUSD')).toBeNull();
    expect(resolveMember([], null)).toBeNull();
  });
});
