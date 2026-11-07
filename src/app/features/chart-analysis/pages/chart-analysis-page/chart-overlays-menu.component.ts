import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { LayerGroupsMenuComponent } from '../../overlays/layer-groups-menu.component';
import { CHART_PAGE } from './chart-page.token';

/**
 * The toolbar's "Chart overlays" menu (volume, trades, events, analysis and order-flow layers, layer groups).
 *
 * U13: a section of the chart page's template split out like the legend and side pane — it renders the page's own
 * state and calls the page's own handlers (`page.…`), so behaviour is exactly as when it was inline. Eager change
 * detection for the same reason: it is checked whenever the page is.
 */
@Component({
  selector: 'app-chart-overlays-menu',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent, LayerGroupsMenuComponent],
  templateUrl: './chart-overlays-menu.component.html',
  styleUrl: './chart-overlays-menu.component.scss',
})
export class ChartOverlaysMenuComponent {
  protected readonly page = inject(CHART_PAGE);
}
