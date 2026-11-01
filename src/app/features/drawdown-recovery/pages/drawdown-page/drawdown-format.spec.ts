import { describe, expect, it } from 'vitest';

import { formatDuration, formatElapsed, gaugeMax, groupByMode, plural } from './drawdown-format';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('formatDuration', () => {
  it('uses minutes under an hour, hours under two days, then days', () => {
    expect(formatDuration(45 * MIN)).toBe('45 min');
    expect(formatDuration(8 * HOUR + 22 * MIN)).toBe('8 h 22 min');
    expect(formatDuration(3 * HOUR)).toBe('3 h');
    expect(formatDuration(82 * HOUR)).toBe('3.4 days');
  });
});

describe('formatElapsed', () => {
  it('marks a figure bounded by the window start with ≥', () => {
    expect(formatElapsed({ ms: 8 * HOUR, lowerBound: true })).toBe('≥ 8 h');
    expect(formatElapsed({ ms: 20 * MIN, lowerBound: false })).toBe('20 min');
  });
  it('shows the fallback when there is nothing to measure', () => {
    expect(formatElapsed(null)).toBe('—');
    expect(formatElapsed(null, 'At peak')).toBe('At peak');
  });
  it('never prints a negative duration', () => {
    expect(formatElapsed({ ms: -5 * MIN, lowerBound: false })).toBe('0 min');
  });
});

describe('gaugeMax', () => {
  it('leaves headroom above the halt line', () => {
    expect(gaugeMax(4, 20)).toBe(25);
  });
  it('never runs past 100%', () => {
    expect(gaugeMax(14, 80)).toBe(100);
    expect(gaugeMax(99, 95)).toBe(100);
  });
  it('always holds the current value', () => {
    expect(gaugeMax(40, 20)).toBe(45);
  });
});

describe('groupByMode', () => {
  it('orders the most severe mode first and drops empty modes', () => {
    const g = groupByMode([
      { id: 1, recoveryMode: 'Reduced' as const },
      { id: 2, recoveryMode: 'Halted' as const },
      { id: 3, recoveryMode: 'Reduced' as const },
    ]);
    expect(g.map((x) => x.mode)).toEqual(['Halted', 'Reduced']);
    expect(g[1].items.map((x) => x.id)).toEqual([1, 3]);
  });
  it('keeps an unknown mode after the known ones', () => {
    const g = groupByMode([{ recoveryMode: 'Paused' }, { recoveryMode: 'Normal' }]);
    expect(g.map((x) => x.mode)).toEqual(['Normal', 'Paused']);
  });
});

describe('plural', () => {
  it('pluralises by count', () => {
    expect(plural(1, 'account')).toBe('1 account');
    expect(plural(5, 'account')).toBe('5 accounts');
  });
});
