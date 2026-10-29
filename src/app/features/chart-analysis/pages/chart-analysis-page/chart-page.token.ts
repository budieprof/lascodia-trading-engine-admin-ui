import { InjectionToken } from '@angular/core';
import type { ChartAnalysisPageComponent } from './chart-analysis-page.component';

/**
 * The chart page itself, for the components that render sections of its template (drawing rail,
 * panel strip, legend, context menus, side pane, studies strip). Provided by the page.
 */
export const CHART_PAGE = new InjectionToken<ChartAnalysisPageComponent>('CHART_PAGE');
