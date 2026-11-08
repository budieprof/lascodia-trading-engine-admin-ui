import { ChangeDetectionStrategy, Component, inject, input, model, output } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { ChartAlertsService } from '../../alerts/chart-alerts.service';
import { DrawingStore } from '../../drawings/drawing-store.service';
import { ChartPanelsState } from '../../panels/side/chart-panels-state.service';
import type { SidePanel } from '../../panels/side/chart-panels.types';

/** The page's side panes the strip opens (one at a time; the same button again closes it). */
export type StripSidePane = 'details' | 'news' | 'calendar' | 'datawindow';

/**
 * The right-hand strip of panel buttons: watchlist, alerts, object tree, details, news, data window and the side panels.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. US02b: it takes the page's open/closed state as inputs (the watchlist and the object tree as two-way
 * models) and asks the page to open a pane or panel through outputs; the panel, drawing and alert counts come
 * from their own (root) services. Eager change detection as before: it is checked whenever the page is.
 */
@Component({
  selector: 'app-chart-panel-strip',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent],
  templateUrl: './chart-panel-strip.component.html',
  styleUrl: './chart-panel-strip.component.scss',
})
export class ChartPanelStripComponent {
  protected readonly chartPanels = inject(ChartPanelsState);
  protected readonly drawings = inject(DrawingStore);
  protected readonly chartAlerts = inject(ChartAlertsService);

  readonly watchlistOpen = model.required<boolean>();
  readonly objectTreeOpen = model.required<boolean>();
  /** The page's side pane on screen ('none' when closed). */
  readonly sidePane = input.required<StripSidePane | 'none'>();
  readonly alertManagerOpen = input.required<boolean>();
  /** The symbol is exchange-traded (futures / crypto / equity): the Fundamentals panel applies. */
  readonly showFundamentals = input.required<boolean>();

  readonly sidePaneToggle = output<StripSidePane>();
  readonly panelToggle = output<SidePanel>();
  readonly alertManagerToggle = output<void>();
}
