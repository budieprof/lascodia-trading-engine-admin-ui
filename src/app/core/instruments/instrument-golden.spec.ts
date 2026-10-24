import { afterEach, describe, expect, it } from 'vitest';

import type { CurrencyPairDto } from '@core/api/api.types';
import {
  distanceUnitOf,
  distanceUnitSize,
  formatDistance,
  formatPrice,
  instrumentFromCurrencyPair,
  priceDecimalsOf,
  resolveInstrument,
  setInstrumentCatalogue,
} from './instrument-math';
import { PipsPipe } from '@shared/pipes/pips.pipe';

/**
 * FX GOLDEN PARITY (multi-asset program rule: live FX display must not change).
 *
 * Fixture: every live `CurrencyPair` row, collected 2026-10-24 by a read-only
 * `SELECT "Symbol","BaseCurrency","QuoteCurrency","DecimalPlaces","ContractSize","AssetClass","PipSize"`
 * on LascodiaTradingEngineDb. `enginePip` is the EA-reported `CurrencyPair.PipSize` — what the engine's
 * `InstrumentMath.ResolvePipSize` returns for the row.
 *
 * The LEGACY_* functions are frozen copies of the eight helpers this program replaced, kept here verbatim so the
 * comparison is against what the console showed before, not against the new code.
 */
const LIVE: [string, string, string, number, number, string, number][] = [
  ['AUDCAD', 'AUD', 'CAD', 5, 100000, 'FxMinor', 0.0001],
  ['AUDNZD', 'AUD', 'NZD', 5, 100000, '', 0.0001],
  ['AUDUSD', 'AUD', 'USD', 5, 100000, 'FxMajor', 0.0001],
  ['CADJPY', 'CAD', 'JPY', 3, 100000, 'FxMinor', 0.01],
  ['DE40', 'EUR', 'EUR', 1, 1, 'Index', 0.1],
  ['EURAUD', 'EUR', 'AUD', 5, 100000, 'FxMinor', 0.0001],
  ['EURCAD', 'EUR', 'CAD', 5, 100000, 'FxMinor', 0.0001],
  ['EURGBP', 'EUR', 'GBP', 5, 100000, 'FxMinor', 0.0001],
  ['EURJPY', 'EUR', 'JPY', 3, 100000, 'FxMinor', 0.01],
  ['EURUSD', 'EUR', 'USD', 5, 100000, 'FxMajor', 0.0001],
  ['GBPAUD', 'GBP', 'AUD', 5, 100000, 'FxMinor', 0.0001],
  ['GBPCAD', 'GBP', 'CAD', 5, 100000, 'FxMinor', 0.0001],
  ['GBPCHF', 'GBP', 'CHF', 5, 100000, 'FxExotic', 0.0001],
  ['GBPJPY', 'GBP', 'JPY', 3, 100000, 'FxMinor', 0.01],
  ['GBPNZD', 'GBP', 'NZD', 5, 100000, 'FxMinor', 0.0001],
  ['GBPUSD', 'GBP', 'USD', 5, 100000, 'FxMajor', 0.0001],
  ['NAS100', 'USD', 'USD', 2, 1, 'Index', 0.01],
  ['NZDJPY', 'NZD', 'JPY', 3, 100000, 'FxMinor', 0.01],
  ['NZDUSD', 'NZD', 'USD', 5, 100000, 'FxMajor', 0.0001],
  ['US500', 'USD', 'USD', 2, 1, 'Index', 0.01],
  ['USDCAD', 'USD', 'CAD', 5, 100000, 'FxMajor', 0.0001],
  ['USDCHF', 'USD', 'CHF', 5, 100000, 'FxMajor', 0.0001],
  ['USDCNH', 'USD', 'CNH', 5, 100000, '', 0.0001],
  ['USDJPY', 'USD', 'JPY', 3, 100000, 'FxMajor', 0.01],
  ['USDNGN', 'USD', 'NGN', 3, 100000, 'FxExotic', 0.01],
  ['XAUUSD', 'XAU', 'USD', 2, 100, 'Commodity', 0.01],
];
/** A representative live price per symbol (for the market-structure helper, which guessed from price). */
const PRICE: Record<string, number> = {
  AUDCAD: 0.91,
  AUDNZD: 1.13,
  AUDUSD: 0.66,
  CADJPY: 109.4,
  DE40: 24100,
  EURAUD: 1.77,
  EURCAD: 1.62,
  EURGBP: 0.87,
  EURJPY: 176.2,
  EURUSD: 1.163,
  GBPAUD: 2.03,
  GBPCAD: 1.86,
  GBPCHF: 1.07,
  GBPJPY: 202.5,
  GBPNZD: 2.31,
  GBPUSD: 1.334,
  NAS100: 25100,
  NZDJPY: 87.2,
  NZDUSD: 0.575,
  US500: 6700,
  USDCAD: 1.4,
  USDCHF: 0.8,
  USDCNH: 7.12,
  USDJPY: 151.8,
  USDNGN: 1465,
  XAUUSD: 4100,
};

