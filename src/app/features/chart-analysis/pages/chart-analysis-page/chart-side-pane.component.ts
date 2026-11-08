import { ChangeDetectionStrategy, Component, inject, input, model, output } from '@angular/core';
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
import { ChartPanelsState } from '../../panels/side/chart-panels-state.service';
import type { OrderBookSnapshot } from '../../panels/side/chart-panels.types';
import type { DataWindowSection } from '../../chart/value-providers';
import type {
  NewsArticleView,
  NewsFocusResult,
  NewsPressureLeg,
} from '@features/news-intel/news-intel.types';
import type {
  EconomicImpact,
  UpcomingEconomicEvent,
} from '@core/services/economic-calendar.service';
import type { MarketView } from '../../datafeed/market-status';
import type { InstrumentFacts } from '../../datafeed/instrument-facts';
import { formatResolution } from '../../datafeed/resolution';
import type { ChartAnalysisPageComponent } from './chart-analysis-page.component';
import { ChartSessionStore } from './chart-session-store';

/**
 * The chart's side pane: symbol details, news, the economic calendar, the data window and the docked side panels.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. US02b: what it shows comes in as inputs (the calendar's filters as two-way models), what the operator
 * picks goes out as outputs, the main series from the page's {@link ChartSessionStore} and the open side panel from
 * the (root) ChartPanelsState — no page slice. The Details facts, the event relevance and the replay clip keep the
 * page's own (computed) types. Eager change detection as before: it is checked whenever the page is.
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
  /** US02b: the main series (symbol, timeframe, bars). */
  protected readonly session = inject(ChartSessionStore);
  protected readonly chartPanels = inject(ChartPanelsState);
  protected readonly resolutionLabel = formatResolution;

  /** The page's side pane on screen. */
  readonly sidePane = input.required<'none' | 'details' | 'news' | 'calendar' | 'datawindow'>();
  /** Symbol facts for the Details pane (the page's `details`). */
  readonly details = input.required<ReturnType<ChartAnalysisPageComponent['details']>>();
  readonly marketView = input.required<MarketView>();
  readonly newsFocus = input.required<NewsFocusResult | null>();
  readonly newsLoading = input.required<boolean>();
  readonly articles = input.required<readonly NewsArticleView[]>();
  readonly timezone = input.required<string>();
  readonly calendarCurrencies = input.required<string[]>();
  readonly eventRelevance =
    input.required<ReturnType<ChartAnalysisPageComponent['eventRelevance']>>();
  readonly calendarAll = model.required<boolean>();
  readonly calendarMinImpact = model.required<EconomicImpact>();
  readonly precision = input.required<number>();
  readonly facts = input.required<InstrumentFacts>();
  readonly orderFlowReplayClip =
    input.required<ReturnType<ChartAnalysisPageComponent['orderFlowReplayClip']>>();
  readonly orderFlowSourceId = input.required<string | null>();
  readonly tickReplayBook = input.required<OrderBookSnapshot | null | undefined>();
  readonly dataWindowSections = input.required<readonly DataWindowSection[]>();

  /** A news item tapped: its AI analysis. */
  readonly articleAnalysis = output<NewsArticleView>();
  readonly calendarEventOpened = output<UpcomingEconomicEvent>();
  readonly symbolSelected = output<string>();

  /** Long-press on a news item: the article itself, in a new tab. */
  protected openArticle(a: NewsArticleView): void {
    if (a.url) window.open(a.url, '_blank', 'noopener,noreferrer');
  }

  protected legSummary(leg: NewsPressureLeg | null): string {
    if (!leg) return '—';
    const live = leg.liveShare === null ? '—' : `${Math.round(leg.liveShare * 100)}% live`;
    const stories = `${leg.storyCount} ${leg.storyCount === 1 ? 'story' : 'stories'}`;
    return `${leg.score >= 0 ? '+' : ''}${leg.score.toFixed(2)} · ${stories} · ${live}`;
  }
}
