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
  {
    group: 'Trading',
    label: 'Dashboard',
    route: '/dashboard',
    keywords:
      'overview home equity drawdown open positions daily pnl equity curve pending signals approve reject recent alerts worker health ea connections',
  },
  { group: 'Trading', label: 'Orders', route: '/orders', keywords: 'order list trade' },
  {
    group: 'Trading',
    label: 'Positions',
    route: '/positions',
    keywords:
      'open closed positions unrealized realized pnl exposure by symbol long short win rate profit factor expectancy drawdown analytics per-symbol breakdown',
  },
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
  {
    group: 'Trading',
    label: 'Event Exposure',
    route: '/positions/event-exposure',
    keywords:
      'open positions across upcoming high impact news release economic event exposed lots unrealised without stop loss risk',
  },
  {
    group: 'Trading',
    label: 'Signal Sensitivity Analysis',
    route: '/signal-sensitivity',
    keywords:
      'replay historic signals what-if tp sl multiplier sweep equity curve r-multiple hold time shrinkage martingale ladder simulation parked recs',
  },
  {
    group: 'Trading',
    label: 'Signal Rejections',
    route: '/rejections',
    keywords:
      'rejection log declined signals reasons ea engine broker stage top reasons spread filter fleet wide why rejected',
  },
  {
    group: 'Trading',
    label: 'Trade Recommendations',
    route: '/trade-recommendations',
    keywords:
      'recommendation cards trade ideas chat patient trader spot analysis monitor review filed watching triggered rejected expired cancelled became signal',
  },
  {
    group: 'Trading',
    label: 'Pending-Signal Recs',
    route: '/pending-signal-recs',
    keywords:
      'parked llm recommendations waiting for entry price touch revalidation approved signal expired rejected conversion rate cancel rec',
  },
  {
    group: 'Trading',
    label: 'Market Data — Subscriber Declarations',
    route: '/market-data/declarations',
    keywords:
      'professional non-professional subscriber declaration per exchange real-time data feed access entitlements live sources valid until',
  },
  {
    group: 'Trading',
    label: 'Market Data — Instrument Candles',
    route: '/market-data/instrument-candles',
    keywords:
      'futures crypto stocks candle builder built span lag trade prints continuous futures roll calendar panama ratio adjustment sources',
  },
  {
    group: 'Trading',
    label: 'Watchlist',
    route: '/watchlist',
    keywords:
      'watchlist wall mini charts symbol tiles timeframe overlays open position pending order lines add symbol open full chart',
  },
  {
    group: 'Trading',
    label: 'Charts',
    route: '/chart-analysis',
    keywords:
      'chart candlestick indicators pine scripts drawings layouts bar replay price alert footprint heatmap dom order book economic events overlays',
  },

  {
    group: 'Configuration',
    label: 'Strategies',
    route: '/strategies',
    keywords:
      'strategy list activate pause stop risk profile apply template strategy monitor win rate profit factor sharpe health score equity curve',
  },
  {
    group: 'Configuration',
    label: 'Strategy Settings',
    route: '/strategies/settings',
    keywords:
      'strategy promotion worker tuning cadence promotion gates activation gates champion challenger engine config hot reload',
  },
  {
    group: 'Configuration',
    label: 'Trading Accounts',
    route: '/trading-accounts',
    keywords:
      'broker accounts balance equity margin used activate sync demo live environment currency mt5 login',
  },
  {
    group: 'Configuration',
    label: 'Connections',
    route: '/connections',
    keywords:
      'execution accounts exchanges brokers venue api credentials adapter health execution workers router entries switches multi-asset outbox fills',
  },
  {
    group: 'Configuration',
    label: 'Connections — Reconciliation Drift',
    route: '/connections/drift',
    keywords:
      'reconciliation drift engine vs venue positions working orders quantity mismatch difference adapter report act mode read-only',
  },
  {
    group: 'Configuration',
    label: 'Fee Schedules',
    route: '/reference/fee-schedules',
    keywords:
      'fees commissions futures crypto equity venue fee schedule cost model reference data in force exchange',
  },
  {
    group: 'Configuration',
    label: 'Margin Requirements',
    route: '/reference/margin-requirements',
    keywords:
      'margin futures margins crypto leverage tiers equity house rates multi-asset risk reference data csv import',
  },
  {
    group: 'Configuration',
    label: 'Brokers',
    route: '/brokers',
    keywords:
      'broker connectivity trading accounts ea instances heartbeat owned symbols balance equity margin utilization last sync',
  },
  {
    group: 'Configuration',
    label: 'Risk Profiles',
    route: '/risk-profiles',
    keywords:
      'risk sizing max lot max positions daily drawdown total drawdown risk per trade min sl tp risk reward exposure var tier-2 options',
  },
  {
    group: 'Configuration',
    label: 'Spread-Reactive',
    route: '/spread-reactive',
    keywords:
      'spread spike stop loss widening broker spread baseline floor pre-emptive widening signal entry pad ny close news weekend gap revert',
  },
  {
    group: 'Configuration',
    label: 'Currency Pairs',
    route: '/currency-pairs',
    keywords:
      'symbols contract specs base quote currency decimal places contract size min max lot step currency exposure matrix',
  },
  {
    group: 'Configuration',
    label: 'Alerts',
    route: '/alerts',
    keywords:
      'alert rules notification channels email smtp webhook telegram test alert severity detector price level drawdown triggered',
  },

  {
    group: 'ML & Optimization',
    label: 'ML Models',
    route: '/ml-models',
    keywords: 'training shadow ab test',
  },
  {
    group: 'ML & Optimization',
    label: 'ML — Training Queue',
    route: '/ml-models/training-queue',
    keywords: 'training queue queued running pending pipeline backlog worker stuck',
  },
  {
    group: 'ML & Optimization',
    label: 'ML — Overfit Watchlist',
    route: '/ml-models/overfit-watchlist',
    keywords: 'overfit cv live sharpe edge collapse ratio',
  },
  {
    group: 'ML & Optimization',
    label: 'ML — Symbolic Features',
    route: '/ml-models/symbolic-features',
    keywords: 'symbolic genetic programming candidate promoted retired feature',
  },
  {
    group: 'LLM',
    label: 'Strategies — LLM Proposals',
    route: '/strategies/llm-proposals',
    keywords: 'llm gpt proposal candidate promote pending pine script compile',
  },
  {
    group: 'Configuration',
    label: 'Strategies — Rejection Summary',
    route: '/strategies/rejections',
    keywords: 'rejection signal gate audit stage reason',
  },
  {
    group: 'Configuration',
    label: 'Strategies — Templates',
    route: '/strategies/templates',
    keywords: 'template apply bulk symbols multi pair',
  },
  {
    group: 'Configuration',
    label: 'Strategies — Pine Libraries',
    route: '/strategies/libraries',
    keywords: 'pine script library libraries import export publish version tradingview code',
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
    group: 'Trading',
    label: 'Market Data — Order Book',
    route: '/market-data/order-book',
    keywords: 'order book depth ladder dom bid ask spread microstructure',
  },
  {
    group: 'Trading',
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
    group: 'ML & Optimization',
    label: 'CompositeML — Active Policies',
    route: '/composite-ml',
    keywords: 'policy snapshot trainer activation',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Layer Health',
    route: '/composite-ml/layer-health',
    keywords: 'layer enabled fraction cycle config hash',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Policy Diff',
    route: '/composite-ml/diff',
    keywords: 'compare snapshots knob delta',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Layer Skill',
    route: '/composite-ml/layer-skill',
    keywords: 'arbitration weight override skill estimate z-statistic',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Trainer Skill',
    route: '/composite-ml/trainer-skill',
    keywords: 'trainer suppression promotion skill estimate z-statistic',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Catalogue Drift',
    route: '/composite-ml/drift',
    keywords: 'drift summary drop alert observed count threshold warm cold',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Drift History',
    route: '/composite-ml/drift/history',
    keywords:
      'drift history gate scope observed count threshold warm cold samples trend chart lookback evidence layer',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Gate Cutover',
    route: '/composite-ml/gate-cutover',
    keywords: 'cutover ledger legacy idiom gate flip',
  },
  {
    group: 'ML & Optimization',
    label: 'CompositeML — Cold-Start Diagnostics',
    route: '/composite-ml/cold-start',
    keywords: 'cold start warm threshold donor selection forensic',
  },
  {
    group: 'ML & Optimization',
    label: 'Optimizations',
    route: '/optimizations',
    keywords: 'bayesian hyperparam sharpe',
  },
  {
    group: 'ML & Optimization',
    label: 'Backtests',
    route: '/backtests',
    keywords:
      'backtest historical simulation queue run return profit factor sharpe drawdown trades top performers per-symbol walk-forward oos',
  },
  {
    group: 'ML & Optimization',
    label: 'Walk-Forward',
    route: '/walk-forward',
    keywords: 'oos out-of-sample',
  },
  {
    group: 'ML & Optimization',
    label: 'Portfolio Backtests',
    route: '/portfolio-backtests',
    keywords:
      'portfolio backtest several strategies one account shared equity margin currency exposure limit correlation members combined',
  },
  {
    group: 'ML & Optimization',
    label: 'Drift Report',
    route: '/drift-report',
    keywords:
      'ml drift alerts detector severity symbol fleet-wide firing triggered active model degradation distribution',
  },

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
    group: 'LLM',
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
    label: 'Pine Screener',
    route: '/pine-screener',
    keywords:
      'pine script screener scan symbols indicator plots alerts tradingview saved screens schedule bar close matches',
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
    group: 'Analysis',
    label: 'LLM Backtest',
    route: '/llm-backtest',
    keywords:
      'llm backtest runs spot analysis historical replay hit rate expectancy cost llm calls dry run sweep multi-sample cancel prompt version',
  },
  {
    group: 'Analysis',
    label: 'LLM Backtest — New',
    route: '/llm-backtest/new',
    keywords:
      'launch new llm backtest configure symbols timeframes window sampling stride caps cost estimate token budget daily weekly dry run model tier',
  },
  {
    group: 'Analysis',
    label: 'LLM Backtest — Compare',
    route: '/llm-backtest/compare',
    keywords:
      'compare llm backtest runs baseline candidate delta headline metrics per-symbol breakdown verdict promote prompt version active',
  },
  {
    group: 'Analysis',
    label: 'Prompt Templates',
    route: '/prompt-templates',
    keywords:
      'llm system prompt templates versions drafts archived fork promote active spot analysis live prompt version history',
  },
  {
    group: 'Analysis',
    label: 'Prompt Templates — Diff',
    route: '/prompt-templates/diff',
    keywords:
      'diff compare two prompt template versions system prompt line-level changes unified diff',
  },
  {
    group: 'Analysis',
    label: 'Dealing Desk',
    route: '/dealing',
    keywords:
      'broker dealing desk client flow toxicity markouts latency arbitrage liquidity providers trade feeds a-book b-book suggestions alerts analytics',
  },

  {
    group: 'System',
    label: 'Engine Overview',
    route: '/engine-overview',
    keywords: 'status workers dead-letter dlq summary',
  },
  {
    group: 'System',
    label: 'Fleet Health',
    route: '/fleet-health',
    keywords:
      'fleet vitals engine ea instances daemons sessions heartbeat version http latency outbox order queue kill switch safety stop gvar usage',
  },
  {
    group: 'System',
    label: 'System Health',
    route: '/system-health',
    keywords:
      'engine status worker health degraded failed idle dead-letter dlq backlog errors per hour p95 cycle duration infrastructure metrics',
  },
  {
    group: 'System',
    label: 'Engine Logs',
    route: '/system-logs',
    keywords:
      'engine logs log stream tail errors warnings exceptions info level category search message auto refresh',
  },
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
  {
    group: 'System',
    label: 'Terminals',
    route: '/terminals',
    keywords:
      'mt5 terminals supervisor daemon launch close kill sessions install broker terminal orphan processes pid heartbeat api key rotate',
  },
  {
    group: 'System',
    label: 'Engine Config',
    route: '/engine-config',
    keywords:
      'engine configuration keys values edit settings hot-reload restart required category data type search reason break-glass',
  },
  {
    group: 'System',
    label: 'Audit Trail',
    route: '/audit-trail',
    keywords:
      'audit decision log decision types outcomes approved rejected failed entity source reason context json activity history',
  },
  {
    group: 'System',
    label: 'Drawdown Recovery',
    route: '/drawdown-recovery',
    keywords:
      'drawdown recovery mode normal reduced halted equity peak thresholds per account mode transitions dwell time notes',
  },
  {
    group: 'System',
    label: 'Martingale Ladders',
    route: '/martingale',
    keywords:
      'martingale ladders recovery chains per-symbol opt-in depth cap stake cap target worst case risk profile open chains tune',
  },
  {
    group: 'System',
    label: 'Martingale Internals',
    route: '/martingale/internals',
    keywords:
      'martingale internals chains closes ledger next rung stake depth mismatch repair sweeper outstanding debt running balance',
  },
  {
    group: 'Trading',
    label: 'Signal Internals',
    route: '/trade-signals/internals',
    keywords:
      'signal pipeline internals account readiness blocked accounts tier-2 refusals reasons serving rules ea poll never became signals',
  },
  {
    group: 'System',
    label: 'Paper Trading',
    route: '/paper-trading',
    keywords:
      'paper trading simulated executions paper mode no broker strategy track record win rate net pnl backfill',
  },
  {
    group: 'System',
    label: 'CME Microstructure',
    route: '/cme-microstructure',
    keywords:
      'cme futures tape depth order flow aggressor delta tick-rule proxy experiment verdict feed health contract calendar roll shadow monitor simulator',
  },
  {
    group: 'System',
    label: 'Economic Events',
    route: '/economic-events',
    keywords:
      'economic calendar macro releases news events high impact currency forecast actual previous explainer upcoming schedule',
  },
  {
    group: 'System',
    label: 'Pine Chart Lab',
    route: '/pine-chart-lab',
    keywords:
      'pine chart renderer lab fixtures live script run plots shapes drawings tables trades logs trace profiler bar replay dev',
  },

  {
    group: 'Ops',
    label: 'Alert Triage',
    route: '/alert-triage',
    keywords:
      'alert triage queue active alerts severity critical high snooze group by type symbol insights noise escalate',
  },
  {
    group: 'Ops',
    label: 'Automation Monitor',
    route: '/automation-monitor',
    keywords:
      'automation loops launchd strategy hunt reopt ml training backtests optimization runs in-flight recent activity feed',
  },
  {
    group: 'Ops',
    label: 'Kill Switches',
    route: '/kill-switches',
    keywords:
      'kill switch global per-strategy circuit breaker engage disengage halt trading reason history audit',
  },
  { group: 'Ops', label: 'Dead Letters', route: '/dead-letter', keywords: 'dlq replay' },
  {
    group: 'Ops',
    label: 'Tuning / Calibration',
    route: '/calibration',
    keywords: 'screening gates rejections',
  },
  {
    group: 'Ops',
    label: 'Operator Roles',
    route: '/operator-roles',
    keywords:
      'operator roles grant revoke platform role trading account tier hierarchy permissions role distribution recent grants',
  },

  {
    group: 'LLM',
    label: 'Conversations',
    route: '/conversations',
    keywords:
      'chat llm analysis thread follow-up resume spot macro guard journal memory engineer assistant patient plan review monitor file signal',
  },
  {
    group: 'LLM',
    label: 'Algo-Engineer — Operations',
    route: '/algo-engineer/operations',
    keywords:
      'algo engineer agent work orders running blocked approvals waiting runs cost budget steps today fleet',
  },
  {
    group: 'LLM',
    label: 'Algo-Engineer — Change Scorecard',
    route: '/algo-engineer/scorecard',
    keywords:
      'algo engineer agent changes shipped deployed forecast predicted realised counterfactual delta error graded timeline',
  },
  {
    group: 'LLM',
    label: 'Spot Analysis Report',
    route: '/spot-analysis',
    keywords:
      'spot analysis llm recommendations signals positions attributed pnl cumulative cost latency tokens exits model outcome',
  },
  {
    group: 'LLM',
    label: 'Spot Sweep',
    route: '/spot-sweep',
    keywords:
      'spot sweep autonomous loop pairs sessions auto-trade guardrails cooldown excluded armed watches patient hunter scoreboard runs',
  },
  {
    group: 'LLM',
    label: 'Patient Trader',
    route: '/patient-trader',
    keywords:
      'patient trader discretionary agent market view plans refusals entry stop target rr atr breakout fill rate accuracy',
  },
  {
    group: 'LLM',
    label: 'News Intelligence',
    route: '/news-intel',
    keywords:
      'news intel headlines stories currency pressure board history divergence ingestion publishers articles classification labels',
  },
  {
    group: 'LLM',
    label: 'Viability Gates',
    route: '/viability-gates',
    keywords:
      'viability gates structural conviction enforce advisory off rejected signals ghost outcomes tp sl knobs direction bias',
  },
  {
    group: 'LLM',
    label: 'Analyser Comparison',
    route: '/analyser-comparison',
    keywords:
      'analyser comparison llm vs synthetic analyser decisions buy sell hold counterfactual pnl gated model confidence',
  },
  {
    group: 'LLM',
    label: 'Look-ahead Audit',
    route: '/analyser-comparison/audit',
    keywords:
      'look-ahead audit leak synthetic analyser feature pipeline decision time t1 t5 checks pairs pass fail',
  },
  {
    group: 'LLM',
    label: 'LLM Invocations',
    route: '/llm/invocations',
    keywords:
      'llm invocations model calls provider tokens cost spend latency purpose outcome ledger request response',
  },
  {
    group: 'LLM',
    label: 'Lifecycle Rationales',
    route: '/llm/rationales',
    keywords:
      'rationales why explanation lifecycle events llm reasoning coverage confidence strategy activation optimisation kill switch',
  },
  {
    group: 'LLM',
    label: 'LLM Settings',
    route: '/llm/settings',
    keywords:
      'llm settings provider api keys model choice daily cap pricing connectivity test shrinkage overrides engineconfig hot-reload',
  },

  {
    group: 'Organisation',
    label: 'Members',
    route: '/iam/members',
    keywords:
      'people users staff member list suspend reactivate remove status no mfa last seen sessions sign out everywhere devices sign-ins',
  },
  {
    group: 'Organisation',
    label: 'Invitations',
    route: '/iam/invitations',
    keywords:
      'invite people add user email invitation link temporary password pending expired seven days roles to give new member join',
  },
  {
    group: 'Organisation',
    label: 'Organisation — Roles',
    route: '/iam/roles',
    keywords:
      'organisation roles custom role system roles permissions matrix compose create edit role description what a role allows',
  },
  {
    group: 'Organisation',
    label: 'Access grants',
    route: '/iam/grants',
    keywords:
      'grant role assign permission people teams service accounts scope whole organisation account group expires last used why can they',
  },
  {
    group: 'Organisation',
    label: 'Teams',
    route: '/iam/teams',
    keywords:
      'teams groups of people team members add remove member grant role to team create delete team',
  },
  {
    group: 'Organisation',
    label: 'Account groups',
    route: '/iam/account-groups',
    keywords:
      'account groups sets of trading accounts desk client book portfolio grant role at group add remove accounts',
  },
  {
    group: 'Organisation',
    label: 'Security policy',
    route: '/iam/security',
    keywords:
      'sign-in policy require mfa second factor idle timeout session hours allowed networks cidr ip allowlist password identity provider',
  },
  {
    group: 'Organisation',
    label: 'Single sign-on',
    route: '/iam/sso',
    keywords:
      'sso single sign-on identity provider oidc openid connect saml client id issuer email domains scim directory provisioning token',
  },
  {
    group: 'Organisation',
    label: 'Organisation — Approvals',
    route: '/iam/approvals',
    keywords:
      'approvals four-eyes two-person approve reject pending requests second person waiting approval history requested by expires',
  },
  {
    group: 'Organisation',
    label: 'Access review',
    route: '/iam/access-review',
    keywords:
      'access review who holds what unused grants last used stale permissions revoke grants audit recertification',
  },
  {
    group: 'Organisation',
    label: 'Plan & usage',
    route: '/iam/plan',
    keywords:
      'plan usage subscription limits quota accounts terminals strategies people plans on offer price upgrade',
  },
  {
    group: 'Organisation',
    label: 'Connect a terminal',
    route: '/organisation/terminals',
    keywords:
      'enrollment token ea mt5 terminal supervisor daemon machine credential revoke rotate secret onboard connect instance download ea',
  },
  {
    group: 'Organisation',
    label: 'Connect a terminal — guided',
    route: '/organisation/terminals/connect',
    keywords:
      'guided wizard setup step by step mt5 metatrader ea enrollment token first heartbeat live progress download ea onboarding',
  },
  {
    group: 'Organisation',
    label: 'Organisation — Settings',
    route: '/organisation/settings',
    keywords:
      'organisation account settings effective config overrides inherited value queued pending change takes effect stricter governed risk setting',
  },
  {
    group: 'Organisation',
    label: 'Risk & kill switches',
    route: '/organisation/risk',
    keywords:
      'organisation kill switch account kill switch halt stop trading emergency flatten close all positions organisation-wide limits risk',
  },
  {
    group: 'Organisation',
    label: 'Strategy subscriptions',
    route: '/organisation/strategies',
    keywords:
      'strategy subscription subscribe accounts receive signals bindings lot multiplier pause which strategies copy signals per account',
  },
  {
    group: 'Organisation',
    label: 'Alert channels',
    route: '/organisation/alerts',
    keywords:
      'alert channels notifications email telegram webhook signing secret rotate test delivery where alerts go recipients',
  },
  {
    group: 'Organisation',
    label: 'LLM usage & key',
    route: '/organisation/llm',
    keywords:
      'llm usage budget spend cap calls tokens cost this month provider model own api key byok tenant key billed list price',
  },
  {
    group: 'Organisation',
    label: 'Usage & billing',
    route: '/organisation/billing',
    keywords:
      'billing plan metered usage per day monthly estimate invoices download invoice pdf cost subscription charges',
  },
  {
    group: 'Organisation',
    label: 'Get started',
    route: '/onboarding',
    keywords:
      'onboarding get started setup checklist first steps new organisation connect terminal trading accounts strategies people progress',
  },
  {
    group: 'Organisation',
    label: 'Branding',
    route: '/organisation/branding',
    keywords:
      'branding console look organisation name primary colour logo favicon upload preview white label reset theme',
  },
  {
    group: 'Organisation',
    label: 'Export your data',
    route: '/organisation/data-export',
    keywords:
      'data export download archive everything organisation owns tables records gdpr takeout backup request export link',
  },
  {
    group: 'Organisation',
    label: 'Close the organisation',
    route: '/organisation/close',
    keywords:
      'close organisation delete account leave platform stop everything grace period data deletion confirm slug offboard cancel',
  },
  {
    group: 'Organisation',
    label: 'Approval policies',
    route: '/organisation/approval-policies',
    keywords:
      'four-eyes approval policy approvers required roles governable actions manual order notional threshold who can approve dual control',
  },

  {
    group: 'Fund',
    label: 'Fund — Performance',
    route: '/fund/performance',
    keywords:
      'performance statement investor report time-weighted return drawdown sharpe sortino monthly returns deposits withdrawals cash flows pdf csv portfolio',
  },
  {
    group: 'Fund',
    label: 'Best execution',
    route: '/fund/best-execution',
    keywords:
      'best execution quality slippage fills spread effective spread latency markouts price improvement by broker venue account symbol',
  },
  {
    group: 'Fund',
    label: 'Compliance exports',
    route: '/fund/compliance',
    keywords:
      'compliance export audit log order lifecycle approvals period json csv zip sha-256 hash signature register verify copy regulator',
  },

  {
    group: 'Prop firm',
    label: 'Prop — Firm console',
    route: '/prop/console',
    keywords:
      'prop firm console live breach feed rule breach leaderboard challenge program traders profit drawdown used ranking',
  },
  {
    group: 'Prop firm',
    label: 'Challenge programs',
    route: '/prop/programs',
    keywords:
      'prop challenge program phases rules evaluation preset halt on breach pass versions archive edit funded',
  },
  {
    group: 'Prop firm',
    label: 'Prop — Traders',
    route: '/prop/traders',
    keywords:
      'prop traders people email reference console user accounts held create edit trader funded challenge',
  },
  {
    group: 'Prop firm',
    label: 'Prop — Enrolments',
    route: '/prop/enrollments',
    keywords:
      'prop enrolments enrollments enrol account program phase state outcome advance next phase withdraw profit days trader dashboard',
  },
  {
    group: 'Prop firm',
    label: 'Prop — Payouts',
    route: '/prop/payouts',
    keywords:
      'prop payouts profit split statement funded trader gross deductions net approve reject export csv pdf period',
  },
  {
    group: 'Prop firm',
    label: 'My challenge',
    route: '/prop/me',
    keywords:
      'my challenge my progress trader view rules of my program phase profit target drawdown status prop',
  },

  {
    group: 'Platform',
    label: 'Platform — Organisations',
    route: '/platform/organisations',
    keywords:
      'tenants organisations create new organisation invite first owner suspend reactivate members plan slug canary self-serve signup',
  },
  {
    group: 'Platform',
    label: 'Platform — Plans',
    route: '/platform/plans',
    keywords:
      'plans quotas limits features terminals accounts strategies scripts people llm budget log retention market-data feeds tiers',
  },
  {
    group: 'Platform',
    label: 'Platform — Fleet health',
    route: '/platform/fleet',
    keywords:
      'every organisation terminals ea expert advisor heartbeat stale disconnected kill switches version health cross-tenant fleet read-only',
  },
  {
    group: 'Platform',
    label: 'Platform — Billing',
    route: '/platform/billing',
    keywords:
      'price books invoices generate finalise void collect payment metered usage per terminal per user llm margin download invoice',
  },
  {
    group: 'Platform',
    label: 'Market-data entitlements',
    route: '/market-data/entitlements',
    keywords:
      'feed grants licence who may read feeds display non-display grant revoke organisation feed catalog cme venue access',
  },
  {
    group: 'Platform',
    label: 'Market-data usage',
    route: '/market-data/usage',
    keywords:
      'feed reads per month per organisation per exchange subscriber type distinct users unused feeds export vendor declarations reporting',
  },
  {
    group: 'Platform',
    label: 'Market-data sources',
    route: '/market-data/sources',
    keywords:
      'data sources registry mt5 broker servers cme vendor fx venue register lmax writers symbol map stored coverage feed',
  },
  {
    group: 'Platform',
    label: 'Subscriber declarations — review',
    route: '/market-data/declarations-review',
    keywords:
      'professional non-professional declarations review accept reject exchange questionnaire real-time display subscriber status exchange rules',
  },
  {
    group: 'Platform',
    label: 'Sign-ups',
    route: '/platform/signups',
    keywords:
      'self-serve signup requests approve reject new organisation onboarding pending applicants plans payment registration',
  },
  {
    group: 'Platform',
    label: 'Closed organisations',
    route: '/platform/closures',
    keywords:
      'closures closed tenants reopen grace period deletion plan dry run purge delete data offboarding close organisation',
  },
  {
    group: 'Platform',
    label: 'Elevated access',
    route: '/platform/elevations',
    keywords:
      'elevation request time-limited access organisation data second staff approval support ticket break glass end elevation history',
  },
  {
    group: 'Platform',
    label: 'Impersonation',
    route: '/platform/impersonation',
    keywords:
      'view as another user impersonate read-only support member troubleshoot dashboard ticket reason impersonation history',
  },
  {
    group: 'Platform',
    label: 'Security evidence',
    route: '/platform/security-evidence',
    keywords:
      'auditor evidence bundle signed archive download audit chain verify access reviews release notes compliance soc period',
  },

  {
    group: 'Administration',
    label: 'Admin Users',
    route: '/admin/users',
    keywords:
      'users accounts new user create assign roles reset password temporary password deactivate activate last login provision access',
  },
  {
    group: 'Administration',
    label: 'Administration — Roles & Permissions',
    route: '/admin/roles',
    keywords:
      'roles permissions permission keys create role edit delete system roles access control rbac grant',
  },
  {
    group: 'Administration',
    label: 'Audit log',
    route: '/admin/audit',
    keywords:
      'audit events sign-ins access changes configuration trading controls before after actor hash chain verify export jsonl append-only',
  },
  {
    group: 'Administration',
    label: 'My Profile',
    route: '/account/profile',
    keywords:
      'my account profile my roles my permissions where access comes from second factor mfa recent activity me',
  },
  {
    group: 'Administration',
    label: 'Change Password',
    route: '/account/change-password',
    keywords:
      'change password new password current password reset my password must change password legacy sign-in',
  },
  {
    group: 'Administration',
    label: 'Sessions & devices',
    route: '/account/sessions',
    keywords:
      'my sessions devices signed in where sign out other sessions end session recent sign-ins last active security',
  },
  {
    group: 'Administration',
    label: 'Access tokens',
    route: '/account/tokens',
    keywords:
      'personal access token pat api key bearer scripts tools create token revoke expires permissions last used automation',
  },
  {
    group: 'Administration',
    label: 'Help & guides',
    route: '/docs',
    keywords:
      'help docs documentation guides how to getting started search guides api reference endpoints manual support',
  },
  {
    group: 'Administration',
    label: 'Docs — API Reference',
    route: '/docs/api',
    keywords:
      'api reference endpoints openapi method path permission who may call rate limit parameters request response body docs',
  },
  {
    group: 'Administration',
    label: 'Releases',
    route: '/releases',
    keywords:
      'release notes changelog what changed versions ea builds expert advisor download sha256 engine console build terminals by ea version',
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
