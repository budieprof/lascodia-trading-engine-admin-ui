import { Routes } from '@angular/router';

/** `/pine-chart-lab` — the Pine chart on fixtures or a live run (see PineChartLabPage). */
export const PINE_CHART_LAB_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pine-chart-lab.page').then((m) => m.PineChartLabPage),
  },
];
