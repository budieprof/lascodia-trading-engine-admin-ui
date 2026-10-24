import { signal } from '@angular/core';

import type { CurrencyPairDto } from '@core/api/api.types';
import type {
  DisplayDistance,
  InstrumentAssetClass,
  InstrumentDto,
  QuantityUnit,
} from './instrument.types';

/**
 * The console's ONE instrument rule book (multi-asset WS7 7.1): price, distance, quantity and money for any
 * instrument. Pure functions plus a module-level catalogue signal (filled by `InstrumentsService`), so the pure helpers
 * of the chart, the watchlist and the pages resolve a symbol without a constructor — and a `computed()` that resolved a
 * symbol before the catalogue arrived recomputes when it does.
 *
 * FX parity: for every FX symbol the pip is today's best helper (`pipSizeFor` = the engine's
 * `InstrumentMath.ResolvePipSize`): ten points on a 3- or 5-decimal quote, one point on the old 2- and 4-decimal ones.
 * Without a catalogue row the symbol-only rule is the engine's `InferPipSizeFromSymbol` (JPY 0.01, else 0.0001).
 */

// ── Asset classes ────────────────────────────────────────────────────────────────────────────────────────────────

/** Today's engine `AssetClass` names (FxMajor, FxMinor, FxExotic, Index, Commodity, Crypto, Unknown) → the contract's. */
export function assetClassFromEngine(engine: string | null | undefined): InstrumentAssetClass {
  const ac = (engine ?? '').trim();
  if (!ac || /^fx/i.test(ac) || /^unknown$/i.test(ac)) return 'Fx';
  switch (ac.toLowerCase()) {
    case 'index':
      return 'Index';
    case 'commodity':
      return 'Commodity';
    case 'crypto':
      return 'Crypto';
    case 'future':
    case 'futures':
      return 'Future';
    case 'equity':
    case 'stock':
      return 'Equity';
    case 'etf':
      return 'Etf';
    default:
      // An asset class this console does not know yet counts as FX, as the engine counts Unknown.
      return 'Fx';
  }
}

export function isFx(inst: Pick<InstrumentDto, 'assetClass'> | null | undefined): boolean {
  return !inst || inst.assetClass === 'Fx';
}

// Engine `StrategyGenerationHelpers` symbol lists (the fallback classifier when no catalogue row exists).
const INDICES = new Set([
  'US30',
  'US500',
  'NAS100',
  'GER40',
  'UK100',
  'JPN225',
  'AUS200',
  'FRA40',
  'SPX500',
  'DJ30',
  'USTEC',
  'DE30',
  'DE40',
]);
const COMMODITIES = new Set([
  'XAUUSD',
  'XAGUSD',
  'XAUEUR',
  'WTIUSD',
  'BRENTUSD',
  'XNGUSD',
  'GOLD',
  'SILVER',
  'OIL',
  'USOIL',
  'UKOIL',
]);
const CRYPTOS = new Set([
  'BTCUSD',
  'ETHUSD',
  'LTCUSD',
  'XRPUSD',
  'BCHUSD',
  'BTCEUR',
  'ETHEUR',
  'BTCGBP',
]);

/**
 * A symbol's asset class from its name alone — the engine's `ClassifyAssetFromSymbol` lists, plus the program's
 * canonical forms (`BTC-USDT`, `BTC-USDT-PERP` crypto; `ES1!` continuous futures). Anything else is FX, as the engine
 * defaults an unclassifiable symbol to FxMajor.
 */
export function classifySymbol(symbol: string): InstrumentAssetClass {
  const s = symbol.trim().toUpperCase();
  if (INDICES.has(s)) return 'Index';
  if (COMMODITIES.has(s)) return 'Commodity';
  if (CRYPTOS.has(s) || /^[A-Z0-9]{2,10}-[A-Z0-9]{2,10}(-PERP)?$/.test(s)) return 'Crypto';
  if (/^[A-Z0-9]{1,4}\d!$/.test(s)) return 'Future';
  return 'Fx';
}

// ── Pips, points, ticks ──────────────────────────────────────────────────────────────────────────────────────────

