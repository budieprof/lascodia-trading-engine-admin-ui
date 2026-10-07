import { inject } from '@angular/core';
import { ResolveFn, Routes, type UrlMatchResult, type UrlSegment } from '@angular/router';
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
 * `/chart-analysis` and `/chart-analysis/:symbol`, matched by ONE route. As two routes the router
 * took them for two pages: the first symbol picked on a bare `/chart-analysis` moved to the other
 * route, which tore the chart down and built it again — every request of opening the page, for
 * one switch.
 */
export function chartAnalysisUrl(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length > 1) return null;
  return segments.length
    ? { consumed: segments, posParams: { symbol: segments[0] } }
    : { consumed: [] };
}

/**
 * The symbol is a route param rather than only a control so a position, signal
 * or alert elsewhere in the console can deep-link straight to the right chart
 * (`/chart-analysis/EURUSD?tf=60`).
 */
export const CHART_ANALYSIS_ROUTES: Routes = [
  {
    matcher: chartAnalysisUrl,
    component: ChartAnalysisPageComponent,
    resolve: { workspace: workspaceReady },
    // Settled once, when the page opens. A symbol switch changes the URL's symbol, and by default
    // ('paramsChange') that ran the resolver again — the active layout and the layout list re-read
    // on every switch, and the sync's baseline reset under the open page.
    runGuardsAndResolvers: () => false,
  },
];
