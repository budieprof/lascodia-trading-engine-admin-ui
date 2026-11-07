import type { InstrumentAssetClass, InstrumentDto } from '@core/instruments/instrument.types';

/**
 * Which scheduled events concern a symbol (UA01) — the ONE resolver behind the chart's event marks, the news-blackout
 * shading and the economic-calendar pane. It replaces slicing the symbol into "the first three letters and the next
 * three" (which made AAPL listen to nothing and the calendar fall back to every High event of every currency).
 *
 * By asset class, from the instrument the chart already knows:
 * - **FX / metals** — base and quote currencies, exactly as before (the pair's row, else the symbol's two halves).
 * - **Crypto** — the quote's fiat (a stablecoin counts as the fiat it tracks) for macro releases, plus the coin's own
 *   scheduled events (`CR:<coin>`: token unlocks); perpetuals add their funding times (from the derivatives feed).
 * - **Indices** — the index's own currency (the engine's index catalogue: US500/NAS100/US30 → USD, DE40/FR40/STOXX50 →
 *   EUR, UK100 → GBP, JP225 → JPY, HK50 → HKD, AUS200 → AUD) plus `IDX:<index>` (options expiry, rebalances).
 * - **Equities** — the quote currency's macro (USD for US stocks) plus `EQ:<ticker>` (earnings, from the engine's
 *   scheduled-events store). Dividends and splits are drawn only when the engine holds them; it holds none today.
 * - **Energy** — USD macro plus the commodity's own key (WTI / BRENT / NATGAS: inventories, rig counts, OPEC+).
 * - **Futures** — a currency future (6E: EUR/USD) both currencies, others the quote currency; the contract's last
 *   trade date is marked when the instrument carries it.
 *
 * The market keys are the engine's exposure keys (news-intel `ExposureCatalogue`), so the chart reads the same rows the
 * multi-asset blackout reads. `blackoutCurrencies` mirrors `NewsBlackoutRules.CurrenciesOf` (the keys live ENFORCES —
 * the widened ones only refuse under `NewsBlackout:MultiAsset:Mode=Enforce`, which the chart cannot see): the shading
 * shows what is refused, and a symbol live never blocks is shaded nowhere. Pure.
 */

export type RelevanceKind =
  | 'fx'
  | 'crypto'
  | 'index'
  | 'equity'
  | 'energy'
  | 'future'
  | 'commodity'
  | 'unknown';

export interface EventRelevance {
  kind: RelevanceKind;
  /** Economic-calendar currencies whose releases concern the symbol. Empty: none known — nothing is loaded. */
  currencies: string[];
  /** Scheduled market-event keys (news-intel exposure keys: `EQ:AAPL`, `WTI`, `IDX:US500`, `CR:BTC`). */
  marketKeys: string[];
  /** The calendar keys the live news blackout enforces for the symbol (mirror of `NewsBlackoutRules.CurrenciesOf`). */
  blackoutCurrencies: string[];
  /** A dated future's last trading instant (UTC ms) to mark, when the instrument carries it. */
  expiryMs: number | null;
  /** A crypto perpetual: its funding times are marked (from the derivatives feed). */
  funding: boolean;
  /** One line saying what is shown: "USD releases · AAPL earnings". */
  summary: string;
}

export interface RelevanceInput {
  symbol: string;
  assetClass: InstrumentAssetClass | null;
  /** The MT5 broker row's currencies (the chart's currency-pair list), when there is one. */
  pairBase?: string | null;
  pairQuote?: string | null;
  /** The instrument (catalogue row or the one derived from the pair). */
  instrument?: Pick<
    InstrumentDto,
    'baseCurrency' | 'quoteCurrency' | 'future' | 'crypto' | 'symbol'
  > | null;
}

/** ISO 4217 codes the engine's exposure catalogue knows (plus offshore CNH). */
const ISO = new Set(
  (
    'USD EUR GBP JPY AUD NZD CAD CHF CNH CNY HKD SGD NOK SEK DKK PLN CZK HUF TRY ZAR MXN BRL INR IDR KRW THB TWD PHP ' +
    'MYR RUB ILS SAR AED NGN KES EGP CLP COP PEN ARS UAH KZT VND PKR QAR KWD BHD OMR RON BGN ISK GHS MAD TND JOD LKR ' +
    'BDT NPR UGX TZS'
  ).split(' '),
);
const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

