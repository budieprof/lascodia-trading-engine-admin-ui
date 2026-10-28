import { instrumentCatalogue } from '@core/instruments/instrument-math';
import type { InstrumentDto } from '@core/instruments/instrument.types';

import type {
  AccountHealth,
  ExecutionAccountReconciliation,
  FeeAssetClass,
  FeeScheduleFields,
  MarginKind,
  MarginRequirementFields,
} from './venues.types';

// ── Enum names (exec-gateway DTOs carry numbers or names) ─────────────────────────────────────────

const DRIFT_KINDS = ['EngineOnlyPosition', 'VenueOnlyPosition', 'QuantityMismatch', 'EngineOnlyOrder', 'VenueOnlyOrder'];
const ORDER_TYPES = ['Market', 'Limit', 'Stop', 'StopLimit'];
const TIFS = ['Gtc', 'Ioc', 'Fok', 'Day'];
const QUANTITY_UNITS = ['Lots', 'Contracts', 'Shares', 'Coins'];

function enumName(values: readonly string[], v: string | number | null | undefined): string {
  if (typeof v === 'number') return values[v] ?? String(v);
  return v ?? '';
}

export const driftKindName = (v: string | number) => enumName(DRIFT_KINDS, v);
export const orderTypeName = (v: string | number) => enumName(ORDER_TYPES, v);
export const tifName = (v: string | number) => enumName(TIFS, v);
export const quantityUnitName = (v: string | number) => enumName(QUANTITY_UNITS, v);

/** Plain words for a drift kind. */
export function driftLabel(v: string | number): string {
  switch (driftKindName(v)) {
    case 'EngineOnlyPosition':
      return 'Open in the engine, not at the venue';
    case 'VenueOnlyPosition':
      return 'Open at the venue, not in the engine';
    case 'QuantityMismatch':
      return 'Quantities differ';
    case 'EngineOnlyOrder':
      return 'Working in the engine, not at the venue';
    case 'VenueOnlyOrder':
      return 'Working at the venue, not in the engine';
    default:
      return String(v);
  }
}

// ── Which ticket a symbol gets ────────────────────────────────────────────────────────────────────

/**
 * True only for an EXCHANGE-TRADED instrument (a futures contract, a crypto exchange market, a listed equity / ETF —
 * the instrument master carries its `future` / `crypto` / `equity` detail). Every MT5 symbol — FX, index / metal /
 * crypto CFDs — has none of them, so it keeps today's FX ticket and ladder, unchanged (golden spec over the 26 live
 * pairs).
 */
export function isExchangeTraded(inst: InstrumentDto | null | undefined): boolean {
  if (!inst) return false;
  switch (inst.assetClass) {
    case 'Future':
      return !!inst.future;
    case 'Crypto':
      return !!inst.crypto;
    case 'Equity':
    case 'Etf':
      return !!inst.equity;
    default:
      return false;
  }
}

/**
 * The catalogue's exchange-traded instrument for `symbol`, else null (= today's FX / CFD ticket and ladder). Reads the
 * catalogue signal, so a `computed` follows the catalogue load.
 */
export function venueInstrumentFor(symbol: string | null | undefined): InstrumentDto | null {
  const inst = instrumentCatalogue().get((symbol ?? '').trim().toUpperCase());
  return isExchangeTraded(inst) ? inst! : null;
}

/** Contracts / shares / coins in words, singular or plural. */
export function unitWord(unit: string | null | undefined, qty = 2): string {
  const u = (unit ?? '').toLowerCase();
  const one = Math.abs(qty) === 1;
  switch (u) {
    case 'contracts':
      return one ? 'contract' : 'contracts';
    case 'shares':
      return one ? 'share' : 'shares';
    case 'coins':
      return one ? 'coin' : 'coins';
    default:
      return one ? 'lot' : 'lots';
  }
}

// ── Connections ───────────────────────────────────────────────────────────────────────────────────

export interface CredentialField {
  name: string;
  label: string;
  multiline?: boolean;
  optional?: boolean;
}

/**
 * The credential fields each adapter reads (engine `Application/Execution/Adapters`): every venue takes `apiKey`;
 * the rest per venue. The form accepts extra fields too — the engine stores whatever is sent, encrypted.
 */
