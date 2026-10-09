/**
 * What a script backtest's stored result (`BacktestRun.resultJson`, the engine `BacktestResult`)
 * says beyond its Strategy report: how the run was made (`script`, PE-13 provenance), the engine's
 * own trade list with each trade's R (C6) and its cost totals (PE-I1).
 *
 * The result is PascalCase except its `script` section (camelCase); both spellings are read.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** A property by its camelCase name, tolerating PascalCase. */
function prop(o: Json, camel: string): unknown {
  if (camel in o) return o[camel];
  return o[camel[0].toUpperCase() + camel.slice(1)];
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

/** How a script backtest was made (engine `ScriptBacktestInfo`). */
export interface RunProvenance {
  /** SHA-256 of the script source the run executed, first 16 hex digits. */
  sourceHash: string;
  languageVersion: number | null;
  /** The input overrides applied (id → value). */
  inputs: Record<string, unknown>;
  /** Overrides left out, each with its reason. */
  ignoredInputs: string[];
  compileWarnings: string[];
  /** Queued by hand (not by the pipeline or an optimization). */
  operatorAdHoc: boolean;
  deep: boolean;
  barMagnifier: boolean;
  costModel: string;
  costModelReason: string;
  scriptDeclaredCosts: boolean;
  chartTimeframe: string;
  chartSource: string;
  warmupBars: number | null;
  bars: number | null;
  tradingStartUtc: string | null;
  initialCapital: number | null;
  capitalSource: string;
  accountCurrency: string;
  lazyLoads: string[];
  elapsedMs: number | null;
  executions: number | null;
  /** The adversarial gate's synthetic news shock was applied (BT-03). */
  priceShock: boolean;
}

/** The engine's cost totals for the run, in the account currency. */
export interface EngineCosts {
  commission: number | null;
  swap: number | null;
  /** Slippage and spread together, as the engine books them. */
  slippage: number | null;
  model: string;
  /** Extra cost per trade, in pips, that takes the net profit to zero (BT-I10). */
  breakevenPipsPerTrade: number | null;
}

export interface EngineRun {
  /** The engine's trade list (raw rows: PascalCase `RMultiple`, `PnL`, `RiskedAmount`…). */
  trades: unknown[];
  costs: EngineCosts | null;
  /** The engine's own R statistics, when the result carries them. */
  expectancyR: number | null;
  rTradeCount: number | null;
  /** Percent (0–100) of R trades whose run-up reached +1R. */
  pctReachedOneR: number | null;
  provenance: RunProvenance | null;
}

function parseRoot(resultJson: unknown): Json | null {
  if (isObject(resultJson)) return resultJson;
  if (typeof resultJson !== 'string' || !resultJson.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(resultJson);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseProvenance(script: unknown): RunProvenance | null {
  if (!isObject(script)) return null;
  const inputs = prop(script, 'inputs');
  return {
    sourceHash: str(prop(script, 'sourceHash')).toLowerCase(),
    languageVersion: num(prop(script, 'languageVersion')),
    inputs: isObject(inputs) ? { ...inputs } : {},
    ignoredInputs: strings(prop(script, 'ignoredInputs')),
    compileWarnings: strings(prop(script, 'compileWarnings')),
    operatorAdHoc: prop(script, 'operatorAdHoc') === true,
    deep: prop(script, 'deep') === true,
    barMagnifier: prop(script, 'barMagnifier') === true,
    costModel: str(prop(script, 'costModel')),
    costModelReason: str(prop(script, 'costModelReason')),
    scriptDeclaredCosts: prop(script, 'scriptDeclaredCosts') === true,
    chartTimeframe: str(prop(script, 'chartTimeframe')),
    chartSource: str(prop(script, 'chartSource')),
    warmupBars: num(prop(script, 'warmupBars')),
    bars: num(prop(script, 'bars')),
    tradingStartUtc: str(prop(script, 'tradingStartUtc')) || null,
    initialCapital: num(prop(script, 'initialCapital')),
    capitalSource: str(prop(script, 'capitalSource')),
    accountCurrency: str(prop(script, 'accountCurrency')),
    lazyLoads: strings(prop(script, 'lazyLoads')),
    elapsedMs: num(prop(script, 'elapsedMs')),
    executions: num(prop(script, 'executions')),
    priceShock: isObject(prop(script, 'priceShock')),
  };
}

/** Null when the result cannot be read or is not an engine result. */
export function parseEngineRun(resultJson: unknown): EngineRun | null {
  const root = parseRoot(resultJson);
  if (!root) return null;
  const trades = prop(root, 'trades');
  const commission = num(prop(root, 'totalCommission'));
  const swap = num(prop(root, 'totalSwap'));
  const slippage = num(prop(root, 'totalSlippage'));
  const hasCosts = commission !== null || swap !== null || slippage !== null;
  return {
    trades: Array.isArray(trades) ? trades : [],
    costs: hasCosts
      ? {
          commission,
          swap,
          slippage,
          model: str(prop(root, 'costModel')),
          breakevenPipsPerTrade: num(prop(root, 'costBreakevenPipsPerTrade')),
        }
      : null,
    expectancyR: num(prop(root, 'expectancyR')),
    rTradeCount: num(prop(root, 'rMultipleTradeCount')),
    pctReachedOneR: num(prop(root, 'pctReachedOneR')),
    provenance: parseProvenance(prop(root, 'script')),
  };
}

/** A value as the run applied it, for display. */
export function inputValueText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface InputDifference {
  id: string;
  /** What the run used; null when it did not set it (the script's default). */
  run: string | null;
  /** What the strategy has now; null when it does not set it. */
  now: string | null;
}

/**
 * The inputs where the run and the strategy now differ. Values compare as text, so `20` and
 * `"20"` (a JSON number and its string form) are the same.
 */
export function inputDifferences(
  runInputs: Record<string, unknown>,
  current: Record<string, unknown>,
): InputDifference[] {
  const ids = [...new Set([...Object.keys(runInputs), ...Object.keys(current)])].sort();
  const out: InputDifference[] = [];
  for (const id of ids) {
    const run = id in runInputs ? inputValueText(runInputs[id]) : null;
    const now = id in current ? inputValueText(current[id]) : null;
    if (run !== now) out.push({ id, run, now });
  }
  return out;
}
