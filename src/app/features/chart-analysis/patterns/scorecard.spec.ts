import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Ohlc } from '../indicators/math';
import { CANDLESTICK_PATTERNS } from './candlestick-patterns';
import { canExportPine, pineStrategyFor } from './pine-export';
import {
  STRUCTURE_EVENTS,
  candleSignals,
  scoreSignals,
  scoreTrade,
  structureSignals,
  type ScoreSignal,
} from './scorecard';

const H = 3_600_000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): Ohlc => ({
  time: i * H,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

/** A flat market: every bar 1.0000–1.0010, so ATR(14) settles at 0.0010. */
const flat = (n: number): Ohlc[] =>
  Array.from({ length: n }, (_, i) => bar(i, 1.0005, 1.001, 1.0, 1.0005));

describe('pattern scorecard (DR-I8)', () => {
  it('enters at the next open, leaves at the open k bars later, in ATR units after one spread', () => {
    const bars = flat(30);
    // Signal at bar 20 (long). Entry: bar 21 open 1.0005. Bars 21..23 held; exit at bar 24's open.
    bars[22] = bar(22, 1.0005, 1.004, 0.9998, 1.003);
    bars[24] = bar(24, 1.0025, 1.003, 1.002, 1.0025);
    const atrValues = bars.map(() => 0.001);
    const t = scoreTrade(
      bars,
      atrValues,
      { index: 20, direction: 'bullish' },
      { horizon: 3, spread: 0.0001 },
    )!;
    expect(t.r).toBeCloseTo((1.0025 - 1.0005 - 0.0001) / 0.001, 9); // +1.9R
    expect(t.mfeR).toBeCloseTo((1.004 - 1.0005 - 0.0001) / 0.001, 9); // the best high in the held bars
    expect(t.maeR).toBeCloseTo((1.0005 - 0.9998 + 0.0001) / 0.001, 9); // the worst low, plus the spread
    // A short on the same bars loses what the long made, and both pay the spread.
    const s = scoreTrade(
      bars,
      atrValues,
      { index: 20, direction: 'bearish' },
      { horizon: 3, spread: 0.0001 },
    )!;
    expect(s.r).toBeCloseTo((-(1.0025 - 1.0005) - 0.0001) / 0.001, 9);
    // Not scored until all k bars (and the exit open) exist.
    expect(
      scoreTrade(bars, atrValues, { index: 27, direction: 'bullish' }, { horizon: 3, spread: 0 }),
    ).toBeNull();
  });

  it('aggregates per signal and direction: samples, hit rate, mean R', () => {
    const bars = flat(60);
    for (let i = 30; i < 60; i++)
      bars[i] = bar(
        i,
        1.0005 + (i - 30) * 0.0001,
        1.0012 + (i - 30) * 0.0001,
        0.9999 + (i - 30) * 0.0001,
        1.0006 + (i - 30) * 0.0001,
      );
    const sig = (index: number, direction: 'bullish' | 'bearish'): ScoreSignal => ({
      index,
      id: 'x',
      name: 'X',
      direction,
      source: 'candle',
    });
    const scores = scoreSignals(
      bars,
      [sig(35, 'bullish'), sig(40, 'bullish'), sig(41, 'bearish'), sig(59, 'bullish')],
      {
        horizon: 5,
        spread: 0,
      },
    );
    const long = scores.find((s) => s.direction === 'bullish')!;
    const short = scores.find((s) => s.direction === 'bearish')!;
    expect(long.samples).toBe(2); // the signal at 59 has no bars ahead
    expect(long.hitRate).toBe(1);
    expect(long.meanR).toBeGreaterThan(0);
    expect(short.hitRate).toBe(0);
    expect(scores[0].samples).toBeGreaterThanOrEqual(scores[1].samples);
  });

  it('finds breaks of structure once per swing, and climaxes on outsized range AND volume', () => {
    const bars = flat(80);
    // A swing high at bar 20 (confirmed 5 bars later), then a close above it at bar 30.
    bars[20] = bar(20, 1.0005, 1.003, 1.0, 1.0005);
    bars[30] = bar(30, 1.0005, 1.0045, 1.0, 1.004);
    bars[31] = bar(31, 1.004, 1.005, 1.0035, 1.0045); // still above: not a second break
    // A selling climax at 70: range 0.0040 and volume 1000 against means of ~0.0010 / 100.
    bars[70] = bar(70, 1.004, 1.004, 1.0, 1.0002, 1000);
    const events = structureSignals(bars, 5, 2.5);
    expect(events.filter((e) => e.id === 'bos-up').map((e) => e.index)).toEqual([30]);
    const climax = events.find((e) => e.id === 'selling-climax');
    expect(climax?.index).toBe(70);
    expect(climax?.direction).toBe('bullish');
    expect(Object.keys(STRUCTURE_EVENTS)).toHaveLength(4);
  });

  it('scores only the candlestick patterns that point a way', () => {
    const bars = flat(40);
    bars[30] = bar(30, 1.0005, 1.001, 1.0, 1.0005); // a doji-like bar (neutral)
    const ways = new Set<string>(candleSignals(bars).map((s) => s.direction));
    expect(ways.has('neutral')).toBe(false);
  });
});

describe('scorecard → Pine strategy draft (DR-I8)', () => {
  it('exports every directional candlestick pattern and the structure events, not chart patterns', () => {
    for (const p of CANDLESTICK_PATTERNS)
      expect(canExportPine({ source: 'candle', id: p.id }), p.id).toBe(true);
    expect(canExportPine({ source: 'structure', id: 'bos-up' })).toBe(true);
    expect(canExportPine({ source: 'chart', id: 'double-top' })).toBe(false);
  });

  it('writes a v6 strategy that enters on the signal and leaves after the bars held', () => {
    const src = pineStrategyFor(
      {
        source: 'candle',
        id: 'bullish-engulfing',
        name: 'Bullish Engulfing',
        direction: 'bullish',
      },
      { horizon: 10, trendFilter: true, symbol: 'EURUSD', timeframe: '60' },
    )!;
    expect(src.startsWith('//@version=6\n')).toBe(true);
    expect(src).toContain('strategy("Bullish Engulfing — scorecard export"');
    expect(src).toContain('holdBars = input.int(10, "Bars held", minval = 1)');
    expect(src).toContain('pattern = f_black(1) and f_white(0)');
    expect(src).toContain('trendOk = not useTrend or close[2] < sma50[2]');
    expect(src).toContain('strategy.entry("Long", strategy.long)');
    expect(src).toContain('strategy.close_all()');
    const bos = pineStrategyFor(
      {
        source: 'structure',
        id: 'bos-down',
        name: 'Break of structure down',
        direction: 'bearish',
      },
      { horizon: 5, depth: 4 },
    )!;
    expect(bos).toContain('ta.pivotlow(low, depth, depth)');
    expect(bos).toContain('signal = bosDown');
    expect(bos).toContain('strategy.entry("Short", strategy.short)');
  });

  /**
   * The engine's half of this check (`Scripting.UnitTest/ChartParity/PatternScorecardExportTests`) compiles every
   * exported strategy, runs it over the DR-I1 reference window and asserts its Signal marks exactly the bars the
   * scorecard counts here (from bar 20, past the 14-bar body average's warm-up) — and that its trades hold k bars.
   */
  it('writes the engine compile fixture when asked (LASCODIA_WRITE_PINE_EXPORTS=<path>)', () => {
    const fixture = JSON.parse(
      readFileSync(
        join(__dirname, '../indicators/__fixtures__/chart-indicators.reference.json'),
        'utf8',
      ),
    ) as { bars: [number, number, number, number, number, number][] };
    const bars: Ohlc[] = fixture.bars.map(([time, open, high, low, close, volume]) => ({
      time,
      open,
      high,
      low,
      close,
      volume,
    }));
    const expected = (source: 'candle' | 'structure', id: string): number[] =>
      (source === 'candle'
        ? candleSignals(bars, { ids: [id], trend: 'sma50' })
        : structureSignals(bars, 5, 2.5).filter((e) => e.id === id)
      )
        .map((e) => e.index)
        .filter((i) => i >= 20);
    const rows = [
      ...CANDLESTICK_PATTERNS.filter((p) => p.direction !== 'neutral').map((p) => ({
        source: 'candle' as const,
        id: p.id,
        name: p.name,
        direction: p.direction as 'bullish' | 'bearish',
      })),
      ...Object.entries(STRUCTURE_EVENTS).map(([id, e]) => ({
        source: 'structure' as const,
        id,
        name: e.name,
        direction: e.direction,
      })),
    ];
    const scripts = rows.map((r) => ({
      id: `${r.source}:${r.id}`,
      holdBars: 10,
      signals: expected(r.source, r.id),
      source: pineStrategyFor(r, { horizon: 10, trendFilter: true, depth: 5 }),
    }));
    expect(scripts.every((s) => typeof s.source === 'string' && s.source.length > 100)).toBe(true);
    const out = process.env['LASCODIA_WRITE_PINE_EXPORTS'];
    if (out) writeFileSync(out, JSON.stringify(scripts, null, 2) + '\n');
  });
});
