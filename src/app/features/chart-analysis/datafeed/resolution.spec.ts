import { describe, expect, it } from 'vitest';
import {
  RESOLUTION_SOURCES,
  SUPPORTED_RESOLUTIONS,
  isSupportedResolution,
  resolutionMs,
  resolutionSource,
  sourceBarsNeeded,
  type EngineTimeframe,
} from './resolution';
import { priceScaleFor, toSymbolInfo } from './symbol-info';

/** The only timeframes the engine's `Timeframe` enum stores. */
const STORED: EngineTimeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

describe('resolution mapping', () => {
  it('only ever sources bars from a timeframe the engine actually stores', () => {
    // The handler answers an unknown timeframe with responseCode -11, and the
    // chart shows that as an endless spinner rather than an error — so this is
    // the test that stops us advertising a resolution we cannot serve.
    for (const [resolution, src] of Object.entries(RESOLUTION_SOURCES)) {
      expect(STORED, `${resolution} sources from ${src.timeframe}`).toContain(src.timeframe);
    }
  });

  it('advertises exactly the resolutions it can source', () => {
    expect([...SUPPORTED_RESOLUTIONS].sort()).toEqual(Object.keys(RESOLUTION_SOURCES).sort());
    for (const r of SUPPORTED_RESOLUTIONS) expect(isSupportedResolution(r)).toBe(true);
  });

  it('serves the six stored timeframes directly, without aggregation', () => {
    for (const r of ['1', '5', '15', '60', '240', '1D']) {
      expect(resolutionSource(r)?.aggregate).toBe(1);
    }
  });

  it('aggregates the three the engine does not store', () => {
    expect(resolutionSource('30')).toEqual({ timeframe: 'M15', aggregate: 2 });
    expect(resolutionSource('1W')).toEqual({ timeframe: 'D1', aggregate: 'week' });
    expect(resolutionSource('1M')).toEqual({ timeframe: 'D1', aggregate: 'month' });
  });

  it('rejects an unknown resolution', () => {
    expect(resolutionSource('3')).toBeNull();
    expect(isSupportedResolution('3')).toBe(false);
  });

  it('reports bar widths in ms', () => {
    expect(resolutionMs('1')).toBe(60_000);
    expect(resolutionMs('30')).toBe(30 * 60_000);
    expect(resolutionMs('240')).toBe(4 * 60 * 60_000);
    expect(resolutionMs('3')).toBeNull();
  });

  it('over-fetches source bars for aggregated resolutions', () => {
    // Asking for 10 source bars to build 10 weekly ones renders a chart ten
    // times too short, so the multiplier must be applied.
    expect(sourceBarsNeeded('1D', 10)).toBe(10);
    expect(sourceBarsNeeded('30', 10)).toBe(20);
    expect(sourceBarsNeeded('1W', 10)).toBe(70);
    expect(sourceBarsNeeded('1M', 2)).toBe(62);
  });
});

describe('symbol info', () => {
  it('scales 5-decimal majors and 3-decimal JPY pairs differently', () => {
    expect(priceScaleFor(5)).toBe(100_000);
    expect(priceScaleFor(3)).toBe(1_000);
  });

  it('falls back to 5 decimals rather than producing a scale of 1', () => {
    // pricescale 1 renders every FX price as a whole number, which reads as a
    // data bug rather than a config bug.
    expect(priceScaleFor(0)).toBe(100_000);
    expect(priceScaleFor(Number.NaN)).toBe(100_000);
  });

  it('declares a Sunday→Friday session, never 24x7', () => {
    const info = toSymbolInfo({
      id: 1,
      symbol: 'EURUSD',
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      decimalPlaces: 5,
      contractSize: 100000,
      minLotSize: 0.01,
      maxLotSize: 100,
      lotStep: 0.01,
      isActive: true,
    });
    expect(info.session).toBe('0000-0000:123456');
    expect(info.session).not.toContain('7');
    expect(info.timezone).toBe('Etc/UTC');
    expect(info.pricescale).toBe(100_000);
    expect(info.description).toBe('EUR/USD');
    expect(info.has_intraday).toBe(true);
  });
});