function pair(r: (typeof LIVE)[number]): CurrencyPairDto {
  return {
    id: 1,
    symbol: r[0],
    baseCurrency: r[1],
    quoteCurrency: r[2],
    decimalPlaces: r[3],
    contractSize: r[4],
    minLotSize: 0.01,
    maxLotSize: 100,
    lotStep: 0.01,
    isActive: true,
    assetClass: r[5] || null,
  };
}
const FX = LIVE.filter((r) => !['Index', 'Commodity'].includes(r[5]));

// ── Frozen legacy helpers ───────────────────────────────────────────────────────────────────────────────────────
/** datafeed/symbol-info.ts pipSizeFor (the "best" helper — the engine rule). */
function LEGACY_pipSizeFor(decimalPlaces: number, assetClass?: string | null): number {
  const digits =
    Number.isFinite(decimalPlaces) && decimalPlaces >= 0 ? Math.trunc(decimalPlaces) : 5;
  const point = 10 ** -digits;
  const fx = !assetClass || /^fx/i.test(assetClass) || assetClass === 'Unknown';
  return fx && digits >= 3 && digits % 2 === 1 ? point * 10 : point;
}
/** dom/ladder-model.ts pipSizeOf. */
function LEGACY_ladder(digits: number): number {
  const p = (d: number) => 10 ** -Math.max(0, d);
  return digits === 5 || digits === 3 ? p(digits - 1) : p(digits);
}
/** watchlist/watchlist-columns.ts pipSizeOf (no quoted pip). */
function LEGACY_watchlist(symbol: string, digits: number): number {
  const s = symbol.toUpperCase();
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.01;
  if (s.endsWith('JPY')) return 0.01;
  return digits === 3 || digits === 5 ? 10 ** -(digits - 1) : 10 ** -digits;
}
/** trade-signals create-signal-dialog/signal-defaults.ts pipSizeFor. */
function LEGACY_signalDefaults(digits: number): number {
  return digits === 3 || digits === 5 ? 10 ** -(digits - 1) : 10 ** -digits;
}
/** orders-page regex. */
function LEGACY_orders(symbol: string | null): number {
  const s = (symbol ?? '').toUpperCase();
  if (!s) return 0.0001;
  if (s.startsWith('XAU') || s.startsWith('GOLD')) return 0.1;
  if (s.startsWith('XAG') || s.startsWith('SILVER')) return 0.01;
  if (/^(US30|US500|SPX|NAS|USTEC|GER|DE40|UK100|JP225|BTC|ETH)/.test(s)) return 1;
  if (s.includes('JPY')) return 0.01;
  return 0.0001;
}
/** positions-page JPY rule. */
function LEGACY_positions(symbol: string | null): number {
  if (!symbol) return 0.0001;
  return symbol.toUpperCase().includes('JPY') ? 0.01 : 0.0001;
}
/** overlays/market-structure.ts pipSize (by price). */
function LEGACY_marketStructure(price: number): number {
  return price < 20 ? 0.0001 : 0.01;
}
/** shared/.../rec-preview-chart.ts priceDecimals. */
function LEGACY_recPreviewDecimals(symbol: string): number {
  return symbol.includes('JPY') ? 3 : 5;
}

/**
 * Where the old helpers disagreed with the engine for an FX symbol. The new service keeps the ENGINE's answer
 * (`InstrumentMath.ResolvePipSize` = the EA's `PipSize`) — what the console's best helper (`pipSizeFor`) already showed:
 * - USDNGN (3 decimals): positions / orders / rec-preview treated a non-JPY pair as 5-decimal / 0.0001-pip. Kept 0.01 /
 *   3 decimals (the broker's quote) — the old values showed a 1-naira move as 100 pips.
 */
