import { describe, expect, it } from 'vitest';

import {
  classifyFailure,
  dailyActivity,
  failureReasons,
  runOutcome,
  symbolOutcomes,
  type TrainingRunLike,
} from './training-lab.logic';

const run = (p: Partial<TrainingRunLike> & { id: number }): TrainingRunLike => ({
  symbol: 'EURUSD',
  status: 'Failed',
  errorMessage: null,
  startedAt: '2026-11-08T10:00:00Z',
  ...p,
});

describe('training lab logic', () => {
  it('classifies the engine failure messages seen in production', () => {
    expect(
      classifyFailure(
        '[Permanently failed after 3 attempt(s)] Training sample count 412 below minimum 500. Expand the training window (MLTraining:T',
      ).title,
    ).toBe('Too few training samples');
    expect(
      classifyFailure(
        '[Permanently failed after 1 attempt(s)] Label imbalance out of bounds: buy fraction 71.2 % outside [30 %, 70 %]',
      ).title,
    ).toBe('Buy/sell labels too one-sided');
    expect(classifyFailure('Insufficient candles: 120 (need 530)').title).toBe(
      'Not enough candle history',
    );
    expect(
      classifyFailure(
        'Quality gate failed: no skill over base rate: walk-forward accuracy 56.0 % < majority-class baseline 56.2 % + margin 2.0 %',
      ).title,
    ).toBe('Quality gate: no edge over the base rate');
    expect(classifyFailure('Quality gate failed: brier 0.27 > 0.25').title).toBe(
      'Quality gate: poorly calibrated (Brier)',
    );
    expect(
      classifyFailure(
        '[Permanently failed after 2 attempt(s)] 57014: canceling statement due to user request',
      ).title,
    ).toBe('Database query timed out');
    expect(classifyFailure(null).title).toBe('No error recorded');
  });

  it('masks numbers in unknown messages so similar ones group together', () => {
    expect(classifyFailure('Worker 12 crashed: boom').title).toBe('Worker N crashed');
    expect(classifyFailure('Worker 7 crashed: other').title).toBe('Worker N crashed');
  });

  it('groups failed runs by cause, most frequent first, with the newest example', () => {
    const rows = failureReasons([
      run({
        id: 1,
        errorMessage: 'Insufficient candles: 1 (need 2)',
        startedAt: '2026-11-01T00:00:00Z',
      }),
      run({
        id: 2,
        errorMessage: 'Insufficient candles: 3 (need 4)',
        startedAt: '2026-11-05T00:00:00Z',
      }),
      run({ id: 3, errorMessage: 'Quality gate failed: brier 0.3 > 0.25' }),
      run({ id: 4, status: 'Completed', errorMessage: 'Insufficient candles: 9 (need 9)' }),
    ]);
    expect(rows.map((r) => [r.title, r.count, r.latestRunId])).toEqual([
      ['Not enough candle history', 2, 2],
      ['Quality gate: poorly calibrated (Brier)', 1, 3],
    ]);
    expect(rows[0].share).toBeCloseTo(66.67, 1);
  });

  it('rolls outcomes up per symbol', () => {
    const rows = symbolOutcomes([
      run({ id: 1, symbol: 'GBPUSD', status: 'Completed' }),
      run({ id: 2, symbol: 'GBPUSD', status: 'Failed' }),
      run({ id: 3, symbol: 'GBPUSD', status: 'Cancelled', startedAt: '2026-11-09T00:00:00Z' }),
      run({ id: 4, symbol: 'USDCHF', status: 'Queued' }),
    ]);
    expect(rows[0]).toMatchObject({
      symbol: 'GBPUSD',
      runs: 3,
      completed: 1,
      failed: 1,
      cancelled: 1,
      successPct: 50,
      lastStartedAt: '2026-11-09T00:00:00Z',
    });
    expect(rows[1]).toMatchObject({ symbol: 'USDCHF', inFlight: 1, successPct: null });
  });

  it('buckets activity by UTC day and outcome', () => {
    const now = new Date('2026-11-08T23:30:00Z');
    const a = dailyActivity(
      [
        run({ id: 1, status: 'Completed', startedAt: '2026-11-08T23:10:00Z' }),
        run({ id: 2, status: 'Failed', startedAt: '2026-11-07T00:05:00Z' }),
        run({ id: 3, status: 'Running', startedAt: '2026-11-08T01:00:00Z' }),
        run({ id: 4, status: 'Failed', startedAt: '2026-10-01T00:00:00Z' }),
      ],
      now,
      3,
    );
    expect(a.days).toEqual(['2026-11-06', '2026-11-07', '2026-11-08']);
    expect(a.series.Completed).toEqual([0, 0, 1]);
    expect(a.series.Failed).toEqual([0, 1, 0]);
    expect(a.series.InFlight).toEqual([0, 0, 1]);
    expect(a.total).toBe(3);
  });

  it('maps statuses to outcomes', () => {
    expect(runOutcome('Queued')).toBe('InFlight');
    expect(runOutcome('Running')).toBe('InFlight');
    expect(runOutcome('Weird')).toBeNull();
  });
});
