import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import { CHART_PATTERNS, detectChartPatterns, findPivots } from './chart-patterns';

const SEG = 6;
const OPTS = { pivotDepth: 3 };

/** Bars whose closes walk linearly between waypoints, SEG bars per leg; tiny wicks. */
function fromCloses(closes: number[]): Ohlc[] {
  return closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { time: i * 3_600_000, open: o, high: Math.max(o, c) + 0.01, low: Math.min(o, c) - 0.01, close: c, volume: 1 };
  });
}
function path(wps: number[], seg = SEG): Ohlc[] {
  const closes: number[] = [wps[0]];
  for (let k = 1; k < wps.length; k++) for (let j = 1; j <= seg; j++) closes.push(wps[k - 1] + ((wps[k] - wps[k - 1]) * j) / seg);
  return fromCloses(closes);
}
const mirror = (wps: number[]) => wps.map((p) => 200 - p);

function cupCloses(sign: 1 | -1): number[] {
  const f = (p: number) => (sign === 1 ? p : 200 - p);
  const closes: number[] = [];
  for (let j = 0; j <= 6; j++) closes.push(f(104 + j));
  for (let j = 1; j <= 30; j++) {
    const x = (j - 15) / 15;
    closes.push(f(100 + 10 * x * x));
  }
  for (let j = 1; j <= 5; j++) closes.push(f(110 - (4 * j) / 5));
  for (let j = 1; j <= 8; j++) closes.push(f(106 + (9 * j) / 8));
  return closes;
}

const DT = [102, 100, 110, 104, 110.2, 96];
const HS = [102, 100, 108, 104, 113, 104.2, 108.3, 98];
const ASC = [100, 110, 102, 110, 105, 110.1, 107, 115];
const SYM = [95, 112, 100, 110, 102, 108, 103];
const RECT = [95, 110, 100, 110, 100, 110, 105];
const RWEDGE = [95, 105, 100, 108, 104, 110, 101];
const FLAG = [105, 100, 120, 116, 119, 115, 125];
const PENNANT = [105, 100, 120, 113, 118, 115, 125];
const ELLIOTT = [105, 100, 110, 104, 125, 115, 132, 120];
const GARTLEY = [104, 100, 110, 103.82, 107.64, 102.14, 106];
const BAT = [104, 100, 110, 105.5, 108.28, 101.14, 106];
const BUTTERFLY = [104, 100, 110, 102.14, 107, 97.3, 104];
const CRAB = [104, 100, 110, 105, 109.43, 93.82, 104];
const CYPHER = [104, 100, 110, 105, 113, 102.78, 108];

const FIXTURES: Record<string, Ohlc[]> = {
  'double-top': path(DT),
  'double-bottom': path(mirror(DT)),
  'head-and-shoulders': path(HS),
  'inverse-head-and-shoulders': path(mirror(HS)),
  'ascending-triangle': path(ASC),
  'descending-triangle': path(mirror(ASC)),
  'symmetric-triangle': path(SYM),
  rectangle: path(RECT),
  'rising-wedge': path(RWEDGE),
  'falling-wedge': path(mirror(RWEDGE)),
  'bull-flag': path(FLAG),
  'bear-flag': path(mirror(FLAG)),
  'bull-pennant': path(PENNANT),
  'bear-pennant': path(mirror(PENNANT)),
  'cup-and-handle': fromCloses(cupCloses(1)),
  'inverted-cup-and-handle': fromCloses(cupCloses(-1)),
  'elliott-impulse': path(ELLIOTT),
  abcd: path(GARTLEY),
  gartley: path(GARTLEY),
  bat: path(BAT),
  butterfly: path(BUTTERFLY),
  crab: path(CRAB),
  cypher: path(CYPHER),
};

describe('findPivots', () => {
  it('returns an alternating zig-zag at the waypoints', () => {
    const piv = findPivots(path(DT), 3);
    expect(piv.map((p) => p.kind)).toEqual(['low', 'high', 'low', 'high']);
    expect(piv.map((p) => p.index)).toEqual([6, 12, 18, 24]);
  });
});

