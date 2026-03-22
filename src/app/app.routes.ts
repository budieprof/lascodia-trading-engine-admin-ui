import { Routes } from '@angular/router';
import { LayoutComponent } from './layout/layout.component';
import { LoginComponent } from '@core/auth/login/login.component';
import { authGuard } from '@core/auth/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  {
    path: '',
    component: LayoutComponent,
    canActivate: [authGuard],
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        data: { breadcrumb: 'Dashboard' },
        loadChildren: () => import('@features/dashboard/dashboard.routes').then(m => m.DASHBOARD_ROUTES),
      },
      {
        path: 'orders',
        data: { breadcrumb: 'Orders' },
        loadChildren: () => import('@features/orders/orders.routes').then(m => m.ORDERS_ROUTES),
      },
      {
        path: 'positions',
        data: { breadcrumb: 'Positions' },
        loadChildren: () => import('@features/positions/positions.routes').then(m => m.POSITIONS_ROUTES),
      },
      {
        path: 'strategies',
        data: { breadcrumb: 'Strategies' },
        loadChildren: () => import('@features/strategies/strategies.routes').then(m => m.STRATEGIES_ROUTES),
      },
      {
        path: 'trade-signals',
        data: { breadcrumb: 'Trade Signals' },
        loadChildren: () => import('@features/trade-signals/trade-signals.routes').then(m => m.TRADE_SIGNALS_ROUTES),
      },
      {
        path: 'trading-accounts',
        data: { breadcrumb: 'Trading Accounts' },
        loadChildren: () => import('@features/trading-accounts/trading-accounts.routes').then(m => m.TRADING_ACCOUNTS_ROUTES),
      },
      {
        path: 'brokers',
        data: { breadcrumb: 'Brokers' },
        loadChildren: () => import('@features/brokers/brokers.routes').then(m => m.BROKERS_ROUTES),
      },
      {
        path: 'risk-profiles',
        data: { breadcrumb: 'Risk Profiles' },
        loadChildren: () => import('@features/risk-profiles/risk-profiles.routes').then(m => m.RISK_PROFILES_ROUTES),
      },
      {
        path: 'currency-pairs',
        data: { breadcrumb: 'Currency Pairs' },
        loadChildren: () => import('@features/currency-pairs/currency-pairs.routes').then(m => m.CURRENCY_PAIRS_ROUTES),
      },
      {
        path: 'market-data',
        data: { breadcrumb: 'Market Data' },
        loadChildren: () => import('@features/market-data/market-data.routes').then(m => m.MARKET_DATA_ROUTES),
      },
      {
        path: 'ml-models',
        data: { breadcrumb: 'ML Models' },
        loadChildren: () => import('@features/ml-models/ml-models.routes').then(m => m.ML_MODELS_ROUTES),
      },
      {
        path: 'backtests',
        data: { breadcrumb: 'Backtesting' },
        loadChildren: () => import('@features/backtests/backtests.routes').then(m => m.BACKTESTS_ROUTES),
      },
      {
        path: 'walk-forward',
        data: { breadcrumb: 'Walk-Forward' },
        loadChildren: () => import('@features/walk-forward/walk-forward.routes').then(m => m.WALK_FORWARD_ROUTES),
      },
      {
        path: 'strategy-ensemble',
        data: { breadcrumb: 'Strategy Ensemble' },
        loadChildren: () => import('@features/strategy-ensemble/strategy-ensemble.routes').then(m => m.STRATEGY_ENSEMBLE_ROUTES),
      },
      {
        path: 'alerts',
        data: { breadcrumb: 'Alerts' },
        loadChildren: () => import('@features/alerts/alerts.routes').then(m => m.ALERTS_ROUTES),
      },
      {
        path: 'execution-quality',
        data: { breadcrumb: 'Execution Quality' },
        loadChildren: () => import('@features/execution-quality/execution-quality.routes').then(m => m.EXECUTION_QUALITY_ROUTES),
      },
      {
        path: 'sentiment',
        data: { breadcrumb: 'Sentiment & Regime' },
        loadChildren: () => import('@features/sentiment/sentiment.routes').then(m => m.SENTIMENT_ROUTES),
      },
      {
        path: 'performance',
        data: { breadcrumb: 'Performance' },
        loadChildren: () => import('@features/performance/performance.routes').then(m => m.PERFORMANCE_ROUTES),
      },
      {
        path: 'drawdown-recovery',
        data: { breadcrumb: 'Drawdown Recovery' },
        loadChildren: () => import('@features/drawdown-recovery/drawdown-recovery.routes').then(m => m.DRAWDOWN_RECOVERY_ROUTES),
      },
      {
        path: 'paper-trading',
        data: { breadcrumb: 'Paper Trading' },
        loadChildren: () => import('@features/paper-trading/paper-trading.routes').then(m => m.PAPER_TRADING_ROUTES),
      },
      {
        path: 'engine-config',
        data: { breadcrumb: 'Engine Config' },
        loadChildren: () => import('@features/engine-config/engine-config.routes').then(m => m.ENGINE_CONFIG_ROUTES),
      },
      {
        path: 'audit-trail',
        data: { breadcrumb: 'Audit Trail' },
        loadChildren: () => import('@features/audit-trail/audit-trail.routes').then(m => m.AUDIT_TRAIL_ROUTES),
      },
      {
        path: 'system-health',
        data: { breadcrumb: 'System Health' },
        loadChildren: () => import('@features/system-health/system-health.routes').then(m => m.SYSTEM_HEALTH_ROUTES),
      },
      { path: '**', redirectTo: 'dashboard' },
    ],
  },
];