export function credentialFieldsFor(kind: string): CredentialField[] {
  const k = kind.toLowerCase();
  const key: CredentialField = { name: 'apiKey', label: 'API key' };
  const secret: CredentialField = { name: 'apiSecret', label: 'API secret' };
  if (k.startsWith('okx')) return [key, secret, { name: 'passphrase', label: 'Passphrase' }];
  if (k.startsWith('coinbase'))
    return [
      { name: 'apiKey', label: 'Key name (organizations/…/apiKeys/…)' },
      { name: 'apiSecret', label: 'Private key (EC PEM)', multiline: true },
    ];
  if (k.startsWith('binance'))
    return [key, secret, { name: 'privateKeyPem', label: 'Ed25519 private key (PEM)', multiline: true, optional: true }];
  if (k === 'tradovate')
    return [
      { name: 'apiKey', label: 'User name' },
      { name: 'password', label: 'Password' },
      { name: 'cid', label: 'App id (cid)' },
      { name: 'apiSecret', label: 'App secret' },
    ];
  if (k === 'rithmic' || k === 'cqg')
    return [
      { name: 'apiKey', label: 'User name' },
      { name: 'apiSecret', label: 'Password' },
    ];
  if (k === 'ib') return [{ name: 'apiKey', label: 'Client Portal access token' }];
  // Tradier signs every call with one bearer access token; there is no secret.
  if (k === 'tradier') return [{ name: 'apiKey', label: 'Access token' }];
  return [key, secret];
}

/** The fields to send: trimmed, empty optional ones dropped; null when a required one is missing. */
export function credentialBody(
  fields: readonly CredentialField[],
  values: Record<string, string>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = (values[f.name] ?? '').trim();
    if (!v) {
      if (f.optional) continue;
      return null;
    }
    out[f.name] = v;
  }
  return out;
}

export function healthTone(h: AccountHealth | string): 'ok' | 'warn' | 'bad' | '' {
  switch (h) {
    case 'ok':
      return 'ok';
    case 'attention':
      return 'bad';
    case 'idle':
      return '';
    default:
      return 'warn';
  }
}

export function credentialTone(status: string | null | undefined): 'ok' | 'warn' | 'bad' | '' {
  switch (status) {
    case 'Verified':
      return 'ok';
    case 'Unverified':
      return 'warn';
    case 'RefusedWithdrawalRights':
    case 'Rejected':
      return 'bad';
    default:
      return '';
  }
}

/** Plain words for a credential status. */
export function credentialLabel(status: string | null | undefined): string {
  switch (status) {
    case 'Verified':
      return 'Verified';
    case 'Unverified':
      return 'Saved, not verified';
    case 'RefusedWithdrawalRights':
      return 'Refused: the key can withdraw or transfer';
    case 'Rejected':
      return 'Rejected by the venue';
    case 'Revoked':
      return 'Revoked';
    case null:
    case undefined:
    case '':
      return 'No credential';
    default:
      return status;
  }
}

export interface DriftSummary {
  accounts: number;
  withDrift: number;
  drifts: number;
  skipped: number;
}

export function driftSummary(rows: readonly ExecutionAccountReconciliation[]): DriftSummary {
  return {
    accounts: rows.length,
    withDrift: rows.filter((r) => r.drift.length > 0).length,
    drifts: rows.reduce((n, r) => n + r.drift.length, 0),
    skipped: rows.filter((r) => !!r.skipped).length,
  };
}

// ── Fee schedules ─────────────────────────────────────────────────────────────────────────────────

export const FEE_ASSET_CLASSES: readonly FeeAssetClass[] = ['Future', 'Crypto', 'Equity', 'Etf'];

export function emptyFee(assetClass: FeeAssetClass = 'Future'): FeeScheduleFields {
  return {
    code: '',
    assetClass,
    venue: '',
    scope: null,
    currency: 'USD',
    commissionPerContract: null,
    exchangeFeePerContract: null,
    clearingFeePerContract: null,
    regulatoryFeePerContract: null,
    makerFeeBps: null,
    takerFeeBps: null,
    tierMinVolume30d: null,
    commissionPerShare: null,
    commissionBps: null,
    minCommissionPerOrder: null,
    maxCommissionPctOfNotional: null,
    secFeePerMillion: null,
    finraTafPerShare: null,
    finraTafMaxPerTrade: null,
    borrowFeeAnnualPct: null,
    slippageTicks: null,
    effectiveFromUtc: new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
    effectiveToUtc: null,
    source: 'operator',
    notes: null,
  };
}

