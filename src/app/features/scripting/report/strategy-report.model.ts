/**
 * TradingView-style Strategy report for script strategies (ADR-0027) — the wire model and its
 * normaliser.
 *
 * <p>The shape is the camelCase serialisation of the engine's
 * `LascodiaTradingEngine.Scripting.Broker.StrategyReport` (Meta, Performance, Equity, Returns,
 * Capital, Trades, EquityCurve, MonthlyReturns, Warnings). Every money value is in the account
 * currency; `null` means na / N/A. Loss magnitudes (gross loss, average / largest losing trade)
 * are positive numbers, like `strategy.grossloss`.</p>
 *
 * <p>The report reaches the console three ways — `POST scripting/run` (`report`), a backtest
 * run's `resultJson`, and `GET strategy/{id}/script/live` (`report`) — and not all of them are
 * guaranteed to go through the report's own camelCase serialiser. {@link normalizeStrategyReport}
 * therefore accepts PascalCase too, maps the named floating-point literals the serialiser allows
 * (`"NaN"`, `"Infinity"`) to null, and fills missing sections so the view never has to guard
 * against `undefined`.</p>
 */

/** A number the engine may report as na (null). */
export type Num = number | null;

/** `strategy()` declaration parameters as the report echoes them (Scripting `StrategyProperties`). */
export interface ReportStrategyProperties {
  pyramiding: Num;
  calcOnOrderFills: boolean | null;
  calcOnEveryTick: boolean | null;
  calcOnEveryHistoryTick: boolean | null;
  maxBarsBack: Num;
  backtestFillLimitsAssumption: Num;
  /** `Fixed` | `Cash` | `PercentOfEquity`. */
  defaultQtyType: string | null;
  defaultQtyValue: Num;
  initialCapital: Num;
  /** ISO currency or `NONE` (= symbol currency). */
  currency: string | null;
  slippage: Num;
  /** `Percent` | `CashPerContract` | `CashPerOrder`. */
  commissionType: string | null;
  commissionValue: Num;
  processOrdersOnClose: boolean | null;
  closeEntriesRule: string | null;
  marginLong: Num;
  marginShort: Num;
  riskFreeRate: Num;
  useBarMagnifier: boolean | null;
  fillOrdersOnStandardOhlc: boolean | null;
}

export interface ReportMeta {
  symbol: string;
  timeframe: string;
  accountCurrency: string;
  symbolCurrency: string;
  initialCapital: Num;
  /** Unix ms of the first / last processed bar's open, and the last bar's close. */
  firstBarTime: Num;
  lastBarTime: Num;
  lastBarTimeClose: Num;
  firstBarIndex: Num;
  lastBarIndex: Num;
  bars: Num;
  /** Closed trades trimmed beyond the trade limit (`strategy.closedtrades.first_index`). */
  trimmedTrades: Num;
  useBarMagnifier: boolean;
  riskHalted: boolean;
  riskHaltReason: string;
  properties: ReportStrategyProperties | null;
}

/** Returns / trades analysis for one side (all, long or short trades). */
export interface ReportSplit {
  netProfit: Num;
  netProfitPercent: Num;
  grossProfit: Num;
  grossProfitPercent: Num;
  grossLoss: Num;
  grossLossPercent: Num;
  profitFactor: Num;
  commissionPaid: Num;
  openPnL: Num;
  openPnLPercent: Num;
  totalClosedTrades: Num;
  totalOpenTrades: Num;
  winningTrades: Num;
  losingTrades: Num;
  evenTrades: Num;
  percentProfitable: Num;
  /** Average trade (expected payoff). */
  avgTrade: Num;
  avgTradePercent: Num;
  avgWinningTrade: Num;
  avgWinningTradePercent: Num;
  avgLosingTrade: Num;
  avgLosingTradePercent: Num;
  ratioAvgWinAvgLoss: Num;
  largestWinningTrade: Num;
  largestWinningTradePercent: Num;
  largestLosingTrade: Num;
  largestLosingTradePercent: Num;
  avgBarsInTrades: Num;
  avgBarsInWinningTrades: Num;
  avgBarsInLosingTrades: Num;
  maxContractsHeld: Num;
  /** Largest favourable / adverse excursion of a single closed trade. */
  maxTradeRunup: Num;
  maxTradeDrawdown: Num;
}

