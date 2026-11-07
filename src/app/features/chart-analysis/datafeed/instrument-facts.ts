import type { CurrencyPairDto } from '@core/api/api.types';
import {
  classifySymbol,
  distanceUnitLabel,
  distanceUnitSize,
  fallbackInstrument,
  instrumentCatalogue,
  instrumentFromCurrencyPair,
  normaliseDecimals,
} from '@core/instruments/instrument-math';
import type {
  InstrumentAssetClass,
  InstrumentDto,
  QuantityUnit,
} from '@core/instruments/instrument.types';
import type { InstrumentLookupState } from '@core/instruments/instruments.service';
import { isExchangeTraded, unitWord } from '@features/venues/venues.logic';

/**
 * The chart's ONE source of instrument facts (multi-asset chart program UI01): precision, tick / min move, the distance
 * unit and its label, contract value, quantity step and unit, and which ticket the symbol gets. Every "pip", lot and
 * 100 000 on the chart, the tickets, replay, the ladder and the watchlist is read from here.
 *
 * Which row decides:
 * - an EXCHANGE-TRADED catalogue instrument (futures / crypto / equity detail) → the catalogue (the venue's spec);
 * - else the MT5 broker's currency-pair row (what MT5 orders are sized and priced on) — FX keeps exactly the numbers it
 *   always had: decimals from the pair, the pip ten points on a 3/5-decimal quote, the pair's contract and lot step;
 * - else a catalogue row (an engine instrument the broker does not list);
 * - else a GUESS from the symbol (and the bars' own decimals): money and sizing are then unknown, never FX's.
 *
 * Pure: a `computed` calling {@link instrumentFacts} follows the catalogue signal.
 */

export type FactsOrigin = 'catalogue' | 'pair' | 'guess';

/** Which ticket the symbol gets: still resolving (no ticket, no one-click), the MT5 broker's, or a venue's. */
export type TicketRoute =
  | { kind: 'resolving' }
  | { kind: 'mt5' }
  | { kind: 'venue'; name: string; instrument: InstrumentDto };

export interface InstrumentFacts {
  readonly symbol: string;
  readonly origin: FactsOrigin;
  /** The catalogue is still loading / the symbol is being looked up, and no broker row says what it is. */
  readonly resolving: boolean;
  readonly instrument: InstrumentDto;
  readonly assetClass: InstrumentAssetClass;
  readonly isFx: boolean;
  /** Quote decimals. */
  readonly precision: number;
  /** Smallest price increment (the chart's min move). */
  readonly tickSize: number;
  /** One display-distance unit in price: the pip (FX), the tick, the point, the cent, a basis point at `refPrice`. */
  readonly distanceUnit: number;
  /** `pips`, `ticks`, `points`, `¢`, `bps`. */
  readonly distanceLabel: string;
  /** `pip`, `tick`, `point`, `¢`, `bp`. */
  readonly distanceLabelOne: string;
  readonly quoteCurrency: string | null;
  /** Money (in {@link pnlCurrency}) one tick is worth on one quantity unit; null = not known. */
  readonly tickValue: number | null;
  /** Units of the underlying per quantity unit (100 000 for an FX lot, 50 for ES); null = not known. */
  readonly contractValue: number | null;
  /**
   * Money one quantity unit makes on a 1.0 price move (linear contracts): the contract size on an MT5 row (100 000 on
   * FX, as replay always counted), tick value ÷ tick size on a catalogue row; null = not known.
   */
  readonly valuePerPrice: number | null;
  /** Coin-margined (inverse) contract: P&L is in the base coin and not linear in price. */
  readonly inverse: boolean;
  /** The currency P&L is counted in (the quote currency; the base coin for an inverse contract). */
  readonly pnlCurrency: string | null;
  readonly quantityUnit: QuantityUnit;
  /** The order-size step; null = not known (sizing is refused rather than guessed). */
  readonly quantityStep: number | null;
  /** Decimals a quantity is shown and sent with. */
  readonly quantityDecimals: number;
  readonly minQuantity: number | null;
  readonly maxQuantity: number | null;
  readonly route: TicketRoute;
}

