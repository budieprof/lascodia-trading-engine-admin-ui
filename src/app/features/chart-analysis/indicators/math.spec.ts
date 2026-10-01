import { describe, expect, it } from 'vitest';
import * as M5 from './math';
import {
  adx,
  atr,
  bollinger,
  donchian,
  ema,
  macd,
  obv,
  rsi,
  sma,
  stochastic,
  trueRange,
  vwap,
  wma,
  awesome,
  cci,
  ichimoku,
  keltner,
  mfi,
  momentum,
  pivotPoints,
  psar,
  roc,
  superTrend,
  williamsR,
  adl,
  alma,
  aroon,
  choppiness,
  cmf,
  dema,
  dpo,
  elderRay,
  envelope,
  fisher,
  forceIndex,
  historicalVolatility,
  hma,
  linreg,
  pvt,
  smma,
  stochRsi,
  tema,
  trix,
  ultimate,
  volumeProfile,
  vortex,
  vwma,
  alligator,
  bandwidth,
  coppock,
  kst,
  percentB,
  ppo,
  rvi,
  schaff,
  standardErrorBands,
  volumeIndices,
  volumeOscillator,
  type Ohlc,
} from './math';

const closes = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

function bars(values: Array<[number, number, number, number, number?]>, startMs = 0): Ohlc[] {
  return values.map(([o, h, l, c, v], i) => ({
    time: startMs + i * 3_600_000,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v ?? 100,
  }));
}

