import { describe, expect, it } from 'vitest';
import { BacktestStatus, type LlmBacktestRunSummary } from '@core/services/llm-backtest.service';
import { pickComparablePair } from './compare-pick.logic';

const run = (over: Partial<LlmBacktestRunSummary>): LlmBacktestRunSummary =>
  ({
    id: 1,
    name: '',
    createdAt: '2026-08-12T00:00:00Z',
    createdBy: null,
    status: BacktestStatus.Completed,
    promptVersion: 'v11.5',
    modelTier: 'Quick',
    totalPoints: 10,
    completedPoints: 10,
    cacheHits: 0,
    estimatedCostUsd: 0,
    actualCostUsd: 0,
    startedAt: null,
    completedAt: null,
    note: null,
    progress: null,
    symbols: ['EURUSD'],
    timeframes: ['H1'],
    windowStartUtc: '2026-05-11T00:00:00Z',
    windowEndUtc: '2026-08-10T00:00:00Z',
    dryRun: false,
    sweepKnob: null,
    sweepValueCount: null,
    sampleCount: 10,
    totalRecommendations: 5,
    viableCount: 3,
    rejectedByGateCount: 2,
    hitRate: 0.5,
    expectedR: 0.1,
    cacheHitRatio: 0,
    ...over,
  }) as LlmBacktestRunSummary;

describe('pickComparablePair', () => {
  it('pairs the newest run with the most similar earlier one', () => {
    const p = pickComparablePair([
      run({ id: 81, createdAt: '2026-08-12T10:00:00Z' }),
      run({ id: 77, createdAt: '2026-08-12T08:00:00Z', symbols: ['EURUSD', 'GBPUSD'] }),
      run({ id: 80, createdAt: '2026-08-12T09:00:00Z' }),
    ]);
    expect(p).toMatchObject({ left: 80, right: 81 });
    expect(p!.reason).toContain('same symbols and timeframes over the same window');
  });

  it('skips failed, cancelled and dry runs', () => {
    expect(
      pickComparablePair([
        run({ id: 3, createdAt: '2026-08-13T00:00:00Z', status: BacktestStatus.Failed }),
        run({ id: 2, createdAt: '2026-08-12T00:00:00Z', dryRun: true }),
        run({ id: 1, createdAt: '2026-08-11T00:00:00Z' }),
      ]),
    ).toBeNull();
  });

  it('a different prompt wins a tie', () => {
    const p = pickComparablePair([
      run({ id: 9, createdAt: '2026-08-12T10:00:00Z' }),
      run({ id: 8, createdAt: '2026-08-12T09:00:00Z' }),
      run({ id: 7, createdAt: '2026-08-12T08:00:00Z', promptVersion: 'v11.3' }),
    ]);
    expect(p).toMatchObject({ left: 7, right: 9 });
  });

  it('accepts the status by name too', () => {
    const p = pickComparablePair([
      run({ id: 2, createdAt: '2026-08-12T10:00:00Z', status: 'Completed' as never }),
      run({ id: 1, createdAt: '2026-08-12T09:00:00Z', status: 'Completed' as never }),
    ]);
    expect(p).toMatchObject({ left: 1, right: 2 });
  });

  it('no overlap → no pair', () => {
    expect(
      pickComparablePair([
        run({ id: 2, createdAt: '2026-08-12T10:00:00Z' }),
        run({ id: 1, createdAt: '2026-08-12T09:00:00Z', symbols: ['USDJPY'] }),
      ]),
    ).toBeNull();
  });
});
