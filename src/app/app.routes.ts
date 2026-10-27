import { Routes } from '@angular/router';
import { LayoutComponent } from './layout/layout.component';
import { LoginComponent } from '@core/auth/login/login.component';
import { authGuard } from '@core/auth/auth.guard';
import { canAccessPath } from '@core/auth/can-access.guard';
import { mustChangePasswordGuard } from '@core/auth/must-change-password.guard';
import { devModeOrFeatureFlag } from '@core/feature-flags/feature-flag.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    // Invitation links (U3.7): outside the console layout — the invited person may not belong to
    // any organisation yet. The page itself starts the sign-in when needed.
    path: 'invite/:token',
    loadComponent: () =>
      import('@features/invite/invite-accept-page.component').then(
        (m) => m.InviteAcceptPageComponent,
      ),
  },
  {
    // Self-serve "Create an organisation" (multi-tenancy Phase 7, c7-lifecycle): public, outside the console.
    path: 'signup',
    loadComponent: () =>
      import('@features/onboarding/pages/signup-page.component').then((m) => m.SignupPageComponent),
  },
  {
    // Public system status (engine resilience program): no sign-in, outside the console; reads GET /health/status.
    path: 'status',
    loadComponent: () =>
      import('@features/status/status-page.component').then((m) => m.StatusPageComponent),
  },
  {
    // The public demonstration (engine enterprise onboarding): recorded data replayed on a loop, no
    // sign-in, no trading. Off in the engine, the page says the demo is not available.
    path: 'demo',
    loadComponent: () =>
      import('@features/demo/demo-page.component').then((m) => m.DemoPageComponent),
  },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    canActivateChild: [mustChangePasswordGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        // The documentation portal (engine enterprise onboarding): any signed-in person.
        path: 'docs',
        canActivate: [canAccessPath('docs')],
        data: { breadcrumb: 'Documentation' },
        loadChildren: () => import('@features/docs/docs.routes').then((m) => m.DOCS_ROUTES),
      },
      {
        path: 'dashboard',
        canActivate: [canAccessPath('dashboard')],
        data: { breadcrumb: 'Dashboard' },
        loadChildren: () =>
          import('@features/dashboard/dashboard.routes').then((m) => m.DASHBOARD_ROUTES),
      },
      {
        path: 'orders',
        canActivate: [canAccessPath('orders')],
        data: { breadcrumb: 'Orders' },
        loadChildren: () => import('@features/orders/orders.routes').then((m) => m.ORDERS_ROUTES),
      },
      {
        path: 'positions',
        canActivate: [canAccessPath('positions')],
        data: { breadcrumb: 'Positions' },
        loadChildren: () =>
          import('@features/positions/positions.routes').then((m) => m.POSITIONS_ROUTES),
      },
      {
        path: 'strategies',
        canActivate: [canAccessPath('strategies')],
        data: { breadcrumb: 'Strategies' },
        loadChildren: () =>
          import('@features/strategies/strategies.routes').then((m) => m.STRATEGIES_ROUTES),
      },
      {
        path: 'trade-signals',
        canActivate: [canAccessPath('trade-signals')],
        data: { breadcrumb: 'Trade Signals' },
        loadChildren: () =>
          import('@features/trade-signals/trade-signals.routes').then(
            (m) => m.TRADE_SIGNALS_ROUTES,
          ),
      },
      {
        path: 'rejections',
        canActivate: [canAccessPath('rejections')],
        data: { breadcrumb: 'Signal Rejections' },
        loadChildren: () =>
          import('@features/signal-rejections/signal-rejections.routes').then(
            (m) => m.SIGNAL_REJECTIONS_ROUTES,
          ),
      },
      {
        path: 'trade-recommendations',
        canActivate: [canAccessPath('trade-recommendations')],
        data: { breadcrumb: 'Recommendations' },
        loadChildren: () =>
          import('@features/trade-recommendations/trade-recommendations.routes').then(
            (m) => m.TRADE_RECOMMENDATIONS_ROUTES,
          ),
      },
      {
        path: 'pending-signal-recs',
        canActivate: [canAccessPath('pending-signal-recs')],
        data: { breadcrumb: 'Pending Recs' },
        loadChildren: () =>
          import('@features/pending-signal-recs/pending-signal-recs.routes').then(
            (m) => m.PENDING_SIGNAL_RECS_ROUTES,
          ),
      },
      {
        path: 'trading-accounts',
        canActivate: [canAccessPath('trading-accounts')],
        data: { breadcrumb: 'Trading Accounts' },
        loadChildren: () =>
          import('@features/trading-accounts/trading-accounts.routes').then(
            (m) => m.TRADING_ACCOUNTS_ROUTES,
          ),
      },
      {
        path: 'brokers',
        canActivate: [canAccessPath('brokers')],
        data: { breadcrumb: 'Brokers' },
        loadChildren: () =>
          import('@features/brokers/brokers.routes').then((m) => m.BROKERS_ROUTES),
      },
      {
        path: 'risk-profiles',
        canActivate: [canAccessPath('risk-profiles')],
        data: { breadcrumb: 'Risk Profiles' },
        loadChildren: () =>
          import('@features/risk-profiles/risk-profiles.routes').then(
            (m) => m.RISK_PROFILES_ROUTES,
          ),
      },
      {
        path: 'currency-pairs',
        canActivate: [canAccessPath('currency-pairs')],
        data: { breadcrumb: 'Currency Pairs' },
        loadChildren: () =>
          import('@features/currency-pairs/currency-pairs.routes').then(
            (m) => m.CURRENCY_PAIRS_ROUTES,
          ),
      },
      {
        path: 'market-data',
        canActivate: [canAccessPath('market-data')],
        data: { breadcrumb: 'Market Data' },
        loadChildren: () =>
          import('@features/market-data/market-data.routes').then((m) => m.MARKET_DATA_ROUTES),
      },
      {
        // Multi-asset WS7 7.7: execution accounts at venues, write-only credentials, adapter health, drift.
        path: 'connections',
        canActivate: [canAccessPath('connections')],
        data: { breadcrumb: 'Connections' },
        loadChildren: () =>
          import('@features/venues/venues.routes').then((m) => m.CONNECTIONS_ROUTES),
      },
      {
        // Multi-asset WS7 7.10: exchange reference data (fee schedules, margin requirements).
        path: 'reference',
        canActivate: [canAccessPath('reference')],
        data: { breadcrumb: 'Reference data' },
        loadChildren: () =>
          import('@features/venues/venues.routes').then((m) => m.REFERENCE_ROUTES),
      },
      {
        path: 'chart-analysis',
        canActivate: [canAccessPath('chart-analysis')],
        data: { breadcrumb: 'Charts' },
        loadChildren: () =>
          import('@features/chart-analysis/chart-analysis.routes').then(
            (m) => m.CHART_ANALYSIS_ROUTES,
          ),
      },
      {
        path: 'watchlist',
        canActivate: [canAccessPath('watchlist')],
        data: { breadcrumb: 'Watchlist' },
        loadChildren: () =>
          import('@features/watchlist/watchlist.routes').then((m) => m.WATCHLIST_ROUTES),
      },
      {
        path: 'spot-analysis',
        canActivate: [canAccessPath('spot-analysis')],
        data: { breadcrumb: 'Spot Analysis' },
        loadChildren: () =>
          import('@features/spot-analysis/spot-analysis.routes').then(
            (m) => m.SPOT_ANALYSIS_ROUTES,
          ),
      },
      {
        path: 'conversations',
        canActivate: [canAccessPath('conversations')],
        data: { breadcrumb: 'Conversations' },
        loadChildren: () =>
          import('@features/conversations/conversations.routes').then(
            (m) => m.CONVERSATIONS_ROUTES,
          ),
      },
      {
        path: 'analysis-monitors',
        canActivate: [canAccessPath('analysis-monitors')],
        data: { breadcrumb: 'Analysis Monitors' },
        loadChildren: () =>
          import('@features/analysis-monitors/analysis-monitors.routes').then(
            (m) => m.ANALYSIS_MONITORS_ROUTES,
          ),
      },
      {
        path: 'algo-engineer/operations',
        canActivate: [canAccessPath('algo-engineer/operations')],
        data: { breadcrumb: 'Agent Operations' },
        loadChildren: () =>
          import('@features/algo-engineer/algo-engineer.routes').then(
            (m) => m.ALGO_ENGINEER_OPERATIONS_ROUTES,
          ),
      },
      {
        path: 'algo-engineer/scorecard',
        canActivate: [canAccessPath('algo-engineer/scorecard')],
        data: { breadcrumb: 'Change Scorecard' },
        loadChildren: () =>
          import('@features/algo-engineer/algo-engineer.routes').then(
            (m) => m.ALGO_ENGINEER_ROUTES,
          ),
      },
      {
        path: 'spot-sweep',
        canActivate: [canAccessPath('spot-sweep')],
        data: { breadcrumb: 'Spot Sweep' },
        loadChildren: () =>
          import('@features/spot-sweep/spot-sweep.routes').then((m) => m.SPOT_SWEEP_ROUTES),
      },
      {
        path: 'patient-trader',
        canActivate: [canAccessPath('patient-trader')],
        data: { breadcrumb: 'Patient Trader' },
        loadChildren: () =>
          import('@features/patient-trader/patient-trader.routes').then(
            (m) => m.PATIENT_TRADER_ROUTES,
          ),
      },
      {
        path: 'news-intel',
        canActivate: [canAccessPath('news-intel')],
        data: { breadcrumb: 'News Intelligence' },
        loadChildren: () =>
          import('@features/news-intel/news-intel.routes').then((m) => m.NEWS_INTEL_ROUTES),
      },
      {
        path: 'spread-reactive',
        canActivate: [canAccessPath('spread-reactive')],
        data: { breadcrumb: 'Spread-Reactive' },
        loadChildren: () =>
          import('@features/spread-reactive/spread-reactive.routes').then(
            (m) => m.SPREAD_REACTIVE_ROUTES,
          ),
      },
      {
        path: 'viability-gates',
        canActivate: [canAccessPath('viability-gates')],
        data: { breadcrumb: 'Viability Gates' },
        loadChildren: () =>
          import('@features/viability-gates/viability-gates.routes').then(
            (m) => m.VIABILITY_GATES_ROUTES,
          ),
      },
      {
        path: 'analyser-comparison',
        canActivate: [canAccessPath('analyser-comparison')],
        data: { breadcrumb: 'Analyser Comparison' },
        loadChildren: () =>
          import('@features/analyser-comparison/analyser-comparison.routes').then(
            (m) => m.ANALYSER_COMPARISON_ROUTES,
          ),
      },
      {
        path: 'signal-sensitivity',
        canActivate: [canAccessPath('signal-sensitivity')],
        data: { breadcrumb: 'Signal Sensitivity' },
        loadChildren: () =>
          import('@features/signal-sensitivity/signal-sensitivity.routes').then(
            (m) => m.SIGNAL_SENSITIVITY_ROUTES,
          ),
      },
      {
        path: 'llm-backtest',
        canActivate: [canAccessPath('llm-backtest')],
        data: { breadcrumb: 'LLM Backtest' },
        loadChildren: () =>
          import('@features/llm-backtest/llm-backtest.routes').then((m) => m.LLM_BACKTEST_ROUTES),
      },
      {
        path: 'prompt-templates',
        canActivate: [canAccessPath('prompt-templates')],
        data: { breadcrumb: 'Prompt Templates' },
        loadChildren: () =>
          import('@features/prompt-templates/prompt-templates.routes').then(
            (m) => m.PROMPT_TEMPLATES_ROUTES,
          ),
      },
      {
        path: 'ml-models',
        canActivate: [canAccessPath('ml-models')],
        data: { breadcrumb: 'ML Models' },
        loadChildren: () =>
          import('@features/ml-models/ml-models.routes').then((m) => m.ML_MODELS_ROUTES),
      },
      {
        path: 'composite-ml',
        canActivate: [canAccessPath('composite-ml')],
        data: { breadcrumb: 'CompositeML' },
        loadChildren: () =>
          import('@features/composite-ml/composite-ml.routes').then((m) => m.COMPOSITE_ML_ROUTES),
      },
      {
        path: 'llm',
        canActivate: [canAccessPath('llm')],
        data: { breadcrumb: 'LLM' },
        loadChildren: () => import('@features/llm/llm.routes').then((m) => m.LLM_ROUTES),
      },
      {
        path: 'backtests',
        canActivate: [canAccessPath('backtests')],
        data: { breadcrumb: 'Backtesting' },
        loadChildren: () =>
          import('@features/backtests/backtests.routes').then((m) => m.BACKTESTS_ROUTES),
      },
      {
        path: 'walk-forward',
        canActivate: [canAccessPath('walk-forward')],
        data: { breadcrumb: 'Walk-Forward' },
        loadChildren: () =>
          import('@features/walk-forward/walk-forward.routes').then((m) => m.WALK_FORWARD_ROUTES),
      },
      {
        // Portfolio backtests (BT-I12 / BX-5): several script strategies on one account and one bar clock.
        path: 'portfolio-backtests',
        canActivate: [canAccessPath('portfolio-backtests')],
        data: { breadcrumb: 'Portfolio Backtests' },
        loadChildren: () =>
          import('@features/scripting/backtest/portfolio/portfolio-backtest.routes').then(
            (m) => m.PORTFOLIO_BACKTEST_ROUTES,
          ),
      },
      {
        // Pine screener (ADR-0027 §6): runs a script over many symbols' recent bars.
        path: 'pine-screener',
        canActivate: [canAccessPath('pine-screener')],
        data: { breadcrumb: 'Pine Screener' },
        loadComponent: () =>
          import('@features/scripting/screener/pine-screener-page.component').then(
            (m) => m.PineScreenerPageComponent,
          ),
      },
      {
        path: 'strategy-ensemble',
        canActivate: [canAccessPath('strategy-ensemble')],
        data: { breadcrumb: 'Strategy Ensemble' },
        loadChildren: () =>
          import('@features/strategy-ensemble/strategy-ensemble.routes').then(
            (m) => m.STRATEGY_ENSEMBLE_ROUTES,
          ),
      },
      {
        path: 'strategy-portfolio',
        canActivate: [canAccessPath('strategy-portfolio')],
        // Page hits /strategy/allocation-weights + /strategy-generation/portfolio/fwer-report,
        // both Operator-policy server-side. Gate the route so Viewers don't
        // see CORS/403 storms in the console.
        data: { breadcrumb: 'Strategy Portfolio' },
        loadChildren: () =>
          import('@features/strategy-portfolio/strategy-portfolio.routes').then(
            (m) => m.STRATEGY_PORTFOLIO_ROUTES,
          ),
      },
      {
        path: 'strategy-generation',
        canActivate: [canAccessPath('strategy-generation')],
        // Same: trigger-cycle endpoint is Operator-only and the timeline
        // refresh is reactive.
        data: { breadcrumb: 'Strategy Generation' },
        loadChildren: () =>
          import('@features/strategy-generation/strategy-generation.routes').then(
            (m) => m.STRATEGY_GENERATION_ROUTES,
          ),
      },
      {
        path: 'engine-overview',
        canActivate: [canAccessPath('engine-overview')],
        // /health/workers is Operator-gated; the dead-letter panels need
        // platform.infrastructure.manage and are left out without it.
        data: { breadcrumb: 'Engine Overview' },
        loadChildren: () =>
          import('@features/engine-overview/engine-overview.routes').then(
            (m) => m.ENGINE_OVERVIEW_ROUTES,
          ),
      },
      {
        path: 'cme-microstructure',
        canActivate: [canAccessPath('cme-microstructure')],
        // Every /experiment/cme-* endpoint is Operator-gated engine-side.
        data: { breadcrumb: 'CME Microstructure' },
        loadChildren: () =>
          import('@features/cme-microstructure/cme-microstructure.routes').then(
            (m) => m.CME_MICROSTRUCTURE_ROUTES,
          ),
      },
      {
        path: 'fleet-health',
        canActivate: [canAccessPath('fleet-health')],
        // Phase-16: read-only observability dashboard.
        data: { breadcrumb: 'Fleet Health' },
        loadChildren: () =>
          import('@features/fleet-health/fleet-health.routes').then((m) => m.FLEET_HEALTH_ROUTES),
      },
      {
        path: 'alerts',
        canActivate: [canAccessPath('alerts')],
        data: { breadcrumb: 'Alerts' },
        loadChildren: () => import('@features/alerts/alerts.routes').then((m) => m.ALERTS_ROUTES),
      },
      {
        // Broker dealing desk (enterprise program wave 2, broker module — a plan feature).
        path: 'dealing',
        canActivate: [canAccessPath('dealing')],
        data: { breadcrumb: 'Dealing Desk' },
        loadChildren: () =>
          import('@features/dealing/dealing.routes').then((m) => m.DEALING_ROUTES),
      },
      {
        path: 'execution-quality',
        canActivate: [canAccessPath('execution-quality')],
        data: { breadcrumb: 'Execution Quality' },
        loadChildren: () =>
          import('@features/execution-quality/execution-quality.routes').then(
            (m) => m.EXECUTION_QUALITY_ROUTES,
          ),
      },
      {
        path: 'sentiment',
        canActivate: [canAccessPath('sentiment')],
        data: { breadcrumb: 'Sentiment & Regime' },
        loadChildren: () =>
          import('@features/sentiment/sentiment.routes').then((m) => m.SENTIMENT_ROUTES),
      },
      {
        path: 'performance',
        canActivate: [canAccessPath('performance')],
        data: { breadcrumb: 'Performance' },
        loadChildren: () =>
          import('@features/performance/performance.routes').then((m) => m.PERFORMANCE_ROUTES),
      },
      {
        path: 'drawdown-recovery',
        canActivate: [canAccessPath('drawdown-recovery')],
        data: { breadcrumb: 'Drawdown Recovery' },
        loadChildren: () =>
          import('@features/drawdown-recovery/drawdown-recovery.routes').then(
            (m) => m.DRAWDOWN_RECOVERY_ROUTES,
          ),
      },
      {
        path: 'martingale',
        canActivate: [canAccessPath('martingale')],
        data: { breadcrumb: 'Martingale Ladders' },
        loadChildren: () =>
          import('@features/martingale/martingale.routes').then((m) => m.MARTINGALE_ROUTES),
      },
      {
        path: 'drift-report',
        canActivate: [canAccessPath('drift-report')],
        data: { breadcrumb: 'Drift Report' },
        loadChildren: () =>
          import('@features/drift-report/drift-report.routes').then((m) => m.DRIFT_REPORT_ROUTES),
      },
      {
        path: 'operator-roles',
        canActivate: [canAccessPath('operator-roles')],
        data: { breadcrumb: 'Operator Roles' },
        loadChildren: () =>
          import('@features/operator-roles/operator-roles.routes').then(
            (m) => m.OPERATOR_ROLES_ROUTES,
          ),
      },
      {
        path: 'paper-trading',
        canActivate: [canAccessPath('paper-trading')],
        data: { breadcrumb: 'Paper Trading' },
        loadChildren: () =>
          import('@features/paper-trading/paper-trading.routes').then(
            (m) => m.PAPER_TRADING_ROUTES,
          ),
      },
      {
        path: 'engine-config',
        canActivate: [canAccessPath('engine-config')],
        data: { breadcrumb: 'Engine Config' },
        loadChildren: () =>
          import('@features/engine-config/engine-config.routes').then(
            (m) => m.ENGINE_CONFIG_ROUTES,
          ),
      },
      {
        path: 'economic-events',
        canActivate: [canAccessPath('economic-events')],
        data: { breadcrumb: 'Economic Events' },
        loadChildren: () =>
          import('@features/economic-events/economic-events.routes').then(
            (m) => m.ECONOMIC_EVENTS_ROUTES,
          ),
      },
      {
        path: 'audit-trail',
        canActivate: [canAccessPath('audit-trail')],
        data: { breadcrumb: 'Audit Trail' },
        loadChildren: () =>
          import('@features/audit-trail/audit-trail.routes').then((m) => m.AUDIT_TRAIL_ROUTES),
      },
      {
        path: 'system-health',
        canActivate: [canAccessPath('system-health')],
        data: { breadcrumb: 'System Health' },
        loadChildren: () =>
          import('@features/system-health/system-health.routes').then(
            (m) => m.SYSTEM_HEALTH_ROUTES,
          ),
      },
      {
        path: 'system-logs',
        canActivate: [canAccessPath('system-logs')],
        data: { breadcrumb: 'Engine Logs' },
        loadChildren: () =>
          import('@features/system-logs/system-logs.routes').then((m) => m.SYSTEM_LOGS_ROUTES),
      },
      {
        path: 'kill-switches',
        canActivate: [canAccessPath('kill-switches')],
        data: { breadcrumb: 'Kill Switches' },
        loadChildren: () =>
          import('@features/kill-switches/kill-switches.routes').then(
            (m) => m.KILL_SWITCHES_ROUTES,
          ),
      },
      {
        path: 'worker-health',
        canActivate: [canAccessPath('worker-health')],
        data: { breadcrumb: 'Worker Health' },
        loadChildren: () =>
          import('@features/worker-health/worker-health.routes').then(
            (m) => m.WORKER_HEALTH_ROUTES,
          ),
      },
      {
        path: 'ea-instances',
        canActivate: [canAccessPath('ea-instances')],
        data: { breadcrumb: 'EA Instances' },
        loadChildren: () =>
          import('@features/ea-instances/ea-instances.routes').then((m) => m.EA_INSTANCES_ROUTES),
      },
      {
        path: 'terminals',
        canActivate: [canAccessPath('terminals')],
        data: { breadcrumb: 'Terminals' },
        loadComponent: () =>
          import('@features/terminals/pages/terminals-page/terminals-page.component').then(
            (m) => m.TerminalsPageComponent,
          ),
      },
      {
        path: 'dead-letter',
        canActivate: [canAccessPath('dead-letter')],
        data: { breadcrumb: 'Dead Letters' },
        loadChildren: () =>
          import('@features/dead-letter/dead-letter.routes').then((m) => m.DEAD_LETTER_ROUTES),
      },
      {
        path: 'alert-triage',
        canActivate: [canAccessPath('alert-triage')],
        data: { breadcrumb: 'Alert Triage' },
        loadChildren: () =>
          import('@features/alert-triage/alert-triage.routes').then((m) => m.ALERT_TRIAGE_ROUTES),
      },
      {
        path: 'calibration',
        canActivate: [canAccessPath('calibration')],
        data: { breadcrumb: 'Tuning' },
        loadChildren: () =>
          import('@features/calibration/calibration.routes').then((m) => m.CALIBRATION_ROUTES),
      },
      {
        path: 'optimizations',
        canActivate: [canAccessPath('optimizations')],
        data: { breadcrumb: 'Optimizations' },
        loadChildren: () =>
          import('@features/optimizations/optimizations.routes').then(
            (m) => m.OPTIMIZATIONS_ROUTES,
          ),
      },
      {
        path: 'automation-monitor',
        canActivate: [canAccessPath('automation-monitor')],
        data: { breadcrumb: 'Automation Monitor' },
        loadChildren: () =>
          import('@features/automation-monitor/automation-monitor.routes').then(
            (m) => m.AUTOMATION_MONITOR_ROUTES,
          ),
      },
      {
        path: 'auto-tune',
        canActivate: [canAccessPath('auto-tune')],
        data: { breadcrumb: 'Auto-Tune' },
        loadChildren: () =>
          import('@features/auto-tune/auto-tune.routes').then((m) => m.AUTO_TUNE_ROUTES),
      },
      {
        path: 'admin/users',
        canActivate: [canAccessPath('admin/users')],
        data: { breadcrumb: 'Admin Users' },
        loadChildren: () =>
          import('@features/admin-users/admin-users.routes').then((m) => m.ADMIN_USERS_ROUTES),
      },
      {
        path: 'admin/roles',
        canActivate: [canAccessPath('admin/roles')],
        data: { breadcrumb: 'Roles' },
        loadChildren: () => import('@features/roles/roles.routes').then((m) => m.ROLES_ROUTES),
      },
      {
        path: 'admin/audit',
        canActivate: [canAccessPath('admin/audit')],
        data: { breadcrumb: 'Audit Log' },
        loadChildren: () =>
          import('@features/audit-log/audit-log.routes').then((m) => m.AUDIT_LOG_ROUTES),
      },
      {
        // Organisation administration (multi-tenancy W3, U3.4): members, invitations, roles,
        // grants, teams, account groups, security policy, SSO, approvals, access review.
        path: 'iam',
        canActivate: [canAccessPath('iam')],
        data: { breadcrumb: 'Organisation' },
        loadChildren: () => import('@features/iam/iam.routes').then((m) => m.IAM_ROUTES),
      },
      {
        // Organisation console (multi-tenancy Phase 7, c7-tenant): terminals, settings, risk and kill
        // switches, strategy subscriptions, alert channels, LLM usage and key.
        path: 'organisation',
        canActivate: [canAccessPath('organisation')],
        data: { breadcrumb: 'Organisation' },
        loadChildren: () =>
          import('@features/organisation/organisation.routes').then((m) => m.ORGANISATION_ROUTES),
      },
      {
        // Fund module (enterprise program): performance statements, best-execution evidence, compliance exports.
        path: 'fund',
        canActivate: [canAccessPath('fund')],
        data: { breadcrumb: 'Fund' },
        loadChildren: () => import('@features/fund/fund.routes').then((m) => m.FUND_ROUTES),
      },
      {
        // Release notes of every platform component (enterprise program, security-controls).
        path: 'releases',
        canActivate: [canAccessPath('releases')],
        data: { breadcrumb: 'Release notes' },
        loadComponent: () =>
          import('@features/security/pages/release-notes-page.component').then(
            (m) => m.ReleaseNotesPageComponent,
          ),
      },
      {
        // Getting a new organisation going (multi-tenancy Phase 7, c7-lifecycle).
        path: 'onboarding',
        canActivate: [canAccessPath('onboarding')],
        data: { breadcrumb: 'Get started' },
        loadComponent: () =>
          import('@features/onboarding/pages/onboarding-page.component').then(
            (m) => m.OnboardingPageComponent,
          ),
      },
      {
        // Prop-firm module (enterprise program, prop-module): programs, traders, enrolments, dashboards,
        // breach feed, leaderboard, payouts, and the trader's own "My challenge".
        path: 'prop',
        canActivate: [canAccessPath('prop')],
        data: { breadcrumb: 'Prop firm' },
        loadChildren: () => import('@features/prop/prop.routes').then((m) => m.PROP_ROUTES),
      },
      {
        // Platform console (multi-tenancy W3, U3.6): organisations, elevated access, impersonation.
        path: 'platform',
        canActivate: [canAccessPath('platform')],
        data: { breadcrumb: 'Platform' },
        loadChildren: () =>
          import('@features/platform/platform.routes').then((m) => m.PLATFORM_ROUTES),
      },
      {
        path: 'account',
        canActivate: [canAccessPath('account')],
        data: { breadcrumb: 'Account' },
        loadChildren: () =>
          import('@features/account/account.routes').then((m) => m.ACCOUNT_ROUTES),
      },
      {
        // Pine chart renderer on fixtures or a live scripting/run — a development surface: on in
        // dev builds, and in a release only where the `pine-chart-lab` flag admits (Admins).
        path: 'pine-chart-lab',
        data: { breadcrumb: 'Pine Chart Lab' },
        canActivate: [devModeOrFeatureFlag('pine-chart-lab'), canAccessPath('pine-chart-lab')],
        loadChildren: () =>
          import('@features/scripting/pine-chart-lab/pine-chart-lab.routes').then(
            (m) => m.PINE_CHART_LAB_ROUTES,
          ),
      },
      { path: '**', redirectTo: 'dashboard' },
    ],
  },
];
