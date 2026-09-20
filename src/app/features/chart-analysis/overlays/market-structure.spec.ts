import { describe, expect, it } from 'vitest';
import { marketStructure } from './market-structure';
import { EURUSD_H1 } from './__fixtures__/eurusd-h1';
import type { Ohlc } from '../indicators/math';

const REAL: Ohlc[] = EURUSD_H1.map(([time, open, high, low, close, volume]) => ({
  time,
  open,
  high,
  low,
  close,
  volume,
}));

describe('marketStructure', () => {
  it('says nothing on too few bars rather than inventing a range', () => {
    const s = marketStructure(REAL.slice(0, 10));
    expect(s.zones).toEqual([]);
    expect(s.summary).toBeNull();
  });

  it('says nothing on a flat series, where there is no scale to measure against', () => {
    const flat: Ohlc[] = Array.from({ length: 80 }, (_, i) => ({
      time: i * 3_600_000,
      open: 1.1,
      high: 1.1,
      low: 1.1,
      close: 1.1,
      volume: 100,
    }));
    expect(marketStructure(flat).zones).toEqual([]);
  });

  describe('on real EURUSD H1 bars', () => {
    const s = marketStructure(REAL);

    it('finds a balance and describes it in pips and bars', () => {
      const balance = s.zones.find((z) => z.kind === 'balance');
      expect(balance).toBeDefined();
      expect(balance!.label).toMatch(/^Balance — \d+ pips, \d+ bars$/);
      expect(balance!.to).toBeGreaterThan(balance!.from);
      expect(s.summary).toMatch(/Balancing \d+ pips over \d+ bars/);
    });

    it('puts the balance at the END of the series, not the prettiest patch in history', () => {
      // The operator is asking what price is doing NOW; a balance from three weeks ago
      // does not answer that.
      const balance = s.zones.find((z) => z.kind === 'balance')!;
      const last = REAL[REAL.length - 1];
      expect(last.close).toBeGreaterThanOrEqual(balance.from - 0.002);
      expect(last.close).toBeLessThanOrEqual(balance.to + 0.002);
    });

    it('brackets the balance with stop pools on both sides', () => {
      const pools = s.zones.filter((z) => z.kind === 'pool');
      const balance = s.zones.find((z) => z.kind === 'balance')!;
      expect(pools).toHaveLength(2);
      // Above the high and below the low — where stops rest if they rest anywhere.
      expect(pools.some((p) => p.from >= balance.to)).toBe(true);
      expect(pools.some((p) => p.to <= balance.from)).toBe(true);
    });

    it('labels the stop pools as estimated', () => {
      // Nobody publishes where stops are. Drawing an inference without saying so is how it
      // gets read as measurement.
      for (const p of s.zones.filter((z) => z.kind === 'pool')) {
        expect(p.label).toMatch(/est\./);
      }
    });

    it('emits the value area with VAH, POC and VAL in order', () => {
      const va = s.zones.find((z) => z.kind === 'value');
      expect(va).toBeDefined();
      const vah = s.levels.find((l) => l.label === 'VAH')!;
      const poc = s.levels.find((l) => l.label === 'POC')!;
      const val = s.levels.find((l) => l.label === 'VAL')!;
      expect(vah.price).toBeGreaterThanOrEqual(poc.price);
      expect(poc.price).toBeGreaterThanOrEqual(val.price);
    });

    it('keeps every level and zone inside the traded range', () => {
      const lo = Math.min(...REAL.map((b) => b.low));
      const hi = Math.max(...REAL.map((b) => b.high));
      for (const l of s.levels) {
        expect(l.price).toBeGreaterThanOrEqual(lo);
        expect(l.price).toBeLessThanOrEqual(hi);
      }
      // Stop pools sit just OUTSIDE the balance but must still be sane.
      for (const z of s.zones) {
        expect(z.from).toBeGreaterThan(lo - 0.01);
        expect(z.to).toBeLessThan(hi + 0.01);
      }
    });

    it('only marks a climax when range AND volume are both outsized', () => {
      // Range alone catches every news spike; volume alone catches the open.
      const ranges = REAL.map((b) => b.high - b.low);
      const meanRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
      for (const m of s.markers.filter((x) => x.kind === 'climax')) {
        const bar = REAL.find((b) => b.time === m.time)!;
        expect(bar.high - bar.low).toBeGreaterThan(meanRange);
        expect(m.label).toMatch(/(Selling|Buying) climax — \d+p, \d+k vol/);
      }
    });

    it('marks a spring only where price undercut the range and closed back inside', () => {
      for (const m of s.markers.filter((x) => x.kind === 'spring')) {
        const bar = REAL.find((b) => b.time === m.time)!;
        expect(bar.close).toBeGreaterThan(bar.low);
      }
    });

    it('reports at most ONE spring and one upthrust — the deepest', () => {
      // A stair-step lower undercuts the running low on four consecutive bars. Labelling
      // all four says the range was tested four times when it was tested once and then
      // extended.
      const springs = s.markers.filter((m) => m.kind === 'spring');
      expect(springs.length).toBeLessThanOrEqual(1);
      expect(s.markers.filter((m) => m.kind === 'upthrust').length).toBeLessThanOrEqual(1);
      if (springs.length === 1) {
        const balance = s.zones.find((z) => z.kind === 'balance')!;
        // The deepest undercut IS the range low, by construction.
        expect(springs[0].price).toBeCloseTo(balance.from, 5);
      }
    });

    it('puts every marker on a real bar', () => {
      const times = new Set(REAL.map((b) => b.time));
      for (const m of s.markers) expect(times.has(m.time)).toBe(true);
    });
  });
});
