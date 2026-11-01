import { Routes } from '@angular/router';

import { canAccessPath } from '@core/auth/can-access.guard';

/** Execution algorithms and block allocation (gaps program, execution). */
export const EXECUTION_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'algo-orders' },
  {
    path: 'algo-orders',
    canActivate: [canAccessPath('execution/algo-orders')],
    data: { breadcrumb: 'Algorithmic orders' },
    loadComponent: () => import('./pages/algo-orders-page.component').then((m) => m.AlgoOrdersPageComponent),
  },
  {
    path: 'algo-orders/:id',
    canActivate: [canAccessPath('execution/algo-orders')],
    data: { breadcrumb: 'Algorithmic order' },
    loadComponent: () => import('./pages/algo-order-detail-page.component').then((m) => m.AlgoOrderDetailPageComponent),
  },
  {
    path: 'settings',
    canActivate: [canAccessPath('execution/settings')],
    data: { breadcrumb: 'Settings' },
    loadComponent: () => import('./pages/execution-settings-page.component').then((m) => m.ExecutionSettingsPageComponent),
  },
  {
    path: 'allocation-groups',
    canActivate: [canAccessPath('execution/allocation-groups')],
    data: { breadcrumb: 'Allocation groups' },
    loadComponent: () => import('./pages/allocation-groups-page.component').then((m) => m.AllocationGroupsPageComponent),
  },
  {
    path: 'blocks/:id',
    canActivate: [canAccessPath('execution/allocation-groups')],
    data: { breadcrumb: 'Block order' },
    loadComponent: () => import('./pages/block-order-page.component').then((m) => m.BlockOrderPageComponent),
  },
];
