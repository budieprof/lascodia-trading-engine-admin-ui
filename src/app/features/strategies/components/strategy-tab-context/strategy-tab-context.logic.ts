/** Which strategy-detail tabs apply to a strategy, and what to say when one does not. Pure. */

export type DetailTab =
  | 'promotion'
  | 'signals'
  | 'orders'
  | 'optimization'
  | 'backtests'
  | 'walkforward'
  | 'variants'
  | 'capacity'
  | 'reviews'
  | 'lineage';

/** Engine `SentinelStrategyRegistry.KnownNames` — only a fallback while the footprint endpoint is unavailable. */
export const SENTINEL_NAMES = ['LLM Spot Analysis', 'Synthetic Analyser', 'Manual Trades'];

export function isSentinelName(name: string | null | undefined): boolean {
  return !!name && SENTINEL_NAMES.includes(name);
}

/** Tabs that are about a strategy's OWN rules and evidence — meaningless for a sentinel. */
const EVIDENCE_TABS: readonly DetailTab[] = [
  'promotion',
  'optimization',
  'backtests',
  'walkforward',
  'variants',
];

const TAB_LABEL: Record<DetailTab, string> = {
  promotion: 'Promotion',
  signals: 'Signals',
  orders: 'Orders',
  optimization: 'Optimization',
  backtests: 'Backtests',
  walkforward: 'Walk-forward',
  variants: 'Variants',
  capacity: 'Capacity',
  reviews: 'Reviews',
  lineage: 'Lineage',
};

const WHY_NOT: Partial<Record<DetailTab, string>> = {
  promotion:
    'Promotion gates judge a strategy’s own backtest evidence before it may trade. A sentinel has no rules to backtest — it is the label the engine puts on trades another source decided — so it is never promoted; it is Active from the start, and pausing it stops that source.',
  optimization:
    'The optimizer searches a strategy’s own parameters. A sentinel has none: the decisions come from the analyser (or from you, for manual trades), so there is nothing to tune here.',
  backtests:
    'A backtest replays a strategy’s rules over history. A sentinel has no rules to replay; the decisions it carries are judged on their live results below — and LLM decisions can be replayed on the LLM Backtest page.',
  walkforward:
    'Walk-forward re-optimises and re-tests a strategy’s rules window by window. A sentinel has no rules, so there is nothing to walk forward.',
  variants:
    'Variants are A/B copies of a strategy with changed parameters, run in shadow. A sentinel has no parameters to vary.',
};

export interface TabApplicability {
  applies: boolean;
  title: string;
  why: string | null;
}

export function tabApplicability(tab: DetailTab, sentinel: boolean): TabApplicability {
  if (sentinel && EVIDENCE_TABS.includes(tab))
    return {
      applies: false,
      title: `${TAB_LABEL[tab]} does not apply to a sentinel strategy`,
      why: WHY_NOT[tab] ?? null,
    };
  return { applies: true, title: TAB_LABEL[tab], why: null };
}

/** "≈ 0.4 signals a day" from a daily series. */
export function perDay(series: readonly { signals: number }[]): number {
  if (series.length === 0) return 0;
  return series.reduce((a, d) => a + d.signals, 0) / series.length;
}
