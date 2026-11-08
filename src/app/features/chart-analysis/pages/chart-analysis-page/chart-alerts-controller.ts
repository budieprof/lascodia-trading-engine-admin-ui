import { effect, signal, untracked, type DestroyRef, type ElementRef, type Signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import type { ParamMap } from '@angular/router';
import { map, type Observable } from 'rxjs';

import type { NotificationService } from '@core/notifications/notification.service';
import { AlertLinesPrimitive, type AlertLineMove } from '../../alerts/alert-lines-primitive';
import { alertLinesFor, movedBounds } from '../../alerts/alert-lines-geometry';
import { inputOf } from '../../alerts/chart-alert-rules';
import type { ChartAlertsService } from '../../alerts/chart-alerts.service';
import type { ChartAlertDto } from '../../alerts/chart-alerts.types';
import type { ChartHostComponent } from '../../chart/chart-host.component';
import { drawingAlertDraft } from '../../drawings/drawing-alert';
import type { DrawingStore } from '../../drawings/drawing-store.service';

/** What the chart alerts read on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartAlertsControllerDeps {
  symbol: () => string;
  resolution: () => string;
  logScale: () => boolean;
  precision: () => number;
  host: () => ChartHostComponent | undefined;
  /** The right-clicked price and level (the chart's context menu); closed by an "Add alert" from it. */
  contextMenu: () => { price?: number | null; level?: { price: number } | null } | null;
  closeContextMenu: () => void;
  /** The toolbar's one-open-menu state: the alert form is its `alert` menu. */
  openAlertMenu: () => void;
  closeMenus: () => void;
  toggleAlertMenu: (ev: Event) => void;
  alertMoveDialog: () => ElementRef<HTMLDialogElement> | undefined;
  queryParamMap: Observable<ParamMap>;
  drawings: Pick<DrawingStore, 'allDrawings'>;
  chartAlerts: Pick<ChartAlertsService, 'alerts' | 'ensureLoaded' | 'update'>;
  notify: Pick<NotificationService, 'success' | 'error' | 'warning'>;
  destroyRef: DestroyRef;
}

/**
 * b9-maint — the chart's price alerts (alerts v2: ChartAlert rows the engine evaluates on every tick), moved out of
 * ChartAnalysisPageComponent behaviour for behaviour: the alert form's preset / drawing draft, the alert manager and
 * the alert a bell link asks to show, and the alert lines on the price scale with their drag-to-move confirmation. The
 * template reads it as `alerts`.
 */
export class ChartAlertsController {
  constructor(private readonly deps: ChartAlertsControllerDeps) {}

  /** A level picked on the chart for the alert form (right-click "Add alert at …"); null = 10 points off the live price. */
  readonly alertPreset = signal<number | null>(null);
  /** A drawing's alert the form starts from (DR-I6: "Add alert" on the drawing toolbar); null = a price alert. */
  readonly alertDraft = signal<ChartAlertDto | null>(null);

  openAlertDraft(ev: Event): void {
    this.alertPreset.set(null);
    this.alertDraft.set(null);
    this.deps.toggleAlertMenu(ev);
  }

  /**
   * "Add alert" on a selected line / channel / Fib level (DR-I6): the alert form opens pre-filled with the drawing's
   * anchors (the engine follows the shape bar by bar on this timeframe); nothing is armed until the operator saves.
   */
  addDrawingAlert(e: { id: string; level?: number }): void {
    const d = this.deps.drawings.allDrawings().find((x) => x.id === e.id);
    const draft = d
      ? drawingAlertDraft(d, {
          symbol: this.deps.symbol(),
          timeframe: this.deps.resolution(),
          level: e.level,
          logScale: this.deps.logScale(),
        })
      : null;
    if (!draft) {
      this.deps.notify.error(
        'An alert can watch a line, a channel or a Fib level drawn on the price, with two different times.',
      );
      return;
    }
    this.alertPreset.set(null);
    this.alertDraft.set(draft);
    this.deps.openAlertMenu();
  }

  createAlertAtLevel(ev?: Event): void {
    // The same click would reach the page's (document:click) close-all and shut the popover it opens.
    ev?.stopPropagation();
    const level = this.deps.contextMenu()?.level;
    this.deps.closeContextMenu();
    if (!level || !Number.isFinite(level.price) || level.price <= 0) return;
    this.alertPreset.set(level.price);
    this.alertDraft.set(null);
    this.deps.openAlertMenu();
  }

  // ChartAlert rows evaluated by the engine on every tick (a CROSSING of the price on the alert's side, bid by
  // default), not the old polled PriceLevel rule that compared the mid price every 30 s and fired at once when set at
  // the last close (SP-02/SP-03).

