import { describe, expect, it } from 'vitest';

import {
  ANALYTICS_SAMPLE_ROW_CAP,
  ANALYTICS_SAMPLE_ROW_FLOOR,
  analyticsSampleSize,
  newestRowsRequest,
} from './analytics-sample';

describe('analyticsSampleSize', () => {
  it('fetches every row, up to the cap, when rows are small', () => {
    const row = { id: 1, symbol: 'EURUSD', totalReturn: 1.2 };
    expect(analyticsSampleSize(4797, row)).toBe(4797);
    expect(analyticsSampleSize(9000, row)).toBe(ANALYTICS_SAMPLE_ROW_CAP);
    expect(analyticsSampleSize(120, row)).toBe(120);
  });

  it('shrinks the sample when each row carries a large payload', () => {
    // A walk-forward list row with its ~64 KB windowResultsJson.
    const row = { id: 2973, windowResultsJson: 'x'.repeat(64_000) };
    const size = analyticsSampleSize(2973, row);
    expect(size).toBeLessThan(250);
    expect(size).toBeGreaterThanOrEqual(ANALYTICS_SAMPLE_ROW_FLOOR);
  });

  it('never goes below the floor, nor above the total', () => {
    const huge = { blob: 'x'.repeat(5_000_000) };
    expect(analyticsSampleSize(2973, huge)).toBe(ANALYTICS_SAMPLE_ROW_FLOOR);
    expect(analyticsSampleSize(40, huge)).toBe(40);
  });

  it('is 0 for an empty list and falls back to the cap without a probe row', () => {
    expect(analyticsSampleSize(0, null)).toBe(0);
    expect(analyticsSampleSize(9000, null)).toBe(ANALYTICS_SAMPLE_ROW_CAP);
  });
});

describe('newestRowsRequest', () => {
  it('asks for the newest rows explicitly', () => {
    expect(newestRowsRequest(25)).toEqual({
      currentPage: 1,
      itemCountPerPage: 25,
      filter: null,
      sortBy: 'id',
      sortDirection: 'desc',
    });
  });
});
