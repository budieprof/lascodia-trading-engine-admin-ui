import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ScriptChipComponent } from '../../scripts/script-chip.component';
import { CHART_PAGE } from './chart-page.token';

/**
 * The active-studies strip under the chart: each Pine script's chip and each indicator with its inline inputs.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. It renders the page's own state and calls the page's own handlers (`page.…`), so
 * behaviour is exactly as when it was inline. Eager change detection for the same reason: it is
 * checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-studies-strip',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent, ScriptChipComponent],
  templateUrl: './chart-studies-strip.component.html',
  styleUrl: './chart-studies-strip.component.scss',
})
export class ChartStudiesStripComponent {
  protected readonly page = inject(CHART_PAGE);
}