/** Stablecoins → the fiat they track (engine `ExposureCatalogue.Stablecoins`). */
const STABLES: Record<string, string> = {
  USDT: 'USD',
  USDC: 'USD',
  BUSD: 'USD',
  FDUSD: 'USD',
  TUSD: 'USD',
  USD1: 'USD',
  USDP: 'USD',
  PAX: 'USD',
  PYUSD: 'USD',
  DAI: 'USD',
  USDE: 'USD',
  USDS: 'USD',
  EURC: 'EUR',
  EURCV: 'EUR',
  EURT: 'EUR',
  EURI: 'EUR',
  BIDR: 'IDR',
  BKRW: 'KRW',
};
const COIN_ALIASES: Record<string, string> = { XBT: 'BTC', XDG: 'DOGE' };

/** The engine's index catalogue (`IndexInstruments.Catalogue`): canonical name, currency, broker aliases. */
const INDICES: readonly { symbol: string; currency: string; aliases: string[]; core: boolean }[] = [
  {
    symbol: 'US500',
    currency: 'USD',
    core: true,
    aliases: ['SPX500', 'SP500', 'USA500', 'SPX', 'US500CASH', 'SPX500CASH'],
  },
  {
    symbol: 'NAS100',
    currency: 'USD',
    core: true,
    aliases: ['USTEC', 'US100', 'NDX100', 'NDX', 'USTECH', 'USTEC100', 'NAS100CASH', 'US100CASH'],
  },
  {
    symbol: 'DE40',
    currency: 'EUR',
    core: true,
    aliases: ['GER40', 'DE30', 'GER30', 'DAX40', 'DAX30', 'DAX', 'DE40CASH', 'GER40CASH'],
  },
  {
    symbol: 'US30',
    currency: 'USD',
    core: false,
    aliases: ['DJ30', 'DJI', 'DOW30', 'WS30', 'USA30', 'US30CASH', 'DJ30CASH'],
  },
  {
    symbol: 'UK100',
    currency: 'GBP',
    core: false,
    aliases: ['FTSE100', 'GB100', 'UK100CASH', 'FTSE'],
  },
  {
    symbol: 'FR40',
    currency: 'EUR',
    core: false,
    aliases: ['CAC40', 'FRA40', 'F40', 'FR40CASH', 'CAC'],
  },
  {
    symbol: 'STOXX50',
    currency: 'EUR',
    core: false,
    aliases: ['EU50', 'SX5E', 'ESTX50', 'EUSTX50', 'STOXX50E', 'EU50CASH'],
  },
  {
    symbol: 'JP225',
    currency: 'JPY',
    core: false,
    aliases: ['JPN225', 'NIKKEI', 'NIKKEI225', 'NI225', 'N225', 'JP225CASH'],
  },
  {
    symbol: 'HK50',
    currency: 'HKD',
    core: false,
    aliases: ['HSI', 'HKG50', 'HANGSENG', 'HK50CASH'],
  },
  {
    symbol: 'AUS200',
    currency: 'AUD',
    core: false,
    aliases: ['ASX200', 'AU200', 'AUS200CASH', 'XJO'],
  },
];

/** Energy CFDs → commodity key (engine `ExposureCatalogue.Energy`). */
const ENERGY: readonly { key: string; names: string[] }[] = [
  {
    key: 'WTI',
    names: ['USOIL', 'WTI', 'XTIUSD', 'USOUSD', 'WTIUSD', 'USCRUDE', 'CRUDEOIL', 'OILUSD'],
  },
  { key: 'BRENT', names: ['UKOIL', 'BRENT', 'XBRUSD', 'UKOUSD', 'BRENTUSD', 'UKBRENT'] },
  { key: 'NATGAS', names: ['XNGUSD', 'NATGAS', 'NGAS', 'XNG', 'NATGASUSD', 'NGASUSD', 'USGAS'] },
];

/**
 * A broker spelling reduced the way the engine's `SymbolNormalizer` does: upper case, a `.`/`-`/`_` suffix dropped
 * (`EURUSD.pro`, `US500-cash`), a trailing lower-case broker letter dropped (`EURUSDm`).
 */
export function normalizeSymbol(symbol: string): string {
  let s = (symbol ?? '').trim();
  s = s.replace(/[._][A-Za-z0-9]+$/, '');
  if (/^[A-Z0-9]{6,}[a-z]$/.test(s)) s = s.slice(0, -1);
  return s.toUpperCase();
}

function indexOf(symbol: string, core: boolean): (typeof INDICES)[number] | null {
  const s = normalizeSymbol(symbol);
  return (
    INDICES.find((i) => (!core || i.core) && (i.symbol === s || i.aliases.includes(s))) ?? null
  );
}

