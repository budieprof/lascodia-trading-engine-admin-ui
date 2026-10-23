import type { MdConsolidatedWire } from '@core/realtime/marketdata.types';
import { consolidatedId, consolidatedLabel, consolidatedSubset, isConsolidatedId } from '@core/realtime/marketdata.types';
import { restoredOrderFlow } from '../orderflow/orderflow.types';
import { DispersionStrip, buildMultibook, formatAge, formatPoints, sourceColour } from './multibook-model';
import { hourStats } from './multibook-panel.component';

/** A consolidated view as the engine sends it. Sources named test-* are synthetic TEST sources (specs only). */
function view(): MdConsolidatedWire {
  return {
    t: 1_000,
    point: 0.00001,
    sizeUnit: 'base',
    b: [
      { p: 1.1, s: 1_300_000, partial: false, src: ['mt5-a', 'test-venue'], sz: [1_000_000, 300_000] },
      { p: 1.09999, s: 500_000, partial: true, src: ['test-venue', 'test-lots'], sz: [500_000, null] },
    ],
    a: [
      { p: 1.10002, s: 2_000_000, partial: false, src: ['mt5-a'], sz: [2_000_000] },
      { p: 1.10003, s: 400_000, partial: false, src: ['test-venue'], sz: [400_000] },
    ],
    bestBid: 1.10001,
    bestAsk: 1.10002,
    bestBidSources: ['test-quote'],
    bestAskSources: ['mt5-a'],
    crossed: false,
    locked: false,
    crosses: [],
    medianMid: 1.100015,
    midRange: 0.00002,
    sources: [
      src('mt5-a', 'MetaQuotes-Demo (MT5 broker)', 'book', 1.1, 1.10002),
      src('test-venue', 'TEST venue', 'book', 1.1, 1.10003),
      src('test-quote', 'TEST quotes', 'quote', 1.10001, 1.10004),
      { ...src('test-old', 'TEST stale', 'book', 1.2, 1.3), state: 'stale', ageMs: 20_000 },
    ],
  };
}

function src(sourceId: string, name: string, mode: string, bid: number, ask: number) {
  return {
    sourceId, name, kind: 'FixVenue', state: 'live', mode, bid, ask, mid: (bid + ask) / 2, topT: 900, ageMs: 100, lagMs: 40,
    bidLevels: 3, askLevels: 3, sizeUnit: 'Units', sizeKnown: true, dev: 0, basis: null,
  };
}

describe('multibook model', () => {
  const order = ['mt5-a', 'test-venue', 'test-lots', 'test-quote', 'test-old'];

  it('lays out asks above bids, with per-source colour segments scaled to the widest level', () => {
    const v = buildMultibook(view(), new Set(), order);
    expect(v.rows.map((r) => `${r.side}:${r.price}`)).toEqual(['ask:1.10003', 'ask:1.10002', 'bid:1.1', 'bid:1.09999']);
    const top = v.rows[2];
    expect(top.total).toBe(1_300_000);
    expect(top.segments.map((g) => [g.sourceId, g.colour, g.width])).toEqual([
      ['mt5-a', sourceColour(0), 0.5],
      ['test-venue', sourceColour(1), 0.15],
    ]);
    const partial = v.rows[3];
    expect(partial.partial).toBe(true);
    expect(partial.segments[1]).toMatchObject({ sourceId: 'test-lots', size: null, width: 0 });
  });

  it('best prices come from live sources incl. quote-only ones, which are marked at their price', () => {
    const v = buildMultibook(view(), new Set(), order);
    expect(v.bestBid).toBe(1.10001);
    expect(v.bestBidSources).toEqual(['test-quote']);
    expect(v.bestAsk).toBe(1.10002);
    expect(v.rows.find((r) => r.price === 1.10002)!.best).toBe(true);
    // live mids: mt5-a 1.10001, test-venue 1.100015, test-quote 1.100025 → range 0.000015 = 1.5 points
    expect(v.midRangePoints).toBeCloseTo(1.5, 6);
  });

  it('a toggled-off source leaves totals, segments, best prices and dispersion', () => {
    const v = buildMultibook(view(), new Set(['mt5-a', 'test-quote']), order);
    expect(v.rows.map((r) => r.price)).toEqual([1.10003, 1.1, 1.09999]);
    expect(v.rows.find((r) => r.price === 1.1)!.total).toBe(300_000);
    expect(v.bestBid).toBe(1.1);
    expect(v.bestAsk).toBe(1.10003);
    expect(v.sources.find((s) => s.sourceId === 'mt5-a')!.enabled).toBe(false);
    expect(v.sources.find((s) => s.sourceId === 'mt5-a')!.devPoints).toBeNull();
    expect(v.midRangePoints).toBeNull(); // one live enabled source left
  });

  it('detects crossed and locked quotes between enabled sources', () => {
    const c = view();
    c.sources[2] = src('test-quote', 'TEST quotes', 'quote', 1.10003, 1.10005); // bid above mt5-a's ask
    c.sources[1] = src('test-venue', 'TEST venue', 'book', 1.10002, 1.10004); // bid = mt5-a's ask
    const v = buildMultibook(c, new Set(), order);
    expect(v.crossed).toBe(true);
    expect(v.crosses).toContainEqual({ bidSource: 'test-quote', askSource: 'mt5-a', locked: false });
    expect(v.crosses).toContainEqual({ bidSource: 'test-venue', askSource: 'mt5-a', locked: true });
  });

  it('health lines: stale sources stay listed with their age, deviation and spread in points', () => {
    const v = buildMultibook(view(), new Set(), order);
    const old = v.sources.find((s) => s.sourceId === 'test-old')!;
    expect(old.state).toBe('stale');
    expect(old.devPoints).toBeNull();
    const a = v.sources.find((s) => s.sourceId === 'mt5-a')!;
    expect(a.name).toBe('MetaQuotes-Demo');
    expect(a.spreadPoints).toBeCloseTo(2, 6);
    expect(formatAge(1_500)).toBe('1.5 s');
    expect(formatPoints(-0.96)).toBe('−1.0');
  });

  it('the dispersion strip keeps a 5-minute window of per-source deviations', () => {
    const strip = new DispersionStrip(60_000);
    for (let t = 1_000; t <= 200_000; t += 1_000) {
      const c = view();
      c.t = t;
      strip.push(buildMultibook(c, new Set(), order, 0));
    }
    expect(strip.all()[0].t).toBe(140_000);
    expect(strip.all().at(-1)!.dev.has('mt5-a')).toBe(true);
    expect(strip.all().at(-1)!.dev.has('test-old')).toBe(false);
    expect(strip.maxAbs()).toBeGreaterThanOrEqual(0.5);
  });
});