const KNOWN_FX_DISAGREEMENTS = new Set(['USDNGN']);

describe("FX golden parity — catalogue from today's currency pairs", () => {
  afterEach(() => setInstrumentCatalogue([]));

  it('every live row: unit size === pipSizeFor === engine PipSize; decimals === DecimalPlaces', () => {
    setInstrumentCatalogue(LIVE.map((r) => instrumentFromCurrencyPair(pair(r))));
    for (const r of LIVE) {
      const inst = resolveInstrument(r[0]);
      expect(distanceUnitSize(inst), r[0]).toBe(LEGACY_pipSizeFor(r[3], r[5] || null));
      expect(distanceUnitSize(inst), r[0]).toBeCloseTo(r[6], 12);
      expect(inst.priceDecimals, r[0]).toBe(r[3]);
      expect(inst.displayDistance, r[0]).toBe(
        ['Index', 'Commodity'].includes(r[5]) ? 'Points' : 'Pips',
      );
    }
  });

  it("FX rows: every replaced helper shows today's value (documented disagreements excepted)", () => {
    setInstrumentCatalogue(LIVE.map((r) => instrumentFromCurrencyPair(pair(r))));
    for (const r of FX) {
      const [sym, , , digits] = r;
      const pip = distanceUnitOf(sym);
      expect(pip, `${sym} ladder`).toBe(LEGACY_ladder(digits));
      expect(pip, `${sym} watchlist`).toBe(LEGACY_watchlist(sym, digits));
      expect(pip, `${sym} signal-defaults`).toBe(LEGACY_signalDefaults(digits));
      expect(pip, `${sym} market-structure`).toBe(LEGACY_marketStructure(PRICE[sym]));
      if (KNOWN_FX_DISAGREEMENTS.has(sym)) continue;
      expect(pip, `${sym} orders`).toBe(LEGACY_orders(sym));
      expect(pip, `${sym} positions`).toBe(LEGACY_positions(sym));
      expect(priceDecimalsOf(sym), `${sym} rec-preview`).toBe(LEGACY_recPreviewDecimals(sym));
    }
  });

  it('FX rows with NO catalogue (engine unreachable): symbol-only rule = positions/orders/rec-preview today', () => {
    setInstrumentCatalogue([]);
    for (const r of FX) {
      const sym = r[0];
      if (KNOWN_FX_DISAGREEMENTS.has(sym)) continue;
      expect(distanceUnitOf(sym), sym).toBe(LEGACY_positions(sym));
      expect(distanceUnitOf(sym), sym).toBe(LEGACY_orders(sym));
      expect(priceDecimalsOf(sym), sym).toBe(LEGACY_recPreviewDecimals(sym));
    }
  });

  it('pips pipe and distance text are unchanged for FX', () => {
    setInstrumentCatalogue(LIVE.map((r) => instrumentFromCurrencyPair(pair(r))));
    const pipe = new PipsPipe();
    expect(pipe.transform(12.345)).toBe('12.3 pips');
    expect(pipe.transform(12.345, 2, 'EURUSD')).toBe('12.35 pips');
    expect(pipe.transform(null)).toBe('-');
    expect(formatDistance(resolveInstrument('EURUSD'), 0.00123)).toBe('12.3 pips');
    expect(formatDistance(resolveInstrument('USDJPY'), 0.123)).toBe('12.3 pips');
    expect(formatPrice(resolveInstrument('EURUSD'), 1.163)).toBe('1.16300');
    expect(formatPrice(resolveInstrument('USDJPY'), 151.8)).toBe('151.800');
  });

  it('non-FX: points (index/commodity), documented change from the symbol guesses', () => {
    setInstrumentCatalogue(LIVE.map((r) => instrumentFromCurrencyPair(pair(r))));
    // Engine rule: a point. orders-page guessed 1 (indices) / 0.1 (gold); watchlist guessed 0.1 for gold.
    expect(distanceUnitOf('DE40')).toBeCloseTo(0.1, 12);
    expect(distanceUnitOf('NAS100')).toBeCloseTo(0.01, 12);
    expect(distanceUnitOf('XAUUSD')).toBeCloseTo(0.01, 12);
    expect(new PipsPipe().transform(25, 1, 'DE40')).toBe('25.0 points');
  });
});