function energyOf(symbol: string): string | null {
  const s = normalizeSymbol(symbol);
  return ENERGY.find((e) => e.names.includes(s))?.key ?? null;
}

const up = (c: string | null | undefined): string => (c ?? '').trim().toUpperCase();

/**
 * The currencies the live news blackout ENFORCES for a symbol — `NewsBlackoutRules.LegacyCurrenciesOf`, verbatim: a
 * core catalogue index (US500, NAS100, DE40 and their aliases) its own currency; a symbol shorter than six characters
 * none; a letters-and-digits symbol its first three and next three characters; anything else (`BTC/USD`) its first
 * and last three.
 */
export function blackoutCurrenciesOf(symbol: string): string[] {
  const upper = (symbol ?? '').trim().toUpperCase();
  if (!upper) return [];
  const index = indexOf(upper, true);
  if (index) return [index.currency];
  if (upper.length < 6) return [];
  if (/^[A-Z0-9]+$/.test(upper)) return [upper.slice(0, 3), upper.slice(3, 6)];
  return [upper.slice(0, 3), upper.slice(-3)];
}

/** `BTC-USDT` / `BTC/USD` / `BTC-USD-PERP` → base and quote; null when the symbol is not separated. */
function separatedLegs(symbol: string): { base: string; quote: string } | null {
  const parts = up(symbol).split(/[-/]/).filter(Boolean);
  return parts.length >= 2 ? { base: parts[0], quote: parts[1] } : null;
}

function fiatOf(quote: string): string | null {
  if (ISO.has(quote)) return quote;
  return STABLES[quote] ?? null;
}

const listOf = (xs: readonly (string | null | undefined)[]): string[] => [
  ...new Set(xs.map(up).filter((x) => x.length > 0)),
];

