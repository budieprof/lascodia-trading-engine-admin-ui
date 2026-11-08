import { ChangeDetectionStrategy, Component, inject, input, model, output } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { LayerGroupsMenuComponent } from '../../overlays/layer-groups-menu.component';
import type { MdSource } from '@core/realtime/marketdata.types';
import type { AutoAnalysisSettings } from '../../overlays/auto-analysis';
import type { VolumeProfileMode } from '../../overlays/analysis-overlays';
import type { OrderFlowFeed } from '../../orderflow/orderflow-feed';
import { ChartOverlaySettings } from './chart-overlay-settings';

/** One auto-analysis layer as the menu lists it. */
export interface AutoAnalysisLayer {
  id: keyof AutoAnalysisSettings;
  label: string;
  hint: string;
}

/**
 * The toolbar's "Chart overlays" menu (volume, trades, events, analysis and order-flow layers, layer groups).
 *
 * U13: a section of the chart page's template split out like the legend and side pane. US02b: the layout-saved
 * overlay settings are read and changed on the page's {@link ChartOverlaySettings} (provided by the page); what the
 * page derives (counts, the blackout title, the delta study, auto analysis, the order-flow sources) comes in as
 * inputs, volume / session breaks / the trade timeline as two-way models, and the actions with side effects of the
 * page's (events reload, studies, auto-analysis preference, the menu itself) go out as outputs — no page slice.
 * Eager change detection as before: it is checked whenever the page is.
 */
@Component({
  selector: 'app-chart-overlays-menu',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent, LayerGroupsMenuComponent],
  templateUrl: './chart-overlays-menu.component.html',
  styleUrl: './chart-overlays-menu.component.scss',
})
export class ChartOverlaysMenuComponent {
  protected readonly overlays = inject(ChartOverlaySettings);

  /** The menu is open (the page's toolbar menu is 'overlays'). */
  readonly open = input.required<boolean>();
  readonly overlayCount = input.required<number>();
  readonly showVolume = model.required<boolean>();
  readonly sessionBreaks = model.required<boolean>();
  readonly showTradeTimeline = model.required<boolean>();
  readonly tradeTimelineInfo = input.required<string | null>();
  readonly blackoutTitle = input.required<string>();
  readonly deltaOn = input.required<boolean>();
  readonly autoAnalysis = input.required<AutoAnalysisSettings>();
  readonly autoAnalysisOn = input.required<boolean>();
  readonly autoAnalysisLayers = input.required<readonly AutoAnalysisLayer[]>();
  readonly footprintRowUnit = input.required<'points' | 'ticks'>();
  readonly footprintRowChoices =
    input.required<readonly { label: string; points: number | null; hint: string }[]>();
  /** The market-data sources the order-flow layers may read, and why one is refused. */
  readonly orderFlowFeed = input.required<Pick<OrderFlowFeed, 'mdSources' | 'sourceNotEntitled'>>();
  /** Multibook: the sources the consolidated heatmap may combine. */
  readonly consolidatableSources = input.required<readonly MdSource[]>();

  readonly menuToggle = output<Event>();
  readonly eventsToggle = output<void>();
  readonly eventImpactCycle = output<void>();
  readonly deltaToggle = output<void>();
  readonly autoAnalysisToggle = output<void>();
  readonly autoLayerToggle = output<keyof AutoAnalysisSettings>();
  readonly scorecard = output<void>();
  readonly volumeProfileModePick = output<VolumeProfileMode>();
  readonly consolidatedSourceToggle = output<string>();
}
