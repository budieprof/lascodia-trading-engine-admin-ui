import { describe, expect, it } from 'vitest';

import { blockSizeFor, monteCarloR, pathStats } from './monte-carlo';

describe('pathStats', () => {
  it('compounds R at the risk per trade and measures the deepest drawdown', () => {
    const s = pathStats([-1, -1, 2, -1], 10);
    // 1 → 0.9 → 0.81 → 0.972 → 0.8748: peak 1, deepest 19%, longest losing streak 2.
    expect(s.maxDrawdownPct).toBeCloseTo(19, 9);
    expect(s.finalReturnPct).toBeCloseTo(-12.52, 9);
    expect(s.longestLosingStreak).toBe(2);
  });

  it('cannot go below zero equity', () => {
    const s = pathStats([-5, -5], 30);
    expect(s.maxDrawdownPct).toBe(100);
    expect(s.finalReturnPct).toBe(-100);
  });
});

describe('monteCarloR', () => {
  const edge = Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 2.2 : -1));

  it('reorders the same trades many times, the same way each time', () => {
    const a = monteCarloR(edge, { runs: 500 })!;
    const b = monteCarloR(edge, { runs: 500 })!;
    expect(a).toEqual(b);
    expect(a.runs).toBe(500);
    expect(a.trades).toBe(100);
    expect(a.blockSize).toBe(10);
    // Every path holds a resample of the same trades: the percentiles are ordered.
    const dd = a.maxDrawdownPct;
    expect(dd.p5).toBeLessThanOrEqual(dd.p50);
    expect(dd.p50).toBeLessThanOrEqual(dd.p95);
    expect(a.observed.maxDrawdownPct).toBeGreaterThan(0);
  });

  it('reports ruin as the share of paths reaching the ruin drawdown', () => {
    const losing = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 1 : -1));
    const safe = monteCarloR(losing, { runs: 300, riskPct: 0.5 })!;
    const reckless = monteCarloR(losing, { runs: 300, riskPct: 5 })!;
    expect(safe.riskOfRuin).toBe(0);
    expect(reckless.riskOfRuin).toBeGreaterThan(0.9);
    expect(reckless.ruinDrawdownPct).toBe(50);
  });

  it('resamples trade by trade below ten trades, and needs two', () => {
    expect(blockSizeFor(9)).toBe(1);
    expect(blockSizeFor(10)).toBe(4);
    expect(blockSizeFor(101)).toBe(11);
    expect(monteCarloR([1, -1, 0.5], { runs: 50 })!.blockSize).toBe(1);
    expect(monteCarloR([1])).toBeNull();
  });
});
