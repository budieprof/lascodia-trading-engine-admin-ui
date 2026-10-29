import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { CHART_PAGE } from './chart-page.token';

/**
 * The left drawing rail: the cursor, one button per tool family with its flyout, magnet, stay-in-drawing, lock, hide and remove.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. It renders the page's own state and calls the page's own handlers (`page.…`), so
 * behaviour is exactly as when it was inline. Eager change detection for the same reason: it is
 * checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-drawing-rail',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent],
  templateUrl: './chart-drawing-rail.component.html',
  styleUrl: './chart-drawing-rail.component.scss',
})
export class ChartDrawingRailComponent {
  protected readonly page = inject(CHART_PAGE);
}
