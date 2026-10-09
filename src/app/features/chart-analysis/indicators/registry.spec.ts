import { describe, expect, it } from 'vitest';
import { INDICATORS, INDICATOR_CATEGORIES, defaultParams, indicatorById } from './registry';
import type { Ohlc } from './math';

/**
 * Registry-wide invariants.
 *
 * Each of these is a failure mode that produces NO error at runtime — the
 * indicator is added, the legend shows it, and the pane is simply empty or
 * wrong. That silence is what makes them worth a test.
 */

/**
 * A synthetic series long enough to warm up every indicator here (the longest
 * default lookback is Connors RSI's 100-bar percent rank).
 *
 * Deliberately NOT a straight ramp: a monotonic series has zero deviation, so
 * anything dividing by a standard deviation or a high-low range would hit a
 * guard and return null everywhere, and the "produces values" assertion below
 * would pass vacuously on a broken indicator. The sine wave plus drift gives
 * every formula something real to chew on.
 */
const bars: Ohlc[] = Array.from({ length: 300 }, (_, i) => {
  const base = 100 + i * 0.05 + Math.sin(i / 7) * 3;
  const high = base + 0.8 + Math.abs(Math.cos(i / 5));
  const low = base - 0.8 - Math.abs(Math.sin(i / 11));
  const open = base + Math.sin(i / 3) * 0.3;
  const close = base + Math.cos(i / 4) * 0.4;
  return {
    time: Date.UTC(2026, 0, 1) + i * 3_600_000,
    open,
    high: Math.max(high, open, close),
    low: Math.min(low, open, close),
    close,
    // Vary volume so volume-driven indicators are not fed a constant.
    volume: 1000 + Math.round(Math.abs(Math.sin(i / 6)) * 900),
  };
});

/** A second, related-but-different series for the multi-symbol studies. */
const compareBars: Ohlc[] = bars.map((b, i) => {
  const k = 1.25 + Math.sin(i / 13) * 0.02;
  return { ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k };
});

describe('indicator registry', () => {
  it('gives every indicator a known category and a one-sentence description', () => {
    for (const def of INDICATORS) {
      expect(INDICATOR_CATEGORIES, `${def.id} category`).toContain(def.category);
      expect(def.description.trim().length, `${def.id} description`).toBeGreaterThan(10);
    }
  });

  it('declares options for every select input and a default among them', () => {
    for (const def of INDICATORS) {
      for (const input of def.inputs.filter((i) => i.type === 'select')) {
        expect(input.options?.length, `${def.id}.${input.key}`).toBeGreaterThan(0);
        expect(input.options).toContain(input.default);
      }
    }
  });

  it('marks exactly the indicators with a symbol input as needing compare bars', () => {
    for (const def of INDICATORS) {
      const hasSymbol = def.inputs.some((i) => i.type === 'symbol');
      expect(!!def.needsCompare, def.id).toBe(hasSymbol);
    }
  });

  it('returns bar-aligned all-null series for compare studies when no compare bars are given', () => {
    for (const def of INDICATORS.filter((d) => d.needsCompare)) {
      const r = def.compute(bars, defaultParams(def));
      for (const plot of def.plots) {
        expect(r[plot.key].length).toBe(bars.length);
        expect(r[plot.key].every((v) => v === null)).toBe(true);
      }
    }
  });

  it('computes every select option without error', () => {
    for (const def of INDICATORS) {
      for (const input of def.inputs.filter((i) => i.type === 'select')) {
        for (const opt of input.options ?? []) {
          const r = def.compute(bars, { ...defaultParams(def), [input.key]: opt }, { compareBars });
          for (const plot of def.plots) expect(r[plot.key]?.length).toBe(bars.length);
        }
      }
    }
  });

  it('has unique ids', () => {
    const ids = INDICATORS.map((i) => i.id);
    expect(new Set(ids).size, `duplicate id in ${ids.join(', ')}`).toBe(ids.length);
  });

  it('resolves every id through indicatorById', () => {
    for (const def of INDICATORS) expect(indicatorById(def.id)?.id).toBe(def.id);
  });

  for (const def of INDICATORS) {
    describe(def.id, () => {
      const result = def.compute(bars, defaultParams(def), { compareBars });

      it('returns a series for every declared plot', () => {
        // The trap: a plot whose key `compute` never returns draws nothing,
        // silently. The legend still lists it, so it looks configured.
        for (const plot of def.plots) {
          expect(result[plot.key], `plot "${plot.key}" has no series`).toBeDefined();
        }
      });

      it('returns series aligned one-for-one with the bars', () => {
        // Misalignment shifts an indicator in TIME against the candles it is
        // drawn over — the value looks plausible and sits on the wrong bar.
        for (const plot of def.plots) {
          const series = result[plot.key];
          if (!series) continue;
          expect(series.length, `plot "${plot.key}" is not bar-aligned`).toBe(bars.length);
        }
      });

      it('produces at least one finite value after warm-up', () => {
        // Guards against an indicator that typechecks but returns all-null
        // (a wrong guard, an off-by-one in the warm-up, a NaN poisoning).
        for (const plot of def.plots) {
          const series = result[plot.key];
          if (!series) continue;
          const finite = series.filter((v) => v !== null && Number.isFinite(v));
          expect(finite.length, `plot "${plot.key}" is entirely null/NaN`).toBeGreaterThan(0);
        }
      });

      it('emits no NaN or Infinity', () => {
        // A NaN blanks the pane from that bar on; an Infinity collapses the
        // pane's autoscale so every other plot on it flatlines.
        for (const plot of def.plots) {
          const series = result[plot.key];
          if (!series) continue;
          const bad = series.findIndex((v) => v !== null && !Number.isFinite(v));
          expect(bad, `plot "${plot.key}" has a non-finite value at index ${bad}`).toBe(-1);
        }
      });

      if (def.range) {
        it('stays inside its declared range', () => {
          // A bounded oscillator that escapes its range is a formula error,
          // and it silently rescales the pane for everything sharing it.
          for (const plot of def.plots) {
            const series = result[plot.key];
            if (!series) continue;
            for (const v of series) {
              if (v === null) continue;
              expect(v).toBeGreaterThanOrEqual(def.range!.min);
              expect(v).toBeLessThanOrEqual(def.range!.max);
            }
          }
        });
      }
    });
  }
});

describe('TradingView defaults', () => {
  it('Stochastic %K is unsmoothed by default, as on TradingView (DR-15)', () => {
    const def = indicatorById('stochastic')!;
    expect(defaultParams(def)['smoothK']).toBe(1);
    expect(defaultParams(def)['smoothD']).toBe(3);
  });

  it('SuperTrend draws its up and down trends as two plots that break at a flip (DR-08)', () => {
    const def = indicatorById('supertrend')!;
    expect(def.plots.map((p) => [p.key, p.gaps])).toEqual([
      ['up', 'break'],
      ['down', 'break'],
    ]);
  });

  it('Parabolic SAR is drawn as points, never a joined line (DR-09)', () => {
    expect(indicatorById('psar')!.plots[0].kind).toBe('points');
  });
});
