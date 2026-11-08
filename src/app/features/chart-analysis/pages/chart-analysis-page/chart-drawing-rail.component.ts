import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { DrawingFavorites } from '../../drawings/drawing-favorites.service';
import { ChartDrawingTools } from './chart-drawing-tools';

/**
 * The left drawing rail: the cursor, one button per tool family with its flyout, magnet, stay-in-drawing, lock, hide and remove.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. US02b: it reads the page's {@link ChartDrawingTools} (the armed tool, magnet, flyouts), which the
 * page provides, and the drawings and favourite tools from their root services — no page slice. Eager change
 * detection as before: it is checked whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-drawing-rail',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent],
  templateUrl: './chart-drawing-rail.component.html',
  styleUrl: './chart-drawing-rail.component.scss',
})
export class ChartDrawingRailComponent {
  protected readonly tools = inject(ChartDrawingTools);
  protected readonly drawings = inject(DrawingStore);
  protected readonly favorites = inject(DrawingFavorites);
}
