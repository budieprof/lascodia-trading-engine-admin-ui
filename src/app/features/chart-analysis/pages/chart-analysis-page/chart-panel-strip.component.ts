import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { CHART_PAGE } from './chart-page.token';

/**
 * The right-hand strip of panel buttons: watchlist, alerts, object tree, details, news, data window and the side panels.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. It renders the page's own state and calls the page's own handlers (`page.…`), so
 * behaviour is exactly as when it was inline. Eager change detection for the same reason: it is
 * checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-panel-strip',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent],
  templateUrl: './chart-panel-strip.component.html',
  styleUrl: './chart-panel-strip.component.scss',
})
export class ChartPanelStripComponent {
  protected readonly page = inject(CHART_PAGE);
}
