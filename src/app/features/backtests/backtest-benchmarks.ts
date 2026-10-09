/**
 * What a script backtest is measured against — `resultJson.Benchmarks` (engine `BacktestBenchmarks`, BT-I10,
 * 2026-10-09): holding the instrument across the window with its carry, and the run's own trades entered at random
 * bars with the same exits. Absent on results stored before then and on rule-engine runs.
 */
export interface BacktestRandomEntry {
  samples: number;
  seed: number;
  /** The run's trades with an R that were re-entered. */
  trades: number;
  /** The run's trades left out (no stop on the losing side, so no R). */
  tradesWithoutR: number;
  strategySumR: number;
  randomMedianSumR: number;
  randomP5SumR: number;
  randomP95SumR: number;
  /** Share (0–1) of random runs whose sum of R reached the run's own. */
  shareAtLeastStrategy: number;
}

export interface BacktestBenchmarks {
  buyAndHoldPriceReturnPct: number;
  /** Swap a held long earned (+) or paid (−), % of notional; null when the run modelled no swap. */
  buyAndHoldCarryPct: number | null;
  carryAdjustedBuyAndHoldReturnPct: number | null;
  carryNights: number;
  randomEntry: BacktestRandomEntry | null;
  notes: string[];
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A property by its PascalCase (wire) name, tolerating camelCase. */
function prop(o: Json, pascal: string): unknown {
  if (pascal in o) return o[pascal];
  return o[pascal[0].toLowerCase() + pascal.slice(1)];
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number {
  const n = num(v);
  return n === null ? 0 : Math.max(0, Math.trunc(n));
}

function randomEntryOf(v: unknown): BacktestRandomEntry | null {
  if (!isObject(v)) return null;
  const strategy = num(prop(v, 'StrategySumR'));
  const median = num(prop(v, 'RandomMedianSumR'));
  const p5 = num(prop(v, 'RandomP5SumR'));
  const p95 = num(prop(v, 'RandomP95SumR'));
  const share = num(prop(v, 'ShareAtLeastStrategy'));
  const samples = int(prop(v, 'Samples'));
  if (
    strategy === null ||
    median === null ||
    p5 === null ||
    p95 === null ||
    share === null ||
    samples === 0
  ) {
    return null;
  }
  return {
    samples,
    seed: int(prop(v, 'Seed')),
    trades: int(prop(v, 'Trades')),
    tradesWithoutR: int(prop(v, 'TradesWithoutR')),
    strategySumR: strategy,
    randomMedianSumR: median,
    randomP5SumR: p5,
    randomP95SumR: p95,
    shareAtLeastStrategy: Math.min(1, Math.max(0, share)),
  };
}

/** The run's `Benchmarks`, or null when it has none (older runs, rule-engine runs, bad JSON). */
export function backtestBenchmarksOf(
  resultJson: string | null | undefined,
): BacktestBenchmarks | null {
  if (!resultJson) return null;
  let root: unknown;
  try {
    root = JSON.parse(resultJson);
  } catch {
    return null;
  }
  if (!isObject(root)) return null;
  const b = prop(root, 'Benchmarks');
  if (!isObject(b)) return null;
  const price = num(prop(b, 'BuyAndHoldPriceReturnPct'));
  if (price === null) return null;
  const notes = prop(b, 'Notes');
  return {
    buyAndHoldPriceReturnPct: price,
    buyAndHoldCarryPct: num(prop(b, 'BuyAndHoldCarryPct')),
    carryAdjustedBuyAndHoldReturnPct: num(prop(b, 'CarryAdjustedBuyAndHoldReturnPct')),
    carryNights: int(prop(b, 'CarryNights')),
    randomEntry: randomEntryOf(prop(b, 'RandomEntry')),
    notes: Array.isArray(notes)
      ? notes
          .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
          .map((n) => n.trim())
      : [],
  };
}

export type BenchmarkVerdictTone = 'beats' | 'inside' | 'below';

/** What the backtest detail page shows for a run's benchmarks. */
export interface BenchmarksView {
  /** The run's own return, %, when the page has it (compared with buy & hold). */
  runReturnPct: number | null;
  buyAndHold: {
    pricePct: number;
    carryPct: number | null;
    adjustedPct: number | null;
    nights: number;
    /** One sentence comparing the run with holding, or null without the run's return. */
    comparison: string | null;
  };
  random: {
    view: BacktestRandomEntry;
    tone: BenchmarkVerdictTone;
    /** "Better than 97% of random entries with the same exits" style sentence. */
    verdict: string;
    /** What the samples were (count, trades, those left out). */
    detail: string;
    /** 0–100 positions of P5 / median / P95 / the run on a shared axis, for the strip. */
    axis: { p5: number; median: number; p95: number; run: number; min: number; max: number };
  } | null;
  notes: string[];
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
}

function r(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}R`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function formatBenchmarkPct(v: number | null): string {
  return v === null ? '—' : pct(v);
}

export function formatBenchmarkR(v: number): string {
  return r(v);
}

export function summarizeBenchmarks(
  b: BacktestBenchmarks,
  runReturnPct: number | null,
): BenchmarksView {
  const held = b.carryAdjustedBuyAndHoldReturnPct ?? b.buyAndHoldPriceReturnPct;
  const heldWord =
    b.carryAdjustedBuyAndHoldReturnPct === null ? 'holding a long' : 'holding a long with its swap';
  let comparison: string | null = null;
  if (runReturnPct !== null && Number.isFinite(runReturnPct)) {
    const diff = runReturnPct - held;
    comparison =
      Math.abs(diff) < 0.005
        ? `The run returned the same as ${heldWord} (${pct(held)}).`
        : `The run returned ${pct(runReturnPct)}, ${Math.abs(diff).toFixed(2)} points ${diff > 0 ? 'more' : 'less'} than ${heldWord} (${pct(held)}).`;
  }

  let random: BenchmarksView['random'] = null;
  const re = b.randomEntry;
  if (re) {
    const share = re.shareAtLeastStrategy;
    const better = Math.round((1 - share) * 100);
    const tone: BenchmarkVerdictTone =
      re.strategySumR > re.randomP95SumR
        ? 'beats'
        : re.strategySumR < re.randomP5SumR
          ? 'below'
          : 'inside';
    const verdict =
      tone === 'beats'
        ? `The run's ${r(re.strategySumR)} is above 95% of random entries with the same exits — only ${(share * 100).toFixed(1)}% reached it, so luck explains little of it.`
        : tone === 'below'
          ? `The run's ${r(re.strategySumR)} is below 95% of random entries with the same exits — the entries did worse than chance.`
          : `The run's ${r(re.strategySumR)} beat ${better}% of random entries with the same exits — inside the random range, so the entries may add nothing over the exits.`;
    const min = Math.min(re.randomP5SumR, re.strategySumR, re.randomMedianSumR);
    const max = Math.max(re.randomP95SumR, re.strategySumR, re.randomMedianSumR);
    const span = max - min || 1;
    const at = (v: number) => Math.round(((v - min) / span) * 1000) / 10;
    random = {
      view: re,
      tone,
      verdict,
      detail:
        `${plural(re.samples, 'random run', 'random runs')} (seed ${re.seed}) re-entered ${plural(re.trades, 'trade', 'trades')} ` +
        `at random bars with the same direction, stop, target and longest hold, each charged its own costs` +
        (re.tradesWithoutR > 0
          ? `; ${plural(re.tradesWithoutR, 'trade', 'trades')} without a stop left out.`
          : '.'),
      axis: {
        p5: at(re.randomP5SumR),
        median: at(re.randomMedianSumR),
        p95: at(re.randomP95SumR),
        run: at(re.strategySumR),
        min,
        max,
      },
    };
  }

  return {
    runReturnPct: runReturnPct !== null && Number.isFinite(runReturnPct) ? runReturnPct : null,
    buyAndHold: {
      pricePct: b.buyAndHoldPriceReturnPct,
      carryPct: b.buyAndHoldCarryPct,
      adjustedPct: b.carryAdjustedBuyAndHoldReturnPct,
      nights: b.carryNights,
      comparison,
    },
    random,
    notes: b.notes,
  };
}
