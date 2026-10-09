import { describe, expect, it } from 'vitest';
import {
  RESOLUTION_SOURCES,
  SUPPORTED_RESOLUTIONS,
  isSessionResolution,
  isSupportedResolution,
  resolutionMs,
  resolutionSource,
  sourceBarsNeeded,
  type EngineTimeframe,
} from './resolution';
import { pipSizeFor, priceScaleFor, toSymbolInfo } from './symbol-info';

/** The only timeframes the engine's `Timeframe` enum stores. */
const STORED: EngineTimeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

describe('resolution mapping', () => {
  it('only ever sources stored bars from a timeframe the engine actually stores', () => {
    // The handler answers an unknown timeframe with responseCode -11, and the
    // chart shows that as an endless spinner rather than an error — so this is
    // the test that stops us advertising a resolution we cannot serve.
    for (const [resolution, src] of Object.entries(RESOLUTION_SOURCES)) {
      if (src.kind === 'stored') {
        expect(STORED, `${resolution} sources from ${src.timeframe}`).toContain(src.timeframe);
      }
    }
  });

  it('advertises exactly the resolutions it can source', () => {
    expect([...SUPPORTED_RESOLUTIONS].sort()).toEqual(Object.keys(RESOLUTION_SOURCES).sort());
    for (const r of SUPPORTED_RESOLUTIONS) expect(isSupportedResolution(r)).toBe(true);
  });

  it('serves 1m … 1h from the stored candles, 30m folded from M15', () => {
    for (const r of ['1', '5', '15', '60']) {
      expect(resolutionSource(r)).toMatchObject({ kind: 'stored', aggregate: 1 });
    }
    expect(resolutionSource('30')).toEqual({ kind: 'stored', timeframe: 'M15', aggregate: 2 });
  });

  it("serves 2h, 4h, 1D, 1W and 1M from the engine's session grid — never the UTC-midnight H4/D1", () => {
    // 17:00 New York is 21:00 or 22:00 UTC: 1h and 30m bars coincide with the session grid, these do not.
    for (const r of ['120', '240', '1D', '1W', '1M']) {
      expect(resolutionSource(r)?.kind, r).toBe('session');
      expect(isSessionResolution(r)).toBe(true);
    }
    for (const r of ['1', '5', '15', '30', '60', '3']) expect(isSessionResolution(r)).toBe(false);
  });

  it('rejects an unknown resolution', () => {
    expect(resolutionSource('3')).toBeNull();
    expect(isSupportedResolution('3')).toBe(false);
  });

  it('reports bar widths in ms — nominal ones on the session grid', () => {
    expect(resolutionMs('1')).toBe(60_000);
    expect(resolutionMs('30')).toBe(30 * 60_000);
    expect(resolutionMs('120')).toBe(2 * 60 * 60_000);
    expect(resolutionMs('240')).toBe(4 * 60 * 60_000);
    expect(resolutionMs('1D')).toBe(86_400_000);
    expect(resolutionMs('1W')).toBe(7 * 86_400_000);
    expect(resolutionMs('1M')).toBe(31 * 86_400_000);
    expect(resolutionMs('3')).toBeNull();
  });

  it('over-fetches source rows for aggregated resolutions; session bars come built, one per bar', () => {
    // Asking for 10 M15 rows to build 10 thirty-minute bars renders a chart half as long.
    expect(sourceBarsNeeded('60', 10)).toBe(10);
    expect(sourceBarsNeeded('30', 10)).toBe(20);
    expect(sourceBarsNeeded('1D', 10)).toBe(10);
    expect(sourceBarsNeeded('1W', 10)).toBe(10);
    expect(sourceBarsNeeded('1M', 2)).toBe(2);
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

describe("pipSizeFor — the engine's pip (InstrumentMath.ResolvePipSize)", () => {
  it('is ten points on fractional FX quotes and one point on the old ones', () => {
    expect(pipSizeFor(5)).toBeCloseTo(0.0001, 12);
    expect(pipSizeFor(3)).toBeCloseTo(0.01, 12);
    expect(pipSizeFor(4)).toBeCloseTo(0.0001, 12);
    expect(pipSizeFor(2)).toBeCloseTo(0.01, 12);
    expect(pipSizeFor(5, 'FxMajor')).toBeCloseTo(0.0001, 12);
  });

  it('is the point for anything that is not FX', () => {
    expect(pipSizeFor(2, 'Commodity')).toBeCloseTo(0.01, 12);
    expect(pipSizeFor(1, 'Index')).toBeCloseTo(0.1, 12);
    expect(pipSizeFor(3, 'Crypto')).toBeCloseTo(0.001, 12);
  });
});
