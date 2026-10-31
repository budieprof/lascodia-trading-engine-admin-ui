/**
 * Every word on the public landing page. Kept apart from the templates so copy can change without touching layout.
 *
 * Rule for this file: claim only what the platform does today. No prices the engine does not publish, no customer
 * names, no testimonials, no performance figures. Capabilities that ship disabled (CME, FIX venues, exchange-traded
 * venues) are not sold here as available.
 */

export type IconName =
  | 'chart'
  | 'code'
  | 'spark'
  | 'fleet'
  | 'shield'
  | 'team'
  | 'lock'
  | 'key'
  | 'approve'
  | 'audit'
  | 'doc'
  | 'isolate'
  | 'user'
  | 'trophy'
  | 'bank'
  | 'fund';

export interface Feature {
  icon: IconName;
  title: string;
  body: string;
  points: string[];
  /** Wide tiles span two columns of the grid; full tiles the whole row. */
  wide?: boolean;
  full?: boolean;
}

export const STATS: { value: string; label: string }[] = [
  { value: '7', label: 'independent risk gates checked before every order' },
  { value: '1 s', label: 'heartbeat between every terminal and the engine' },
  { value: '< 3 s', label: 'target from signal to order at the broker' },
  { value: '5', label: 'coordination protocols formally model-checked' },
];

/** The hero ticker: shipped capabilities only, two rows that scroll opposite ways. */
export const TICKER: string[][] = [
  [
    'Order-book ladder',
    'Footprint charts',
    'Cumulative volume delta',
    'Volume profiles',
    'Bar replay',
    'Pine backtests with real costs',
    'Walk-forward tests',
    'Paper trading',
    'Plain-language AI analysis',
    'Self-arming watches',
  ],
  [
    'Kill switches',
    'News blackouts',
    'Dead-man switch',
    'Exactly-once signals',
    'Four-eyes approvals',
    'SSO & SCIM',
    'Signed exports',
    'Telegram & webhook alerts',
    'Broker reconciliation',
    'Any MetaTrader 5 broker',
  ],
];

export const FEATURES: Feature[] = [
  {
    icon: 'chart',
    title: 'A chart built for decisions',
    body: 'Live prices from your own broker, with the depth behind them.',
    points: [
      'Order-book ladder with one-click tickets',
      'Order-flow heatmap, footprint, CVD and volume profiles',
      'Bar replay to rehearse any session',
    ],
    wide: true,
  },
  {
    icon: 'code',
    title: 'Pine scripts, tested honestly',
    body: 'Write strategies in Pine and see what they would really have done.',
    points: [
      'Backtests priced with spread and commission',
      'Walk-forward and optimisation runs',
      'Paper trading before any account sees a signal',
    ],
  },
  {
    icon: 'spark',
    title: 'An analyst that explains itself',
    body: 'AI market analysis written in plain language, with its reasoning kept.',
    points: [
      'Trade now, watch, or stand aside — and why',
      'Watches that arm themselves on your conditions',
      'Every recommendation keeps its reason, even the rejected ones',
    ],
  },
  {
    icon: 'fleet',
    title: 'Your MetaTrader 5 fleet, one console',
    body: 'The Lascodia EA turns any MT5 terminal into a governed execution venue.',
    points: [
      'Guided connection with a one-time enrollment token',
      'Positions and orders reconciled against the broker',
      'Broker symbol names mapped for you',
    ],
  },
  {
    icon: 'team',
    title: 'Built for the whole desk',
    body: 'Traders, analysts and risk managers in one organisation, each with exactly the access they need.',
    points: [
      'Roles from Viewer to RiskManager — or your own',
      'Alerts by e-mail, Telegram or signed webhook',
      'Your branding across the console',
    ],
  },
  {
    icon: 'shield',
    title: 'Risk you can see — and stop',
    body: 'Limits per symbol, per account and per organisation, enforced at the terminal.',
    points: [
      'Kill switches with typed-confirmation flatten',
      'Daily-loss, exposure and drawdown limits',
      'News blackouts around high-impact events',
    ],
    full: true,
  },
];

export interface Gate {
  name: string;
  detail: string;
}

