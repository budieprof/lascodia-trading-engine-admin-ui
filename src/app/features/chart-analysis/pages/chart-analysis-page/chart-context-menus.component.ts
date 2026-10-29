import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingSettingsDialogComponent } from '../../drawings/ui/drawing-settings-dialog.component';
import { DecimalPipe } from '@angular/common';
import { CHART_PAGE } from './chart-page.token';

/**
 * The chart's right-click menus — on a drawing and on the chart — and the drawing settings dialog they open.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. It renders the page's own state and calls the page's own handlers (`page.…`), so
 * behaviour is exactly as when it was inline. Eager change detection for the same reason: it is
 * checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-context-menus',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent, DrawingSettingsDialogComponent, DecimalPipe],
  templateUrl: './chart-context-menus.component.html',
  styleUrl: './chart-context-menus.component.scss',
})
export class ChartContextMenusComponent {
  protected readonly page = inject(CHART_PAGE);
}
