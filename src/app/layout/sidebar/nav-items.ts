import type { LucideIconData } from '@lucide/angular';

import { navIcon } from './nav-icons';

/**
 * The sidebar's navigation. Whether an item shows is decided by the route table
 * (`core/auth/route-access.ts`) — the same rule the route guard applies — so the sidebar never
 * offers a page the guard would refuse. An item whose route is not in the table never shows (the
 * spec checks there are none).
 */
export interface NavItem {
  label: string;
  route: string;
  /**
   * A Lucide line icon (`navIcon.<Name>`; run scripts/generate-nav-icons.mjs after adding one), drawn
   * in the item's text colour (grey, accent when active). One icon per item across the whole menu:
   * on the collapsed rail the icon is all there is to tell items apart.
   */
  icon: LucideIconData;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Trading',
    items: [
      { label: 'Orders', route: '/orders', icon: navIcon.ClipboardList },
      { label: 'Positions', route: '/positions', icon: navIcon.Wallet },
      { label: 'Position Deltas', route: '/positions/deltas', icon: navIcon.ArrowLeftRight },
      // Directly under Positions: it answers a question about the open book that the
      // positions list cannot, because nothing there knows the economic calendar.
      { label: 'Event Exposure', route: '/positions/event-exposure', icon: navIcon.CalendarClock },
      { label: 'Trade Signals', route: '/trade-signals', icon: navIcon.Zap },
      // Sibling entry, not a sub-item: 'what signals exist' and 'why did nothing
      // happen' are different jobs, and the second is the one reached for under
      // time pressure. It is also the only screen that shows generation-stage
      // rejections, which never reach the signals list at all.
      { label: 'Signal Internals', route: '/trade-signals/internals', icon: navIcon.Microscope },
      {
        label: 'Signal Sensitivity',
        route: '/signal-sensitivity',
        icon: navIcon.SlidersHorizontal,
      },
      { label: 'Signal Exits', route: '/trade-signals/feedback', icon: navIcon.LogOut },
      { label: 'Signal Rejections', route: '/rejections', icon: navIcon.Ban },
      // Every trade card an analysis wrote, with what became of it — the cards the chat,
      // Patient Trader and monitor reviews produce, one page each.
      { label: 'Recommendations', route: '/trade-recommendations', icon: navIcon.SquareStack },
      { label: 'Pending Recs', route: '/pending-signal-recs', icon: navIcon.CirclePause },
      { label: 'Market Data', route: '/market-data', icon: navIcon.ChartCandlestick },
      { label: 'Watchlist', route: '/watchlist', icon: navIcon.Eye },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { label: 'Strategies', route: '/strategies', icon: navIcon.Target },
      { label: 'Strategy Settings', route: '/strategies/settings', icon: navIcon.Settings2 },
      { label: 'Pine Libraries', route: '/strategies/libraries', icon: navIcon.Library },
      { label: 'Accounts', route: '/trading-accounts', icon: navIcon.Landmark },
      { label: 'Brokers', route: '/brokers', icon: navIcon.Handshake },
      { label: 'Risk Profiles', route: '/risk-profiles', icon: navIcon.ShieldCheck },
      { label: 'Spread-Reactive', route: '/spread-reactive', icon: navIcon.Activity },
      { label: 'Currency Pairs', route: '/currency-pairs', icon: navIcon.Coins },
      { label: 'Alerts', route: '/alerts', icon: navIcon.Bell },
    ],
  },
  {
    label: 'ML & Optimization',
    items: [
      { label: 'ML Models', route: '/ml-models', icon: navIcon.Brain },
      { label: 'Training Queue', route: '/ml-models/training-queue', icon: navIcon.Hourglass },
      { label: 'CompositeML', route: '/composite-ml', icon: navIcon.Puzzle },
      { label: 'Drift Report', route: '/drift-report', icon: navIcon.ChartSpline },
      { label: 'Optimizations', route: '/optimizations', icon: navIcon.TestTubeDiagonal },
      { label: 'Backtesting', route: '/backtests', icon: navIcon.RotateCcwClock },
      { label: 'Walk-Forward', route: '/walk-forward', icon: navIcon.StepForward },
      { label: 'Portfolio Backtests', route: '/portfolio-backtests', icon: navIcon.Briefcase },
    ],
  },
  {
    label: 'LLM',
    items: [
      { label: 'Proposals', route: '/strategies/llm-proposals', icon: navIcon.Lightbulb },
      { label: 'Conversations', route: '/conversations', icon: navIcon.MessagesSquare },
      { label: 'Monitors', route: '/analysis-monitors', icon: navIcon.Telescope },
      { label: 'Agent Operations', route: '/algo-engineer/operations', icon: navIcon.Wrench },
      {
        label: 'Change Scorecard',
        route: '/algo-engineer/scorecard',
        icon: navIcon.ClipboardCheck,
      },
      { label: 'Spot Analysis', route: '/spot-analysis', icon: navIcon.ScanSearch },
      { label: 'Spot Sweep', route: '/spot-sweep', icon: navIcon.Radar },
      { label: 'Patient Trader', route: '/patient-trader', icon: navIcon.Crosshair },
      { label: 'News Intel', route: '/news-intel', icon: navIcon.Newspaper },
      { label: 'Viability Gates', route: '/viability-gates', icon: navIcon.Funnel },
      { label: 'Analyser Comparison', route: '/analyser-comparison', icon: navIcon.GitCompare },
      { label: 'Look-ahead Audit', route: '/analyser-comparison/audit', icon: navIcon.SearchCheck },
      { label: 'Invocations', route: '/llm/invocations', icon: navIcon.Sparkles },
      { label: 'Rationales', route: '/llm/rationales', icon: navIcon.StickyNote },
      { label: 'Settings', route: '/llm/settings', icon: navIcon.KeyRound },
    ],
  },
  {
    label: 'Analysis',
    items: [
      { label: 'LLM Backtest', route: '/llm-backtest', icon: navIcon.Repeat2 },
      { label: 'Prompt templates', route: '/prompt-templates', icon: navIcon.FileText },
      { label: 'Performance', route: '/performance', icon: navIcon.TrendingUp },
      { label: 'Execution Quality', route: '/execution-quality', icon: navIcon.Timer },
      { label: 'Sentiment', route: '/sentiment', icon: navIcon.Thermometer },
      { label: 'Ensemble', route: '/strategy-ensemble', icon: navIcon.Scale },
      { label: 'Portfolio', route: '/strategy-portfolio', icon: navIcon.ChartPie },
      { label: 'Compare', route: '/strategies/compare', icon: navIcon.Columns2 },
      { label: 'Generation', route: '/strategy-generation', icon: navIcon.Dna },
      { label: 'Pine Screener', route: '/pine-screener', icon: navIcon.ListFilter },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Engine Overview', route: '/engine-overview', icon: navIcon.Gauge },
      { label: 'Fleet Health', route: '/fleet-health', icon: navIcon.HeartPulse },
      { label: 'Health', route: '/system-health', icon: navIcon.Stethoscope },
      { label: 'Logs', route: '/system-logs', icon: navIcon.ScrollText },
      { label: 'Worker Health', route: '/worker-health', icon: navIcon.Cpu },
      { label: 'EA Instances', route: '/ea-instances', icon: navIcon.Satellite },
      { label: 'Terminals', route: '/terminals', icon: navIcon.Monitor },
      { label: 'Config', route: '/engine-config', icon: navIcon.FileCog },
      { label: 'Audit Trail', route: '/audit-trail', icon: navIcon.Footprints },
      { label: 'Drawdown', route: '/drawdown-recovery', icon: navIcon.TrendingDown },
      { label: 'Martingale', route: '/martingale', icon: navIcon.ChartBarIncreasing },
      // Separate entry rather than a sub-item: configuring the ladder and investigating
      // what it did are different jobs, and the investigation is the one an operator
      // reaches for under time pressure. Burying it one click inside the config screen
      // made it findable only by someone who already knew it existed.
      { label: 'Martingale Internals', route: '/martingale/internals', icon: navIcon.ScanEye },
      { label: 'Paper Trading', route: '/paper-trading', icon: navIcon.FlaskConical },
      {
        label: 'CME Microstructure',
        route: '/cme-microstructure',
        icon: navIcon.ChartColumnStacked,
      },
      { label: 'Economic Events', route: '/economic-events', icon: navIcon.Calendar },
    ],
  },
  {
    label: 'Ops',
    items: [
      { label: 'Alert Triage', route: '/alert-triage', icon: navIcon.Siren },
      { label: 'Automation Monitor', route: '/automation-monitor', icon: navIcon.Bot },
      { label: 'Kill Switches', route: '/kill-switches', icon: navIcon.Power },
      { label: 'Dead Letters', route: '/dead-letter', icon: navIcon.MailX },
      { label: 'Tuning', route: '/calibration', icon: navIcon.SlidersVertical },
      { label: 'Operator Roles', route: '/operator-roles', icon: navIcon.LockKeyhole },
    ],
  },
  {
    // Organisation administration (U3.4): self-service identity and access for the active organisation.
    label: 'Organisation',
    items: [
      { label: 'Members', route: '/iam/members', icon: navIcon.Users },
      { label: 'Invitations', route: '/iam/invitations', icon: navIcon.MailPlus },
      { label: 'Roles', route: '/iam/roles', icon: navIcon.UserCog },
      { label: 'Access grants', route: '/iam/grants', icon: navIcon.KeySquare },
      { label: 'Teams', route: '/iam/teams', icon: navIcon.Group },
      { label: 'Account groups', route: '/iam/account-groups', icon: navIcon.Folders },
      { label: 'Security policy', route: '/iam/security', icon: navIcon.Shield },
      { label: 'Single sign-on', route: '/iam/sso', icon: navIcon.FingerprintPattern },
      { label: 'Approvals', route: '/iam/approvals', icon: navIcon.CircleCheckBig },
      { label: 'Access review', route: '/iam/access-review', icon: navIcon.UserSearch },
      { label: 'Plan & usage', route: '/iam/plan', icon: navIcon.Package },
      // The organisation console (multi-tenancy Phase 7, c7-tenant).
      { label: 'Connect a terminal', route: '/organisation/terminals', icon: navIcon.Plug },
      { label: 'Settings', route: '/organisation/settings', icon: navIcon.Settings },
      { label: 'Risk & kill switches', route: '/organisation/risk', icon: navIcon.ShieldAlert },
      { label: 'Strategy subscriptions', route: '/organisation/strategies', icon: navIcon.Rss },
      { label: 'Alert channels', route: '/organisation/alerts', icon: navIcon.BellRing },
      { label: 'LLM usage & key', route: '/organisation/llm', icon: navIcon.BrainCircuit },
      // An organisation's life cycle (multi-tenancy Phase 7, c7-lifecycle).
      { label: 'Get started', route: '/onboarding', icon: navIcon.Rocket },
      { label: 'Branding', route: '/organisation/branding', icon: navIcon.Palette },
      { label: 'Export your data', route: '/organisation/data-export', icon: navIcon.Download },
      { label: 'Close the organisation', route: '/organisation/close', icon: navIcon.DoorClosed },
      // Four-eyes policies (enterprise program, fund-module).
      {
        label: 'Approval policies',
        route: '/organisation/approval-policies',
        icon: navIcon.UsersRound,
      },
    ],
  },
  {
    // The fund module (enterprise program): reporting and evidence for funds and their investors.
    label: 'Fund',
    items: [
      {
        label: 'Performance statements',
        route: '/fund/performance',
        icon: navIcon.ChartNoAxesCombined,
      },
      { label: 'Best execution', route: '/fund/best-execution', icon: navIcon.BadgeCheck },
      { label: 'Compliance exports', route: '/fund/compliance', icon: navIcon.FileArchive },
    ],
  },
  {
    // Platform console (U3.6): platform staff only.
    label: 'Platform',
    items: [
      { label: 'Organisations', route: '/platform/organisations', icon: navIcon.BuildingComplex },
      { label: 'Plans', route: '/platform/plans', icon: navIcon.Layers },
      { label: 'Fleet health', route: '/platform/fleet', icon: navIcon.Globe },
      // Market-data entitlements (C6): staff pages that live under /market-data.
      { label: 'Data entitlements', route: '/market-data/entitlements', icon: navIcon.KeyRound },
      { label: 'Data usage', route: '/market-data/usage', icon: navIcon.ChartColumnStacked },
      { label: 'Data sources', route: '/market-data/sources', icon: navIcon.RadioTower },
      { label: 'Sign-ups', route: '/platform/signups', icon: navIcon.UserPlus },
      { label: 'Closed organisations', route: '/platform/closures', icon: navIcon.Archive },
      { label: 'Elevated access', route: '/platform/elevations', icon: navIcon.ChevronsUp },
      { label: 'Impersonation', route: '/platform/impersonation', icon: navIcon.VenetianMask },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', route: '/admin/users', icon: navIcon.User },
      { label: 'Roles & Permissions', route: '/admin/roles', icon: navIcon.ListChecks },
      { label: 'Audit Log', route: '/admin/audit', icon: navIcon.FileClock },
      { label: 'My Account', route: '/account/profile', icon: navIcon.CircleUser },
      { label: 'Sessions & devices', route: '/account/sessions', icon: navIcon.Laptop },
      { label: 'Access tokens', route: '/account/tokens', icon: navIcon.Ticket },
      // The documentation portal (enterprise onboarding).
      { label: 'Documentation', route: '/docs', icon: navIcon.BookOpen },
    ],
  },
];
