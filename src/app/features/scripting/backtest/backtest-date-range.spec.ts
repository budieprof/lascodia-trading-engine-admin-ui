import { describe, expect, it } from 'vitest';

import { describeSpan, matchingPreset, presetRange } from './backtest-date-range';

const NOW = new Date('2026-11-04T20:15:00Z');

describe('presetRange', () => {
  it('ends on the UTC day and goes back the preset length', () => {
    expect(presetRange('3M', NOW)).toEqual({ fromDate: '2026-08-04', toDate: '2026-11-04' });
    expect(presetRange('6M', NOW)).toEqual({ fromDate: '2026-05-04', toDate: '2026-11-04' });
    expect(presetRange('1Y', NOW)).toEqual({ fromDate: '2025-11-04', toDate: '2026-11-04' });
    expect(presetRange('2Y', NOW)).toEqual({ fromDate: '2024-11-04', toDate: '2026-11-04' });
    expect(presetRange('5Y', NOW)).toEqual({ fromDate: '2021-11-04', toDate: '2026-11-04' });
  });

  it('YTD starts on 1 January', () => {
    expect(presetRange('YTD', NOW)).toEqual({ fromDate: '2026-01-01', toDate: '2026-11-04' });
  });
});

describe('matchingPreset', () => {
  it('names the preset a window equals, else null', () => {
    expect(matchingPreset('2025-11-04', '2026-11-04', NOW)).toBe('1Y');
    expect(matchingPreset('2025-01-01', '2025-12-31', NOW)).toBeNull();
  });
});

describe('describeSpan', () => {
  it('reads days, months, then years', () => {
    expect(describeSpan('2026-11-01', '2026-11-04')).toBe('3 days');
    expect(describeSpan('2026-05-04', '2026-11-04')).toBe('184 days (about 6 months)');
    expect(describeSpan('2021-11-04', '2026-11-04')).toBe('1826 days (about 5.0 years)');
  });

  it('is empty for a backwards or broken window', () => {
    expect(describeSpan('2026-11-04', '2026-11-01')).toBe('');
    expect(describeSpan('', '2026-11-01')).toBe('');
  });
});