describe('consolidated ids', () => {
  it('parse, build and label canonical subsets', () => {
    expect(isConsolidatedId('consolidated')).toBe(true);
    expect(isConsolidatedId('consolidated:a,b')).toBe(true);
    expect(isConsolidatedId('mt5-a')).toBe(false);
    expect(consolidatedSubset('consolidated:b,a,a')).toEqual(['a', 'b']);
    expect(consolidatedSubset('consolidated')).toBeNull();
    expect(consolidatedId(['a', 'b', 'c'], ['c', 'a'])).toBe('consolidated:a,c');
    expect(consolidatedId(['a', 'b'], ['a', 'b'])).toBe('consolidated');
    expect(consolidatedLabel('consolidated:a', [{ sourceId: 'a', displayName: 'Alpha (MT5 broker)' }])).toBe('Consolidated — Alpha');
  });

  it('survive a saved layout round trip', () => {
    expect(restoredOrderFlow({ sourceId: 'consolidated:mt5-a,test-venue' }).sourceId).toBe('consolidated:mt5-a,test-venue');
    expect(restoredOrderFlow({ sourceId: 'consolidated' }).sourceId).toBe('consolidated');
    expect(restoredOrderFlow({ sourceId: 'consolidated:a b' }).sourceId).toBeNull();
  });

  it('hour stats weight deviation by live samples and report the stale share', () => {
    const s = hourStats({
      symbol: 'EURUSD',
      denied: [],
      minutes: [
        { t: 0, samples: 10, sampleIntervalMs: 500, meanLiveSources: 2, midRangeMean: null, midRangeMax: null, rangeSamples: null,
          crossedSamples: null, lockedSamples: null, point: 0.00001,
          sources: [{ sourceId: 'a', samples: 10, liveSamples: 8, staleSamples: 2, meanAbsDev: 0.00001, maxAgeMs: 0, maxLagMs: 0, meanLagMs: 30 }] },
        { t: 60_000, samples: 10, sampleIntervalMs: 500, meanLiveSources: 2, midRangeMean: null, midRangeMax: null, rangeSamples: null,
          crossedSamples: null, lockedSamples: null, point: 0.00001,
          sources: [{ sourceId: 'a', samples: 10, liveSamples: 2, staleSamples: 0, meanAbsDev: 0.00006, maxAgeMs: 0, maxLagMs: 0, meanLagMs: 50 }] },
      ],
    });
    expect(s['a'].meanAbsDevPoints).toBeCloseTo((1 * 8 + 6 * 2) / 10, 6);
    expect(s['a'].stalePct).toBeCloseTo(10, 6);
    expect(s['a'].meanLagMs).toBe(40);
  });
});
