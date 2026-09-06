/**
 * Every navigable page in the console, with the words an operator would use to look for it.
 *
 * <p>This table was written for the ⌘K command palette, but its `keywords` field is a
 * hand-written description of what each page is for — which is exactly the vocabulary the
 * admin assistant needs to answer "where do I see X" and to name the page an operator is
 * standing on. Lifted here so both consume one list; the palette imports it unchanged.</p>
 */
export interface PageCommand {
  label: string;
  group: string;
  route: string;
  keywords?: string;
}

export const PAGE_CATALOG: readonly PageCommand[] = [
  { group: 'Trading', label: 'Dashboard', route: '/dashboard' },
  { group: 'Trading', label: 'Orders', route: '/orders', keywords: 'order list trade' },
  { group: 'Trading', label: 'Positions', route: '/positions' },
  {
    group: 'Trading',
    label: 'Position Deltas',
    route: '/positions/deltas',
    keywords: 'lifecycle delta feed open close modify reconcile stale audit timeline',
  },
  {
    group: 'Trading',
    label: 'Trade Signals',
    route: '/trade-signals',
    keywords: 'approve reject pending',
  },
  {
    group: 'Trading',
    label: 'Signal Exits',
    route: '/trade-signals/feedback',
    keywords: 'ea expert advisor rejection expired dropped spread feedback exit feed strategy',
  },
  {
    group: 'Trading',
    label: 'Market Data',
    route: '/market-data',
    keywords: 'prices candles live quotes',
  },

  { group: 'Configuration', label: 'Strategies', route: '/strategies' },
  { group: 'Configuration', label: 'Trading Accounts', route: '/trading-accounts' },
  { group: 'Configuration', label: 'Brokers', route: '/brokers' },
  { group: 'Configuration', label: 'Risk Profiles', route: '/risk-profiles' },
  { group: 'Configuration', label: 'Currency Pairs', route: '/currency-pairs' },
  { group: 'Configuration', label: 'Alerts', route: '/alerts' },

  { group: 'ML', label: 'ML Models', route: '/ml-models', keywords: 'training shadow ab test' },
  {
    group: 'ML',
    label: 'ML — Training Queue',
    route: '/ml-models/training-queue',
    keywords: 'training queue queued running pending pipeline backlog worker stuck',
  },
  {
    group: 'ML',
    label: 'ML — Overfit Watchlist',
    route: '/ml-models/overfit-watchlist',
    keywords: 'overfit cv live sharpe edge collapse ratio',
  },
  {
    group: 'ML',
    label: 'ML — Symbolic Features',
    route: '/ml-models/symbolic-features',
    keywords: 'symbolic genetic programming candidate promoted retired feature',
  },
  {
    group: 'Strategy',
    label: 'Strategies — LLM Proposals',
    route: '/strategies/llm-proposals',
    keywords: 'llm gpt proposal candidate promote pending dsl',
  },
  {
    group: 'Strategy',
    label: 'Strategies — Rejection Summary',
    route: '/strategies/rejections',
    keywords: 'rejection signal gate audit stage reason',
  },
  {
    group: 'Strategy',
    label: 'Strategies — Templates',
    route: '/strategies/templates',
    keywords: 'template apply bulk symbols multi pair',
  },
  {
    group: 'Ops',
    label: 'Auto-Tune — Proposals',
    route: '/auto-tune',
    keywords: 'auto tune proposal apply reject knob mutation',
  },
  {
    group: 'Ops',
    label: 'Auto-Tune — Auto-Apply Config',
    route: '/auto-tune/auto-apply',
    keywords: 'auto apply safety gate convergence quiet period',
  },
  {
    group: 'System',
    label: 'Market Data — Order Book',
    route: '/market-data/order-book',
    keywords: 'order book depth ladder dom bid ask spread microstructure',
  },
  {
    group: 'System',
    label: 'Market Data — Candle Coverage',
    route: '/market-data/coverage',
    keywords: 'candle coverage gaps history segments missing ohlcv backfill',
  },
  {
    group: 'System',
    label: 'System — Worker Override Knobs',
    route: '/system-health/worker-override-knobs',
    keywords: 'override knob worker config key reference allow-list',
  },
  {
    group: 'ML',
    label: 'CompositeML — Active Policies',
    route: '/composite-ml',
    keywords: 'policy snapshot trainer activation',
  },
  {
    group: 'ML',
    label: 'CompositeML — Layer Health',
    route: '/composite-ml/layer-health',
    keywords: 'layer enabled fraction cycle config hash',
  },
  {
    group: 'ML',
    label: 'CompositeML — Policy Diff',
    route: '/composite-ml/diff',
    keywords: 'compare snapshots knob delta',
  },
  {
    group: 'ML',
    label: 'CompositeML — Layer Skill',
    route: '/composite-ml/layer-skill',
    keywords: 'arbitration weight override skill estimate z-statistic',
  },
  {
    group: 'ML',
    label: 'CompositeML — Trainer Skill',
    route: '/composite-ml/trainer-skill',
    keywords: 'trainer suppression promotion skill estimate z-statistic',
  },
  {
    group: 'ML',
    label: 'CompositeML — Catalogue Drift',
    route: '/composite-ml/drift',
    keywords: 'drift summary drop alert observed count threshold warm cold',
  },
  {
    group: 'ML',
    label: 'CompositeML — Gate Cutover',
    route: '/composite-ml/gate-cutover',
    keywords: 'cutover ledger legacy idiom gate flip',
  },
  {
    group: 'ML',
    label: 'CompositeML — Cold-Start Diagnostics',
    route: '/composite-ml/cold-start',
    keywords: 'cold start warm threshold donor selection forensic',
  },
  {
    group: 'ML',
    label: 'Optimizations',
    route: '/optimizations',
    keywords: 'bayesian hyperparam sharpe',
  },
  { group: 'ML', label: 'Backtests', route: '/backtests' },
  { group: 'ML', label: 'Walk-Forward', route: '/walk-forward', keywords: 'oos out-of-sample' },

  {
    group: 'Analysis',
    label: 'Performance',
    route: '/performance',
    keywords: 'pnl sharpe sortino',
  },
  {
    group: 'Analysis',
    label: 'Execution Quality',
    route: '/execution-quality',
    keywords: 'slippage latency tca',
  },
  { group: 'Analysis', label: 'Sentiment', route: '/sentiment', keywords: 'regime cot' },
  {
    group: 'Analysis',
    label: 'Analysis Monitors',
    route: '/analysis-monitors',
    keywords: 'watch monitor alert armed hunter fired trigger',
  },
  {
    group: 'Analysis',
    label: 'Strategy Ensemble',
    route: '/strategy-ensemble',
    keywords: 'allocation rebalance',
  },
  {
    group: 'Analysis',
    label: 'Strategy Portfolio',
    route: '/strategy-portfolio',
    keywords: 'allocations donut fwer multiple-testing throttled',
  },
  {
    group: 'Analysis',
    label: 'Compare Strategies',
    route: '/strategies/compare',
    keywords: 'overlay equity curves side-by-side correlation',
  },
  {
    group: 'Analysis',
    label: 'Strategy Generation',
    route: '/strategy-generation',
    keywords: 'cycles timeline candidates pruned trigger',
  },

  {
    group: 'System',
    label: 'Engine Overview',
    route: '/engine-overview',
    keywords: 'status workers dead-letter dlq summary',
  },
  { group: 'System', label: 'System Health', route: '/system-health' },
  {
    group: 'System',
    label: 'Worker Health',
    route: '/worker-health',
    keywords: 'workers cycle error backlog',
  },
  {
    group: 'System',
    label: 'EA Instances',
    route: '/ea-instances',
    keywords: 'expert advisor heartbeat mt5',
  },
  { group: 'System', label: 'Engine Config', route: '/engine-config' },
  { group: 'System', label: 'Audit Trail', route: '/audit-trail' },
  { group: 'System', label: 'Drawdown Recovery', route: '/drawdown-recovery' },
  { group: 'System', label: 'Martingale Ladders', route: '/martingale' },
  { group: 'System', label: 'Martingale Internals', route: '/martingale/internals' },
  { group: 'System', label: 'Signal Internals', route: '/trade-signals/internals' },
  { group: 'System', label: 'Paper Trading', route: '/paper-trading' },
  { group: 'System', label: 'Economic Events', route: '/economic-events' },

  { group: 'Ops', label: 'Kill Switches', route: '/kill-switches' },
  { group: 'Ops', label: 'Dead Letters', route: '/dead-letter', keywords: 'dlq replay' },
  {
    group: 'Ops',
    label: 'Tuning / Calibration',
    route: '/calibration',
    keywords: 'screening gates rejections',
  },
];

/**
 * The catalogue entry for a URL, by longest matching route prefix — so /backtests/480
 * resolves to the Backtesting entry rather than to nothing. Query string ignored.
 */
export function findPage(url: string): PageCommand | null {
  const path = (url || '').split('?')[0].split('#')[0];
  let best: PageCommand | null = null;
  for (const page of PAGE_CATALOG) {
    if (path === page.route || path.startsWith(page.route + '/')) {
      if (!best || page.route.length > best.route.length) best = page;
    }
  }
  return best;
}
