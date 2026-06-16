import { Routes } from '@angular/router';
import { LayoutComponent } from './layout/layout.component';
import { LoginComponent } from '@core/auth/login/login.component';
import { authGuard } from '@core/auth/auth.guard';
import { requireRoles } from '@core/auth/role.guard';
import { requirePermission } from '@core/auth/permission.guard';
import { mustChangePasswordGuard } from '@core/auth/must-change-password.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    canActivateChild: [mustChangePasswordGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        data: { breadcrumb: 'Dashboard' },
        loadChildren: () =>
          import('@features/dashboard/dashboard.routes').then((m) => m.DASHBOARD_ROUTES),
      },
      {
        path: 'orders',
        data: { breadcrumb: 'Orders' },
        loadChildren: () => import('@features/orders/orders.routes').then((m) => m.ORDERS_ROUTES),
      },
      {
        path: 'positions',
        data: { breadcrumb: 'Positions' },
        loadChildren: () =>
          import('@features/positions/positions.routes').then((m) => m.POSITIONS_ROUTES),
      },
      {
        path: 'strategies',
        data: { breadcrumb: 'Strategies' },
        loadChildren: () =>
          import('@features/strategies/strategies.routes').then((m) => m.STRATEGIES_ROUTES),
      },
      {
        path: 'trade-signals',
        data: { breadcrumb: 'Trade Signals' },
        loadChildren: () =>
          import('@features/trade-signals/trade-signals.routes').then(
            (m) => m.TRADE_SIGNALS_ROUTES,
          ),
      },
      {
        path: 'rejections',
        data: { breadcrumb: 'Signal Rejections' },
        loadChildren: () =>
          import('@features/signal-rejections/signal-rejections.routes').then(
            (m) => m.SIGNAL_REJECTIONS_ROUTES,
          ),
      },
      {
        path: 'trading-accounts',
        data: { breadcrumb: 'Trading Accounts' },
        loadChildren: () =>
          import('@features/trading-accounts/trading-accounts.routes').then(
            (m) => m.TRADING_ACCOUNTS_ROUTES,
          ),
      },
      {
        path: 'brokers',
        data: { breadcrumb: 'Brokers' },
        loadChildren: () =>
          import('@features/brokers/brokers.routes').then((m) => m.BROKERS_ROUTES),
      },
      {
        path: 'risk-profiles',
        data: { breadcrumb: 'Risk Profiles' },
        loadChildren: () =>
          import('@features/risk-profiles/risk-profiles.routes').then(
            (m) => m.RISK_PROFILES_ROUTES,
          ),
      },
      {
        path: 'currency-pairs',
        data: { breadcrumb: 'Currency Pairs' },
        loadChildren: () =>
          import('@features/currency-pairs/currency-pairs.routes').then(
            (m) => m.CURRENCY_PAIRS_ROUTES,
          ),
      },
      {
        path: 'market-data',
        data: { breadcrumb: 'Market Data' },
        loadChildren: () =>
          import('@features/market-data/market-data.routes').then((m) => m.MARKET_DATA_ROUTES),
      },
      {
        path: 'watchlist',
        data: { breadcrumb: 'Watchlist' },
        loadChildren: () =>
          import('@features/watchlist/watchlist.routes').then((m) => m.WATCHLIST_ROUTES),
      },
      {
        path: 'spot-analysis',
        data: { breadcrumb: 'Spot Analysis' },
        loadChildren: () =>
          import('@features/spot-analysis/spot-analysis.routes').then(
            (m) => m.SPOT_ANALYSIS_ROUTES,
          ),
      },
      {
        path: 'spot-sweep',
        data: { breadcrumb: 'Spot Sweep' },
        loadChildren: () =>
          import('@features/spot-sweep/spot-sweep.routes').then((m) => m.SPOT_SWEEP_ROUTES),
      },
      {
        path: 'analyser-comparison',
        data: { breadcrumb: 'Analyser Comparison' },
        loadChildren: () =>
          import('@features/analyser-comparison/analyser-comparison.routes').then(
            (m) => m.ANALYSER_COMPARISON_ROUTES,
          ),
      },
      {
        path: 'signal-sensitivity',
        data: { breadcrumb: 'Signal Sensitivity' },
        loadChildren: () =>
          import('@features/signal-sensitivity/signal-sensitivity.routes').then(
            (m) => m.SIGNAL_SENSITIVITY_ROUTES,
          ),
      },
      {
        path: 'ml-models',
        data: { breadcrumb: 'ML Models' },
        loadChildren: () =>
          import('@features/ml-models/ml-models.routes').then((m) => m.ML_MODELS_ROUTES),
      },
      {
        path: 'composite-ml',
        data: { breadcrumb: 'CompositeML' },
        loadChildren: () =>
          import('@features/composite-ml/composite-ml.routes').then((m) => m.COMPOSITE_ML_ROUTES),
      },
      {
        path: 'llm',
        data: { breadcrumb: 'LLM' },
        loadChildren: () => import('@features/llm/llm.routes').then((m) => m.LLM_ROUTES),
      },
      {
        path: 'backtests',
        data: { breadcrumb: 'Backtesting' },
        loadChildren: () =>
          import('@features/backtests/backtests.routes').then((m) => m.BACKTESTS_ROUTES),
      },
      {
        path: 'walk-forward',
        data: { breadcrumb: 'Walk-Forward' },
        loadChildren: () =>
          import('@features/walk-forward/walk-forward.routes').then((m) => m.WALK_FORWARD_ROUTES),
      },
      {
        path: 'strategy-ensemble',
        data: { breadcrumb: 'Strategy Ensemble' },
        loadChildren: () =>
          import('@features/strategy-ensemble/strategy-ensemble.routes').then(
            (m) => m.STRATEGY_ENSEMBLE_ROUTES,
          ),
      },
      {
        path: 'strategy-portfolio',
        // Page hits /strategy/allocation-weights + /strategy-generation/portfolio/fwer-report,
        // both Operator-policy server-side. Gate the route so Viewers don't
        // see CORS/403 storms in the console.
        canActivate: [requireRoles('Operator', 'Admin')],
        data: { breadcrumb: 'Strategy Portfolio' },
        loadChildren: () =>
          import('@features/strategy-portfolio/strategy-portfolio.routes').then(
            (m) => m.STRATEGY_PORTFOLIO_ROUTES,
          ),
      },
      {
        path: 'strategy-generation',
        // Same: trigger-cycle endpoint is Operator-only and the timeline
        // refresh is reactive.
        canActivate: [requireRoles('Operator', 'Admin')],
        data: { breadcrumb: 'Strategy Generation' },
        loadChildren: () =>
          import('@features/strategy-generation/strategy-generation.routes').then(
            (m) => m.STRATEGY_GENERATION_ROUTES,
          ),
      },
      {
        path: 'engine-overview',
        // Calls /health/workers + /dead-letter/list which are Operator-gated.
        canActivate: [requireRoles('Operator', 'Admin')],
        data: { breadcrumb: 'Engine Overview' },
        loadChildren: () =>
          import('@features/engine-overview/engine-overview.routes').then(
            (m) => m.ENGINE_OVERVIEW_ROUTES,
          ),
      },
      {
        path: 'fleet-health',
        // Phase-16: read-only observability dashboard.
        canActivate: [requireRoles('Operator', 'Admin')],
        data: { breadcrumb: 'Fleet Health' },
        loadChildren: () =>
          import('@features/fleet-health/fleet-health.routes').then((m) => m.FLEET_HEALTH_ROUTES),
      },
      {
        path: 'alerts',
        data: { breadcrumb: 'Alerts' },
        loadChildren: () => import('@features/alerts/alerts.routes').then((m) => m.ALERTS_ROUTES),
      },
      {
        path: 'execution-quality',
        data: { breadcrumb: 'Execution Quality' },
        loadChildren: () =>
          import('@features/execution-quality/execution-quality.routes').then(
            (m) => m.EXECUTION_QUALITY_ROUTES,
          ),
      },
      {
        path: 'sentiment',
        data: { breadcrumb: 'Sentiment & Regime' },
        loadChildren: () =>
          import('@features/sentiment/sentiment.routes').then((m) => m.SENTIMENT_ROUTES),
      },
      {
        path: 'performance',
        data: { breadcrumb: 'Performance' },
        loadChildren: () =>
          import('@features/performance/performance.routes').then((m) => m.PERFORMANCE_ROUTES),
      },
      {
        path: 'drawdown-recovery',
        data: { breadcrumb: 'Drawdown Recovery' },
        loadChildren: () =>
          import('@features/drawdown-recovery/drawdown-recovery.routes').then(
            (m) => m.DRAWDOWN_RECOVERY_ROUTES,
          ),
      },
      {
        path: 'drift-report',
        data: { breadcrumb: 'Drift Report' },
        loadChildren: () =>
          import('@features/drift-report/drift-report.routes').then((m) => m.DRIFT_REPORT_ROUTES),
      },
      {
        path: 'operator-roles',
        data: { breadcrumb: 'Operator Roles' },
        canActivate: [requireRoles('Admin')],
        loadChildren: () =>
          import('@features/operator-roles/operator-roles.routes').then(
            (m) => m.OPERATOR_ROLES_ROUTES,
          ),
      },
      {
        path: 'paper-trading',
        data: { breadcrumb: 'Paper Trading' },
        loadChildren: () =>
          import('@features/paper-trading/paper-trading.routes').then(
            (m) => m.PAPER_TRADING_ROUTES,
          ),
      },
      {
        path: 'engine-config',
        data: { breadcrumb: 'Engine Config' },
        loadChildren: () =>
          import('@features/engine-config/engine-config.routes').then(
            (m) => m.ENGINE_CONFIG_ROUTES,
          ),
      },
      {
        path: 'economic-events',
        data: { breadcrumb: 'Economic Events' },
        loadChildren: () =>
          import('@features/economic-events/economic-events.routes').then(
            (m) => m.ECONOMIC_EVENTS_ROUTES,
          ),
      },
      {
        path: 'audit-trail',
        data: { breadcrumb: 'Audit Trail' },
        loadChildren: () =>
          import('@features/audit-trail/audit-trail.routes').then((m) => m.AUDIT_TRAIL_ROUTES),
      },
      {
        path: 'system-health',
        data: { breadcrumb: 'System Health' },
        loadChildren: () =>
          import('@features/system-health/system-health.routes').then(
            (m) => m.SYSTEM_HEALTH_ROUTES,
          ),
      },
      {
        path: 'system-logs',
        data: { breadcrumb: 'Engine Logs' },
        loadChildren: () =>
          import('@features/system-logs/system-logs.routes').then((m) => m.SYSTEM_LOGS_ROUTES),
      },
      {
        path: 'kill-switches',
        data: { breadcrumb: 'Kill Switches' },
        canActivate: [requireRoles('Operator', 'Admin')],
        loadChildren: () =>
          import('@features/kill-switches/kill-switches.routes').then(
            (m) => m.KILL_SWITCHES_ROUTES,
          ),
      },
      {
        path: 'worker-health',
        data: { breadcrumb: 'Worker Health' },
        loadChildren: () =>
          import('@features/worker-health/worker-health.routes').then(
            (m) => m.WORKER_HEALTH_ROUTES,
          ),
      },
      {
        path: 'ea-instances',
        data: { breadcrumb: 'EA Instances' },
        loadChildren: () =>
          import('@features/ea-instances/ea-instances.routes').then((m) => m.EA_INSTANCES_ROUTES),
      },
      {
        path: 'terminals',
        data: { breadcrumb: 'Terminals' },
        loadComponent: () =>
          import('@features/terminals/pages/terminals-page/terminals-page.component').then(
            (m) => m.TerminalsPageComponent,
          ),
      },
      {
        path: 'dead-letter',
        data: { breadcrumb: 'Dead Letters' },
        loadChildren: () =>
          import('@features/dead-letter/dead-letter.routes').then((m) => m.DEAD_LETTER_ROUTES),
      },
      {
        path: 'alert-triage',
        data: { breadcrumb: 'Alert Triage' },
        loadChildren: () =>
          import('@features/alert-triage/alert-triage.routes').then((m) => m.ALERT_TRIAGE_ROUTES),
      },
      {
        path: 'calibration',
        data: { breadcrumb: 'Tuning' },
        loadChildren: () =>
          import('@features/calibration/calibration.routes').then((m) => m.CALIBRATION_ROUTES),
      },
      {
        path: 'optimizations',
        data: { breadcrumb: 'Optimizations' },
        loadChildren: () =>
          import('@features/optimizations/optimizations.routes').then(
            (m) => m.OPTIMIZATIONS_ROUTES,
          ),
      },
      {
        path: 'automation-monitor',
        data: { breadcrumb: 'Automation Monitor' },
        loadChildren: () =>
          import('@features/automation-monitor/automation-monitor.routes').then(
            (m) => m.AUTOMATION_MONITOR_ROUTES,
          ),
      },
      {
        path: 'auto-tune',
        canActivate: [requireRoles('Operator', 'Admin')],
        data: { breadcrumb: 'Auto-Tune' },
        loadChildren: () =>
          import('@features/auto-tune/auto-tune.routes').then((m) => m.AUTO_TUNE_ROUTES),
      },
      {
        path: 'admin/users',
        data: { breadcrumb: 'Admin Users' },
        canActivate: [requirePermission('users.manage')],
        loadChildren: () =>
          import('@features/admin-users/admin-users.routes').then((m) => m.ADMIN_USERS_ROUTES),
      },
      {
        path: 'admin/roles',
        data: { breadcrumb: 'Roles' },
        canActivate: [requirePermission('roles.manage')],
        loadChildren: () => import('@features/roles/roles.routes').then((m) => m.ROLES_ROUTES),
      },
      {
        path: 'account',
        data: { breadcrumb: 'Account' },
        loadChildren: () =>
          import('@features/account/account.routes').then((m) => m.ACCOUNT_ROUTES),
      },
      { path: '**', redirectTo: 'dashboard' },
    ],
  },
];
