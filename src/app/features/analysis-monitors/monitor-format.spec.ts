import { describe, expect, it } from 'vitest';
import type { AnalysisMonitorDto } from '@core/api/api.types';
import {
  attentionReasons,
  formatAge,
  formatCountdown,
  levelDistance,
  lifeProgress,
  nearestLevel,
  pipSize,
} from './monitor-format';

function mon(over: Partial<AnalysisMonitorDto> = {}): AnalysisMonitorDto {
  return {
    id: 1,
    symbol: 'EURUSD',
    timeframe: 'H1',
    intentText: 'x',
    evaluationMode: 'Deterministic',
    triggerSpecJson: '{}',
    actionSpecJson: '{}',
    status: 'Active',
    recurring: false,
    triggerCount: 0,
    maxTriggers: 1,
    cooldownSeconds: 0,
    createdAtUtc: '2026-11-12T00:00:00',
    expiresAtUtc: '2026-11-13T00:00:00',
    isLive: true,
    secondsSinceLastCheck: 5,
    secondsToExpiry: 40_000,
    ...over,
  };
}

describe('monitor-format', () => {
  it('formats ages and countdowns', () => {
    expect(formatAge(42)).toBe('42s');
    expect(formatAge(3 * 3600 + 14 * 60)).toBe('3h 14m');
    expect(formatAge(2 * 86_400 + 4 * 3600)).toBe('2d 4h');
    expect(formatCountdown(-1)).toBe('overdue');
    expect(formatCountdown(30)).toBe('1m');
  });

  it('measures pips only for FX pairs, JPY in hundredths', () => {
    expect(pipSize('EURUSD', 1.1)).toBe(0.0001);
    expect(pipSize('USDJPYm', 150)).toBe(0.01);
    expect(pipSize('XAUUSD', 4000)).toBeNull();
    expect(levelDistance(1.1, 1.1012, mon())).toBe('+12 pips');
    expect(levelDistance(1.1, 1.09995, mon())).toBe('−0.5 pips');
    expect(levelDistance(4000, 3980, mon({ symbol: 'XAUUSD' }))).toBe('−0.50%');
  });

  it('nearest level prefers what the watch waits for over its breaks and targets', () => {
    const m = mon({
      lastObservedPrice: 1.1,
      levels: [
        { price: 1.1001, kind: 'invalidation', label: 'called off' },
        { price: 1.103, kind: 'trigger', label: 'wakes above' },
      ],
    });
    const p = nearestLevel(m)!;
    expect(p.level.kind).toBe('trigger');
    expect(p.text).toBe('+30 pips');
    expect(p.closeness).toBeCloseTo(0.7, 5);
    expect(nearestLevel(mon({ lastObservedPrice: null, levels: m.levels }))).toBeNull();
  });

  it('life progress stops where a finished watch ended', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(lifeProgress(mon(), now)).toBeCloseTo(0.5, 5);
    expect(lifeProgress(mon({ status: 'Triggered', lastCheckedAtUtc: '2026-11-12T06:00:00' }), now)).toBeCloseTo(0.25, 5);
  });

  it('flags what needs a look and nothing else', () => {
    expect(attentionReasons(mon())).toEqual([]);
    expect(attentionReasons(mon({ secondsSinceLastCheck: 600 }))).toContain('overdue for a check');
    expect(attentionReasons(mon({ awaitingAckSinceUtc: '2026-11-12T00:00:00' }))).toContain('needs acknowledgement');
    expect(attentionReasons(mon({ maxActionTier: 2, dryRunActions: false }))).toContain('acts on live trading');
    // An LLM-judged watch throttled to 10 minutes is not overdue at 15.
    expect(attentionReasons(mon({ evaluationMode: 'LlmAssisted', minEvalIntervalSeconds: 600, secondsSinceLastCheck: 900 }))).toEqual([]);
  });
});