/** CSafetyGateGuard's gates, in the order the EA checks them. */
export const GATES: Gate[] = [
  { name: 'Terminal state', detail: 'Only a healthy, running terminal may open trades.' },
  { name: 'Kill switch', detail: 'Account, organisation or global — one press stops new entries.' },
  { name: 'Global safety stop', detail: 'Fleet-wide stop shared by every terminal.' },
  {
    name: 'Fleet circuit breaker',
    detail: 'Total positions, lots, daily loss and orders per minute.',
  },
  {
    name: 'Symbol circuit breaker',
    detail: 'Spread, lot size, position count and losing streaks.',
  },
  { name: 'Rate limiter', detail: 'Order slots claimed atomically across terminals.' },
  { name: 'News blackout', detail: 'Stands aside around scheduled high-impact releases.' },
];

export const SAFEGUARDS: { title: string; body: string }[] = [
  {
    title: 'Dead-man switch',
    body: 'If a terminal hears nothing from the engine for five minutes, it stops opening trades on its own.',
  },
  {
    title: 'Exactly once',
    body: 'Every signal is de-duplicated in a way that survives a restart — a retry never doubles a position.',
  },
  {
    title: 'Protection keeps running',
    body: 'Trailing stops keep working even while new entries are stopped.',
  },
  {
    title: 'One thread, end to end',
    body: 'A correlation id follows each trade from signal to broker deal to report, so every fill can be traced.',
  },
];

export interface Audience {
  id: string;
  icon: IconName;
  label: string;
  headline: string;
  body: string;
  points: string[];
}

export const AUDIENCES: Audience[] = [
  {
    id: 'traders',
    icon: 'user',
    label: 'Traders',
    headline: 'Systematic trading without the plumbing.',
    body: 'Subscribe to platform strategies or bring your own scripts. Lascodia handles execution, monitoring and the guardrails, so you can focus on the ideas.',
    points: [
      'Strategy subscriptions per account',
      'Pine editor, backtests and paper trading',
      'Alerts by e-mail, Telegram or signed webhook',
    ],
  },
  {
    id: 'prop',
    icon: 'trophy',
    label: 'Prop firms',
    headline: 'Run evaluation programmes on rails.',
    body: 'Define your programme rules once and let the platform enforce them on every account, with presets for FX, futures and crypto contract sizes.',
    points: [
      'Programme rules enforced at execution',
      'Per-account limits and kill switches',
      'Fleet health across every trader terminal',
    ],
  },
  {
    id: 'brokers',
    icon: 'bank',
    label: 'Brokers',
    headline: 'A dealing desk that shows its working.',
    body: 'See client risk, markouts and liquidity in one place. A/B suggestions are advisory only — the decision always stays with your desk.',
    points: [
      'Client risk table and markout curves',
      'Liquidity-provider statistics per symbol',
      'Alerts computed from your own trade feeds',
    ],
  },
  {
    id: 'funds',
    icon: 'fund',
    label: 'Funds',
    headline: 'Reporting your investors and auditors can verify.',
    body: 'Performance statements, best-execution analysis and compliance exports — each download signed so a copy can be checked later.',
    points: [
      'Statements per account or account group',
      'Four-eyes approval on sensitive changes',
      'Investor role that sees only performance',
    ],
  },
];

export interface Step {
  title: string;
  body: string;
  detail: string;
}

/** Mirrors the console's Get started checklist (`/onboarding`) and the getting-started guide. */
export const STEPS: Step[] = [
  {
    title: 'Create your organisation',
    body: 'Sign up with your work e-mail. We verify the address and you set a password and an authenticator app.',
    detail: 'You become its Owner',
  },
  {
    title: 'Invite your team',
    body: 'Give each person exactly the role they need — Trader, Analyst, RiskManager, Billing or your own.',
    detail: 'Second factor can be made compulsory',
  },
  {
    title: 'Connect a terminal',
    body: 'The guided wizard gives you a one-time token and a ready-made MT5 preset, then turns green on the first heartbeat.',
    detail: 'Tells you why if it does not connect',
  },
  {
    title: 'Open a live chart',
    body: 'Pick a symbol: prices, the order book and your positions appear live. Subscribe to strategies when you are ready.',
    detail: 'Demo accounts to start',
  },
];