/** Normalised quote decimals: a non-finite or negative value counts as 5 (today's `pipSizeFor` normalisation). */
export function normaliseDecimals(decimalPlaces: number | null | undefined): number {
  return Number.isFinite(decimalPlaces) && (decimalPlaces as number) >= 0
    ? Math.trunc(decimalPlaces as number)
    : 5;
}

/** One FX pip from the quote's decimals: ten points on a fractional (3/5-decimal) quote, else one point. */
export function fxPipSize(decimalPlaces: number): number {
  const digits = normaliseDecimals(decimalPlaces);
  const point = 10 ** -digits;
  return digits >= 3 && digits % 2 === 1 ? point * 10 : point;
}

/** The size of one display-distance unit, in price: the pip (FX), the point, the tick or the cent. */
export function distanceUnitSize(inst: InstrumentDto): number {
  switch (inst.displayDistance) {
    case 'Pips':
      return fxPipSize(inst.priceDecimals);
    case 'Ticks':
      return inst.tickSize > 0 ? inst.tickSize : 10 ** -normaliseDecimals(inst.priceDecimals);
    case 'Cents':
      return 0.01;
    case 'Points':
    case 'Bps':
    default:
      return 10 ** -normaliseDecimals(inst.priceDecimals);
  }
}

/**
 * A price difference in the instrument's display unit (pips for FX). `Bps` needs the reference price; without one it
 * falls back to points.
 */
export function distanceInUnits(
  inst: InstrumentDto,
  priceDelta: number,
  refPrice?: number | null,
): number {
  if (inst.displayDistance === 'Bps' && refPrice && refPrice > 0)
    return (priceDelta / refPrice) * 10_000;
  return priceDelta / distanceUnitSize(inst);
}

const UNIT_LABEL: Record<DisplayDistance, string> = {
  Pips: 'pips',
  Ticks: 'ticks',
  Points: 'points',
  Cents: '¢',
  Bps: 'bps',
};

export function distanceUnitLabel(inst: InstrumentDto | null | undefined): string {
  return UNIT_LABEL[inst?.displayDistance ?? 'Pips'] ?? 'pips';
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────────────────────────

export function formatPrice(inst: InstrumentDto, price: number | null | undefined): string {
  if (price == null || !Number.isFinite(price)) return '—';
  return price.toFixed(Math.min(10, normaliseDecimals(inst.priceDecimals)));
}

/** `12.3 pips` (FX), `4.0 ticks`, `25.0 points` — the pips pipe's shape for every asset class. */
export function formatDistance(
  inst: InstrumentDto,
  priceDelta: number | null | undefined,
  decimals = 1,
  refPrice?: number | null,
): string {
  if (priceDelta == null || !Number.isFinite(priceDelta)) return '-';
  return `${distanceInUnits(inst, priceDelta, refPrice).toFixed(decimals)} ${distanceUnitLabel(inst)}`;
}

/** Decimals a quantity step needs (0.01 → 2, 1 → 0, 0.001 → 3). */
export function stepDecimals(step: number | null | undefined): number {
  if (!step || !Number.isFinite(step) || step <= 0 || step >= 1) return 0;
  return Math.min(8, Math.max(0, Math.round(-Math.log10(step) + 0.49)));
}

const QTY_UNIT: Record<QuantityUnit, [string, string]> = {
  Lots: ['lot', 'lots'],
  Contracts: ['contract', 'contracts'],
  Shares: ['share', 'shares'],
  Coins: ['coin', 'coins'],
};

/** `0.10 lots`, `2 contracts`, `100 shares`, `0.5 BTC`. */
export function formatQuantity(inst: InstrumentDto, qty: number | null | undefined): string {
  if (qty == null || !Number.isFinite(qty)) return '—';
  const unit = inst.quantityUnit ?? 'Lots';
  const dp =
    unit === 'Lots'
      ? Math.max(2, stepDecimals(inst.quantityStep))
      : stepDecimals(inst.quantityStep);
  const text = qty.toFixed(dp);
  if (unit === 'Coins') return `${text} ${inst.baseCurrency || QTY_UNIT.Coins[1]}`;
  const [one, many] = QTY_UNIT[unit] ?? QTY_UNIT.Lots;
  return `${text} ${Math.abs(qty) === 1 ? one : many}`;
}

/** Money in a currency (`USD 1,234.50`); JPY-like zero-decimal currencies keep no decimals. */
export function formatMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const ccy = (currency ?? '').toUpperCase();
  if (/^[A-Z]{3}$/.test(ccy)) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy }).format(value);
    } catch {
      /* not an ISO code Intl knows (USDT, …) — fall through */
    }
  }
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return ccy ? `${text} ${ccy}` : text;
}

