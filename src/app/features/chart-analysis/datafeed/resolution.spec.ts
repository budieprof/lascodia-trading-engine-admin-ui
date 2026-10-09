import { describe, expect, it } from 'vitest';
import {
  RESOLUTION_SOURCES,
  SUPPORTED_RESOLUTIONS,
  formatResolution,
  isSessionResolution,
  parseInterval,
  isSupportedResolution,
  resolutionMs,
  resolutionSource,
  sourceBarsNeeded,
  type EngineTimeframe,
} from './resolution';
import { pipSizeFor, priceScaleFor, rankSymbols, toSymbolInfo } from './symbol-info';

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
    // Seconds need tick history; 2000 minutes is past Pine's 1440.
    for (const r of ['30S', '2000', 'abc']) {
      expect(resolutionSource(r), r).toBeNull();
      expect(isSupportedResolution(r), r).toBe(false);
    }
  });

  it('reports bar widths in ms — nominal ones on the session grid', () => {
    expect(resolutionMs('1')).toBe(60_000);
    expect(resolutionMs('30')).toBe(30 * 60_000);
    expect(resolutionMs('120')).toBe(2 * 60 * 60_000);
    expect(resolutionMs('240')).toBe(4 * 60 * 60_000);
    expect(resolutionMs('1D')).toBe(86_400_000);
    expect(resolutionMs('1W')).toBe(7 * 86_400_000);
    expect(resolutionMs('1M')).toBe(31 * 86_400_000);
    expect(resolutionMs('30S')).toBeNull();
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

describe('more timeframes (CC-I8)', () => {
  it('folds 2, 3 and 10 minutes from the stored grid, where the engine’s session-anchored bars coincide', () => {
    expect(resolutionSource('2')).toEqual({ kind: 'stored', timeframe: 'M1', aggregate: 2 });
    expect(resolutionSource('3')).toEqual({ kind: 'stored', timeframe: 'M1', aggregate: 3 });
    expect(resolutionSource('10')).toEqual({ kind: 'stored', timeframe: 'M5', aggregate: 2 });
    // 17:00 New York is 21:00 or 22:00 UTC: whole multiples of 2, 3 and 10 minutes …
    for (const m of [2, 3, 10]) expect([(21 * 60) % m, (22 * 60) % m]).toEqual([0, 0]);
    // … but not of 45: the winter open is 15 minutes off a 45-minute epoch grid.
    expect((22 * 60) % 45).not.toBe(0);
  });

  it('takes 45 minutes and 3h / 6h / 8h / 12h from the engine’s session grid', () => {
    for (const r of ['45', '180', '360', '480', '720'])
      expect(isSessionResolution(r), r).toBe(true);
    expect(resolutionMs('180')).toBe(3 * 3_600_000);
  });

  it('parses typed intervals into Pine timeframes', () => {
    expect(parseInterval('45')).toBe('45');
    expect(parseInterval('45m')).toBe('45');
    expect(parseInterval('20min')).toBe('20');
    expect(parseInterval('3h')).toBe('180');
    expect(parseInterval('4H')).toBe('240');
    expect(parseInterval('2d')).toBe('2D');
    expect(parseInterval('1W')).toBe('1W');
    expect(parseInterval('3M')).toBe('3M');
    expect(parseInterval('0')).toBeNull();
    expect(parseInterval('2000')).toBeNull(); // past Pine's 1440 minutes
    expect(parseInterval('13M')).toBeNull();
    expect(parseInterval('abc')).toBeNull();
    expect(parseInterval('30s')).toMatchObject({ error: expect.stringMatching(/tick history/) });
  });

  it('serves a typed interval from the session grid', () => {
    expect(resolutionSource('20')).toEqual({ kind: 'session', nominalMs: 20 * 60_000 });
    expect(isSupportedResolution('2D')).toBe(true);
    expect(isSupportedResolution('2000')).toBe(false);
  });

  it('prints intervals as the toolbar shows them', () => {
    expect(['1', '45', '60', '180', '1D', '2W', '3M'].map(formatResolution)).toEqual([
      '1m',
      '45m',
      '1h',
      '3h',
      '1D',
      '2W',
      '3M',
    ]);
  });
});

describe('rankSymbols — Enter takes the best match (CC-I13)', () => {
  const pairs = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USD'].map((symbol) => ({
    symbol,
  }));

  it('puts the symbol itself first, then prefixes, then the rest', () => {
    expect(rankSymbols(pairs, 'usd').map((p) => p.symbol)).toEqual([
      'USD',
      'USDJPY',
      'USDCHF',
      'EURUSD',
      'GBPUSD',
      'AUDUSD',
    ]);
    expect(rankSymbols(pairs, 'eurusd')[0].symbol).toBe('EURUSD');
  });

  it('lists everything for an empty query and nothing for no match', () => {
    expect(rankSymbols(pairs, ' ')).toHaveLength(6);
    expect(rankSymbols(pairs, 'XAU')).toEqual([]);
  });
});
