import type { InstrumentAssetClass } from '@core/instruments/instrument.types';
import { CURRENCY_FLAG_SVG } from './pair-icon.component';

/**
 * Icon artwork for every non-FX instrument, in the same 32×32 circle-clipped inline-SVG form as the currency flags
 * (TradingView parity): a crypto coin over its quote currency, the home-country flag for an index, an oil drop or a
 * gas flame for energy, and a brand-coloured monogram for a stock or ETF (company logos are trademarks we do not
 * ship; TradingView shows the same monogram when it has no logo). All artwork is static — never user input.
 */

/** A coloured disc with one or two letters on it. */
function monogram(bg: string, text: string, fg = '#fff'): string {
  const size = text.length > 1 ? 13 : 17;
  return (
    `<rect width="32" height="32" fill="${bg}"/>` +
    `<text x="16" y="16.5" text-anchor="middle" dominant-baseline="central" font-family="Inter,Arial,Helvetica,sans-serif" ` +
    `font-size="${size}" font-weight="700" fill="${fg}">${text}</text>`
  );
}

/** A letter with the two short strokes through it that Bitcoin-family logos use (₿ is missing from many fonts). */
function struckLetter(bg: string, letter: string, tilt: number): string {
  return (
    `<rect width="32" height="32" fill="${bg}"/><g transform="rotate(${tilt} 16 16)" fill="#fff">` +
    `<rect x="13.2" y="6" width="1.8" height="20"/><rect x="17" y="6" width="1.8" height="20"/>` +
    `<text x="16.5" y="16.5" text-anchor="middle" dominant-baseline="central" font-family="Inter,Arial,Helvetica,sans-serif" ` +
    `font-size="17" font-weight="800">${letter}</text></g>`
  );
}