export interface ReportSplits {
  all: ReportSplit;
  long: ReportSplit;
  short: ReportSplit;
}

export interface ReportEquity {
  finalEquity: Num;
  /** Maximum equity drawdown measured on every processed tick (intrabar). */
  maxDrawdown: Num;
  /** Intrabar max drawdown as a percentage of the equity peak it fell from. */
  maxDrawdownPercent: Num;
  maxDrawdownPercentOfInitialCapital: Num;
  maxDrawdownCloseToClose: Num;
  maxDrawdownCloseToClosePercent: Num;
  maxRunup: Num;
  maxRunupPercent: Num;
  maxRunupPercentOfInitialCapital: Num;
  maxRunupCloseToClose: Num;
  maxRunupCloseToClosePercent: Num;
  /** Net profit ÷ intrabar max drawdown. */
  returnOfMaxDrawdown: Num;
  runupPeriods: Num;
  avgRunupAmount: Num;
  avgRunupDurationBars: Num;
  drawdownPeriods: Num;
  avgDrawdownAmount: Num;
  avgDrawdownDurationBars: Num;
}

export interface ReportReturns {
  returnOnInitialCapitalPercent: Num;
  cagr: Num;
  buyAndHoldReturn: Num;
  buyAndHoldReturnPercent: Num;
  /** Net profit minus the buy-and-hold return. */
  strategyOutperformance: Num;
  /** Sharpe / Sortino of monthly returns against `riskFreeRate` (annual %, taken per month). */
  sharpeRatio: Num;
  sortinoRatio: Num;
  riskFreeRate: Num;
  months: Num;
}

export interface ReportCapital {
  marginCalls: Num;
  liquidatedQty: Num;
  /** Smallest starting capital that never goes below the margin requirement. */
  accountSizeRequired: Num;
  returnOnAccountSizeRequiredPercent: Num;
  netProfitAsPercentOfLargestLoss: Num;
  maxMarginUsed: Num;
  avgMarginPerTrade: Num;
}

/** One row of the List of trades: closed trades oldest first, then open trades. */
export interface ReportTrade {
  /** 1-based trade number (`strategy.closedtrades.*` index + 1; open trades follow). */
  number: Num;
  isOpen: boolean;
  /** `long` | `short`. */
  direction: string;
  entryId: string;
  /** What the Strategy Tester shows: the entry comment, else the id. */
  entrySignal: string;
  entryTime: Num;
  entryBarIndex: Num;
  entryPrice: Num;
  exitId: string;
  exitSignal: string;
  exitTime: Num;
  exitBarIndex: Num;
  exitPrice: Num;
  /** `TakeProfit` | `StopLoss` | `Trailing` | '' — the strategy.exit leg that filled. */
  exitLeg: string;
  qty: Num;
  positionValue: Num;
  profit: Num;
  profitPercent: Num;
  cumulativeProfit: Num;
  cumulativeProfitPercent: Num;
  /** Max favourable excursion (MFE). */
  runUp: Num;
  runUpPercent: Num;
  /** Max adverse excursion (MAE). */
  drawdown: Num;
  drawdownPercent: Num;
  barsHeld: Num;
  commission: Num;
}

export interface ReportEquityPoint {
  /** Unix ms of the bar. */
  time: Num;
  barIndex: Num;
  /** Bars this point covers (the curve is down-sampled). */
  bars: Num;
  equity: Num;
  minEquity: Num;
  maxEquity: Num;
  /** Distance below the running equity peak (money, positive). */
  drawdown: Num;
  drawdownPercent: Num;
  buyHoldEquity: Num;
  /** Signed position size (contracts) — positive long, negative short. */
  positionSize: Num;
}

export interface ReportMonthlyReturn {
  year: number;
  /** 1–12. */
  month: number;
  startEquity: Num;
  endEquity: Num;
  returnPercent: Num;
}

