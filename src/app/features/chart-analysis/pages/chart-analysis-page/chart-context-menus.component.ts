import { ChangeDetectionStrategy, Component, inject, input, model, output } from '@angular/core';
import { ChartIconComponent } from '../../icons/chart-icon.component';
import { DrawingSettingsDialogComponent } from '../../drawings/ui/drawing-settings-dialog.component';
import { DecimalPipe } from '@angular/common';
import { DrawingStore } from '../../drawings/drawing-store.service';
import type { Drawing } from '../../drawings/model';
import type { ZOrderOp } from '../../drawings/drawing-ops';
import type { ScaleMode } from '../../chart/chart-host.component';
import type { AlertableLevel } from '../../overlays/overlay-hits';
import { SUPPORTED_RESOLUTIONS } from '../../datafeed/resolution';

/** The chart's right-click menu: where it opened and the price (or derived level) under the click. */
export interface ChartContextMenuState {
  x: number;
  y: number;
  price: number | null;
  /** A derived level under the click (PR-7): its alert is offered at the level's exact price. */
  level?: AlertableLevel | null;
}

/** What a drawing's right-click menu can do to it. */
export type DrawingMenuAction =
  | 'settings'
  | 'clone'
  | 'copy'
  | 'hide'
  | 'lock'
  | 'remove'
  | ZOrderOp;

/**
 * The chart's right-click menus — on a drawing and on the chart — and the drawing settings dialog they open.
 *
 * A section of the chart page's template, split out so each stylesheet stays within the component
 * style budget. US02b: the menus' state comes in as inputs (the scale options, the countdown and the open drawing
 * settings as two-way models) and every command goes out as an output the page binds to its existing handler — no
 * page slice; drawings are read from the (root) DrawingStore. Eager change detection as before: it is checked
 * whenever the page is, as the inline markup was.
 */
@Component({
  selector: 'app-chart-context-menus',
  changeDetection: ChangeDetectionStrategy.Eager,
  imports: [ChartIconComponent, DrawingSettingsDialogComponent, DecimalPipe],
  templateUrl: './chart-context-menus.component.html',
  styleUrl: './chart-context-menus.component.scss',
})
export class ChartContextMenusComponent {
  protected readonly drawings = inject(DrawingStore);
  protected readonly resolutions = SUPPORTED_RESOLUTIONS;

  /** The drawing whose menu is open and where. */
  readonly drawingMenu = input.required<{ id: string; x: number; y: number } | null>();
  readonly contextMenu = input.required<ChartContextMenuState | null>();
  readonly precision = input.required<number>();
  /** The drawing whose Settings dialog is open. */
  readonly settingsFor = model.required<string | null>();
  readonly invertScale = model.required<boolean>();
  readonly scaleMode = model.required<ScaleMode>();
  readonly scaleSide = model.required<'right' | 'left'>();
  readonly showCountdown = model.required<boolean>();

  readonly drawingAction = output<{ id: string; action: DrawingMenuAction }>();
  /** Close the chart menu (after a toggle). */
  readonly closeMenu = output<void>();
  readonly resetScales = output<void>();
  readonly chartSettings = output<void>();
  readonly commands = output<void>();
  readonly saveImage = output<void>();
  readonly copyImage = output<void>();
  readonly exportData = output<void>();
  readonly showObjects = output<void>();
  readonly addIndicator = output<void>();
  readonly alertAtLevel = output<Event>();
  readonly alertHere = output<Event>();
  readonly saveLayoutAs = output<void>();
  readonly removeAllDrawings = output<void>();

  protected drawingById(id: string): Drawing | undefined {
    return this.drawings.allDrawings().find((d) => d.id === id);
  }

  protected act(id: string, action: DrawingMenuAction): void {
    this.drawingAction.emit({ id, action });
  }
}
