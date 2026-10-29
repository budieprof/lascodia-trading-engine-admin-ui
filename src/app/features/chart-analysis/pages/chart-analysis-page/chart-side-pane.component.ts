import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ChartPanelsDockComponent } from '../../panels/side/chart-panels-dock.component';
import { DataWindowComponent } from '../../chart/data-window.component';
import { EconomicCalendarPaneComponent } from '../../panels/economic-calendar-pane.component';
import { PerformanceTilesComponent } from '../../panels/performance-tiles.component';
import { SeasonalsComponent } from '../../panels/seasonals.component';
import { TechnicalsGaugeComponent } from '../../panels/technicals-gauge.component';
import { LongPressDirective } from '../../panels/long-press.directive';
import { ArticleFlagsPipe } from '../../panels/news-pane';
import { ZonedDatePipe } from '../../panels/zoned-time';
import { DecimalPipe } from '@angular/common';
import { CHART_PAGE } from './chart-page.token';

/**
 * The chart's side pane: symbol details, news, the economic calendar, the data window and the docked side panels.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. It renders the page's own state and calls the page's own handlers (`page.…`), so
 * behaviour is exactly as when it was inline. Eager change detection for the same reason: it is
 * checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-side-pane',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [
    ChartIconComponent,
    ChartPanelsDockComponent,
    DataWindowComponent,
    EconomicCalendarPaneComponent,
    PerformanceTilesComponent,
    SeasonalsComponent,
    TechnicalsGaugeComponent,
    LongPressDirective,
    ArticleFlagsPipe,
    ZonedDatePipe,
    DecimalPipe,
  ],
  templateUrl: './chart-side-pane.component.html',
  styleUrl: './chart-side-pane.component.scss',
})
export class ChartSidePaneComponent {
  protected readonly page = inject(CHART_PAGE);
}
