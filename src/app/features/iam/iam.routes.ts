import { inject } from '@angular/core';
import { Routes } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { canAccessPath } from '@core/auth/can-access.guard';
import type { AccessPath } from '@core/auth/route-access';

/** The organisation pages in sidebar order; `/iam` opens the first one the person may see. */
const PAGES: AccessPath[] = [
  'iam/members',
  'iam/invitations',
  'iam/roles',
  'iam/grants',
  'iam/teams',
  'iam/account-groups',
  'iam/security',
  'iam/sso',
  'iam/approvals',
  'iam/access-review',
  'iam/plan',
];

/**
 * Organisation administration (U3.4, contracts C3.4/C3.5). Every page is gated by its key through
 * the route table; the parent `iam` route (app.routes) needs any of them and BFF sign-in.
 */
export const IAM_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: () => {
      const auth = inject(AuthService);
      return PAGES.find((p) => auth.canSeePath(`/${p}`))?.slice('iam/'.length) ?? '/dashboard';
    },
  },
  {
    path: 'members',
    canActivate: [canAccessPath('iam/members')],
    data: { breadcrumb: 'Members' },
    loadComponent: () =>
      import('./pages/members-page.component').then((m) => m.MembersPageComponent),
  },
  {
    path: 'invitations',
    canActivate: [canAccessPath('iam/invitations')],
    data: { breadcrumb: 'Invitations' },
    loadComponent: () =>
      import('./pages/invitations-page.component').then((m) => m.InvitationsPageComponent),
  },
  {
    path: 'roles',
    canActivate: [canAccessPath('iam/roles')],
    data: { breadcrumb: 'Roles' },
    loadComponent: () =>
      import('./pages/roles-page.component').then((m) => m.IamRolesPageComponent),
  },
  {
    path: 'grants',
    canActivate: [canAccessPath('iam/grants')],
    data: { breadcrumb: 'Access grants' },
    loadComponent: () => import('./pages/grants-page.component').then((m) => m.GrantsPageComponent),
  },
  {
    path: 'teams',
    canActivate: [canAccessPath('iam/teams')],
    data: { breadcrumb: 'Teams', groupKind: 'team' },
    loadComponent: () => import('./pages/groups-page.component').then((m) => m.GroupsPageComponent),
  },
  {
    path: 'account-groups',
    canActivate: [canAccessPath('iam/account-groups')],
    data: { breadcrumb: 'Account groups', groupKind: 'account-group' },
    loadComponent: () => import('./pages/groups-page.component').then((m) => m.GroupsPageComponent),
  },
  {
    path: 'security',
    canActivate: [canAccessPath('iam/security')],
    data: { breadcrumb: 'Security policy' },
    loadComponent: () =>
      import('./pages/security-policy-page.component').then((m) => m.SecurityPolicyPageComponent),
  },
  {
    path: 'sso',
    canActivate: [canAccessPath('iam/sso')],
    data: { breadcrumb: 'Single sign-on' },
    loadComponent: () => import('./pages/sso-page.component').then((m) => m.SsoPageComponent),
  },
  {
    path: 'approvals',
    canActivate: [canAccessPath('iam/approvals')],
    data: { breadcrumb: 'Approvals' },
    loadComponent: () =>
      import('./pages/approvals-page.component').then((m) => m.ApprovalsPageComponent),
  },
  {
    path: 'access-review',
    canActivate: [canAccessPath('iam/access-review')],
    data: { breadcrumb: 'Access review' },
    loadComponent: () =>
      import('./pages/access-review-page.component').then((m) => m.AccessReviewPageComponent),
  },
  {
    // The organisation's plan and usage (multi-tenancy Phase 7).
    path: 'plan',
    canActivate: [canAccessPath('iam/plan')],
    data: { breadcrumb: 'Plan & usage' },
    loadComponent: () => import('./pages/plan-page.component').then((m) => m.PlanPageComponent),
  },
];
