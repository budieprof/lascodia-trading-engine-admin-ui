/**
 * The sidebar's navigation. Whether an item shows is decided by the route table
 * (`core/auth/route-access.ts`) — the same rule the route guard applies — so the sidebar never
 * offers a page the guard would refuse. An item whose route is not in the table never shows (the
 * spec checks there are none).
 */
export interface NavItem {
  label: string;
  route: string;
  icon: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Trading',
    items: [
      { label: 'Orders', route: '/orders', icon: '📋' },
      { label: 'Positions', route: '/positions', icon: '📊' },
      { label: 'Position Deltas', route: '/positions/deltas', icon: '🔄' },
      // Directly under Positions: it answers a question about the open book that the
      // positions list cannot, because nothing there knows the economic calendar.
      { label: 'Event Exposure', route: '/positions/event-exposure', icon: '📅' },
      { label: 'Trade Signals', route: '/trade-signals', icon: '⚡' },
      // Sibling entry, not a sub-item: 'what signals exist' and 'why did nothing
      // happen' are different jobs, and the second is the one reached for under
      // time pressure. It is also the only screen that shows generation-stage
      // rejections, which never reach the signals list at all.
      { label: 'Signal Internals', route: '/trade-signals/internals', icon: '🔬' },
      { label: 'Signal Sensitivity', route: '/signal-sensitivity', icon: '🎛' },
      { label: 'Signal Exits', route: '/trade-signals/feedback', icon: '📨' },
      { label: 'Signal Rejections', route: '/rejections', icon: '🚫' },
      // Every trade card an analysis wrote, with what became of it — the cards the chat,
      // Patient Trader and monitor reviews produce, one page each.
      { label: 'Recommendations', route: '/trade-recommendations', icon: '🃏' },
      { label: 'Pending Recs', route: '/pending-signal-recs', icon: '⏸' },
      { label: 'Market Data', route: '/market-data', icon: '📈' },
      { label: 'Watchlist', route: '/watchlist', icon: '👁' },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { label: 'Strategies', route: '/strategies', icon: '🎯' },
      { label: 'Strategy Settings', route: '/strategies/settings', icon: '⚙' },
      { label: 'Pine Libraries', route: '/strategies/libraries', icon: '📚' },
      { label: 'Accounts', route: '/trading-accounts', icon: '🏦' },
      { label: 'Brokers', route: '/brokers', icon: '🔗' },
      { label: 'Risk Profiles', route: '/risk-profiles', icon: '🛡' },
      { label: 'Spread-Reactive', route: '/spread-reactive', icon: '〰' },
      { label: 'Currency Pairs', route: '/currency-pairs', icon: '💱' },
      { label: 'Alerts', route: '/alerts', icon: '🔔' },
    ],
  },
  {
    label: 'ML & Optimization',
    items: [
      { label: 'ML Models', route: '/ml-models', icon: '🧠' },
      { label: 'Training Queue', route: '/ml-models/training-queue', icon: '⏳' },
      { label: 'CompositeML', route: '/composite-ml', icon: '🧩' },
      { label: 'Drift Report', route: '/drift-report', icon: '📊' },
      { label: 'Optimizations', route: '/optimizations', icon: '🧪' },
      { label: 'Backtesting', route: '/backtests', icon: '📈' },
      { label: 'Walk-Forward', route: '/walk-forward', icon: '🔄' },
      { label: 'Portfolio Backtests', route: '/portfolio-backtests', icon: '🧺' },
    ],
  },
  {
    label: 'LLM',
    items: [
      { label: 'Proposals', route: '/strategies/llm-proposals', icon: '💡' },
      { label: 'Conversations', route: '/conversations', icon: '💬' },
      { label: 'Monitors', route: '/analysis-monitors', icon: '🔭' },
      { label: 'Agent Operations', route: '/algo-engineer/operations', icon: '🛠' },
      { label: 'Change Scorecard', route: '/algo-engineer/scorecard', icon: '🧮' },
      { label: 'Spot Analysis', route: '/spot-analysis', icon: '📊' },
      { label: 'Spot Sweep', route: '/spot-sweep', icon: '🛰' },
      { label: 'Patient Trader', route: '/patient-trader', icon: '🎯' },
      { label: 'News Intel', route: '/news-intel', icon: '📰' },
      { label: 'Viability Gates', route: '/viability-gates', icon: '🛡' },
      { label: 'Analyser Comparison', route: '/analyser-comparison', icon: '🆚' },
      { label: 'Look-ahead Audit', route: '/analyser-comparison/audit', icon: '🔎' },
      { label: 'Invocations', route: '/llm/invocations', icon: '📡' },
      { label: 'Rationales', route: '/llm/rationales', icon: '🗒' },
      { label: 'Settings', route: '/llm/settings', icon: '🔑' },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { label: 'LLM Backtest', route: '/llm-backtest', icon: '🔁' },
      { label: 'Prompt templates', route: '/prompt-templates', icon: '📝' },
      { label: 'Performance', route: '/performance', icon: '📉' },
      { label: 'Execution Quality', route: '/execution-quality', icon: '⏱' },
      { label: 'Sentiment', route: '/sentiment', icon: '📰' },
      { label: 'Ensemble', route: '/strategy-ensemble', icon: '⚖' },
      { label: 'Portfolio', route: '/strategy-portfolio', icon: '🥧' },
      { label: 'Compare', route: '/strategies/compare', icon: '🆚' },
      { label: 'Generation', route: '/strategy-generation', icon: '🧬' },
      { label: 'Pine Screener', route: '/pine-screener', icon: '🔍' },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Engine Overview', route: '/engine-overview', icon: '🩺' },
      { label: 'Fleet Health', route: '/fleet-health', icon: '📊' },
      { label: 'Health', route: '/system-health', icon: '💚' },
      { label: 'Logs', route: '/system-logs', icon: '📝' },
      { label: 'Worker Health', route: '/worker-health', icon: '⚡' },
      { label: 'EA Instances', route: '/ea-instances', icon: '🛰' },
      { label: 'Terminals', route: '/terminals', icon: '🖥' },
      { label: 'Config', route: '/engine-config', icon: '⚙' },
      { label: 'Audit Trail', route: '/audit-trail', icon: '📜' },
      { label: 'Drawdown', route: '/drawdown-recovery', icon: '📉' },
      { label: 'Martingale', route: '/martingale', icon: '🪜' },
      // Separate entry rather than a sub-item: configuring the ladder and investigating
      // what it did are different jobs, and the investigation is the one an operator
      // reaches for under time pressure. Burying it one click inside the config screen
      // made it findable only by someone who already knew it existed.
      { label: 'Martingale Internals', route: '/martingale/internals', icon: '🔬' },
      { label: 'Paper Trading', route: '/paper-trading', icon: '🧪' },
      { label: 'CME Microstructure', route: '/cme-microstructure', icon: '📶' },
      { label: 'Economic Events', route: '/economic-events', icon: '📅' },
    ],
  },
  {
    label: 'Ops',
    items: [
      { label: 'Alert Triage', route: '/alert-triage', icon: '🚨' },
      { label: 'Automation Monitor', route: '/automation-monitor', icon: '🤖' },
      { label: 'Kill Switches', route: '/kill-switches', icon: '⛔' },
      { label: 'Dead Letters', route: '/dead-letter', icon: '✉' },
      { label: 'Tuning', route: '/calibration', icon: '🎚' },
      { label: 'Operator Roles', route: '/operator-roles', icon: '🔐' },
    ],
  },
  {
    // Organisation administration (U3.4): self-service identity and access for the active organisation.
    label: 'Organisation',
    items: [
      { label: 'Members', route: '/iam/members', icon: '👥' },
      { label: 'Invitations', route: '/iam/invitations', icon: '✉' },
      { label: 'Roles', route: '/iam/roles', icon: '🛂' },
      { label: 'Access grants', route: '/iam/grants', icon: '🔑' },
      { label: 'Teams', route: '/iam/teams', icon: '🧑‍🤝‍🧑' },
      { label: 'Account groups', route: '/iam/account-groups', icon: '🗂' },
      { label: 'Security policy', route: '/iam/security', icon: '🛡' },
      { label: 'Single sign-on', route: '/iam/sso', icon: '🔗' },
      { label: 'Approvals', route: '/iam/approvals', icon: '✅' },
      { label: 'Access review', route: '/iam/access-review', icon: '🔍' },
      { label: 'Plan & usage', route: '/iam/plan', icon: '📦' },
      // The organisation console (multi-tenancy Phase 7, c7-tenant).
      { label: 'Connect a terminal', route: '/organisation/terminals', icon: '🔌' },
      { label: 'Settings', route: '/organisation/settings', icon: '⚙' },
      { label: 'Risk & kill switches', route: '/organisation/risk', icon: '⛔' },
      { label: 'Strategy subscriptions', route: '/organisation/strategies', icon: '📡' },
      { label: 'Alert channels', route: '/organisation/alerts', icon: '🔔' },
      { label: 'LLM usage & key', route: '/organisation/llm', icon: '🧠' },
    ],
  },
  {
    // Platform console (U3.6): platform staff only.
    label: 'Platform',
    items: [
      { label: 'Organisations', route: '/platform/organisations', icon: '🏢' },
      { label: 'Plans', route: '/platform/plans', icon: '📦' },
      { label: 'Fleet health', route: '/platform/fleet', icon: '🛰' },
      { label: 'Elevated access', route: '/platform/elevations', icon: '⏫' },
      { label: 'Impersonation', route: '/platform/impersonation', icon: '🎭' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', route: '/admin/users', icon: '👤' },
      { label: 'Roles & Permissions', route: '/admin/roles', icon: '🛂' },
      { label: 'Audit Log', route: '/admin/audit', icon: '📜' },
      { label: 'My Account', route: '/account/profile', icon: '🪪' },
      { label: 'Sessions & devices', route: '/account/sessions', icon: '💻' },
      { label: 'Access tokens', route: '/account/tokens', icon: '🎟' },
    ],
  },
];
