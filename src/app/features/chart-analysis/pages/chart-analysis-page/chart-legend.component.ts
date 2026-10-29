import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ScriptStatusLineComponent } from '../../scripts/script-status-line.component';
import { MeasuredBottomDirective } from '../../chart/measured-bottom.directive';
import { DecimalPipe } from '@angular/common';
import { CHART_PAGE } from './chart-page.token';

/**
 * The floating legend over the main chart: symbol, interval and market status, OHLC, indicator values, compare series and overlay scripts' status lines.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. It renders the page's own state and calls the page's own handlers (`page.…`), so
 * behaviour is exactly as when it was inline. Eager change detection for the same reason: it is
 * checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-legend',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent, ScriptStatusLineComponent, MeasuredBottomDirective, DecimalPipe],
  templateUrl: './chart-legend.component.html',
  styleUrl: './chart-legend.component.scss',
})
export class ChartLegendComponent {
  protected readonly page = inject(CHART_PAGE);
}