export interface FactsContext {
  /** The MT5 broker's row for the symbol (the chart's currency-pair list), if any. */
  pair?: CurrencyPairDto | null;
  /** `InstrumentsService.lookupState(symbol)`; absent = the catalogue as it stands is final. */
  lookup?: InstrumentLookupState;
  /** A price to measure a basis point against (the last close); a function is read only for a Bps instrument. */
  refPrice?: number | null | (() => number | null);
  /**
   * The bars' own decimals, for a guessed NON-FX instrument (never over a real row; an FX guess keeps the engine's
   * JPY 3 / else 5). A function is read only when it is needed.
   */
  digitsHint?: number | null | (() => number | null);
}

const ONE: Record<string, string> = {
  pips: 'pip',
  ticks: 'tick',
  points: 'point',
  '¢': '¢',
  bps: 'bp',
};

/** Decimal places of a step, exactly (0.25 → 2, 0.001 → 3, 1e-8 → 8, 1 → 0). */
export function exactStepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  const s = step.toString();
  if (s.includes('e-')) {
    const [mant, exp] = s.split('e-');
    const dot = mant.indexOf('.');
    return Number(exp) + (dot < 0 ? 0 : mant.length - dot - 1);
  }
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

function positiveOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) && v > 0 ? v : null;
}

function read(v: number | null | undefined | (() => number | null)): number | null {
  return typeof v === 'function' ? v() : (v ?? null);
}

/** The instrument and where it came from, by the precedence in the file comment. */
function pick(
  key: string,
  ctx: FactsContext,
): { inst: InstrumentDto; origin: FactsOrigin; row: InstrumentDto | null } {
  const row = instrumentCatalogue().get(key) ?? null;
  if (row && isExchangeTraded(row)) return { inst: row, origin: 'catalogue', row };
  const pair = ctx.pair;
  if (pair && (pair.symbol ?? '').toUpperCase() === key) {
    // A pair without an asset class takes the catalogue's, else the symbol's — never a blind "Fx" (UI01).
    const assetClass = pair.assetClass || row?.assetClass || classifySymbol(key);
    return { inst: instrumentFromCurrencyPair({ ...pair, assetClass }), origin: 'pair', row };
  }
  if (row) return { inst: row, origin: 'catalogue', row };
  const hint = classifySymbol(key) === 'Fx' ? null : read(ctx.digitsHint);
  return {
    inst: fallbackInstrument(key, { digits: hint }),
    origin: 'guess',
    row: null,
  };
}

/** The facts for `symbol`. Reads the catalogue signal. */
export function instrumentFacts(
  symbol: string | null | undefined,
  ctx: FactsContext = {},
): InstrumentFacts {
  const key = (symbol ?? '').trim().toUpperCase();
  const { inst, origin, row } = pick(key, ctx);
  const isFx = inst.assetClass === 'Fx';
  const precision = normaliseDecimals(inst.priceDecimals);
  const point = 10 ** -precision;
  const tickSize = inst.tickSize > 0 ? inst.tickSize : point;
  const ref = inst.displayDistance === 'Bps' ? read(ctx.refPrice) : null;
  const distanceUnit = distanceUnitSize(inst, ref);
  const distanceLabel = distanceUnitLabel(inst, ref);

  // Money: what the row says. A guess knows the FX lot (100 000 units — the engine's own fallback) and nothing else.
  const moneyKnown = origin !== 'guess' || isFx;
  const tickValue = moneyKnown ? positiveOrNull(inst.tickValue) : null;
  const contractValue = moneyKnown ? positiveOrNull(inst.multiplier) : null;
  const valuePerPrice =
    origin === 'pair' || (origin === 'guess' && isFx)
      ? contractValue
      : tickValue != null
        ? tickValue / tickSize
        : null;
  const inverse = !!inst.crypto && inst.contractType === 'Inverse';
  const pnlCurrency = inverse
    ? (inst.crypto?.settleAsset ?? inst.baseCurrency ?? null)
    : (inst.quoteCurrency ?? null);

  const unit: QuantityUnit = inst.quantityUnit ?? 'Lots';
  const sizingKnown = origin !== 'guess' || isFx;
  const step = sizingKnown
    ? (positiveOrNull(inst.quantityStep) ?? (origin === 'pair' && isFx ? 0.01 : null))
    : null;
  const stepDp = step ? exactStepDecimals(step) : 0;

  const resolving = ctx.lookup === 'resolving' && origin !== 'pair' && !(row && isExchangeTraded(row));
  const route: TicketRoute = resolving
    ? { kind: 'resolving' }
    : row && isExchangeTraded(row)
      ? {
          kind: 'venue',
          name: row.exchange || row.candleSource?.label || 'exchange',
          instrument: row,
        }
      : { kind: 'mt5' };

  return {
    symbol: key,
    origin,
    resolving,
    instrument: inst,
    assetClass: inst.assetClass,
    isFx,
    precision,
    tickSize,
    distanceUnit,
    distanceLabel,
    distanceLabelOne: ONE[distanceLabel] ?? distanceLabel,
    quoteCurrency: inst.quoteCurrency ?? null,
    tickValue,
    contractValue,
    valuePerPrice,
    inverse,
    pnlCurrency,
    quantityUnit: unit,
    quantityStep: step,
    quantityDecimals: unit === 'Lots' ? Math.max(2, stepDp) : stepDp,
    minQuantity: sizingKnown ? positiveOrNull(inst.minQuantity) : null,
    maxQuantity: sizingKnown ? positiveOrNull(inst.maxQuantity) : null,
    route,
  };
}

