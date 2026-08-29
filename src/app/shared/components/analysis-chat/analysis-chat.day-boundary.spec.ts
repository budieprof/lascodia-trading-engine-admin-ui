import { describe, expect, it } from 'vitest';
import { startsNewLocalDay } from './analysis-chat.component';

describe('startsNewLocalDay', () => {
  it('marks the first turn so the thread always opens with a date', () => {
    expect(startsNewLocalDay('2026-08-29T05:56:25Z', undefined)).toBe(true);
    expect(startsNewLocalDay('2026-08-29T05:56:25Z', null)).toBe(true);
  });

  it('does not repeat the date for turns on the same day', () => {
    // The four turns conversation 24272 posted inside twenty seconds.
    expect(startsNewLocalDay('2026-08-29T05:56:30Z', '2026-08-29T05:56:25Z')).toBe(false);
    expect(startsNewLocalDay('2026-08-29T20:26:11Z', '2026-08-29T05:56:25Z')).toBe(false);
  });

  it('draws a divider when a work order is resumed on a later day', () => {
    expect(startsNewLocalDay('2026-08-30T09:00:00Z', '2026-08-29T20:26:11Z')).toBe(true);
  });

  it('compares in the viewer timezone, not UTC', () => {
    // 23:30Z and 00:30Z are two different UTC dates but the SAME local day in UTC-2, and the
    // same local day either side of midnight in UTC+2 would be two. Whatever the runner's
    // zone, the answer must agree with the local date the timestamps render as.
    const a = '2026-08-29T23:30:00Z';
    const b = '2026-08-30T00:30:00Z';
    const expected = new Date(a).toDateString() !== new Date(b).toDateString();
    expect(startsNewLocalDay(b, a)).toBe(expected);
  });

  it('is inert without a timestamp', () => {
    expect(startsNewLocalDay(undefined, '2026-08-29T05:56:25Z')).toBe(false);
    expect(startsNewLocalDay('', '2026-08-29T05:56:25Z')).toBe(false);
  });
});