/** Money one quantity of the instrument makes or loses over a price difference (in its quote currency). */
export function moneyForMove(inst: InstrumentDto, priceDelta: number, qty: number): number {
  const tick = inst.tickSize > 0 ? inst.tickSize : 10 ** -normaliseDecimals(inst.priceDecimals);
  return (priceDelta / tick) * inst.tickValue * qty;
}

// ── Building instruments ─────────────────────────────────────────────────────────────────────────────────────────

/** The calendar a fallback instrument trades on (the engine backfill's rule). */
function calendarFor(ac: InstrumentAssetClass): string {
  return ac === 'Crypto' ? 'crypto-24x7' : 'fx-24x5';
}

function displayDistanceFor(ac: InstrumentAssetClass): DisplayDistance {
  return ac === 'Fx' ? 'Pips' : ac === 'Future' ? 'Ticks' : 'Points';
}

/**
 * The FX instrument today's currency pair stands for — the fallback while the engine has no `instruments` endpoint.
 * Its pip is exactly `pipSizeFor(decimalPlaces, assetClass)`.
 */
export function instrumentFromCurrencyPair(pair: CurrencyPairDto): InstrumentDto {
  const symbol = (pair.symbol ?? '').toUpperCase();
  const assetClass = assetClassFromEngine(pair.assetClass);
  const digits = normaliseDecimals(pair.decimalPlaces);
  const tickSize = 10 ** -digits;
  const contract = pair.contractSize > 0 ? pair.contractSize : 1;
  return {
    symbol,
    assetClass,
    exchange: null,
    description:
      pair.baseCurrency && pair.quoteCurrency
        ? `${pair.baseCurrency}/${pair.quoteCurrency}`
        : symbol,
    quoteCurrency: pair.quoteCurrency,
    baseCurrency: pair.baseCurrency,
    tickSize,
    tickValue: tickSize * contract,
    multiplier: contract,
    quantityUnit: 'Lots',
    quantityStep: pair.lotStep,
    minQuantity: pair.minLotSize,
    maxQuantity: pair.maxLotSize,
    priceDecimals: digits,
    displayDistance: displayDistanceFor(assetClass),
    tradingCalendarCode: calendarFor(assetClass),
    status: pair.isActive ? 'Active' : 'Inactive',
  };
}

/**
 * An instrument for a symbol the catalogue does not hold — the engine's `ResolvePipSize(null, symbol)` /
 * `ResolveDecimalPlaces(null, symbol)`: FX JPY 3 decimals (pip 0.01), other FX 5 (pip 0.0001), anything else 2
 * decimals with the point as its unit. `hint.digits` (a quote's own decimals) wins over the guess.
 */
export function fallbackInstrument(
  symbol: string,
  hint?: { digits?: number | null; assetClass?: string | null },
): InstrumentDto {
  const s = (symbol ?? '').trim().toUpperCase();
  const assetClass = hint?.assetClass ? assetClassFromEngine(hint.assetClass) : classifySymbol(s);
  const fx = assetClass === 'Fx';
  const hinted = hint?.digits != null && Number.isFinite(hint.digits) && hint.digits >= 0;
  const digits = hinted ? Math.trunc(hint!.digits as number) : fx ? (s.includes('JPY') ? 3 : 5) : 2;
  const tickSize = 10 ** -digits;
  const contract = fx ? 100_000 : assetClass === 'Commodity' ? 100 : 1;
  const crypto = /^([A-Z0-9]+)-([A-Z0-9]+)/.exec(s);
  return {
    symbol: s,
    assetClass,
    exchange: null,
    description: s,
    quoteCurrency: crypto ? crypto[2] : fx && s.length === 6 ? s.slice(3) : null,
    baseCurrency: crypto ? crypto[1] : fx && s.length === 6 ? s.slice(0, 3) : null,
    tickSize,
    tickValue: tickSize * contract,
    multiplier: contract,
    quantityUnit: assetClass === 'Future' ? 'Contracts' : 'Lots',
    quantityStep: assetClass === 'Future' ? 1 : 0.01,
    minQuantity: assetClass === 'Future' ? 1 : 0.01,
    maxQuantity: 100,
    priceDecimals: digits,
    displayDistance: displayDistanceFor(assetClass),
    tradingCalendarCode: calendarFor(assetClass),
    status: null,
  };
}