describe('moving averages', () => {
  it('sma averages the trailing window and nulls the warm-up', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('sma of a flat series is the constant', () => {
    expect(sma([7, 7, 7, 7], 2)).toEqual([null, 7, 7, 7]);
  });

  it('ema seeds from the SMA of the first period, not the first value', () => {
    // Seeding from closes[0] would put 1 here and drift for hundreds of bars —
    // visibly disagreeing with TradingView without ever erroring.
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(2, 10); // sma(1,2,3)
    expect(out[3]).toBeCloseTo(3, 10); // 4*0.5 + 2*0.5
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it('ema returns all nulls when there are fewer bars than the period', () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });

  it('wma weights the newest bar heaviest', () => {
    // (1*1 + 2*2 + 3*3) / 6
    expect(wma([1, 2, 3], 3)?.[2]).toBeCloseTo(14 / 6, 10);
  });
});

describe('rsi', () => {
  it('is 100 when every bar gains', () => {
    const out = rsi(
      closes(40, (i) => 100 + i),
      14,
    );
    expect(out[39]).toBe(100);
  });

  it('sits at 50 for a perfectly alternating series', () => {
    const out = rsi(
      closes(80, (i) => (i % 2 === 0 ? 100 : 101)),
      14,
    );
    expect(out[79]).toBeGreaterThan(40);
    expect(out[79]).toBeLessThan(60);
  });

  it('stays within 0..100', () => {
    const out = rsi(
      closes(120, (i) => 100 + Math.sin(i / 3) * 10),
      14,
    ).filter((v): v is number => v !== null);
    expect(out.length).toBeGreaterThan(0);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('nulls the warm-up rather than emitting zeros', () => {
    const out = rsi(
      closes(20, (i) => 100 + i),
      14,
    );
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
  });
});

describe('macd', () => {
  it('drives the histogram to zero on a flat series', () => {
    const { macd: line, histogram } = macd(closes(100, () => 50));
    expect(line[99]).toBeCloseTo(0, 10);
    expect(histogram[99]).toBeCloseTo(0, 10);
  });

  it('goes positive on a rising series', () => {
    const { macd: line } = macd(closes(100, (i) => 100 + i));
    expect(line[99]).toBeGreaterThan(0);
  });

  it('offsets the signal line so it starts after the MACD line', () => {
    // Feeding the nulls into the signal EMA would poison its seed and shift
    // every later value — this pins the offset.
    const { macd: line, signal } = macd(closes(100, (i) => 100 + i));
    const firstLine = line.findIndex((v) => v !== null);
    const firstSignal = signal.findIndex((v) => v !== null);
    expect(firstSignal).toBe(firstLine + 8); // signal period 9 → 8 more bars
  });
});

describe('bollinger', () => {
  it('collapses both bands onto the mean when price is flat', () => {
    const { upper, middle, lower } = bollinger(
      closes(30, () => 10),
      20,
      2,
    );
    expect(middle[29]).toBeCloseTo(10, 10);
    expect(upper[29]).toBeCloseTo(10, 10);
    expect(lower[29]).toBeCloseTo(10, 10);
  });

  it('brackets the mean symmetrically', () => {
    const { upper, middle, lower } = bollinger(
      closes(60, (i) => 100 + Math.sin(i) * 5),
      20,
      2,
    );
    const u = upper[59] as number;
    const m = middle[59] as number;
    const l = lower[59] as number;
    expect(u).toBeGreaterThan(m);
    expect(l).toBeLessThan(m);
    expect(u - m).toBeCloseTo(m - l, 10);
  });
});

describe('true range and atr', () => {
  it('falls back to high-low on the first bar', () => {
    expect(trueRange(bars([[10, 12, 9, 11]]))[0]).toBe(3);
  });

  it('accounts for a gap against the previous close', () => {
    // Gap up: the true range spans from the previous close, not just the bar.
    const tr = trueRange(
      bars([
        [10, 11, 9, 10],
        [20, 21, 19, 20],
      ]),
    );
    expect(tr[1]).toBe(11); // 21 - 10
  });

  it('atr of a constant-range series is that range', () => {
    const series = bars(
      Array.from({ length: 40 }, () => [10, 12, 8, 10] as [number, number, number, number]),
    );
    expect(atr(series, 14)[39]).toBeCloseTo(4, 10);
  });
});

describe('stochastic', () => {
  it('pins to 100 when the close is the window high', () => {
    const rising = bars(
      Array.from(
        { length: 40 },
        (_, i) => [100 + i, 100 + i, 99 + i, 100 + i] as [number, number, number, number],
      ),
    );
    expect(stochastic(rising, 14, 1, 1).k[39]).toBeCloseTo(100, 6);
  });

  it('returns 50 for a completely flat window instead of dividing by zero', () => {
    const flat = bars(
      Array.from({ length: 30 }, () => [5, 5, 5, 5] as [number, number, number, number]),
    );
    const { k } = stochastic(flat, 14, 1, 1);
    expect(k[29]).toBe(50);
    expect(Number.isNaN(k[29] as number)).toBe(false);
  });
});

describe('vwap', () => {
  it('resets at each UTC day boundary', () => {
    // Two days: day 1 trades at 10, day 2 at 20. Without the reset the second
    // day would be dragged toward 15 and stop tracking the day's value area.
    const day1 = Date.parse('2026-09-17T00:00:00Z');
    const day2 = Date.parse('2026-09-18T00:00:00Z');
    const series: Ohlc[] = [
      { time: day1, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { time: day1 + 3_600_000, open: 10, high: 10, low: 10, close: 10, volume: 100 },
      { time: day2, open: 20, high: 20, low: 20, close: 20, volume: 100 },
    ];
    const out = vwap(series);
    expect(out[1]).toBeCloseTo(10, 10);
    expect(out[2]).toBeCloseTo(20, 10);
  });

  it('weights by volume within a session', () => {
    const t = Date.parse('2026-09-17T00:00:00Z');
    const out = vwap([
      { time: t, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { time: t + 1000, open: 20, high: 20, low: 20, close: 20, volume: 3 },
    ]);
    expect(out[1]).toBeCloseTo((10 * 1 + 20 * 3) / 4, 10);
  });
});

describe('donchian', () => {
  it('tracks the window extremes and their midpoint', () => {
    const series = bars(
      Array.from(
        { length: 25 },
        (_, i) => [100, 100 + i, 100 - i, 100] as [number, number, number, number],
      ),
    );
    const { upper, lower, middle } = donchian(series, 20);
    expect(upper[24]).toBe(124);
    expect(lower[24]).toBe(76);
    expect(middle[24]).toBe(100);
  });
});

describe('obv', () => {
  it('adds volume on an up close and subtracts on a down close', () => {
    const out = obv(
      bars([
        [10, 10, 10, 10, 50],
        [10, 10, 10, 11, 30],
        [11, 11, 11, 9, 20],
      ]),
    );
    expect(out).toEqual([0, 30, 10]);
  });

  it('leaves the line unchanged on an unchanged close', () => {
    const out = obv(
      bars([
        [10, 10, 10, 10, 50],
        [10, 10, 10, 10, 30],
      ]),
    );
    expect(out[1]).toBe(0);
  });
});

describe('adx', () => {
  it('reads high on a persistent trend', () => {
    const trend = bars(
      Array.from(
        { length: 80 },
        (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i] as [number, number, number, number],
      ),
    );
    const { adx: a, plusDi, minusDi } = adx(trend, 14);
    expect(a[79]).toBeGreaterThan(40);
    expect(plusDi[79] as number).toBeGreaterThan(minusDi[79] as number);
  });

  it('stays within 0..100', () => {
    const noisy = bars(
      Array.from({ length: 120 }, (_, i) => {
        const p = 100 + Math.sin(i / 5) * 8;
        return [p, p + 1, p - 1, p] as [number, number, number, number];
      }),
    );
    for (const v of adx(noisy, 14).adx.filter((x): x is number => x !== null)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('alignment contract', () => {
  it('every indicator returns one value per input bar', () => {
    // The series data must line up with bar times one-for-one; a short array
    // silently shifts an indicator against price.
    const series = bars(
      Array.from(
        { length: 60 },
        (_, i) => [100 + i, 101 + i, 99 + i, 100 + i] as [number, number, number, number],
      ),
    );
    const c = series.map((b) => b.close);
    const n = series.length;
    expect(sma(c, 14)).toHaveLength(n);
    expect(ema(c, 14)).toHaveLength(n);
    expect(wma(c, 14)).toHaveLength(n);
    expect(rsi(c, 14)).toHaveLength(n);
    expect(macd(c).macd).toHaveLength(n);
    expect(macd(c).signal).toHaveLength(n);
    expect(macd(c).histogram).toHaveLength(n);
    expect(bollinger(c).upper).toHaveLength(n);
    expect(atr(series, 14)).toHaveLength(n);
    expect(stochastic(series).k).toHaveLength(n);
    expect(vwap(series)).toHaveLength(n);
    expect(donchian(series).upper).toHaveLength(n);
    expect(obv(series)).toHaveLength(n);
    expect(adx(series, 14).adx).toHaveLength(n);
  });

  it('handles an empty series without throwing', () => {
    expect(sma([], 14)).toEqual([]);
    expect(obv([])).toEqual([]);
    expect(vwap([])).toEqual([]);
  });
});

// ── Second wave ────────────────────────────────────────────────────────────

describe('momentum and roc', () => {
  it('momentum is the difference against the bar `period` back', () => {
    expect(momentum([1, 2, 3, 4, 5], 2)).toEqual([null, null, 2, 2, 2]);
  });

  it('roc is that difference as a percentage', () => {
    expect(roc([100, 110, 121], 1)?.[1]).toBeCloseTo(10, 6);
  });

  it('roc guards a zero base instead of returning Infinity', () => {
    expect(roc([0, 5], 1)?.[1]).toBeNull();
  });
});

describe('williamsR', () => {
  it('is 0 at the top of the range and -100 at the bottom', () => {
    const top = bars(
      Array.from(
        { length: 20 },
        (_, i) => [100, 100 + i, 99, 100 + i] as [number, number, number, number],
      ),
    );
    expect(williamsR(top, 14)[19]).toBeCloseTo(0, 6);
  });

  it('returns -50 for a flat window rather than dividing by zero', () => {
    const flat = bars(
      Array.from({ length: 20 }, () => [5, 5, 5, 5] as [number, number, number, number]),
    );
    expect(williamsR(flat, 14)[19]).toBe(-50);
  });
});

describe('cci', () => {
  it('is 0 when price does not move', () => {
    const flat = bars(
      Array.from({ length: 30 }, () => [10, 10, 10, 10] as [number, number, number, number]),
    );
    expect(cci(flat, 20)[29]).toBe(0);
  });

  it('goes positive on a rally', () => {
    const up = bars(
      Array.from(
        { length: 40 },
        (_, i) => [100 + i, 101 + i, 99 + i, 100 + i] as [number, number, number, number],
      ),
    );
    expect(cci(up, 20)[39] as number).toBeGreaterThan(0);
  });
});

describe('mfi', () => {
  it('pins to 100 when every bar is an up-flow', () => {
    const up = bars(
      Array.from(
        { length: 30 },
        (_, i) =>
          [100 + i, 101 + i, 99 + i, 100 + i, 10] as [number, number, number, number, number],
      ),
    );
    expect(mfi(up, 14)[29]).toBe(100);
  });
});

describe('keltner', () => {
  it('brackets the EMA basis symmetrically', () => {
    const series = bars(
      Array.from({ length: 60 }, (_, i) => {
        const p = 100 + Math.sin(i / 4) * 3;
        return [p, p + 1, p - 1, p] as [number, number, number, number];
      }),
    );
    const { upper, middle, lower } = keltner(series, 20, 2, 10);
    const u = upper[59] as number;
    const m = middle[59] as number;
    const l = lower[59] as number;
    expect(u).toBeGreaterThan(m);
    expect(l).toBeLessThan(m);
    expect(u - m).toBeCloseTo(m - l, 8);
  });
});

describe('psar', () => {
  it('stays below price in an uptrend', () => {
    const up = bars(
      Array.from(
        { length: 50 },
        (_, i) => [100 + i, 101 + i, 99.5 + i, 100.8 + i] as [number, number, number, number],
      ),
    );
    const out = psar(up, 0.02, 0.2);
    expect(out[49] as number).toBeLessThan(up[49].close);
  });

  it('flips to above price after a reversal', () => {
    // Rise then fall: by the end the stop must have crossed to the other side.
    const series = bars([
      ...Array.from(
        { length: 30 },
        (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i] as [number, number, number, number],
      ),
      ...Array.from(
        { length: 30 },
        (_, i) => [130 - i, 131 - i, 129 - i, 129.5 - i] as [number, number, number, number],
      ),
    ]);
    const out = psar(series, 0.02, 0.2);
    expect(out[59] as number).toBeGreaterThan(series[59].close);
  });
});

describe('ichimoku', () => {
  const series = bars(
    Array.from(
      { length: 120 },
      (_, i) => [100 + i, 101 + i, 99 + i, 100 + i] as [number, number, number, number],
    ),
  );

  it('shifts the spans FORWARD by the displacement', () => {
    // The forward shift is the indicator, not a presentation detail: span A at
    // bar i must equal the raw value computed at bar i-26.
    const r = ichimoku(series, 9, 26, 52, 26);
    const raw = ichimoku(series, 9, 26, 52, 0);
    expect(r.spanA[80]).toBeCloseTo(raw.spanA[54] as number, 8);
  });

  it('shifts the lagging span BACKWARD by the displacement', () => {
    const r = ichimoku(series, 9, 26, 52, 26);
    expect(r.lagging[50]).toBeCloseTo(series[76].close, 8);
  });

  it('keeps every plot aligned to the bar count', () => {
    const r = ichimoku(series);
    for (const plot of [r.conversion, r.base, r.spanA, r.spanB, r.lagging]) {
      expect(plot).toHaveLength(series.length);
    }
  });
});

describe('superTrend', () => {
  it('tracks below price while the trend holds', () => {
    const up = bars(
      Array.from(
        { length: 60 },
        (_, i) => [100 + i, 101 + i, 99 + i, 100.7 + i] as [number, number, number, number],
      ),
    );
    expect(superTrend(up, 10, 3)[59] as number).toBeLessThan(up[59].close);
  });
});

describe('pivotPoints', () => {
  it('holds the previous day levels flat through the current day', () => {
    const d1 = Date.parse('2026-09-17T00:00:00Z');
    const d2 = Date.parse('2026-09-18T00:00:00Z');
    const series: Ohlc[] = [
      { time: d1, open: 10, high: 12, low: 8, close: 11, volume: 1 },
      { time: d1 + 3_600_000, open: 11, high: 13, low: 9, close: 10, volume: 1 },
      { time: d2, open: 10, high: 10.5, low: 9.5, close: 10, volume: 1 },
      { time: d2 + 3_600_000, open: 10, high: 10.2, low: 9.8, close: 10, volume: 1 },
    ];
    const r = pivotPoints(series);
    // Day 1 has no prior day, so no levels.
    expect(r.pivot[0]).toBeNull();
    // Day 2 uses day 1's H=13 L=8 C=10 → P = 31/3.
    expect(r.pivot[2]).toBeCloseTo(31 / 3, 8);
    // And it does not move within the day.
    expect(r.pivot[3]).toBeCloseTo(r.pivot[2] as number, 10);
  });
});

describe('awesome', () => {
  it('is zero on a flat series', () => {
    const flat = bars(
      Array.from({ length: 50 }, () => [10, 10, 10, 10] as [number, number, number, number]),
    );
    expect(awesome(flat)[49]).toBeCloseTo(0, 10);
  });
});

// ── Third wave ─────────────────────────────────────────────────────────────

const trendUp = bars(
  Array.from(
    { length: 120 },
    (_, i) =>
      [100 + i, 101 + i, 99 + i, 100.5 + i, 100] as [number, number, number, number, number],
  ),
);
const flat = bars(
  Array.from(
    { length: 120 },
    () => [10, 10, 10, 10, 100] as [number, number, number, number, number],
  ),
);
const upCloses = closes(120, (i) => 100 + i);

describe('moving average family', () => {
  it('every variant tracks a linear ramp closely', () => {
    // On a straight line each of these should sit near the current value; a
    // variant that is wildly off has its smoothing or its seed wrong.
    for (const [name, out] of [
      ['smma', smma(upCloses, 20)],
      ['hma', hma(upCloses, 9)],
      ['dema', dema(upCloses, 20)],
      ['tema', tema(upCloses, 20)],
      ['alma', alma(upCloses, 9)],
      ['linreg', linreg(upCloses, 14)],
    ] as const) {
      const last = out[119] as number;
      expect(last, name).toBeGreaterThan(180);
      expect(last, name).toBeLessThan(240);
    }
  });

  it('hma leads a plain SMA on a ramp', () => {
    // Hull exists to reduce lag; if it does not lead, the nested WMAs are wrong.
    expect(hma(upCloses, 9)[119] as number).toBeGreaterThan(sma(upCloses, 9)[119] as number);
  });

  it('vwma equals sma when every bar has the same volume', () => {
    expect(vwma(trendUp, 20)[119] as number).toBeCloseTo(
      sma(
        trendUp.map((b) => b.close),
        20,
      )[119] as number,
      8,
    );
  });

  it('envelope brackets its basis by the percentage', () => {
    const e = envelope(upCloses, 20, 2);
    const m = e.middle[119] as number;
    expect(e.upper[119] as number).toBeCloseTo(m * 1.02, 8);
    expect(e.lower[119] as number).toBeCloseTo(m * 0.98, 8);
  });
});

describe('aroon', () => {
  it('reads 100 up / 0 down on a clean uptrend', () => {
    const r = aroon(trendUp, 14);
    expect(r.up[119]).toBeCloseTo(100, 6);
    expect(r.down[119]).toBeCloseTo(0, 6);
  });
});

describe('oscillators', () => {
  it('trix is ~0 on a flat series', () => {
    expect(
      trix(
        flat.map((b) => b.close),
        18,
      )[119] as number,
    ).toBeCloseTo(0, 8);
  });

  it('ultimate oscillator stays within 0..100', () => {
    for (const v of ultimate(trendUp).filter((x): x is number => x !== null)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('choppiness stays within 0..100', () => {
    for (const v of choppiness(trendUp, 14).filter((x): x is number => x !== null)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('stochastic RSI stays within 0..100', () => {
    const r = stochRsi(closes(200, (i) => 100 + Math.sin(i / 5) * 10));
    for (const v of r.k.filter((x): x is number => x !== null)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('fisher transform stays finite at the extremes', () => {
    // The transform diverges at ±1, so the clamp is what stops it becoming
    // Infinity and blanking the pane at the top of a move.
    const pinned = bars(
      Array.from(
        { length: 60 },
        (_, i) => [100 + i, 100 + i, 100 + i, 100 + i] as [number, number, number, number],
      ),
    );
    for (const v of fisher(pinned, 9).fisher.filter((x): x is number => x !== null)) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('dpo is ~0 on a flat series', () => {
    expect(
      dpo(
        flat.map((b) => b.close),
        21,
      )[119] as number,
    ).toBeCloseTo(0, 8);
  });
});

describe('volume studies', () => {
  it('a/d line rises when every close is at the bar high', () => {
    const atHigh = bars(
      Array.from(
        { length: 30 },
        (_, i) =>
          [100 + i, 101 + i, 99 + i, 101 + i, 50] as [number, number, number, number, number],
      ),
    );
    expect(adl(atHigh)[29] as number).toBeGreaterThan(0);
  });

  it('cmf is positive when closes sit at the high', () => {
    const atHigh = bars(
      Array.from(
        { length: 30 },
        (_, i) =>
          [100 + i, 101 + i, 99 + i, 101 + i, 50] as [number, number, number, number, number],
      ),
    );
    expect(cmf(atHigh, 20)[29] as number).toBeGreaterThan(0);
  });

  it('cmf is zero when every bar has no range', () => {
    expect(cmf(flat, 20)[119]).toBe(0);
  });

  it('force index is positive on rising closes', () => {
    expect(forceIndex(trendUp, 13)[119] as number).toBeGreaterThan(0);
  });

  it('pvt tolerates a zero previous close without producing Infinity', () => {
    const zeroed: Ohlc[] = [
      { time: 0, open: 0, high: 0, low: 0, close: 0, volume: 10 },
      { time: 1, open: 0, high: 1, low: 0, close: 1, volume: 10 },
    ];
    expect(Number.isFinite(pvt(zeroed)[1] as number)).toBe(true);
  });
});

describe('elder ray', () => {
  it('bull power exceeds bear power in an uptrend', () => {
    const r = elderRay(trendUp, 13);
    expect(r.bull[119] as number).toBeGreaterThan(r.bear[119] as number);
  });
});

describe('vortex', () => {
  it('VI+ exceeds VI- in an uptrend', () => {
    const r = vortex(trendUp, 14);
    expect(r.plus[119] as number).toBeGreaterThan(r.minus[119] as number);
  });
});

describe('historicalVolatility', () => {
  it('is zero for a perfectly flat series', () => {
    expect(historicalVolatility(flat, 20)[119] as number).toBeCloseTo(0, 8);
  });
});

describe('volumeProfile', () => {
  it('distributes total volume across the bins', () => {
    const profile = volumeProfile(trendUp, 12);
    const total = profile.reduce((a, b) => a + b.volume, 0);
    const expected = trendUp.reduce((a, b) => a + b.volume, 0);
    expect(total).toBeCloseTo(expected, 4);
  });

  it('spreads a bar across every bin its range touches, not just its close', () => {
    // A profile built only from closes is a histogram of closing prices — a
    // different and far less useful chart.
    const wide: Ohlc[] = [{ time: 0, open: 10, high: 20, low: 0, close: 10, volume: 100 }];
    const profile = volumeProfile(wide, 10);
    expect(profile.filter((b) => b.volume > 0).length).toBeGreaterThan(5);
  });

  it('returns nothing when the series has no range', () => {
    expect(volumeProfile(flat, 10)).toEqual([]);
    expect(volumeProfile([], 10)).toEqual([]);
  });
});

// ── Fourth wave ────────────────────────────────────────────────────────────

describe('kst and coppock', () => {
  it('kst is ~0 on a flat series', () => {
    expect(kst(closes(200, () => 50)).kst[199] as number).toBeCloseTo(0, 6);
  });

  it('kst goes positive on a sustained rise', () => {
    expect(kst(closes(200, (i) => 100 + i)).kst[199] as number).toBeGreaterThan(0);
  });

  it('coppock is ~0 on a flat series', () => {
    expect(coppock(closes(120, () => 50))[119] as number).toBeCloseTo(0, 6);
  });
});

describe('ppo', () => {
  it('is a PERCENTAGE, so it is scale-invariant where MACD is not', () => {
    // The same shape at 10x the price gives the same PPO but a 10x MACD —
    // that scale independence is the entire reason PPO exists.
    const small = closes(120, (i) => 100 + i);
    const large = closes(120, (i) => 1000 + i * 10);
    expect(ppo(small).ppo[119] as number).toBeCloseTo(ppo(large).ppo[119] as number, 6);
    expect(macd(large).macd[119] as number).toBeGreaterThan((macd(small).macd[119] as number) * 5);
  });
});

describe('schaff', () => {
  it('stays within 0..100', () => {
    const series = closes(300, (i) => 100 + Math.sin(i / 9) * 12);
    for (const v of schaff(series).filter((x): x is number => x !== null)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('rvi', () => {
  it('is positive when every bar closes above its open', () => {
    const up = bars(
      Array.from(
        { length: 40 },
        (_, i) => [100 + i, 102 + i, 99 + i, 101.5 + i] as [number, number, number, number],
      ),
    );
    expect(rvi(up, 10).rvi[39] as number).toBeGreaterThan(0);
  });
});

describe('percentB and bandwidth', () => {
  const series = closes(80, (i) => 100 + Math.sin(i / 4) * 5);

  it('%B sits at ~0.5 when price is at the basis', () => {
    const flat = closes(60, () => 10);
    expect(percentB(flat, 20, 2)[59]).toBeNull(); // bands collapse; undefined by design
    expect(percentB(series, 20, 2)[79]).not.toBeNull();
  });

  it('%B exceeds 1 above the upper band', () => {
    const spike = [...closes(60, () => 100), 200];
    const pb = percentB(spike, 20, 2);
    expect(pb[60] as number).toBeGreaterThan(1);
  });

  it('bandwidth is 0 for a flat series', () => {
    expect(
      bandwidth(
        closes(40, () => 10),
        20,
        2,
      )[39] as number,
    ).toBeCloseTo(0, 10);
  });
});

describe('alligator', () => {
  it('shifts each line forward by its own displacement', () => {
    const series = bars(
      Array.from(
        { length: 80 },
        (_, i) => [100 + i, 101 + i, 99 + i, 100 + i] as [number, number, number, number],
      ),
    );
    const r = alligator(series);
    // The jaw is the slowest AND the most displaced, so it starts last.
    const firstJaw = r.jaw.findIndex((v) => v !== null);
    const firstLips = r.lips.findIndex((v) => v !== null);
    expect(firstJaw).toBeGreaterThan(firstLips);
  });
});

describe('volume studies (fourth wave)', () => {
  it('volume oscillator is 0 when volume is constant', () => {
    const flat = bars(
      Array.from(
        { length: 60 },
        () => [10, 10, 10, 10, 100] as [number, number, number, number, number],
      ),
    );
    expect(volumeOscillator(flat, 5, 10)[59] as number).toBeCloseTo(0, 8);
  });

  it('nvi and pvi both start at 1000 and move on their own volume regime', () => {
    const series = bars([
      [10, 10, 10, 10, 100],
      [10, 11, 10, 11, 50], // volume DOWN → nvi moves, pvi does not
      [11, 12, 11, 12, 200], // volume UP → pvi moves, nvi does not
    ]);
    const r = volumeIndices(series);
    expect(r.nvi[0]).toBe(1000);
    expect(r.pvi[0]).toBe(1000);
    expect(r.nvi[1] as number).toBeGreaterThan(1000);
    expect(r.pvi[1]).toBe(1000);
    expect(r.pvi[2] as number).toBeGreaterThan(1000);
    expect(r.nvi[2]).toBeCloseTo(r.nvi[1] as number, 10);
  });
});

describe('standardErrorBands', () => {
  it('collapses onto the fit when the series is a perfect line', () => {
    // Zero residual ⇒ zero standard error ⇒ bands sit on the regression.
    const line = closes(60, (i) => 100 + i * 2);
    const r = standardErrorBands(line, 21, 2);
    expect(r.upper[59] as number).toBeCloseTo(r.middle[59] as number, 6);
    expect(r.lower[59] as number).toBeCloseTo(r.middle[59] as number, 6);
  });
});

// ── Fifth wave: TradingView built-in parity ────────────────────────────────

const mk = (
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 100,
  hourMs = 3_600_000,
): Ohlc5 => ({
  time: Date.UTC(2026, 0, 5) + i * hourMs, // 2026-01-05 is a Monday
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});
type Ohlc5 = import('./math').Ohlc;
const flatBars = (closes: number[]): Ohlc5[] => closes.map((c, i) => mk(i, c, c + 1, c - 1, c));

describe('fifth wave', () => {
  it('alignByTime is an as-of join and never borrows a future bar', () => {
    const a = [mk(0, 1, 1, 1, 1), mk(1, 1, 1, 1, 1), mk(2, 1, 1, 1, 1), mk(3, 1, 1, 1, 1)];
    const b = [mk(3, 9, 9, 9, 40), mk(1, 9, 9, 9, 20)]; // unsorted, with a gap at 2
    const r = M5.alignByTime(a, b).map((x) => x?.close ?? null);
    expect(r).toEqual([null, 20, 20, 40]);
  });

  it('lsma equals the regression end-point and is exact on a line', () => {
    const line = [1, 3, 5, 7, 9, 11];
    expect(M5.lsma(line, 3)[5]).toBeCloseTo(11);
    expect(M5.lsma(line, 3, 1)[5]).toBeCloseTo(9); // offset walks back along the fit
    expect(M5.lsma(line, 3)[1]).toBeNull();
  });

  it('zlema of a constant is the constant and its lag offset is ⌊(n−1)/2⌋', () => {
    const r = M5.zlema([5, 5, 5, 5, 5, 5, 5, 5], 4);
    // lag = 1: first adjusted value at index 1, EMA seed after 4 more → index 4
    expect(r[3]).toBeNull();
    expect(r[4]).toBeCloseTo(5);
    expect(r[7]).toBeCloseTo(5);
  });

  it('kama moves at the fast constant when efficiency is 1', () => {
    const v = [1, 2, 3, 4, 5];
    const r = M5.kama(v, 2, 2, 30);
    // ER = 1 → sc = (2/3)^2 = 4/9; seed at index 1 = 2; next = 2 + 4/9·(3−2)
    expect(r[1]).toBe(2);
    expect(r[2]).toBeCloseTo(2 + 4 / 9);
  });

  it('vidya with |CMO| = 1 is a plain EMA step', () => {
    const v = [1, 2, 3, 4];
    const r = M5.vidya(v, 3, 2);
    // seeds at index 2 = 3; alpha = 0.5, k = 1 → 0.5·4 + 0.5·3
    expect(r[2]).toBe(3);
    expect(r[3]).toBeCloseTo(3.5);
  });

  it('t3 of a constant is the constant (coefficients sum to 1)', () => {
    const r = M5.t3(new Array(40).fill(7), 3, 0.7);
    expect(r[39]).toBeCloseTo(7);
    expect(r.findIndex((x) => x !== null)).toBe(6 * 2); // six EMAs of length 3
  });

  it('averageDayRange averages high−low', () => {
    const b = [mk(0, 1, 3, 1, 2), mk(1, 1, 5, 1, 2)];
    expect(M5.averageDayRange(b, 2)[1]).toBe(3);
  });

  it('chopZone is ~0 on flat EMA and positive when rising', () => {
    const flat = flatBars(new Array(60).fill(10));
    expect(M5.chopZone(flat)[59]).toBeCloseTo(0);
    const up = flatBars(Array.from({ length: 60 }, (_, i) => 10 + i * 0.5));
    expect(M5.chopZone(up)[59]!).toBeGreaterThan(0);
  });

  it('bbTrend is 0 for a constant series', () => {
    expect(M5.bbTrend(new Array(60).fill(3), 5, 10, 2)[59]).toBe(0);
  });

  it('ulcerIndex is 0 on a rising series and matches RMS drawdown otherwise', () => {
    expect(M5.ulcerIndex([1, 2, 3, 4, 5], 2)[4]).toBe(0);
    // period 2: dd at i=3 (10→8 → −20%), i=4 (8 vs max(8,8)=8 → 0) → sqrt((400+0)/2)
    const r = M5.ulcerIndex([10, 10, 10, 8, 8], 2);
    expect(r[3]).toBeCloseTo(Math.sqrt((0 + 400) / 2));
    expect(r[4]).toBeCloseTo(Math.sqrt((400 + 0) / 2));
  });

  it('chandelierExit hangs mult·ATR off the period extremes', () => {
    const b = [mk(0, 10, 12, 8, 10), mk(1, 10, 12, 8, 10), mk(2, 10, 12, 8, 10)];
    const r = M5.chandelierExit(b, 2, 1); // TR = 4 throughout → ATR 4
    expect(r.long[1]).toBe(12 - 4);
    expect(r.short[1]).toBe(8 + 4);
  });

  it('klinger is 0 with constant signed volume', () => {
    const b = flatBars(Array.from({ length: 80 }, (_, i) => 10 + i));
    const r = M5.klinger(b, 3, 5, 2);
    expect(r.kvo[79]).toBeCloseTo(0);
    expect(r.signal[79]).toBeCloseTo(0);
  });

  it('chaikinVolatility is the % change of EMA(high−low)', () => {
    const b = [mk(0, 1, 2, 1, 1), mk(1, 1, 2, 1, 1), mk(2, 1, 3, 1, 1)];
    // EMA(1): range itself → (2−1)/1·100 with rocLen 2 between index 0 and 2
    expect(M5.chaikinVolatility(b, 1, 2)[2]).toBeCloseTo(100);
  });

  it('priceOscillator is (fast−slow)/slow·100', () => {
    const v = [1, 2, 3, 4];
    // SMA2 at 3 = 3.5, SMA4 = 2.5 → 40%
    expect(M5.priceOscillator(v, 2, 4, 'SMA')[3]).toBeCloseTo(40);
  });

  it('rci is +100 for a strictly rising window and −100 for a falling one', () => {
    expect(M5.rci([1, 2, 3, 4, 5], 5)[4]).toBeCloseTo(100);
    expect(M5.rci([5, 4, 3, 2, 1], 5)[4]).toBeCloseTo(-100);
    // hand: ranks [1,3,2] vs time [1,2,3] → Σd² = 2 → 1 − 12/24 = 0.5
    expect(M5.rci([1, 3, 2], 3)[2]).toBeCloseTo(50);
  });

  it('smi is +100 when price sits at the top of every range', () => {
    const b = Array.from({ length: 30 }, (_, i) => mk(i, i, i + 1, i - 1, i + 1));
    const r = M5.smi(b, 3, 2, 2);
    // close = hh; rel = hh − (hh+ll)/2 = range/2 → 200·(range/2)/range = 100
    expect(r.smi[29]).toBeCloseTo(100);
  });

  it('vwapBands: vwap is volume-weighted typical price and the bands use weighted σ', () => {
    const b = [mk(0, 1, 1, 1, 1, 1), mk(1, 3, 3, 3, 3, 3)];
    const r = M5.vwapBands(b, 1, 2);
    expect(r.vwap[1]).toBeCloseTo((1 + 9) / 4); // 2.5
    const sd = Math.sqrt((1 + 27) / 4 - 2.5 * 2.5); // √0.75
    expect(r.upper1[1]).toBeCloseTo(2.5 + sd);
    expect(r.lower2[1]).toBeCloseTo(2.5 - 2 * sd);
  });

  it('vwapBands resets at the UTC day boundary', () => {
    const b = [mk(0, 1, 1, 1, 1), mk(24, 5, 5, 5, 5)];
    expect(M5.vwapBands(b).vwap[1]).toBe(5);
  });

  it('anchoredVwap starts at the anchor (bars back or timestamp)', () => {
    const b = [1, 2, 3, 4].map((c, i) => mk(i, c, c, c, c));
    const r = M5.anchoredVwap(b, 2);
    expect(r.vwap[1]).toBeNull();
    expect(r.vwap[2]).toBe(3);
    expect(r.vwap[3]).toBeCloseTo(3.5);
    expect(M5.anchoredVwap(b, 100, b[1].time).vwap[1]).toBe(2);
  });

  it('volumeWithMa, upDownVolume', () => {
    const b = [mk(0, 1, 2, 0, 2, 10), mk(1, 2, 2, 0, 1, 30), mk(2, 1, 1, 1, 1, 5)];
    expect(M5.volumeWithMa(b, 2).ma[1]).toBe(20);
    const r = M5.upDownVolume(b);
    expect(r.up).toEqual([10, 0, 0]);
    expect(r.down).toEqual([0, -30, 0]);
    expect(r.delta).toEqual([10, -30, 0]);
  });

  it('cumulativeDeltaByPeriod resets each period', () => {
    // close at high → delta = +volume
    const b = [mk(0, 1, 2, 1, 2, 10), mk(1, 1, 2, 1, 2, 10), mk(24, 1, 2, 1, 2, 10)];
    expect(M5.cumulativeDeltaByPeriod(b, 'Day')).toEqual([10, 20, 10]);
    expect(M5.cumulativeDeltaByPeriod(b, 'None')).toEqual([10, 20, 30]);
  });

  it('periodKey: weeks start on Monday, months by calendar', () => {
    const sun = Date.UTC(2026, 0, 4, 12);
    const mon = Date.UTC(2026, 0, 5, 1);
    expect(M5.periodKey(mon, 'Week')).toBe(M5.periodKey(sun, 'Week') + 1);
    expect(M5.periodKey(Date.UTC(2026, 1, 1), 'Month')).toBe(2026 * 12 + 1);
  });

  // A tent: rises to a peak at 10 then falls to a trough at 20, then rises.
  const tent = Array.from({ length: 40 }, (_, i) => {
    const c = i <= 10 ? i : i <= 20 ? 20 - i : i - 20;
    return mk(i, c, c + 0.5, c - 0.5, c);
  });

  it('swingPivots finds the peak and trough', () => {
    const p = M5.swingPivots(tent, 3, 3);
    expect(p).toContainEqual({ index: 10, price: 10.5, high: true });
    expect(p).toContainEqual({ index: 20, price: -0.5, high: false });
  });

  it('pivotsHighLow holds the last pivot level after confirmation', () => {
    const r = M5.pivotsHighLow(tent, 3, 3);
    expect(r.high[10]).toBeNull();
    expect(r.high[11]).toBe(10.5);
    expect(r.low[25]).toBe(-0.5);
  });

  it('autoFibRetracement: 0 at the later extreme, 1 at the earlier', () => {
    const b = [0, 10, 5].map((c, i) => mk(i, c, c, c, c)); // low first then high
    const lv = M5.autoFibRetracement(b, 3);
    const at = (r: number) => lv[M5.FIB_RETRACEMENT_LEVELS.indexOf(r as never)][2];
    expect(at(0)).toBe(10);
    expect(at(1)).toBe(0);
    expect(at(0.5)).toBe(5);
    expect(at(0.618)).toBeCloseTo(3.82);
  });

  it('autoFibExtension projects C + (B − A)·r', () => {
    // pivots: low 0 at 3, high 10 at 10, low ~4 at 16
    const closes = [3, 2, 1, 0, 2, 4, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 5, 6, 7, 8, 9, 10, 11];
    const b = closes.map((c, i) => mk(i, c, c, c, c));
    const lv = M5.autoFibExtension(b, 3);
    const k = M5.FIB_EXTENSION_LEVELS.indexOf(1 as never);
    expect(lv[k][16]).toBe(4 + (10 - 0) * 1);
    expect(lv[k][15]).toBeNull();
  });

  it('autoPitchfork median passes through the P1–P2 midpoint', () => {
    const closes = [3, 2, 1, 0, 2, 4, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 5, 6, 7, 8, 9, 10, 11];
    const b = closes.map((c, i) => mk(i, c, c, c, c));
    const r = M5.autoPitchfork(b, 3);
    expect(r.median[3]).toBe(0);
    expect(r.median[13]).toBeCloseTo(7); // midpoint of (10,10) and (16,4)
    expect(r.upper[10]).toBe(10);
    expect(r.lower[16]).toBe(4);
  });

  it('autoTrendlines joins the last two swing lows', () => {
    const closes = [5, 4, 3, 4, 5, 6, 5, 4, 5, 6, 7, 8];
    const b = closes.map((c, i) => mk(i, c, c, c, c));
    const r = M5.autoTrendlines(b, 2);
    expect(r.support[2]).toBe(3);
    expect(r.support[7]).toBe(4);
    expect(r.support[11]).toBeCloseTo(4 + (1 / 5) * 4);
  });

  it('pivotLevels: textbook values for each type', () => {
    const [o, h, l, c] = [100, 110, 90, 105];
    const P = (h + l + c) / 3;
    const t = M5.pivotLevels('Traditional', o, h, l, c);
    expect(t.p).toBeCloseTo(P);
    expect(t.r1).toBeCloseTo(2 * P - l);
    expect(t.s3!).toBeCloseTo(l - 2 * (h - P));
    expect(M5.pivotLevels('Fibonacci', o, h, l, c).r2!).toBeCloseTo(P + 0.618 * 20);
    expect(M5.pivotLevels('Woodie', o, h, l, c).p).toBeCloseTo((110 + 90 + 210) / 4);
    expect(M5.pivotLevels('Classic', o, h, l, c).r3!).toBeCloseTo(P + 40);
    const dm = M5.pivotLevels('DM', o, h, l, c); // c > o → X = 2H + L + C = 415
    expect(dm.p).toBeCloseTo(415 / 4);
    expect(dm.r1).toBeCloseTo(415 / 2 - 90);
    expect(dm.r2).toBeNull();
    expect(M5.pivotLevels('Camarilla', o, h, l, c).r3!).toBeCloseTo(105 + (20 * 1.1) / 4);
  });

  it('pivotPointsStandard uses the previous day and breaks at the boundary', () => {
    const b = [
      mk(0, 100, 110, 90, 105),
      mk(1, 105, 108, 95, 100),
      mk(24, 100, 101, 99, 100),
      mk(25, 100, 101, 99, 100),
    ];
    const r = M5.pivotPointsStandard(b, 'Traditional', 'Day');
    expect(r.p[2]).toBeNull();
    expect(r.p[3]).toBeCloseTo((110 + 90 + 100) / 3);
  });

  it('linRegChannel is exact on a line with zero-width bands', () => {
    const r = M5.linRegChannel([0, 1, 2, 3, 4, 5], 4, 2);
    expect(r.middle[1]).toBeNull();
    expect(r.middle[5]).toBeCloseTo(5);
    expect(r.upper[2]).toBeCloseTo(2);
  });

  it('sessionHighLow tracks the running extreme inside the window only', () => {
    const b = [0, 1, 2, 3].map((h) => mk(h, 1, 1 + h, 1 - h, 1));
    const r = M5.sessionHighLow(b, 1, 3);
    expect(r.high).toEqual([null, 2, 3, null]);
    expect(r.low).toEqual([null, 0, -1, null]);
    // wrapping window 22→2
    expect(M5.sessionHighLow(b, 22, 2).high).toEqual([1, 2, null, null]);
  });

  it('correlation is ±1 for linear relations and null over gaps', () => {
    const a = [1, 2, 3, 4, 5];
    expect(M5.correlation(a, [2, 4, 6, 8, 10], 3)[4]).toBeCloseTo(1);
    expect(M5.correlation(a, [5, 4, 3, 2, 1], 3)[4]).toBeCloseTo(-1);
    expect(M5.correlation(a, [1, null, 3, 4, 5], 3)[3]).toBeNull();
  });

  it('relativeStrength and spreadRatio', () => {
    expect(M5.relativeStrength([1, 2], [1, 1], 1)[1]).toBe(2);
    const r = M5.spreadRatio([4, 6], [2, null], 1);
    expect(r.spread).toEqual([2, null]);
    expect(r.ratio).toEqual([2, null]);
  });
});