export const SECURITY: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'lock',
    title: 'Second factor & single sign-on',
    body: 'Authenticator-app sign-in for everyone, SSO and SCIM provisioning for larger teams.',
  },
  {
    icon: 'key',
    title: 'Permission by key, not by title',
    body: 'Every page and action is gated by a specific permission. Nobody can grant more than they hold.',
  },
  {
    icon: 'approve',
    title: 'Four-eyes approvals',
    body: 'Risk-loosening changes can require a second person — and a fresh second-factor check.',
  },
  {
    icon: 'audit',
    title: 'A complete audit trail',
    body: 'Who changed what, when, and from where — kept for every organisation.',
  },
  {
    icon: 'isolate',
    title: 'Organisations kept apart',
    body: 'Each organisation sees only its own data. Another organisation’s records simply do not exist to you.',
  },
  {
    icon: 'doc',
    title: 'Credentials that never come back',
    body: 'Connection secrets are write-only: stored, used, and never shown again — only a fingerprint.',
  },
];

/** Where "Talk to us" goes on the Team and Enterprise plans (empty: those plans offer the main button instead). */
export { SALES_EMAIL } from '@core/branding/contact';

export interface Plan {
  /** The engine plan this card stands for — a paid offer from `GET billing/plans/public` with this slug fills its price. */
  slug: string;
  name: string;
  price: string;
  priceNote: string;
  blurb: string;
  points: string[];
  /** `upgrade`: a real paid offer — the main button ("Start free"). */
  cta: 'primary' | 'contact' | 'upgrade';
  featured?: boolean;
}

/**
 * Plan limits are set per organisation by Lascodia; only the Trial shows a price here. Real prices come only from
 * the engine's public offers (`mergePlanOffers` in `landing.logic.ts`) — never typed into this file.
 */
export const PLANS: Plan[] = [
  {
    slug: 'trial',
    name: 'Trial',
    price: 'Free',
    priceNote: 'No card required',
    blurb: 'Everything you need to see Lascodia work on your own terminal.',
    points: [
      'MetaTrader 5 demo accounts',
      'Live chart, order book and order flow',
      'Platform strategies and Pine scripts',
      'Guided terminal connection',
    ],
    cta: 'primary',
  },
  {
    slug: 'team',
    name: 'Team',
    price: 'Tailored',
    priceNote: 'Limits sized to your desk',
    blurb: 'For desks running several accounts and people.',
    points: [
      'More accounts, terminals and members',
      'More concurrent research jobs',
      'Personal access tokens for scripts',
      'Usage and billing in the console',
    ],
    cta: 'contact',
    featured: true,
  },
  {
    slug: 'enterprise',
    name: 'Enterprise',
    price: 'Tailored',
    priceNote: 'For firms, brokers and funds',
    blurb: 'Governance, modules and data entitlements for regulated teams.',
    points: [
      'SSO and SCIM provisioning',
      'Prop, dealing-desk and fund modules',
      'Four-eyes approval policies',
      'Your branding across the console',
    ],
    cta: 'contact',
  },
];

export const FAQS: { q: string; a: string }[] = [
  {
    q: 'Which brokers does Lascodia work with?',
    a: 'Any broker that offers MetaTrader 5. The Lascodia EA runs on your own terminal and acts as the connection to the engine, and it maps your broker’s symbol names (for example “EURUSDm”) to standard ones for you.',
  },
  {
    q: 'Does Lascodia hold my money?',
    a: 'No. Your funds stay with your broker. Lascodia sends instructions to your terminal, which places the orders on your account.',
  },
  {
    q: 'Can I trade a real account?',
    a: 'New organisations start with MetaTrader 5 demo accounts, so you can see everything working before any real money is involved. Real accounts are enabled by Lascodia for an organisation.',
  },
  {
    q: 'What happens if my connection drops?',
    a: 'The terminal keeps protecting open positions — trailing stops keep running — and stops opening new ones. If the engine stays silent for five minutes it moves to a safety stop, and positions are reconciled with the broker when it reconnects.',
  },
  {
    q: 'Do I need to write code?',
    a: 'No. You can subscribe your accounts to platform strategies. Pine scripting is there when you want to build your own.',
  },
  {
    q: 'Will a strategy make money?',
    a: 'Nobody can promise that, and we do not. What we can do is show you honest evidence: backtests priced with real costs, walk-forward tests, and a paper-trading stage before a strategy reaches an account.',
  },
];