/**
 * Accepts an engine row loosely (numbers may arrive as strings, enums as numbers) and fills what an older or partial
 * answer leaves out, so the rule book never divides by an undefined tick.
 */
export function normaliseInstrument(
  raw: Partial<InstrumentDto> & { symbol?: string | null },
): InstrumentDto | null {
  const symbol = (raw.symbol ?? '').trim().toUpperCase();
  if (!symbol) return null;
  const assetClass = assetClassFromEngine(raw.assetClass as string | undefined);
  const num = (v: unknown, d: number) => {
    const n = typeof v === 'string' ? Number(v) : (v as number);
    return Number.isFinite(n) ? n : d;
  };
  const digits = normaliseDecimals(num(raw.priceDecimals, assetClass === 'Fx' ? 5 : 2));
  const tickSize = num(raw.tickSize, 10 ** -digits) || 10 ** -digits;
  const dd = raw.displayDistance;
  return {
    ...(raw as InstrumentDto),
    symbol,
    assetClass,
    tickSize,
    tickValue: num(raw.tickValue, 0),
    multiplier: num(raw.multiplier, 1),
    quantityUnit: (raw.quantityUnit as QuantityUnit) ?? 'Lots',
    quantityStep: num(raw.quantityStep, 0.01),
    minQuantity: num(raw.minQuantity, 0),
    maxQuantity: num(raw.maxQuantity, 0),
    priceDecimals: digits,
    // Pips are an FX unit only (program decision): an engine row saying otherwise for a non-FX instrument is shown in
    // its own ticks.
    displayDistance:
      dd && (dd !== 'Pips' || assetClass === 'Fx') ? dd : displayDistanceFor(assetClass),
    exchange: raw.exchange ?? null,
    description: raw.description ?? symbol,
    quoteCurrency: raw.quoteCurrency ?? null,
    tradingCalendarCode: raw.tradingCalendarCode ?? calendarFor(assetClass),
    status: raw.status ?? null,
  };
}

// ── The catalogue ────────────────────────────────────────────────────────────────────────────────────────────────

const catalogue = signal<ReadonlyMap<string, InstrumentDto>>(new Map());

/** Replaces the catalogue (InstrumentsService; tests). */
export function setInstrumentCatalogue(list: readonly InstrumentDto[]): void {
  const map = new Map<string, InstrumentDto>();
  for (const i of list) if (i?.symbol) map.set(i.symbol.toUpperCase(), i);
  catalogue.set(map);
}

/** The catalogue, as a signal read (a `computed` reading it follows the load). */
export function instrumentCatalogue(): ReadonlyMap<string, InstrumentDto> {
  return catalogue();
}

/** The catalogue row for `symbol`, else the symbol-only fallback. Reads the catalogue signal. */
export function resolveInstrument(
  symbol: string | null | undefined,
  hint?: { digits?: number | null; assetClass?: string | null },
): InstrumentDto {
  const key = (symbol ?? '').trim().toUpperCase();
  return catalogue().get(key) ?? fallbackInstrument(key, hint);
}

/** One display-distance unit of `symbol` (the pip for FX), in price. */
export function distanceUnitOf(
  symbol: string | null | undefined,
  hint?: { digits?: number | null; assetClass?: string | null },
): number {
  return distanceUnitSize(resolveInstrument(symbol, hint));
}

/** The quote decimals of `symbol`. */
export function priceDecimalsOf(symbol: string | null | undefined): number {
  return resolveInstrument(symbol).priceDecimals;
}
