import { describe, expect, it } from 'vitest';

import type { MLTrainingRunDto } from '@core/api/api.types';
import { failureCategory, summariseRuns } from './training-history.logic';

const run = (p: Partial<MLTrainingRunDto>): MLTrainingRunDto =>
  ({
    id: 1,
    symbol: 'GBPUSD',
    timeframe: 'M15',
    status: 'Failed',
    startedAt: '2026-10-28T00:00:00Z',
    completedAt: null,
    errorMessage: null,
    ...p,
  }) as MLTrainingRunDto;

describe('training history logic', () => {
  it('collapses failure messages into categories', () => {
    expect(failureCategory('Quality gate failed: accuracy 52.3 % < 55.0 %')).toBe(
      'Quality gate failed',
    );
    expect(
      failureCategory(
        '[Permanently failed after 3 attempt(s)] Label imbalance out of bounds: buy fraction 15.4 %',
      ),
    ).toBe('Label imbalance out of bounds');
    expect(
      failureCategory(
        'Timeframe D1 is excluded from ML training (MLTraining:ExcludedTimeframes). Its candle history cannot…',
      ),
    ).toBe('Timeframe is excluded from ML training');
    expect(failureCategory(null)).toBe('No reason recorded');
  });

  it('summarises a page of runs', () => {
    const s = summariseRuns([
      run({
        status: 'Failed' as never,
        errorMessage: 'Quality gate failed: a',
        startedAt: '2026-10-28T05:00:00Z',
        completedAt: '2026-10-28T05:10:00Z',
      }),
      run({
        status: 'Failed' as never,
        errorMessage: 'Quality gate failed: b',
        startedAt: '2026-10-27T05:00:00Z',
      }),
      run({
        status: 'Cancelled' as never,
        errorMessage:
          'Timeframe H4 is excluded from ML training (MLTraining:ExcludedTimeframes). x',
      }),
      run({
        status: 'Completed' as never,
        startedAt: '2026-10-20T00:00:00Z',
        completedAt: '2026-10-20T01:00:00Z',
      }),
    ]);
    expect(s).toMatchObject({ total: 4, completed: 1, failed: 2, cancelled: 1 });
    expect(s.oldestUtc).toBe('2026-10-20T00:00:00Z');
    expect(s.newestFinishedUtc).toBe('2026-10-28T05:10:00Z');
    expect(s.reasons[0]).toEqual({ reason: 'Quality gate failed', count: 2 });
  });
});