export interface StrategyReport {
  meta: ReportMeta;
  performance: ReportSplits;
  equity: ReportEquity;
  returns: ReportReturns;
  capital: ReportCapital;
  trades: ReportTrade[];
  equityCurve: ReportEquityPoint[];
  monthlyReturns: ReportMonthlyReturn[];
  warnings: string[];
}

// ── Normalisation ─────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Keys whose values are text even when they happen to read "NaN" (an entry id, a symbol…). */
const TEXT_KEYS = new Set([
  'symbol',
  'timeframe',
  'accountCurrency',
  'symbolCurrency',
  'riskHaltReason',
  'currency',
  'defaultQtyType',
  'commissionType',
  'closeEntriesRule',
  'direction',
  'entryId',
  'entrySignal',
  'exitId',
  'exitSignal',
  'exitLeg',
]);

const NAMED_FLOAT_LITERALS = new Set(['NaN', 'Infinity', '-Infinity']);

/**
 * System.Text.Json's camelCase naming policy, character for character: lower-case the leading
 * run of capitals, keeping the last one of a run that starts a new word (`URLValue` →
 * `urlValue`, `OpenPnL` → `openPnL`). Idempotent on names that are already camelCase.
 */
export function toCamelCase(name: string): string {
  if (!name || !/[A-Z]/.test(name[0])) return name;
  const chars = [...name];
  for (let i = 0; i < chars.length; i++) {
    if (i === 1 && !isUpper(chars[i])) break;
    const hasNext = i + 1 < chars.length;
    if (i > 0 && hasNext && !isUpper(chars[i + 1])) {
      if (chars[i + 1] === ' ') chars[i] = chars[i].toLowerCase();
      break;
    }
    chars[i] = chars[i].toLowerCase();
  }
  return chars.join('');
}

function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

/**
 * Deep copy with camelCase keys, named float literals mapped to null and non-finite numbers
 * dropped to null. Text keys are left exactly as sent.
 */
function camelizeReportJson(value: unknown, key: string | null = null): unknown {
  if (Array.isArray(value)) return value.map((v) => camelizeReportJson(v, key));
  if (value !== null && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) {
      const ck = toCamelCase(k);
      out[ck] = camelizeReportJson(v, ck);
    }
    return out;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NAMED_FLOAT_LITERALS.has(value) && !TEXT_KEYS.has(key ?? '')) {
    return null;
  }
  return value;
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Parses JSON text (or passes an object through). Null when it is neither. */
function asObject(raw: unknown): Json | null {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text.startsWith('{')) return null;
    try {
      const parsed = JSON.parse(text);
      return isObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isObject(raw) ? raw : null;
}

/** True when a camelCased object has the report's structure (not the DSL BacktestResult). */
function looksLikeReport(o: Json): boolean {
  const perf = o['performance'];
  if (isObject(perf) && isObject(perf['all'])) return true;
  return isObject(o['meta']) && (isObject(o['equity']) || Array.isArray(o['trades']));
}