// ── Reading the facts ────────────────────────────────────────────────────────────────────────────────────────────

/** A price difference in display units (pips for FX); NaN when the unit is not usable. */
export function distanceIn(f: Pick<InstrumentFacts, 'distanceUnit'>, priceDelta: number): number {
  return f.distanceUnit > 0 ? priceDelta / f.distanceUnit : Number.NaN;
}

/** `12.3 pips`, `4.0 ticks`, `25.0 points`; `—` when the delta or the unit is missing. */
export function formatFactsDistance(
  f: Pick<InstrumentFacts, 'distanceUnit' | 'distanceLabel'>,
  priceDelta: number | null | undefined,
  decimals = 1,
): string {
  if (priceDelta == null || !Number.isFinite(priceDelta)) return '—';
  const n = distanceIn(f, priceDelta);
  return Number.isFinite(n) ? `${n.toFixed(decimals)} ${f.distanceLabel}` : '—';
}

/**
 * Profit of `qty` held LONG from `entry` to `exit` (negate for a short), in {@link InstrumentFacts.pnlCurrency}.
 * Linear: move × quantity × value per 1.0 of price — for FX exactly `diff × lots × 100 000`, the formula replay always
 * used. Inverse (coin-margined): contracts × contract value × (1/entry − 1/exit), in the coin. Null when the money
 * facts are unknown.
 */
export function pnlForMove(
  f: Pick<InstrumentFacts, 'valuePerPrice' | 'contractValue' | 'inverse'>,
  entry: number,
  exit: number,
  qty: number,
): number | null {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !Number.isFinite(qty)) return null;
  if (f.inverse) {
    if (!f.contractValue || !(entry > 0) || !(exit > 0)) return null;
    return qty * f.contractValue * (1 / entry - 1 / exit);
  }
  if (f.valuePerPrice == null) return null;
  return (exit - entry) * qty * f.valuePerPrice;
}

/** A quantity rounded to the step's decimals without binary noise. */
function roundQty(q: number, decimals: number): number {
  const k = 10 ** Math.min(12, Math.max(0, decimals));
  return Math.round(q * k) / k;
}

/**
 * A quantity floored to the step (never rounded UP past what was asked), at the step's decimals: 0.0129 BTC on a
 * 0.001 step → 0.012; 0.015 lots on a 0.001 step stays 0.015 (the old 2-decimal rounding made it 0.02). Null when the
 * step is unknown or the result is not positive.
 */
export function snapQuantityDown(
  f: Pick<InstrumentFacts, 'quantityStep' | 'quantityDecimals'>,
  qty: number,
): number | null {
  const step = f.quantityStep;
  if (!step || !Number.isFinite(qty) || qty <= 0) return null;
  const q = roundQty(Math.floor(qty / step + 1e-9) * step, Math.max(f.quantityDecimals, exactStepDecimals(step)));
  return q > 0 ? q : null;
}

/** `lot` / `lots`, `contract(s)`, `share(s)`, the coin (`BTC`) for coins. */
export function quantityWord(
  f: Pick<InstrumentFacts, 'quantityUnit' | 'instrument'>,
  qty = 2,
): string {
  if (f.quantityUnit === 'Coins' && f.instrument.baseCurrency) return f.instrument.baseCurrency;
  return unitWord(f.quantityUnit, qty);
}