/** The numeric fields each asset class's cost model reads (the form shows only these). */
export function feeFieldsFor(assetClass: FeeAssetClass): (keyof FeeScheduleFields)[] {
  switch (assetClass) {
    case 'Future':
      return ['commissionPerContract', 'exchangeFeePerContract', 'clearingFeePerContract', 'regulatoryFeePerContract', 'slippageTicks'];
    case 'Crypto':
      return ['makerFeeBps', 'takerFeeBps', 'tierMinVolume30d'];
    default:
      return [
        'commissionPerShare',
        'commissionBps',
        'minCommissionPerOrder',
        'maxCommissionPctOfNotional',
        'secFeePerMillion',
        'finraTafPerShare',
        'finraTafMaxPerTrade',
        'borrowFeeAnnualPct',
        'slippageTicks',
      ];
  }
}

export const FEE_LABELS: Partial<Record<keyof FeeScheduleFields, string>> = {
  commissionPerContract: 'Commission per contract per side',
  exchangeFeePerContract: 'Exchange fee per contract',
  clearingFeePerContract: 'Clearing fee per contract',
  regulatoryFeePerContract: 'Regulatory (NFA) fee per contract',
  makerFeeBps: 'Maker fee (bps, negative = rebate)',
  takerFeeBps: 'Taker fee (bps)',
  tierMinVolume30d: '30-day volume from which this tier applies',
  commissionPerShare: 'Commission per share',
  commissionBps: 'Commission (bps of notional)',
  minCommissionPerOrder: 'Minimum commission per order',
  maxCommissionPctOfNotional: 'Commission cap (% of notional)',
  secFeePerMillion: 'SEC fee on sells (per $1M)',
  finraTafPerShare: 'FINRA TAF per share (sells)',
  finraTafMaxPerTrade: 'FINRA TAF cap per trade',
  borrowFeeAnnualPct: 'Default borrow fee for shorts (% a year)',
  slippageTicks: 'Slippage per market/stop fill (ticks)',
};

/** The engine's validation, mirrored so the form says what is wrong before it is sent (the engine has the last word). */
export function feeProblems(f: FeeScheduleFields): string[] {
  const p: string[] = [];
  if (!/^[A-Za-z0-9:._-]{1,64}$/.test(f.code.trim())) p.push('Code: letters, digits and : . _ - only (e.g. cme:ES).');
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(f.venue.trim())) p.push('Venue: an exchange or broker id (e.g. cme, binance).');
  if (!/^[A-Za-z]{3,8}$/.test(f.currency.trim())) p.push('Currency: an ISO code or coin.');
  if (!f.source.trim()) p.push('Say where the numbers come from.');
  for (const k of feeFieldsFor(f.assetClass)) {
    const v = f[k] as number | null;
    if (v === null) continue;
    const min = k === 'makerFeeBps' ? -100 : 0;
    if (!Number.isFinite(v) || v < min) p.push(`${FEE_LABELS[k] ?? k} must be at least ${min}.`);
    if ((k === 'makerFeeBps' || k === 'takerFeeBps' || k === 'commissionBps') && v > 1000) p.push(`${FEE_LABELS[k]} is at most 1000 bps.`);
  }
  const has = (keys: (keyof FeeScheduleFields)[]) => keys.some((k) => f[k] !== null);
  const ok =
    f.assetClass === 'Future'
      ? has(['commissionPerContract', 'exchangeFeePerContract', 'clearingFeePerContract', 'regulatoryFeePerContract'])
      : f.assetClass === 'Crypto'
        ? has(['makerFeeBps', 'takerFeeBps'])
        : has(['commissionPerShare', 'commissionBps', 'secFeePerMillion', 'finraTafPerShare', 'borrowFeeAnnualPct']);
  if (!ok) p.push('Give at least one fee of the asset class.');
  if (f.effectiveToUtc && Date.parse(f.effectiveToUtc) <= Date.parse(f.effectiveFromUtc)) p.push('The end must be after the start.');
  return p;
}