function num(v: unknown): Num {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && !NAMED_FLOAT_LITERALS.has(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function numbers<K extends string>(src: Json, keys: readonly K[]): Record<K, Num> {
  const out = {} as Record<K, Num>;
  for (const k of keys) out[k] = num(src[k]);
  return out;
}

const SPLIT_KEYS = [
  'netProfit',
  'netProfitPercent',
  'grossProfit',
  'grossProfitPercent',
  'grossLoss',
  'grossLossPercent',
  'profitFactor',
  'commissionPaid',
  'openPnL',
  'openPnLPercent',
  'totalClosedTrades',
  'totalOpenTrades',
  'winningTrades',
  'losingTrades',
  'evenTrades',
  'percentProfitable',
  'avgTrade',
  'avgTradePercent',
  'avgWinningTrade',
  'avgWinningTradePercent',
  'avgLosingTrade',
  'avgLosingTradePercent',
  'ratioAvgWinAvgLoss',
  'largestWinningTrade',
  'largestWinningTradePercent',
  'largestLosingTrade',
  'largestLosingTradePercent',
  'avgBarsInTrades',
  'avgBarsInWinningTrades',
  'avgBarsInLosingTrades',
  'maxContractsHeld',
  'maxTradeRunup',
  'maxTradeDrawdown',
] as const satisfies readonly (keyof ReportSplit)[];

const EQUITY_KEYS = [
  'finalEquity',
  'maxDrawdown',
  'maxDrawdownPercent',
  'maxDrawdownPercentOfInitialCapital',
  'maxDrawdownCloseToClose',
  'maxDrawdownCloseToClosePercent',
  'maxRunup',
  'maxRunupPercent',
  'maxRunupPercentOfInitialCapital',
  'maxRunupCloseToClose',
  'maxRunupCloseToClosePercent',
  'returnOfMaxDrawdown',
  'runupPeriods',
  'avgRunupAmount',
  'avgRunupDurationBars',
  'drawdownPeriods',
  'avgDrawdownAmount',
  'avgDrawdownDurationBars',
] as const satisfies readonly (keyof ReportEquity)[];

const RETURNS_KEYS = [
  'returnOnInitialCapitalPercent',
  'cagr',
  'buyAndHoldReturn',
  'buyAndHoldReturnPercent',
  'strategyOutperformance',
  'sharpeRatio',
  'sortinoRatio',
  'riskFreeRate',
  'months',
] as const satisfies readonly (keyof ReportReturns)[];

const CAPITAL_KEYS = [
  'marginCalls',
  'liquidatedQty',
  'accountSizeRequired',
  'returnOnAccountSizeRequiredPercent',
  'netProfitAsPercentOfLargestLoss',
  'maxMarginUsed',
  'avgMarginPerTrade',
] as const satisfies readonly (keyof ReportCapital)[];

const TRADE_NUMBER_KEYS = [
  'number',
  'entryTime',
  'entryBarIndex',
  'entryPrice',
  'exitTime',
  'exitBarIndex',
  'exitPrice',
  'qty',
  'positionValue',
  'profit',
  'profitPercent',
  'cumulativeProfit',
  'cumulativeProfitPercent',
  'runUp',
  'runUpPercent',
  'drawdown',
  'drawdownPercent',
  'barsHeld',
  'commission',
] as const satisfies readonly (keyof ReportTrade)[];

const EQUITY_POINT_KEYS = [
  'time',
  'barIndex',
  'bars',
  'equity',
  'minEquity',
  'maxEquity',
  'drawdown',
  'drawdownPercent',
  'buyHoldEquity',
  'positionSize',
] as const satisfies readonly (keyof ReportEquityPoint)[];

function normalizeSplit(v: unknown): ReportSplit {
  return numbers(isObject(v) ? v : {}, SPLIT_KEYS);
}

function normalizeProperties(v: unknown): ReportStrategyProperties | null {
  if (!isObject(v)) return null;
  return {
    pyramiding: num(v['pyramiding']),
    calcOnOrderFills: bool(v['calcOnOrderFills']),
    calcOnEveryTick: bool(v['calcOnEveryTick']),
    calcOnEveryHistoryTick: bool(v['calcOnEveryHistoryTick']),
    maxBarsBack: num(v['maxBarsBack']),
    backtestFillLimitsAssumption: num(v['backtestFillLimitsAssumption']),
    defaultQtyType: v['defaultQtyType'] == null ? null : str(v['defaultQtyType']),
    defaultQtyValue: num(v['defaultQtyValue']),
    initialCapital: num(v['initialCapital']),
    currency: v['currency'] == null ? null : str(v['currency']),
    slippage: num(v['slippage']),
    commissionType: v['commissionType'] == null ? null : str(v['commissionType']),
    commissionValue: num(v['commissionValue']),
    processOrdersOnClose: bool(v['processOrdersOnClose']),
    closeEntriesRule: v['closeEntriesRule'] == null ? null : str(v['closeEntriesRule']),
    marginLong: num(v['marginLong']),
    marginShort: num(v['marginShort']),
    riskFreeRate: num(v['riskFreeRate']),
    useBarMagnifier: bool(v['useBarMagnifier']),
    fillOrdersOnStandardOhlc: bool(v['fillOrdersOnStandardOhlc']),
  };
}

function normalizeMeta(v: unknown): ReportMeta {
  const m = isObject(v) ? v : {};
  return {
    symbol: str(m['symbol']),
    timeframe: str(m['timeframe']),
    accountCurrency: str(m['accountCurrency']),
    symbolCurrency: str(m['symbolCurrency']),
    initialCapital: num(m['initialCapital']),
    firstBarTime: num(m['firstBarTime']),
    lastBarTime: num(m['lastBarTime']),
    lastBarTimeClose: num(m['lastBarTimeClose']),
    firstBarIndex: num(m['firstBarIndex']),
    lastBarIndex: num(m['lastBarIndex']),
    bars: num(m['bars']),
    trimmedTrades: num(m['trimmedTrades']),
    useBarMagnifier: m['useBarMagnifier'] === true,
    riskHalted: m['riskHalted'] === true,
    riskHaltReason: str(m['riskHaltReason']),
    properties: normalizeProperties(m['properties']),
  };
}

function normalizeTrade(v: unknown): ReportTrade {
  const t = isObject(v) ? v : {};
  return {
    ...numbers(t, TRADE_NUMBER_KEYS),
    isOpen: t['isOpen'] === true,
    direction: str(t['direction']).toLowerCase(),
    entryId: str(t['entryId']),
    entrySignal: str(t['entrySignal']) || str(t['entryId']),
    exitId: str(t['exitId']),
    exitSignal: str(t['exitSignal']) || str(t['exitId']),
    exitLeg: str(t['exitLeg']),
  };
}

function normalizeMonth(v: unknown): ReportMonthlyReturn | null {
  if (!isObject(v)) return null;
  const year = num(v['year']);
  const month = num(v['month']);
  if (year === null || month === null || month < 1 || month > 12) return null;
  return {
    year,
    month,
    startEquity: num(v['startEquity']),
    endEquity: num(v['endEquity']),
    returnPercent: num(v['returnPercent']),
  };
}

/**
 * Converts any serialisation of a StrategyReport (JSON text or object, camelCase or PascalCase)
 * into the typed model. Returns null when the input is not a report — e.g. the JSON-DSL
 * `BacktestResult` a DSL backtest run stores. Idempotent: a normalised report passes through
 * unchanged in content.
 */
export function normalizeStrategyReport(raw: unknown): StrategyReport | null {
  const source = asObject(raw);
  if (!source) return null;
  const o = camelizeReportJson(source) as Json;
  if (!looksLikeReport(o)) return null;

  const perf = isObject(o['performance']) ? o['performance'] : {};
  return {
    meta: normalizeMeta(o['meta']),
    performance: {
      all: normalizeSplit(perf['all']),
      long: normalizeSplit(perf['long']),
      short: normalizeSplit(perf['short']),
    },
    equity: numbers(isObject(o['equity']) ? o['equity'] : {}, EQUITY_KEYS),
    returns: numbers(isObject(o['returns']) ? o['returns'] : {}, RETURNS_KEYS),
    capital: numbers(isObject(o['capital']) ? o['capital'] : {}, CAPITAL_KEYS),
    trades: Array.isArray(o['trades']) ? o['trades'].map(normalizeTrade) : [],
    equityCurve: Array.isArray(o['equityCurve'])
      ? o['equityCurve']
          .map((p) => numbers(isObject(p) ? p : {}, EQUITY_POINT_KEYS))
          .filter((p) => p.time !== null)
      : [],
    monthlyReturns: Array.isArray(o['monthlyReturns'])
      ? o['monthlyReturns'].map(normalizeMonth).filter((m): m is ReportMonthlyReturn => m !== null)
      : [],
    warnings: Array.isArray(o['warnings'])
      ? o['warnings'].filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
      : [],
  };
}

/** Wrapper properties a host payload may nest the report under (compared after camelCasing). */
const REPORT_WRAPPER_KEYS = ['report', 'strategyReport', 'scriptReport', 'scriptStrategyReport'];

/**
 * Finds a StrategyReport in a backtest run's `resultJson` (or any payload): the root itself, or
 * one level down under a wrapper property (`report`, `strategyReport`, …, any casing). Returns
 * null for the JSON-DSL `BacktestResult`, so callers can keep the DSL analytics for those runs.
 */
export function extractStrategyReport(resultJson: unknown): StrategyReport | null {
  const root = asObject(resultJson);
  if (!root) return null;
  const direct = normalizeStrategyReport(root);
  if (direct) return direct;
  for (const [k, v] of Object.entries(root)) {
    if (!REPORT_WRAPPER_KEYS.includes(toCamelCase(k))) continue;
    const nested = normalizeStrategyReport(v);
    if (nested) return nested;
  }
  return null;
}

// ── Derived views ─────────────────────────────────────────────────────────────

/** Closed trades only (the Strategy Tester's statistics never include open trades). */
export function closedTrades(report: StrategyReport): ReportTrade[] {
  return report.trades.filter((t) => !t.isOpen);
}

export function openTrades(report: StrategyReport): ReportTrade[] {
  return report.trades.filter((t) => t.isOpen);
}

/** The report's display currency: the account currency, else the declared strategy currency. */
export function reportCurrency(report: StrategyReport): string {
  const c = report.meta.accountCurrency || report.meta.properties?.currency || '';
  return c && c.toUpperCase() !== 'NONE' ? c.toUpperCase() : '';
}

export interface MonthlyReturnsYear {
  year: number;
  /** Index 0 = January; null when the month has no data. */
  months: (ReportMonthlyReturn | null)[];
  /** The year's return from its first month's start equity to its last month's end equity. */
  yearReturnPercent: Num;
}

/**
 * Pivots the monthly returns into year rows (oldest first) with the year's total compounded
 * from start to end equity — the numbers behind the monthly-returns heatmap.
 */
export function monthlyReturnsByYear(months: readonly ReportMonthlyReturn[]): MonthlyReturnsYear[] {
  const byYear = new Map<number, (ReportMonthlyReturn | null)[]>();
  for (const m of months) {
    let row = byYear.get(m.year);
    if (!row) {
      row = new Array<ReportMonthlyReturn | null>(12).fill(null);
      byYear.set(m.year, row);
    }
    row[m.month - 1] = m;
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, row]) => {
      const present = row.filter((m): m is ReportMonthlyReturn => m !== null);
      const first = present[0];
      const last = present[present.length - 1];
      const start = first?.startEquity ?? null;
      const end = last?.endEquity ?? null;
      const yearReturnPercent =
        start !== null && end !== null && start > 0 ? ((end - start) / start) * 100 : null;
      return { year, months: row, yearReturnPercent };
    });
}

