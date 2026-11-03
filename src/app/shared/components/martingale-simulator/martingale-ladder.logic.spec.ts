import { describe, expect, it } from 'vitest';
import {
  medianR,
  simulateLadder,
  type LadderSettings,
  type LadderTrade,
} from './martingale-ladder.logic';

const cfg = (o: Partial<LadderSettings> = {}): LadderSettings => ({
  symbolScope: '__all__',
  mode: 'recovery',
  fixedMult: 2,
  targetProfitR: 0.5,
  baseRiskPct: 1,
  maxDepth: 6,
  capPolicy: 'abandon',
  startBalance: 10000,
  assumedGeomR: 1,
  ...o,
});

let n = 0;
const trade = (
  r: number | null,
  geomR: number | null = 1,
  hour = n,
  symbol = 'EURUSD',
): LadderTrade => ({
  id: ++n,
  symbol,
  at: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(),
  exitMs: Date.UTC(2026, 0, 1, hour, 30),
  r,
  geomR,
});

describe('simulateLadder', () => {
  it('pays back the deficit plus the target on a recovery win, then resets', () => {
    n = 0;
    const s = simulateLadder([trade(-1), trade(1)], cfg());
    // base loss 100; rung stake = (100 + 0.5*100) / 1R = 150; win 150 → +50 net.
    expect(s.trades[1].pnl).toBeCloseTo(150);
    expect(s.finalEquity).toBeCloseTo(10050);
    expect(s.laddersRecovered).toBe(1);
    expect(s.trades[1].depth).toBe(1);
  });

  it('sizes recovery by the assumed R:R when a trade records no target', () => {
    n = 0;
    const s = simulateLadder([trade(-1, null), trade(3, null)], cfg({ assumedGeomR: 3 }));
    expect(s.trades[1].stakePct).toBeCloseTo((150 / 3 / 9900) * 100);
    expect(s.laddersRecovered).toBe(1);
  });

  it('abandons when the next rung would exceed the cap', () => {
    n = 0;
    const s = simulateLadder([trade(-1), trade(-1), trade(-1), trade(-1)], cfg({ maxDepth: 2 }));
    expect(s.laddersAbandoned).toBe(1);
    expect(s.trades[3].depth).toBe(0); // fresh chain after the write-off
  });

  it('ends the run at ruin instead of skipping the unaffordable rung', () => {
    n = 0;
    const s = simulateLadder(
      Array.from({ length: 30 }, () => trade(-1, 0.2)),
      cfg({ capPolicy: 'continue', baseRiskPct: 5 }),
    );
    expect(s.ruinedAtIndex).not.toBeNull();
    expect(s.trades.length).toBeLessThan(30);
  });

  it('skips trades without R and trades that overlap an open position', () => {
    n = 0;
    const a = trade(-1, 1, 0);
    const overlap: LadderTrade = {
      ...trade(1, 1, 0),
      at: new Date(Date.UTC(2026, 0, 1, 0, 10)).toISOString(),
    };
    const s = simulateLadder([a, overlap, trade(null)], cfg());
    expect(s.skippedOverlap).toBe(1);
    expect(s.skipReasons.get(overlap.id)).toMatchObject({
      reason: 'overlap',
      blockedBySignalId: a.id,
    });
    expect(s.skippedNoR).toBe(1);
    expect(s.allFilledCount).toBe(2);
  });

  it('flat baseline compounds the same R at the base risk', () => {
    n = 0;
    const s = simulateLadder([trade(1), trade(-1)], cfg());
    expect(s.baselineFinal).toBeCloseTo(10000 * 1.01 * 0.99);
  });
});

describe('medianR', () => {
  it('takes the median of positive values only', () => {
    expect(medianR([3, 2.9, -1, 3.1])).toBeCloseTo(3);
    expect(medianR([2, 4])).toBe(3);
    expect(medianR([-1])).toBeNull();
  });
});