/** Only the asset class's own amounts are sent; the others are cleared (a futures row carries no bps). */
export function feeBody(f: FeeScheduleFields): FeeScheduleFields {
  const keep = new Set(feeFieldsFor(f.assetClass));
  const out = { ...f, code: f.code.trim(), venue: f.venue.trim().toLowerCase(), currency: f.currency.trim().toUpperCase() };
  for (const k of NUMERIC_FEE_FIELDS) if (!keep.has(k)) (out as Record<string, unknown>)[k] = null;
  return out;
}

const NUMERIC_FEE_FIELDS: (keyof FeeScheduleFields)[] = [
  'commissionPerContract',
  'exchangeFeePerContract',
  'clearingFeePerContract',
  'regulatoryFeePerContract',
  'makerFeeBps',
  'takerFeeBps',
  'tierMinVolume30d',
  'commissionPerShare',
  'commissionBps',
  'minCommissionPerOrder',
  'maxCommissionPctOfNotional',
  'secFeePerMillion',
  'finraTafPerShare',
  'finraTafMaxPerTrade',
  'borrowFeeAnnualPct',
  'slippageTicks',
];

/** One line per row for the table ("0.85 + 1.38 per contract", "maker 2 / taker 5 bps"). */
export function feeSummary(f: FeeScheduleFields): string {
  const n = (v: number | null) => (v === null ? null : String(v));
  switch (f.assetClass) {
    case 'Future': {
      const sum =
        (f.commissionPerContract ?? 0) + (f.exchangeFeePerContract ?? 0) + (f.clearingFeePerContract ?? 0) + (f.regulatoryFeePerContract ?? 0);
      return `${Math.round(sum * 100) / 100} ${f.currency} per contract per side`;
    }
    case 'Crypto':
      return `maker ${n(f.makerFeeBps) ?? '—'} / taker ${n(f.takerFeeBps) ?? '—'} bps${f.tierMinVolume30d ? ` from ${f.tierMinVolume30d}` : ''}`;
    default:
      return f.commissionPerShare !== null
        ? `${f.commissionPerShare} ${f.currency}/share${f.minCommissionPerOrder ? `, min ${f.minCommissionPerOrder}` : ''}`
        : f.commissionBps !== null
          ? `${f.commissionBps} bps`
          : 'regulatory fees only';
  }
}

// ── Margin requirements ───────────────────────────────────────────────────────────────────────────

export const MARGIN_KINDS: readonly MarginKind[] = ['FuturesContract', 'CryptoLeverageTier', 'Equity'];

export function emptyMargin(kind: MarginKind = 'FuturesContract'): MarginRequirementFields {
  return {
    kind,
    symbol: '',
    venue: '',
    currency: kind === 'CryptoLeverageTier' ? 'USDT' : 'USD',
    initialMargin: null,
    maintenanceMargin: null,
    intradayInitialMargin: null,
    intradayMaintenanceMargin: null,
    notionalFloor: kind === 'CryptoLeverageTier' ? 0 : null,
    notionalCap: null,
    maxLeverage: null,
    initialMarginRate: null,
    maintenanceMarginRate: null,
    maintenanceAmount: null,
    effectiveFromUtc: new Date().toISOString().slice(0, 10) + 'T00:00:00Z',
    source: '',
  };
}

export function marginFieldsFor(kind: MarginKind): (keyof MarginRequirementFields)[] {
  switch (kind) {
    case 'FuturesContract':
      return ['initialMargin', 'maintenanceMargin', 'intradayInitialMargin', 'intradayMaintenanceMargin'];
    case 'CryptoLeverageTier':
      return ['notionalFloor', 'notionalCap', 'maxLeverage', 'maintenanceMarginRate', 'maintenanceAmount'];
    default:
      return ['initialMarginRate', 'maintenanceMarginRate'];
  }
}

export const MARGIN_LABELS: Partial<Record<keyof MarginRequirementFields, string>> = {
  initialMargin: 'Initial margin per contract (overnight)',
  maintenanceMargin: 'Maintenance margin per contract (overnight)',
  intradayInitialMargin: 'Intraday initial margin per contract',
  intradayMaintenanceMargin: 'Intraday maintenance margin per contract',
  notionalFloor: 'Tier from notional (inclusive)',
  notionalCap: 'Tier up to notional (exclusive; empty = no cap)',
  maxLeverage: 'Max leverage in this tier',
  maintenanceMarginRate: 'Maintenance rate (0.004 = 0.4 %)',
  maintenanceAmount: 'Maintenance amount ("cum")',
  initialMarginRate: 'Initial rate (0.5 = 50 %)',
};