function hexagon(r: number): string {
  return Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    return `${(16 + r * Math.cos(a)).toFixed(2)},${(16 + r * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}

/** Crypto coins by ticker: simplified marks in each project's brand colour. */
export const COIN_SVG: Readonly<Record<string, string>> = {
  BTC: struckLetter('#F7931A', 'B', 14),
  BCH: struckLetter('#8DC351', 'B', -14),
  ETH:
    '<rect width="32" height="32" fill="#627EEA"/>' +
    '<path d="M16 5l-7 11.3 7 4.1z" fill="#fff" fill-opacity=".6"/><path d="M16 5l7 11.3-7 4.1z" fill="#fff"/>' +
    '<path d="M16 21.8l-7-4.1 7 9.3z" fill="#fff" fill-opacity=".6"/><path d="M16 21.8l7-4.1-7 9.3z" fill="#fff"/>',
  LTC:
    monogram('#345D9D', 'L') +
    '<path d="M9.5 18.5l9-3.4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  DOGE:
    monogram('#C2A633', 'D') +
    '<path d="M8.5 16.5h7" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  XRP:
    '<rect width="32" height="32" fill="#23292F"/>' +
    '<path d="M8 8.5l5.2 5.2a4 4 0 005.6 0L24 8.5M8 23.5l5.2-5.2a4 4 0 015.6 0L24 23.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  ADA:
    '<rect width="32" height="32" fill="#0033AD"/>' +
    Array.from({ length: 6 }, (_, i) => {
      const a = (i * Math.PI) / 3;
      const o = `<circle cx="${(16 + 9 * Math.cos(a)).toFixed(2)}" cy="${(16 + 9 * Math.sin(a)).toFixed(2)}" r="1.5" fill="#fff"/>`;
      const b = a + Math.PI / 6;
      return (
        o +
        `<circle cx="${(16 + 5 * Math.cos(b)).toFixed(2)}" cy="${(16 + 5 * Math.sin(b)).toFixed(2)}" r="1.9" fill="#fff"/>`
      );
    }).join(''),
  BNB:
    '<rect width="32" height="32" fill="#F3BA2F"/><g fill="#fff">' +
    '<path d="M16 12.6l3.4 3.4-3.4 3.4-3.4-3.4z"/><path d="M16 6l5.6 5.6-2 2L16 10l-3.6 3.6-2-2z"/>' +
    '<path d="M16 26l5.6-5.6-2-2L16 22l-3.6-3.6-2 2z"/><path d="M6 16l2-2 2 2-2 2zM22 16l2-2 2 2-2 2z"/></g>',
  SOL:
    '<rect width="32" height="32" fill="#111"/>' +
    '<path d="M10.5 9.5h13l-2.5 2.6h-13z" fill="#14F195"/><path d="M8 14.7h13l2.5 2.6h-13z" fill="#80A8FF"/>' +
    '<path d="M10.5 19.9h13l-2.5 2.6h-13z" fill="#9945FF"/>',
  DOT:
    '<rect width="32" height="32" fill="#E6007A"/>' +
    '<ellipse cx="16" cy="8.8" rx="4.4" ry="2.5" fill="#fff"/><ellipse cx="16" cy="23.2" rx="4.4" ry="2.5" fill="#fff"/>' +
    '<ellipse cx="9.8" cy="12.4" rx="4.4" ry="2.5" fill="#fff" transform="rotate(60 9.8 12.4)"/>' +
    '<ellipse cx="22.2" cy="12.4" rx="4.4" ry="2.5" fill="#fff" transform="rotate(-60 22.2 12.4)"/>' +
    '<ellipse cx="9.8" cy="19.6" rx="4.4" ry="2.5" fill="#fff" transform="rotate(-60 9.8 19.6)"/>' +
    '<ellipse cx="22.2" cy="19.6" rx="4.4" ry="2.5" fill="#fff" transform="rotate(60 22.2 19.6)"/>',
  LINK: `<rect width="32" height="32" fill="#2A5ADA"/><polygon points="${hexagon(8.5)}" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>`,
  MATIC: `<rect width="32" height="32" fill="#8247E5"/><polygon points="${hexagon(8)}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" transform="rotate(30 16 16)"/>`,
  POL: `<rect width="32" height="32" fill="#8247E5"/><polygon points="${hexagon(8)}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round" transform="rotate(30 16 16)"/>`,
  MANA: '<rect width="32" height="32" fill="#FF2D55"/><path d="M7 23L14 12l7 11z" fill="#fff"/><path d="M17 23l4.5-7 4.5 7z" fill="#FFBC5B"/>',
  AAVE: monogram('#B6509E', 'A'),
  UNI: monogram('#FF007A', 'U'),
  FIL: monogram('#0090FF', 'F'),
  XTZ: monogram('#2C7DF7', 'T'),
  USDT: monogram('#26A17B', 'T'),
  USDC: monogram('#2775CA', '$'),
  AVAX: monogram('#E84142', 'A'),
  TRX: monogram('#EB0029', 'T'),
  SHIB: monogram('#FFA409', 'S'),
  XLM: monogram('#14B6E7', 'S'),
  ATOM: monogram('#2E3148', 'A'),
};

/** Coin names for titles ("Bitcoin / U.S. Dollar"). */
export const COIN_NAME: Readonly<Record<string, string>> = {
  BTC: 'Bitcoin',
  BCH: 'Bitcoin Cash',
  ETH: 'Ethereum',
  LTC: 'Litecoin',
  DOGE: 'Dogecoin',
  XRP: 'XRP',
  ADA: 'Cardano',
  BNB: 'BNB',
  SOL: 'Solana',
  DOT: 'Polkadot',
  LINK: 'Chainlink',
  MATIC: 'Polygon',
  POL: 'Polygon',
  MANA: 'Decentraland',
  AAVE: 'Aave',
  UNI: 'Uniswap',
  FIL: 'Filecoin',
  XTZ: 'Tezos',
  USDT: 'Tether',
  USDC: 'USD Coin',
  AVAX: 'Avalanche',
  TRX: 'TRON',
  SHIB: 'Shiba Inu',
  XLM: 'Stellar',
  ATOM: 'Cosmos',
};

/** Country flags for indices whose country shares a currency with others (the euro area). */
export const COUNTRY_FLAG_SVG: Readonly<Record<string, string>> = {
  DE:
    '<rect width="32" height="32" fill="#FFCE00"/><rect width="32" height="10.67" fill="#000"/>' +
    '<rect y="10.67" width="32" height="10.67" fill="#DD0000"/>',
  FR:
    '<rect width="32" height="32" fill="#fff"/><rect width="10.67" height="32" fill="#0055A4"/>' +
    '<rect x="21.33" width="10.67" height="32" fill="#EF4135"/>',
  ES: '<rect width="32" height="32" fill="#AA151B"/><rect y="8" width="32" height="16" fill="#F1BF00"/>',
  IT:
    '<rect width="32" height="32" fill="#fff"/><rect width="10.67" height="32" fill="#009246"/>' +
    '<rect x="21.33" width="10.67" height="32" fill="#CE2B37"/>',
  NL:
    '<rect width="32" height="32" fill="#fff"/><rect width="32" height="10.67" fill="#AE1C28"/>' +
    '<rect y="21.33" width="32" height="10.67" fill="#21468B"/>',
};

/** Index symbol → the flag it shows (a currency code from the flag table, or a country code). */
const INDEX_FLAG: ReadonlyArray<[RegExp, string]> = [
  [
    /^(US30|US500|US100|US2000|USTEC|NAS100|NAS|NDX|SPX|SP500|SPX500|DJ30|DJI|DOW|RUSSELL|VIX)/,
    'USD',
  ],
  [/^(UK100|FTSE)/, 'GBP'],
  [/^(DE40|DE30|GER40|GER30|DAX)/, 'DE'],
  [/^(FR40|FRA40|CAC)/, 'FR'],
  [/^(ES35|ESP35|SPA35|IBEX)/, 'ES'],
  [/^(IT40|ITA40|FTMIB)/, 'IT'],
  [/^(NL25|NETH25|AEX)/, 'NL'],
  [/^(JP225|JPN225|NIKKEI|N225)/, 'JPY'],
  [/^(AUS200|AU200|ASX)/, 'AUD'],
  [/^(HK50|HK33|HSI|HANGSENG)/, 'HKD'],
  [/^(CN50|CHINA50|CHINAA50|A50)/, 'CNH'],
  [/^(SWI20|CH20|SMI)/, 'CHF'],
  [/^(STOXX50|EU50|EUSTX50|ESTX50|EUSTOXX)/, 'EUR'],
];

const OIL =
  '<rect width="32" height="32" fill="#2F3241"/>' +
  '<path d="M16 6.5c3.6 5.2 6.5 8.8 6.5 12.4a6.5 6.5 0 01-13 0c0-3.6 2.9-7.2 6.5-12.4z" fill="#F0B90B"/>' +
  '<path d="M13 19.5a3 3 0 003 3" fill="none" stroke="#2F3241" stroke-width="1.4" stroke-linecap="round"/>';
const GAS =
  '<rect width="32" height="32" fill="#1B2A47"/>' +
  '<path d="M16 5.5c1 4 5.5 6 5.5 11.5a5.5 5.5 0 01-11 0c0-2.6 1.4-4.2 2.6-5.6.4 1.8 1.2 2.8 2.2 3.2-.4-3.4.2-6.4.7-9.1z" fill="#3E8EDE"/>' +
  '<path d="M16 15c1.4 1.6 2.6 2.8 2.6 4.6a2.6 2.6 0 01-5.2 0c0-1.6 1.2-2.8 2.6-4.6z" fill="#9FD3FF"/>';

/** Brand colours for the stocks the engine lists: [background, letter]. Unlisted tickers get a stable palette colour. */
const EQUITY_BRAND: Readonly<Record<string, [string, string]>> = {
  AAPL: ['#1D1D1F', '#fff'],
  ABBV: ['#071D49', '#fff'],
  ABT: ['#009CDE', '#fff'],
  ADBE: ['#FA0F00', '#fff'],
  AMD: ['#000', '#fff'],
  AMGN: ['#0063C3', '#fff'],
  AMZN: ['#232F3E', '#FF9900'],
  AVGO: ['#CC092F', '#fff'],
  BA: ['#0033A1', '#fff'],
  BABA: ['#FF6A00', '#fff'],
  BAC: ['#012169', '#fff'],
  BIDU: ['#2932E1', '#fff'],
  BMY: ['#BE2BBB', '#fff'],
  C: ['#056DAE', '#fff'],
  CMCSA: ['#1F69FF', '#fff'],
  COST: ['#E31837', '#fff'],
  CSCO: ['#049FD9', '#fff'],
  CVS: ['#CC0000', '#fff'],
  EBAY: ['#0064D2', '#fff'],
  F: ['#003478', '#fff'],
  GILD: ['#C5203E', '#fff'],
  GOOGL: ['#4285F4', '#fff'],
  GOOG: ['#4285F4', '#fff'],
  HD: ['#F96302', '#fff'],
  IBM: ['#0F62FE', '#fff'],
  INTC: ['#0071C5', '#fff'],
  JD: ['#E1251B', '#fff'],
  JNJ: ['#D51900', '#fff'],
  JPM: ['#117ACA', '#fff'],
  KO: ['#F40009', '#fff'],
  LLY: ['#D52B1E', '#fff'],
  LMT: ['#00205B', '#fff'],
  MCD: ['#DA291C', '#FFC72C'],
  META: ['#0081FB', '#fff'],
  MO: ['#00A0DF', '#fff'],
  MRK: ['#00857C', '#fff'],
  MS: ['#187ABA', '#fff'],
  NFLX: ['#000', '#E50914'],
  NIO: ['#00263A', '#fff'],
  NKE: ['#111', '#fff'],
  NVDA: ['#76B900', '#fff'],
  ORCL: ['#C74634', '#fff'],
  PEP: ['#004B93', '#fff'],
  PFE: ['#0093D0', '#fff'],
  PG: ['#003DA5', '#fff'],
  PM: ['#003B71', '#fff'],
  PYPL: ['#003087', '#fff'],
  SBUX: ['#00704A', '#fff'],
  T: ['#00A8E0', '#fff'],
  TMO: ['#E71316', '#fff'],
  TSLA: ['#CC0000', '#fff'],
  UNH: ['#002677', '#fff'],
  UPS: ['#351C15', '#FFB500'],
  V: ['#1A1F71', '#fff'],
  VZ: ['#000', '#EE0000'],
  WFC: ['#D71E28', '#FFCD41'],
  WMT: ['#0071CE', '#FFC220'],
  XOM: ['#ED1B2D', '#fff'],
};

/** Logos simple enough to draw exactly as they are: plain geometry, no lettering. */
const EQUITY_MARK: Readonly<Record<string, string>> = {
  MA:
    '<rect width="32" height="32" fill="#1A1A1A"/><circle cx="12.5" cy="16" r="6.5" fill="#EB001B"/>' +
    '<circle cx="19.5" cy="16" r="6.5" fill="#F79E1B"/><path d="M16 10.5a6.5 6.5 0 010 11 6.5 6.5 0 010-11z" fill="#FF5F00"/>',
  MSFT:
    '<rect width="32" height="32" fill="#fff"/><rect x="8" y="8" width="7.5" height="7.5" fill="#F25022"/>' +
    '<rect x="16.5" y="8" width="7.5" height="7.5" fill="#7FBA00"/><rect x="8" y="16.5" width="7.5" height="7.5" fill="#00A4EF"/>' +
    '<rect x="16.5" y="16.5" width="7.5" height="7.5" fill="#FFB900"/>',
};

const PALETTE = [
  '#2962FF',
  '#089981',
  '#F23645',
  '#FF9800',
  '#9C27B0',
  '#00BCD4',
  '#795548',
  '#607D8B',
];

function paletteColour(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Quote currencies a crypto symbol can end in, longest first so USDT wins over USD. */
const CRYPTO_QUOTES = [
  'USDT',
  'USDC',
  'USD',
  'EUR',
  'GBP',
  'JPY',
  'AUD',
  'CAD',
  'CHF',
  'BTC',
  'ETH',
  'XAU',
];

function artFor(code: string): string | null {
  return CURRENCY_FLAG_SVG[code] ?? COIN_SVG[code] ?? COUNTRY_FLAG_SVG[code] ?? null;
}

/** "BTCUSD" / "BTC-USD" / "BTC/USDT" → ["BTC", "USD"]; a bare known coin → [coin, null]. */
export function splitCrypto(symbol: string): [string, string | null] | null {
  const raw = symbol.toUpperCase();
  const sep = /^([A-Z0-9]+)[-/_.]([A-Z0-9]+)/.exec(raw);
  if (sep) return [sep[1], sep[2]];
  const s = raw.replace(/[^A-Z0-9]/g, '');
  if (COIN_SVG[s]) return [s, null];
  for (const q of CRYPTO_QUOTES) {
    if (s.length > q.length + 1 && s.endsWith(q)) return [s.slice(0, -q.length), q];
  }
  return null;
}

/** What an instrument icon draws: one disc, or a base disc in front of a quote disc (like an FX pair). */
export interface SymbolArt {
  front: string;
  back: string | null;
  label: string;
}

function cryptoArt(symbol: string): SymbolArt | null {
  const parts = splitCrypto(symbol);
  if (!parts) return null;
  const [base, quote] = parts;
  const front = COIN_SVG[base];
  if (!front) return null;
  const back = quote ? artFor(quote) : null;
  return { front, back, label: back && quote ? `${base} / ${quote}` : base };
}

function indexArt(symbol: string, quoteCurrency: string | null): SymbolArt | null {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const code = INDEX_FLAG.find(([re]) => re.test(s))?.[1] ?? quoteCurrency?.toUpperCase() ?? null;
  const art = code ? artFor(code) : null;
  return art ? { front: art, back: null, label: s } : null;
}

function energyArt(symbol: string): SymbolArt | null {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/OIL|WTI|BRENT|^CL[A-Z0-9]?$|^BRN/.test(s))
    return { front: OIL, back: null, label: 'Crude oil' };
  if (/^(XNG|NGAS|NATGAS|NG[A-Z0-9]?$)/.test(s))
    return { front: GAS, back: null, label: 'Natural gas' };
  return null;
}

function equityArt(symbol: string): SymbolArt {
  const s =
    symbol
      .toUpperCase()
      .split(/[.:\s]/)[0]
      .replace(/[^A-Z0-9]/g, '') || '?';
  const mark = EQUITY_MARK[s];
  if (mark) return { front: mark, back: null, label: s };
  const [bg, fg] = EQUITY_BRAND[s] ?? [paletteColour(s), '#fff'];
  return { front: monogram(bg, s.charAt(0), fg), back: null, label: s };
}

/**
 * The artwork for a non-FX instrument, or null when there is none (the caller keeps its asset-class letter badge).
 * The asset class decides first; a symbol whose class says nothing useful still gets an icon when its name does.
 */
export function symbolArt(
  symbol: string,
  assetClass: InstrumentAssetClass,
  quoteCurrency: string | null = null,
): SymbolArt | null {
  switch (assetClass) {
    case 'Crypto':
      return cryptoArt(symbol);
    case 'Index':
      return indexArt(symbol, quoteCurrency);
    case 'Equity':
    case 'Etf':
      return equityArt(symbol);
    case 'Commodity':
    case 'Future':
      return energyArt(symbol) ?? indexArt(symbol, null) ?? cryptoArt(symbol);
    default:
      return null;
  }
}