describe('detectChartPatterns', () => {
  it('has a fixture for every catalogue entry', () => {
    expect(CHART_PATTERNS.map((p) => p.id).sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  for (const meta of CHART_PATTERNS) {
    it(`detects ${meta.name}`, () => {
      const hits = detectChartPatterns(FIXTURES[meta.id], { ...OPTS, ids: [meta.id] });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.id === meta.id && h.name === meta.name)).toBe(true);
      if (meta.direction !== 'neutral') expect(hits[0].direction).toBe(meta.direction);
      expect(hits[0].points.length).toBeGreaterThanOrEqual(4 - (meta.id.startsWith('double') ? 1 : 0));
      expect(hits[0].lines.length).toBeGreaterThan(0);
    });
  }

  it('confirms a double top on the neckline break and projects the measured move', () => {
    const [hit] = detectChartPatterns(FIXTURES['double-top'], { ...OPTS, ids: ['double-top'] });
    expect(hit.status).toBe('confirmed');
    expect(hit.breakout).toBeCloseTo(104 - 0.01, 6);
    expect(hit.target!).toBeLessThan(hit.breakout!);
  });

  it('mirrors direction for harmonics and Elliott', () => {
    const bearGartley = detectChartPatterns(path(mirror(GARTLEY)), { ...OPTS, ids: ['gartley'] });
    expect(bearGartley[0]?.direction).toBe('bearish');
    expect(detectChartPatterns(FIXTURES["gartley"], { ...OPTS, ids: ['gartley'] })[0].direction).toBe('bullish');
    expect(detectChartPatterns(path(mirror(ELLIOTT)), { ...OPTS, ids: ['elliott-impulse'] })[0]?.direction).toBe('bearish');
  });

  it('labels harmonic and wave points', () => {
    const [g] = detectChartPatterns(FIXTURES["gartley"], { ...OPTS, ids: ['gartley'] });
    expect(g.points.map((p) => p.label)).toEqual(['X', 'A', 'B', 'C', 'D']);
    const [e] = detectChartPatterns(FIXTURES['elliott-impulse'], { ...OPTS, ids: ['elliott-impulse'] });
    expect(e.points.map((p) => p.label)).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  describe('negatives', () => {
    it('no double top when the peaks differ by far more than the tolerance', () => {
      expect(detectChartPatterns(path([102, 100, 110, 104, 115, 98]), { ...OPTS, ids: ['double-top'] })).toEqual([]);
    });
    it('no head and shoulders without a dominant head', () => {
      expect(detectChartPatterns(path([102, 100, 108, 104, 108.2, 104.2, 108.3, 98]), { ...OPTS, ids: ['head-and-shoulders'] })).toEqual([]);
    });
    it('no Elliott impulse when wave 4 overlaps wave 1', () => {
      expect(detectChartPatterns(path([105, 100, 110, 104, 125, 108, 132, 120]), { ...OPTS, ids: ['elliott-impulse'] })).toEqual([]);
    });
    it('no cup and handle on a V-shaped bottom', () => {
      const v = [104, 110, 100, 110, 106, 115];
      const closes: number[] = [];
      const legs = [6, 15, 15, 5, 8];
      closes.push(v[0]);
      legs.forEach((n, k) => {
        for (let j = 1; j <= n; j++) closes.push(v[k] + ((v[k + 1] - v[k]) * j) / n);
      });
      expect(detectChartPatterns(fromCloses(closes), { ...OPTS, ids: ['cup-and-handle'] })).toEqual([]);
    });
    it('no gartley where the ratios are a bat', () => {
      expect(detectChartPatterns(FIXTURES["bat"], { ...OPTS, ids: ['gartley'] })).toEqual([]);
    });
    it('no triangle / wedge / flag on a monotone trend', () => {
      const trend = path([100, 110, 120, 130]);
      expect(detectChartPatterns(trend, OPTS)).toEqual([]);
    });
  });

  it('caps hits per type and keeps them non-overlapping', () => {
    const many = path([...DT, 104, 110, 104.2, 110.1, 96, 104, 110, 104.1, 110.2, 96, 104, 110, 104, 110.1, 96, 104, 110, 104.1, 110, 96]);
    const hits = detectChartPatterns(many, { ...OPTS, ids: ['double-top'], maxPerType: 2 });
    expect(hits.length).toBe(2);
    expect(hits[0].endIndex).toBeLessThanOrEqual(hits[1].startIndex);
  });
});