/** The shape each margin model needs (mirrors the engine's validator). */
export function marginProblems(m: MarginRequirementFields): string[] {
  const p: string[] = [];
  if (!/^[A-Za-z0-9!._-]{1,32}$/.test(m.symbol.trim())) p.push('Symbol: the instrument (ESZ6, BTC-USDT-PERP, AAPL) or a futures root (ES).');
  if (!/^[A-Za-z]{3,8}$/.test(m.currency.trim())) p.push('Currency: an ISO code or coin.');
  if (!m.source.trim()) p.push('Say where the numbers come from.');
  for (const k of marginFieldsFor(m.kind)) {
    const v = m[k] as number | null;
    if (v !== null && (!Number.isFinite(v) || v < 0)) p.push(`${MARGIN_LABELS[k] ?? k} cannot be negative.`);
  }
  if (m.kind === 'FuturesContract') {
    if (!(m.initialMargin! > 0)) p.push('A futures row needs the initial margin per contract.');
    if (!(m.maintenanceMargin! > 0)) p.push('A futures row needs the maintenance margin per contract.');
    if (m.initialMargin !== null && m.maintenanceMargin !== null && m.maintenanceMargin > m.initialMargin)
      p.push('Maintenance margin cannot exceed the initial margin.');
  } else if (m.kind === 'CryptoLeverageTier') {
    if (m.notionalFloor === null) p.push('A leverage tier needs its notional floor (0 for the first tier).');
    if (!(m.maxLeverage! >= 1 && m.maxLeverage! <= 500)) p.push('Max leverage between 1 and 500.');
    if (!(m.maintenanceMarginRate! > 0 && m.maintenanceMarginRate! < 1)) p.push('Maintenance rate between 0 and 1.');
    else if (m.maxLeverage && m.maintenanceMarginRate! >= 1 / m.maxLeverage)
      p.push('The maintenance rate must be below 1 ÷ max leverage, or a position would open already liquidated.');
    if (m.notionalCap !== null && m.notionalFloor !== null && m.notionalCap <= m.notionalFloor) p.push('The cap must be above the floor.');
  } else {
    if (m.initialMarginRate === null && m.maintenanceMarginRate === null) p.push('Give an initial or a maintenance rate.');
    for (const r of [m.initialMarginRate, m.maintenanceMarginRate])
      if (r !== null && (r < 0 || r > 1)) p.push('Rates are fractions between 0 and 1.');
  }
  return p;
}

export function marginBody(m: MarginRequirementFields): MarginRequirementFields {
  const keep = new Set(marginFieldsFor(m.kind));
  const out = { ...m, symbol: m.symbol.trim().toUpperCase(), venue: m.venue.trim(), currency: m.currency.trim().toUpperCase() };
  for (const k of [
    'initialMargin',
    'maintenanceMargin',
    'intradayInitialMargin',
    'intradayMaintenanceMargin',
    'notionalFloor',
    'notionalCap',
    'maxLeverage',
    'initialMarginRate',
    'maintenanceMarginRate',
    'maintenanceAmount',
  ] as (keyof MarginRequirementFields)[])
    if (!keep.has(k)) (out as Record<string, unknown>)[k] = null;
  return out;
}

export function marginSummary(m: MarginRequirementFields): string {
  switch (m.kind) {
    case 'FuturesContract':
      return `${m.initialMargin ?? '—'} / ${m.maintenanceMargin ?? '—'} ${m.currency} per contract`;
    case 'CryptoLeverageTier':
      return `${m.notionalFloor ?? 0}–${m.notionalCap ?? '∞'}: ${m.maxLeverage ?? '—'}× max, MMR ${m.maintenanceMarginRate ?? '—'}`;
    default:
      return `initial ${m.initialMarginRate ?? '—'}, maintenance ${m.maintenanceMarginRate ?? '—'}`;
  }
}

/** `yyyy-MM-dd` of an ISO instant (for date inputs) and back to an ISO UTC midnight. */
export function dateOnly(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

export function isoMidnight(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : null;
}

/** "3 min" / "2 h" / "4 d" from minutes. */
export function lagText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} d`;
}
