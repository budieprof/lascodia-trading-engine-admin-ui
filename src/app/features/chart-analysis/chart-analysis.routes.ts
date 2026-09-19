import { Routes } from '@angular/router';
import { ChartAnalysisPageComponent } from './pages/chart-analysis-page/chart-analysis-page.component';

/**
 * `/chart-analysis` and `/chart-analysis/:symbol`.
 *
 * The symbol is a route param rather than only a control so a position, signal
 * or alert elsewhere in the console can deep-link straight to the right chart
 * (`/chart-analysis/EURUSD?tf=60`).
 */
export const CHART_ANALYSIS_ROUTES: Routes = [
  { path: '', component: ChartAnalysisPageComponent },
  { path: ':symbol', component: ChartAnalysisPageComponent },
];
