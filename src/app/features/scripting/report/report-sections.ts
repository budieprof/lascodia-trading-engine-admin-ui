import type { Num, ReportSplit, StrategyReport } from './strategy-report.model';
import {
  NA,
  formatBars,
  formatInteger,
  formatMoney,
  formatPercent,
  formatQty,
  formatRatio,
} from './report-format';

/**
 * Row definitions for the report's tabular tabs. Each tab is a list of titled groups; a row
 * knows how to read its value (and an optional percentage shown under it), how to format it,
 * and what colour its value may carry.
 *
 * Kept as data so the Performance table provably covers every field of the report's
 * `performance` section (see the spec) and the tabs stay declarative.
 */

export type MetricKind = 'money' | 'percent' | 'ratio' | 'integer' | 'bars' | 'qty';

/**
 * How a value is coloured:
 * - `signed` — gain/loss by the value's sign (net profit, avg trade, returns);
 * - `gain` / `loss` — always that side (gross profit is a gain, gross loss a loss);
 * - `lossIfPositive` — a count that is only bad when non-zero (margin calls);
 * - `none` — neutral (counts, ratios, capital).
 */
export type MetricTone = 'signed' | 'gain' | 'loss' | 'lossIfPositive' | 'none';

interface MetricRowBase {
  label: string;
  /** Plain-language definition, shown as the row's description. */
  hint?: string;
  kind: MetricKind;
  tone?: MetricTone;
  /** Prefix "+" on positive values (money / percent). */
  signed?: boolean;
  /**
   * The engine reports some losses as positive magnitudes (gross loss, average / largest losing
   * trade). These print with a minus so they read as the losses they are.
   */
  showAsLoss?: boolean;
}

export interface SplitMetricRow extends MetricRowBase {
  /** The ReportSplit field the row reads (used by the coverage spec). */
  field?: keyof ReportSplit;
  /** Extra split fields the row also prints (its percentage line). */
  percentField?: keyof ReportSplit;
  value: (s: ReportSplit) => Num;
  percent?: (s: ReportSplit) => Num;
}

export interface SplitMetricGroup {
  title: string;
  rows: SplitMetricRow[];
}

export interface ReportMetricRow extends MetricRowBase {
  value: (r: StrategyReport) => Num;
  percent?: (r: StrategyReport) => Num;
}

export interface ReportMetricGroup {
  title: string;
  rows: ReportMetricRow[];
}

function splitRow(
  label: string,
  field: keyof ReportSplit,
  kind: MetricKind,
  extra: Partial<SplitMetricRow> = {},
): SplitMetricRow {
  const row: SplitMetricRow = {
    label,
    field,
    kind,
    value: (s) => s[field],
    ...extra,
  };
  if (extra.percentField) {
    const pf = extra.percentField;
    row.percent = (s) => s[pf];
  }
  return row;
}