/** The symbol's relevant events. See the file comment for the rules. */
export function eventRelevance(input: RelevanceInput): EventRelevance {
  const symbol = up(input.symbol);
  const inst = input.instrument ?? null;
  const pairBase = up(input.pairBase);
  const pairQuote = up(input.pairQuote);
  const blackout = blackoutCurrenciesOf(symbol);
  const base: EventRelevance = {
    kind: 'unknown',
    currencies: [],
    marketKeys: [],
    blackoutCurrencies: blackout,
    expiryMs: null,
    funding: false,
    summary: '',
  };
  const done = (
    r: Omit<EventRelevance, 'summary' | 'blackoutCurrencies'> & { blackoutCurrencies?: string[] },
  ) => {
    const out: EventRelevance = {
      ...base,
      ...r,
      blackoutCurrencies: r.blackoutCurrencies ?? blackout,
    };
    return { ...out, summary: relevanceSummary(out) };
  };

  // FX and metals: the pair's two currencies, exactly as the chart has always asked (pair row, else the two halves).
  const pairLike = (b: string, q: string) => b !== q && (ISO.has(b) || METALS.has(b)) && ISO.has(q);
  if (
    input.assetClass === 'Fx' ||
    (pairBase && pairQuote && pairLike(pairBase, pairQuote) && input.assetClass !== 'Future')
  ) {
    const fromPair = listOf([input.pairBase, input.pairQuote]);
    const fromInst = listOf([inst?.baseCurrency, inst?.quoteCurrency]);
    const currencies = fromPair.length
      ? fromPair
      : fromInst.length === 2
        ? fromInst
        : symbol.length >= 6
          ? [symbol.slice(0, 3), symbol.slice(3, 6)]
          : [];
    // The shading has always followed the pair's own currencies for FX — they are what live enforces (6 letters).
    return done({
      kind: 'fx',
      currencies,
      marketKeys: [],
      blackoutCurrencies: currencies,
      expiryMs: null,
      funding: false,
    });
  }

  const index = indexOf(symbol, false);
  if (input.assetClass === 'Index' || (index && input.assetClass !== 'Future')) {
    const currency =
      index?.currency ?? (ISO.has(up(inst?.quoteCurrency)) ? up(inst?.quoteCurrency) : '');
    return done({
      kind: 'index',
      currencies: currency ? [currency] : [],
      marketKeys: [`IDX:${index?.symbol ?? normalizeSymbol(symbol)}`],
      expiryMs: null,
      funding: false,
    });
  }

  const energy = energyOf(symbol);
  if (energy) {
    return done({
      kind: 'energy',
      currencies: ['USD'],
      marketKeys: [energy],
      expiryMs: null,
      funding: false,
    });
  }

  if (input.assetClass === 'Crypto') {
    const legs = separatedLegs(symbol);
    const b =
      COIN_ALIASES[up(inst?.baseCurrency) || legs?.base || ''] ??
      (up(inst?.baseCurrency) || legs?.base || '');
    const q =
      COIN_ALIASES[up(inst?.quoteCurrency) || legs?.quote || ''] ??
      (up(inst?.quoteCurrency) || legs?.quote || '');
    const fiat = fiatOf(q);
    const keys = b && !STABLES[b] ? [`CR:${b}`] : [];
    if (q && !fiat && !METALS.has(q)) keys.push(`CR:${q}`);
    const perp = inst?.crypto?.kind === 'Perpetual' || /-(PERP|SWAP)$/.test(symbol);
    return done({
      kind: 'crypto',
      currencies: fiat ? [fiat] : METALS.has(q) ? [q] : [],
      marketKeys: keys,
      expiryMs: null,
      funding: perp,
    });
  }

  if (input.assetClass === 'Future') {
    const b = up(inst?.baseCurrency);
    const q = up(inst?.quoteCurrency);
    const currencies = ISO.has(b) && ISO.has(q) && b !== q ? [b, q] : ISO.has(q) ? [q] : [];
    const last = Date.parse(inst?.future?.lastTradeDate ?? inst?.future?.expiry ?? '');
    return done({
      kind: 'future',
      currencies,
      marketKeys: [],
      expiryMs: Number.isFinite(last) ? last : null,
      funding: false,
    });
  }

  if (input.assetClass === 'Equity' || input.assetClass === 'Etf') {
    const q = up(inst?.quoteCurrency) || pairQuote;
    const ticker = normalizeSymbol(symbol).replace(/[^A-Z]/g, '');
    return done({
      kind: 'equity',
      currencies: ISO.has(q) ? [q] : [],
      marketKeys: ticker ? [`EQ:${ticker}`] : [],
      expiryMs: null,
      funding: false,
    });
  }

  if (input.assetClass === 'Commodity') {
    const q = up(inst?.quoteCurrency) || pairQuote;
    return done({
      kind: 'commodity',
      currencies: ISO.has(q) ? [q] : [],
      marketKeys: [],
      expiryMs: null,
      funding: false,
    });
  }

  // Not placed: only a symbol whose halves are both real currencies is read as a pair; anything else listens to nothing.
  const halves =
    symbol.length >= 6 && /^[A-Z]{6}/.test(symbol) ? [symbol.slice(0, 3), symbol.slice(3, 6)] : [];
  const currencies = halves.length && pairLike(halves[0], halves[1]) ? halves : [];
  return done({ kind: 'unknown', currencies, marketKeys: [], expiryMs: null, funding: false });
}

/** Same events (the computed's equality: a re-resolve to the same answer reloads nothing). */
export function sameRelevance(a: EventRelevance, b: EventRelevance): boolean {
  return (
    a.kind === b.kind &&
    a.currencies.join() === b.currencies.join() &&
    a.marketKeys.join() === b.marketKeys.join() &&
    a.blackoutCurrencies.join() === b.blackoutCurrencies.join() &&
    a.expiryMs === b.expiryMs &&
    a.funding === b.funding
  );
}

const KEY_WORDS: Record<string, string> = {
  WTI: 'WTI oil events',
  BRENT: 'Brent oil events',
  NATGAS: 'natural-gas events',
};

/** "USD releases · AAPL earnings · expiry", or why nothing is shown. */
export function relevanceSummary(
  r: Pick<EventRelevance, 'currencies' | 'marketKeys' | 'expiryMs' | 'funding' | 'kind'>,
): string {
  const parts: string[] = [];
  if (r.currencies.length) parts.push(`${r.currencies.join('/')} releases`);
  for (const k of r.marketKeys) {
    if (k.startsWith('EQ:')) parts.push(`${k.slice(3)} earnings`);
    else if (k.startsWith('IDX:')) parts.push(`${k.slice(4)} expiries`);
    else if (k.startsWith('CR:')) parts.push(`${k.slice(3)} token events`);
    else parts.push(KEY_WORDS[k] ?? `${k} events`);
  }
  if (r.expiryMs !== null) parts.push('contract expiry');
  if (r.funding) parts.push('funding times');
  return parts.length ? parts.join(' · ') : 'no scheduled events are linked to this symbol';
}
