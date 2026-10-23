import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { canAccessPath } from '@core/auth/can-access.guard';
import type { AccessPath } from '@core/auth/route-access';

import { ORGANISATION_LIFECYCLE_ROUTES } from './lifecycle/lifecycle.routes';

/** The organisation console pages in sidebar order; `/organisation` opens the first one the person may see. */
const PAGES: AccessPath[] = [
  'organisation/terminals',
  'organisation/settings',
  'organisation/risk',
  'organisation/strategies',
  'organisation/alerts',
  'organisation/llm',
  'organisation/branding',
  'organisation/data-export',
  'organisation/close',
];

/**
 * The organisation console (multi-tenancy Phase 7, c7-tenant): what an organisation administers of
 * its own — terminals and their credentials, settings, risk and kill switches, strategy subscriptions,
 * alert channels, LLM usage and key. Every page is gated by its read's key through the route table;
 * actions by their write's key.
 */
export const ORGANISATION_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: () => {
      const auth = inject(AuthService);
      return (
        PAGES.find((p) => auth.canSeePath(`/${p}`))?.slice('organisation/'.length) ?? '/dashboard'
      );
    },
  },
  {
    path: 'terminals',
    canActivate: [canAccessPath('organisation/terminals')],
    data: { breadcrumb: 'Connect a terminal' },
    loadComponent: () =>
      import('./pages/terminals-page.component').then((m) => m.TerminalsPageComponent),
  },
  {
    // The guided connection (engine enterprise onboarding): token, MT5 steps, live progress to the first heartbeat.
    path: 'terminals/connect',
    canActivate: [canAccessPath('organisation/terminals/connect')],
    data: { breadcrumb: 'Guided connection' },
    loadComponent: () =>
      import('./connect/terminal-wizard-page.component').then((m) => m.TerminalWizardPageComponent),
  },
  {
    path: 'settings',
    canActivate: [canAccessPath('organisation/settings')],
    data: { breadcrumb: 'Settings' },
    loadComponent: () =>
      import('./pages/settings-page.component').then((m) => m.SettingsPageComponent),
  },
  {
    path: 'risk',
    canActivate: [canAccessPath('organisation/risk')],
    data: { breadcrumb: 'Risk & kill switches' },
    loadComponent: () => import('./pages/risk-page.component').then((m) => m.RiskPageComponent),
  },
  {
    path: 'strategies',
    canActivate: [canAccessPath('organisation/strategies')],
    data: { breadcrumb: 'Strategy subscriptions' },
    loadComponent: () =>
      import('./pages/subscriptions-page.component').then((m) => m.SubscriptionsPageComponent),
  },
  {
    path: 'alerts',
    canActivate: [canAccessPath('organisation/alerts')],
    data: { breadcrumb: 'Alert channels' },
    loadComponent: () => import('./pages/alerts-page.component').then((m) => m.AlertsPageComponent),
  },
  {
    path: 'llm',
    canActivate: [canAccessPath('organisation/llm')],
    data: { breadcrumb: 'LLM usage & key' },
    loadComponent: () => import('./pages/llm-page.component').then((m) => m.LlmPageComponent),
  },
  // An organisation's life cycle (c7-lifecycle): branding, data export, closing.
  ...ORGANISATION_LIFECYCLE_ROUTES,
];