/** Every field of the report's `performance` section, grouped the way the Strategy Tester reads. */
export const PERFORMANCE_GROUPS: readonly SplitMetricGroup[] = [
  {
    title: 'Returns',
    rows: [
      splitRow('Net profit', 'netProfit', 'money', {
        percentField: 'netProfitPercent',
        tone: 'signed',
        signed: true,
        hint: 'Realised profit of closed trades after commission; % of initial capital.',
      }),
      splitRow('Gross profit', 'grossProfit', 'money', {
        percentField: 'grossProfitPercent',
        tone: 'gain',
        hint: 'Sum of the profits of every winning trade.',
      }),
      splitRow('Gross loss', 'grossLoss', 'money', {
        percentField: 'grossLossPercent',
        tone: 'loss',
        showAsLoss: true,
        hint: 'Sum of the losses of every losing trade.',
      }),
      splitRow('Profit factor', 'profitFactor', 'ratio', {
        hint: 'Gross profit ÷ gross loss. Not defined without a losing trade.',
      }),
      splitRow('Commission paid', 'commissionPaid', 'money', {
        hint: 'Commission of closed trades plus the entry commission of open ones.',
      }),
      splitRow('Open P&L', 'openPnL', 'money', {
        percentField: 'openPnLPercent',
        tone: 'signed',
        signed: true,
        hint: 'Unrealised profit of the trades still open at the last bar.',
      }),
      splitRow('Max contracts held', 'maxContractsHeld', 'qty'),
    ],
  },
  {
    title: 'Trades',
    rows: [
      splitRow('Total closed trades', 'totalClosedTrades', 'integer'),
      splitRow('Total open trades', 'totalOpenTrades', 'integer'),
      splitRow('Winning trades', 'winningTrades', 'integer'),
      splitRow('Losing trades', 'losingTrades', 'integer'),
      splitRow('Even trades', 'evenTrades', 'integer'),
      splitRow('Percent profitable', 'percentProfitable', 'percent'),
      splitRow('Avg trade', 'avgTrade', 'money', {
        percentField: 'avgTradePercent',
        tone: 'signed',
        signed: true,
        hint: 'Expected payoff: net profit ÷ closed trades.',
      }),
      splitRow('Avg winning trade', 'avgWinningTrade', 'money', {
        percentField: 'avgWinningTradePercent',
        tone: 'gain',
      }),
      splitRow('Avg losing trade', 'avgLosingTrade', 'money', {
        percentField: 'avgLosingTradePercent',
        tone: 'loss',
        showAsLoss: true,
      }),
      splitRow('Ratio avg win / avg loss', 'ratioAvgWinAvgLoss', 'ratio'),
      splitRow('Largest winning trade', 'largestWinningTrade', 'money', {
        percentField: 'largestWinningTradePercent',
        tone: 'gain',
      }),
      splitRow('Largest losing trade', 'largestLosingTrade', 'money', {
        percentField: 'largestLosingTradePercent',
        tone: 'loss',
        showAsLoss: true,
      }),
      splitRow('Avg # bars in trades', 'avgBarsInTrades', 'bars'),
      splitRow('Avg # bars in winning trades', 'avgBarsInWinningTrades', 'bars'),
      splitRow('Avg # bars in losing trades', 'avgBarsInLosingTrades', 'bars'),
    ],
  },
  {
    title: 'Trade excursions',
    rows: [
      splitRow('Max trade run-up (MFE)', 'maxTradeRunup', 'money', {
        tone: 'gain',
        hint: 'Largest favourable excursion of a single closed trade.',
      }),
      splitRow('Max trade drawdown (MAE)', 'maxTradeDrawdown', 'money', {
        tone: 'loss',
        hint: 'Largest adverse excursion of a single closed trade.',
      }),
    ],
  },
];

function share(part: Num, whole: Num): Num {
  return part !== null && whole !== null && whole > 0 ? (part / whole) * 100 : null;
}

/** The Strategy Tester's Trades analysis: counts, payoff and holding time, with two derived shares. */
export const TRADES_ANALYSIS_GROUPS: readonly SplitMetricGroup[] = [
  {
    title: 'Counts',
    rows: [
      splitRow('Total closed trades', 'totalClosedTrades', 'integer'),
      splitRow('Total open trades', 'totalOpenTrades', 'integer'),
      splitRow('Winning trades', 'winningTrades', 'integer'),
      splitRow('Losing trades', 'losingTrades', 'integer'),
      splitRow('Even trades', 'evenTrades', 'integer'),
      splitRow('Percent profitable', 'percentProfitable', 'percent'),
    ],
  },
  {
    title: 'Payoff',
    rows: [
      splitRow('Avg P&L', 'avgTrade', 'money', {
        percentField: 'avgTradePercent',
        tone: 'signed',
        signed: true,
      }),
      splitRow('Avg winning trade', 'avgWinningTrade', 'money', {
        percentField: 'avgWinningTradePercent',
        tone: 'gain',
      }),
      splitRow('Avg losing trade', 'avgLosingTrade', 'money', {
        percentField: 'avgLosingTradePercent',
        tone: 'loss',
        showAsLoss: true,
      }),
      splitRow('Ratio avg win / avg loss', 'ratioAvgWinAvgLoss', 'ratio'),
      splitRow('Largest winning trade', 'largestWinningTrade', 'money', {
        percentField: 'largestWinningTradePercent',
        tone: 'gain',
      }),
      {
        label: 'Largest winner as % of gross profit',
        kind: 'percent',
        value: (s) => share(s.largestWinningTrade, s.grossProfit),
        hint: 'How much of the gross profit came from the single best trade.',
      },
      splitRow('Largest losing trade', 'largestLosingTrade', 'money', {
        percentField: 'largestLosingTradePercent',
        tone: 'loss',
        showAsLoss: true,
      }),
      {
        label: 'Largest loser as % of gross loss',
        kind: 'percent',
        value: (s) => share(s.largestLosingTrade, s.grossLoss),
        hint: 'How much of the gross loss came from the single worst trade.',
      },
    ],
  },
  {
    title: 'Holding time',
    rows: [
      splitRow('Avg # bars in trades', 'avgBarsInTrades', 'bars'),
      splitRow('Avg # bars in winning trades', 'avgBarsInWinningTrades', 'bars'),
      splitRow('Avg # bars in losing trades', 'avgBarsInLosingTrades', 'bars'),
    ],
  },
];