  /**
   * Add an alert at the right-clicked price: opens the alert form at that level. The operator still sees the direction
   * (pre-set to the way price must travel to reach it), the side and the rest before anything is armed.
   */
  createAlertHere(ev?: Event): void {
    // The same click would reach the page's (document:click) close-all and shut the popover it opens.
    ev?.stopPropagation();
    const menu = this.deps.contextMenu();
    this.deps.closeContextMenu();
    const price = menu?.price;
    if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return;
    this.alertPreset.set(price);
    this.alertDraft.set(null);
    this.deps.openAlertMenu();
  }

  /** The form saved an alert. */
  onAlertSaved(): void {
    this.deps.closeMenus();
    const drawing = this.alertDraft() !== null;
    this.alertDraft.set(null);
    this.deps.notify.success(
      drawing
        ? 'Alert set — it fires when price crosses the drawing.'
        : 'Alert set — it fires when price crosses the level.',
    );
  }

  /** The alert manager (right rail) and the alert a bell link asked to show. */
  readonly alertManagerOpen = signal(false);
  readonly alertFocusId = signal<number | null>(null);

  toggleAlertManager(): void {
    if (this.alertManagerOpen()) this.closeAlertManager();
    else this.alertManagerOpen.set(true);
  }

  closeAlertManager(): void {
    this.alertManagerOpen.set(false);
    this.alertFocusId.set(null);
    this.scriptAlertFocusId.set(null);
  }

  /** The alert on a chart script a bell link asked to show (`?scriptAlert=12`, SS-I1). */
  readonly scriptAlertFocusId = signal<number | null>(null);

  /** The price alerts of this symbol as dashed lines; dragging one asks before moving the alert. */
  private readonly alertLines = new AlertLinesPrimitive(
    () => this.deps.precision(),
    (move) => this.askMoveAlert(move),
  );

  /**
   * The bell links (`?scriptAlert=` / `?alert=`) and the alert lines on the price scale. Call ONCE, from a page field
   * initialiser at the place these effects had among the page's own (their order is the page's effect order).
   */
  connect(): { scriptAlertQuery: Signal<string | null>; alertQuery: Signal<string | null> } {
    const d = this.deps;
    const scriptAlertQuery = toSignal(d.queryParamMap.pipe(map((q) => q.get('scriptAlert'))), {
      initialValue: null,
    });
    effect(() => {
      const id = Number(scriptAlertQuery());
      if (!Number.isFinite(id) || id <= 0) return;
      untracked(() => {
        this.scriptAlertFocusId.set(id);
        this.alertManagerOpen.set(true);
      });
    });

    /** `?alert=12` (the bell's link to a fired chart alert): open the manager on it. */
    const alertQuery = toSignal(d.queryParamMap.pipe(map((q) => q.get('alert'))), {
      initialValue: null,
    });
    effect(() => {
      const id = Number(alertQuery());
      if (!Number.isFinite(id) || id <= 0) return;
      untracked(() => {
        this.alertFocusId.set(id);
        this.alertManagerOpen.set(true);
      });
    });

    effect((onCleanup) => {
      const host = d.host();
      if (!host) return;
      untracked(() => d.chartAlerts.ensureLoaded());
      onCleanup(host.attachPricePrimitive(this.alertLines));
    });
    effect(() =>
      this.alertLines.setLines(alertLinesFor(d.chartAlerts.alerts(), d.symbol(), d.precision())),
    );
    return { scriptAlertQuery, alertQuery };
  }

  readonly pendingAlertMove = signal<{
    alertId: number;
    label: string;
    from: number;
    to: number;
    move: AlertLineMove;
  } | null>(null);

  private askMoveAlert(move: AlertLineMove): void {
    const alert = this.deps.chartAlerts.alerts().find((a) => a.id === move.line.alertId);
    if (!alert) return;
    if (!movedBounds(alert, move.line.bound, move.price)) {
      this.deps.notify.warning('The upper level of a channel must stay above its lower level.');
      return;
    }
    this.pendingAlertMove.set({
      alertId: alert.id,
      label: alert.name || alert.symbol,
      from: move.line.price,
      to: move.price,
      move,
    });
    this.deps.alertMoveDialog()?.nativeElement.showModal();
  }

  confirmAlertMove(): void {
    const d = this.deps;
    const pending = this.pendingAlertMove();
    d.alertMoveDialog()?.nativeElement.close();
    const alert = pending ? d.chartAlerts.alerts().find((a) => a.id === pending.alertId) : null;
    if (!pending || !alert) return;
    const bounds = movedBounds(alert, pending.move.line.bound, pending.to);
    if (!bounds) return;
    d.chartAlerts
      .update(alert.id, { ...inputOf(alert), price: bounds.price, upperPrice: bounds.upperPrice })
      .pipe(takeUntilDestroyed(d.destroyRef))
      .subscribe({
        next: (res) =>
          res?.status
            ? d.notify.success('Alert moved.')
            : d.notify.error(res?.message || 'The alert could not be moved.'),
        error: () => d.notify.error('The alert could not be moved — the engine did not answer.'),
      });
  }
}