/** `0.10 lots`, `2 contracts`, `0.015 BTC`; `—` when missing. */
export function formatFactsQuantity(
  f: Pick<InstrumentFacts, 'quantityUnit' | 'instrument' | 'quantityDecimals'>,
  qty: number | null | undefined,
): string {
  if (qty == null || !Number.isFinite(qty)) return '—';
  return `${qty.toFixed(f.quantityDecimals)} ${quantityWord(f, qty)}`;
}

/** The price scale's format: decimals and the tick as its min move (0.25 for ES, a point for FX). */
export function priceFormatOf(
  f: Pick<InstrumentFacts, 'precision' | 'tickSize'>,
): { type: 'price'; precision: number; minMove: number } {
  return { type: 'price', precision: f.precision, minMove: f.tickSize > 0 ? f.tickSize : 10 ** -f.precision };
}

/**
 * Decimals the prices themselves carry (the most any of them needs, up to 8) — what a guessed instrument shows
 * instead of a blanket 2. Null with no prices.
 */
export function decimalsOfPrices(prices: readonly number[]): number | null {
  let best: number | null = null;
  for (const p of prices) {
    if (!Number.isFinite(p)) continue;
    let d = 0;
    while (d < 8 && Math.abs(p * 10 ** d - Math.round(p * 10 ** d)) > 1e-6) d++;
    best = best === null ? d : Math.max(best, d);
  }
  return best;
}

/** The badge a ticket wears: "MT5 broker", "Venue: Coinbase", "Resolving instrument…". */
export function routeBadge(route: TicketRoute): string {
  switch (route.kind) {
    case 'venue':
      return `Venue: ${route.name}`;
    case 'mt5':
      return 'MT5 broker';
    default:
      return 'Resolving instrument…';
  }
}

/** Equal facts (a `computed`'s `equal`): consumers re-run only when something they show changed. */
export function sameFacts(a: InstrumentFacts, b: InstrumentFacts): boolean {
  return (
    a === b ||
    (a.symbol === b.symbol &&
      a.instrument === b.instrument &&
      a.origin === b.origin &&
      a.resolving === b.resolving &&
      a.precision === b.precision &&
      a.tickSize === b.tickSize &&
      a.distanceUnit === b.distanceUnit &&
      a.distanceLabel === b.distanceLabel &&
      a.valuePerPrice === b.valuePerPrice &&
      a.tickValue === b.tickValue &&
      a.contractValue === b.contractValue &&
      a.pnlCurrency === b.pnlCurrency &&
      a.quantityStep === b.quantityStep &&
      a.quantityDecimals === b.quantityDecimals &&
      a.minQuantity === b.minQuantity &&
      a.maxQuantity === b.maxQuantity &&
      a.route.kind === b.route.kind &&
      (a.route.kind !== 'venue' || (b.route.kind === 'venue' && a.route.name === b.route.name)))
  );
}

const SHORT: Record<string, string> = { pips: 'p', ticks: 't', points: 'pt', '¢': '¢', bps: 'bp' };

/** The suffix a compact chart label uses: `12.4p` (pips), `6.0t` (ticks), `25.0pt` (points). */
export function shortDistanceLabel(label: string): string {
  return SHORT[label] ?? ` ${label}`;
}

/**
 * One display unit (the pip on FX) of a broker currency-pair row — the facts' rule for pages that list pairs (market
 * data, the watchlist page): FX keeps its pip, a pair without an asset class takes the catalogue's / the symbol's
 * class instead of a blind FX pip (UI08; replaces `symbol-info.pipSizeFor`).
 */
export function pairDistanceUnit(
  pair: Pick<CurrencyPairDto, 'symbol' | 'decimalPlaces'> & Partial<CurrencyPairDto>,
): number {
  const full: CurrencyPairDto = {
    id: 0,
    baseCurrency: null,
    quoteCurrency: null,
    contractSize: 0,
    minLotSize: 0,
    maxLotSize: 0,
    lotStep: 0,
    isActive: true,
    ...pair,
  } as CurrencyPairDto;
  return instrumentFacts(full.symbol, { pair: full }).distanceUnit;
}