/** Risk & returns: returns, risk-adjusted ratios and the equity curve's drawdown / run-up. */
export const RISK_RETURNS_GROUPS: readonly ReportMetricGroup[] = [
  {
    title: 'Returns',
    rows: [
      { label: 'Initial capital', kind: 'money', value: (r) => r.meta.initialCapital },
      { label: 'Final equity', kind: 'money', value: (r) => r.equity.finalEquity },
      {
        label: 'Return on initial capital',
        kind: 'percent',
        tone: 'signed',
        signed: true,
        value: (r) => r.returns.returnOnInitialCapitalPercent,
      },
      {
        label: 'CAGR',
        kind: 'percent',
        tone: 'signed',
        signed: true,
        value: (r) => r.returns.cagr,
        hint: 'Compound annual growth rate over the tested range.',
      },
      {
        label: 'Buy & hold return',
        kind: 'money',
        tone: 'signed',
        signed: true,
        value: (r) => r.returns.buyAndHoldReturn,
        percent: (r) => r.returns.buyAndHoldReturnPercent,
        hint: 'What holding the symbol over the same range would have made.',
      },
      {
        label: 'Strategy outperformance',
        kind: 'money',
        tone: 'signed',
        signed: true,
        value: (r) => r.returns.strategyOutperformance,
        hint: 'Net profit minus the buy & hold return.',
      },
    ],
  },
  {
    title: 'Risk-adjusted',
    rows: [
      {
        label: 'Sharpe ratio',
        kind: 'ratio',
        value: (r) => r.returns.sharpeRatio,
        hint: 'Mean monthly return over the risk-free rate ÷ its standard deviation. Needs 2+ months.',
      },
      {
        label: 'Sortino ratio',
        kind: 'ratio',
        value: (r) => r.returns.sortinoRatio,
        hint: 'As Sharpe, but divided by the downside deviation only.',
      },
      {
        label: 'Risk-free rate (annual)',
        kind: 'percent',
        value: (r) => r.returns.riskFreeRate,
      },
      { label: 'Months in sample', kind: 'integer', value: (r) => r.returns.months },
    ],
  },
  {
    title: 'Drawdown',
    rows: [
      {
        label: 'Max equity drawdown (intrabar)',
        kind: 'money',
        tone: 'loss',
        value: (r) => r.equity.maxDrawdown,
        percent: (r) => r.equity.maxDrawdownPercent,
        hint: 'Largest fall from an equity peak, measured on every processed tick.',
      },
      {
        label: 'Max drawdown as % of initial capital',
        kind: 'percent',
        value: (r) => r.equity.maxDrawdownPercentOfInitialCapital,
      },
      {
        label: 'Max drawdown (close-to-close)',
        kind: 'money',
        tone: 'loss',
        value: (r) => r.equity.maxDrawdownCloseToClose,
        percent: (r) => r.equity.maxDrawdownCloseToClosePercent,
      },
      {
        label: 'Return of max drawdown',
        kind: 'ratio',
        value: (r) => r.equity.returnOfMaxDrawdown,
        hint: 'Net profit ÷ intrabar max drawdown.',
      },
      { label: 'Drawdown periods', kind: 'integer', value: (r) => r.equity.drawdownPeriods },
      {
        label: 'Avg drawdown',
        kind: 'money',
        tone: 'loss',
        value: (r) => r.equity.avgDrawdownAmount,
      },
      {
        label: 'Avg drawdown duration (bars)',
        kind: 'bars',
        value: (r) => r.equity.avgDrawdownDurationBars,
      },
    ],
  },
  {
    title: 'Run-up',
    rows: [
      {
        label: 'Max equity run-up (intrabar)',
        kind: 'money',
        tone: 'gain',
        value: (r) => r.equity.maxRunup,
        percent: (r) => r.equity.maxRunupPercent,
      },
      {
        label: 'Max run-up as % of initial capital',
        kind: 'percent',
        value: (r) => r.equity.maxRunupPercentOfInitialCapital,
      },
      {
        label: 'Max run-up (close-to-close)',
        kind: 'money',
        tone: 'gain',
        value: (r) => r.equity.maxRunupCloseToClose,
        percent: (r) => r.equity.maxRunupCloseToClosePercent,
      },
      { label: 'Run-up periods', kind: 'integer', value: (r) => r.equity.runupPeriods },
      { label: 'Avg run-up', kind: 'money', tone: 'gain', value: (r) => r.equity.avgRunupAmount },
      {
        label: 'Avg run-up duration (bars)',
        kind: 'bars',
        value: (r) => r.equity.avgRunupDurationBars,
      },
    ],
  },
];

