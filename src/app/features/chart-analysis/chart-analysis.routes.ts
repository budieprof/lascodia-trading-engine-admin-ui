import { inject } from '@angular/core';
import { ResolveFn, Routes } from '@angular/router';
import { ChartAnalysisPageComponent } from './pages/chart-analysis-page/chart-analysis-page.component';
import { ChartPrefsService } from './workspace/chart-prefs.service';
import { ChartWorkspaceSync } from './workspace/workspace-sync.service';

/**
 * The engine's chart preferences and the active layout are settled before the page renders, so
 * the chart opens as it was left — on any browser or machine — instead of on defaults that then
 * jump. Never fails: offline, the local copies serve (each call times out on its own).
 */
const workspaceReady: ResolveFn<boolean> = async () => {
  await Promise.all([inject(ChartPrefsService).hydrate(), inject(ChartWorkspaceSync).load()]);
  return true;
};

/**
 * `/chart-analysis` and `/chart-analysis/:symbol`.
 *
 * The symbol is a route param rather than only a control so a position, signal
 * or alert elsewhere in the console can deep-link straight to the right chart
 * (`/chart-analysis/EURUSD?tf=60`).
 */
export const CHART_ANALYSIS_ROUTES: Routes = [
  { path: '', component: ChartAnalysisPageComponent, resolve: { workspace: workspaceReady } },
  {
    path: ':symbol',
    component: ChartAnalysisPageComponent,
    resolve: { workspace: workspaceReady },
  },
];