export interface ExtremeWindow {
  /** Index into the equity curve where the move started (peak for a drawdown, trough for a run-up). */
  fromIndex: number;
  /** Index where it ended (trough for a drawdown, peak for a run-up). */
  toIndex: number;
  amount: number;
}

/**
 * The largest close-to-close drawdown (peak → trough) on the equity curve, located so the chart
 * can shade it. Null when the curve never fell below a prior peak.
 */
export function maxDrawdownWindow(curve: readonly ReportEquityPoint[]): ExtremeWindow | null {
  let peakIdx = -1;
  let peak = -Infinity;
  let best: ExtremeWindow | null = null;
  for (let i = 0; i < curve.length; i++) {
    const equity = curve[i].equity;
    if (equity === null) continue;
    if (equity > peak) {
      peak = equity;
      peakIdx = i;
      continue;
    }
    const fall = peak - equity;
    if (fall > 0 && (best === null || fall > best.amount)) {
      best = { fromIndex: peakIdx, toIndex: i, amount: fall };
    }
  }
  return best;
}

/** The largest close-to-close run-up (trough → peak) on the equity curve. */
export function maxRunupWindow(curve: readonly ReportEquityPoint[]): ExtremeWindow | null {
  let troughIdx = -1;
  let trough = Infinity;
  let best: ExtremeWindow | null = null;
  for (let i = 0; i < curve.length; i++) {
    const equity = curve[i].equity;
    if (equity === null) continue;
    if (equity < trough) {
      trough = equity;
      troughIdx = i;
      continue;
    }
    const rise = equity - trough;
    if (rise > 0 && (best === null || rise > best.amount)) {
      best = { fromIndex: troughIdx, toIndex: i, amount: rise };
    }
  }
  return best;
}