/** Capital efficiency: margin use and the account size the strategy actually needed. */
export const CAPITAL_GROUPS: readonly ReportMetricGroup[] = [
  {
    title: 'Capital',
    rows: [
      {
        label: 'Account size required',
        kind: 'money',
        value: (r) => r.capital.accountSizeRequired,
        hint: 'Smallest starting capital that never falls below the margin requirement (or zero).',
      },
      {
        label: 'Return on account size required',
        kind: 'percent',
        tone: 'signed',
        signed: true,
        value: (r) => r.capital.returnOnAccountSizeRequiredPercent,
      },
      {
        label: 'Net profit as % of largest loss',
        kind: 'percent',
        tone: 'signed',
        signed: true,
        value: (r) => r.capital.netProfitAsPercentOfLargestLoss,
      },
      { label: 'Commission paid', kind: 'money', value: (r) => r.performance.all.commissionPaid },
      {
        label: 'Max contracts held',
        kind: 'qty',
        value: (r) => r.performance.all.maxContractsHeld,
      },
    ],
  },
  {
    title: 'Margin',
    rows: [
      {
        label: 'Margin calls',
        kind: 'integer',
        tone: 'lossIfPositive',
        value: (r) => r.capital.marginCalls,
        hint: 'Times the emulated broker liquidated part of the position for lack of margin.',
      },
      { label: 'Liquidated quantity', kind: 'qty', value: (r) => r.capital.liquidatedQty },
      { label: 'Max margin used', kind: 'money', value: (r) => r.capital.maxMarginUsed },
      { label: 'Avg margin per trade', kind: 'money', value: (r) => r.capital.avgMarginPerTrade },
      {
        label: 'Margin for longs',
        kind: 'percent',
        value: (r) => r.meta.properties?.marginLong ?? null,
        hint: '100% = no leverage; 0% = no margin checks.',
      },
      {
        label: 'Margin for shorts',
        kind: 'percent',
        value: (r) => r.meta.properties?.marginShort ?? null,
      },
    ],
  },
];

/** Formats a metric's primary value. */
export function formatMetricValue(row: MetricRowBase, v: Num, currency: string): string {
  if (v === null) return NA;
  const shown = row.showAsLoss && v > 0 ? -v : v;
  switch (row.kind) {
    case 'money':
      return formatMoney(shown, currency, { signed: row.signed });
    case 'percent':
      return formatPercent(shown, { signed: row.signed });
    case 'ratio':
      return formatRatio(shown);
    case 'integer':
      return formatInteger(shown);
    case 'bars':
      return formatBars(shown);
    case 'qty':
      return formatQty(shown);
  }
}

/** Formats a row's secondary percentage (always a percentage, signed like its value). */
export function formatMetricPercent(row: MetricRowBase, v: Num): string {
  if (v === null) return '';
  const shown = row.showAsLoss && v > 0 ? -v : v;
  return formatPercent(shown, { signed: row.signed });
}

/** CSS tone class for a value: `gain`, `loss` or '' (neutral). */
export function metricToneClass(row: MetricRowBase, v: Num): '' | 'gain' | 'loss' {
  if (v === null) return '';
  switch (row.tone ?? 'none') {
    case 'signed':
      return v > 0 ? 'gain' : v < 0 ? 'loss' : '';
    case 'gain':
      return v !== 0 ? 'gain' : '';
    case 'loss':
      return v !== 0 ? 'loss' : '';
    case 'lossIfPositive':
      return v > 0 ? 'loss' : '';
    default:
      return '';
  }
}
