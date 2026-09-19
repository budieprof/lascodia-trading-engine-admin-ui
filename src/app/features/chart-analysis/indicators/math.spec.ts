import { describe, expect, it } from 'vitest';
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
