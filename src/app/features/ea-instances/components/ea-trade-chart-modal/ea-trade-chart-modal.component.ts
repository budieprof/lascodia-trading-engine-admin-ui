import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
  ViewEncapsulation,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsModule } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import type { CandleDto, Timeframe } from '@core/api/api.types';

/**
 * Phase-6 trade chart modal — shared by the EA Positions and Pending Orders
 * panels.  Operators click a row, this component fetches candles centred on
 * the trade's reference time, and renders a candlestick chart with horizontal
 * markLines for entry/trigger, stop-loss, take-profit, and current price.
 *
 * Modelled after the Signal Sensitivity Analysis chart (same ECharts
 * candlestick + reference-line pattern) but stripped of scenario sweeps —
 * positions and pending orders carry exactly one set of levels each, so the
 * dashed scenario lines are dead weight here.
 *
 * Inputs are shaped to accept either origin:
 *   - Open position  → referenceLabel='ENTRY',  exitPrice=null,   currentPrice=set
 *   - Pending order  → referenceLabel='TRIGGER',exitPrice=null,   currentPrice=null
 *   - Closed trade   → referenceLabel='ENTRY',  exitPrice=set,    currentPrice=null
 */
export interface TradeChartSelection {
  /** Human-readable title shown in the modal header. */
  title: string;
  /** Engine symbol (e.g. "EURUSD"). */
  symbol: string;
  /** "Buy" / "Sell" — controls SL/TP polarity and entry-zone colour. */
  direction: 'Buy' | 'Sell';
  /** The price the trade hangs off (fill price for positions, trigger for pending). */
  referencePrice: number;
  /** When the reference is anchored — fill time / placed time / opened time. */
  referenceTime: string;
  /** Label shown on the reference horizontal line ("ENTRY", "TRIGGER", etc.). */
  referenceLabel: string;
  /** SL price or null when not set. */
  stopLoss: number | null;
  /** TP price or null when not set. */
  takeProfit: number | null;
  /** Current market price (positions only) — drawn as a separate horizontal line. */
  currentPrice: number | null;
  /** Optional exit dot (rare here; included for parity with sensitivity chart). */
  exitPrice: number | null;
  exitTime: string | null;
  /** When the signal fired (ISO) — used with {@link orderPlacedAt} to show the
   *  signal → order placement latency. Both null until the timing fetch returns. */
  signalAt?: string | null;
  /** When the opening order was placed (ISO). */
  orderPlacedAt?: string | null;
  /**
   * Optional destructive action footer.  When present the modal renders a
   * primary action button beneath the chart with an inline confirm step.
   * The parent panel handles the actual service call when `actionConfirmed`
   * fires — the modal stays UI-only so the chart component doesn't need
   * to depend on PositionsService / OrdersService.
   */
  action: {
    label: string; // e.g. "Close position"
    confirmLabel: string; // e.g. "Confirm close"
    description: string; // e.g. "Closes at the live mid-price ..."
    busyLabel: string; // e.g. "Closing…"
  } | null;
}

@Component({
  selector: 'app-ea-trade-chart-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ::backdrop on a top-layer <dialog> isn't reachable through Angular's
  // emulated style scoping — same workaround as the control panel.
  encapsulation: ViewEncapsulation.None,
  imports: [CommonModule, NgxEchartsModule],
  template: `
    <dialog
      #dialog
      class="trade-chart-dialog"
      (close)="onDialogClose()"
      (cancel)="$event.preventDefault(); close()"
    >
      <div class="modal" role="dialog" aria-modal="true">
        <header class="modal-head">
          <div class="head-left">
            <h2>{{ selection?.title ?? 'Trade chart' }}</h2>
            @if (selection; as s) {
              <p class="modal-sub">
                {{ s.symbol }} · {{ s.direction }} ·
                <span class="ref-label">{{ s.referenceLabel }}</span>
                {{ s.referencePrice | number: '1.5-5' }}
                @if (s.referenceTime) {
                  · {{ s.referenceTime | date: 'medium' }}
                }
              </p>
              @if (signalToOrderLabel(); as lat) {
                <p
                  class="modal-sub latency"
                  [title]="
                    'Signal fired ' +
                    (s.signalAt | date: 'medium') +
                    ' → order placed ' +
                    (s.orderPlacedAt | date: 'medium')
                  "
                >
                  ⏱ Signal → order placed: <strong>{{ lat }}</strong>
                </p>
              }
            }
          </div>
          <div class="head-right">
            <div class="tf-toolbar" role="group" aria-label="Timeframe">
              @for (tf of timeframes; track tf) {
                <button
                  type="button"
                  class="tf-btn"
                  [class.tf-btn--active]="selectedTimeframe() === tf"
                  (click)="setTimeframe(tf)"
                >
                  {{ tf }}
                </button>
              }
            </div>
            <button type="button" class="modal-close" (click)="close()" aria-label="Close">
              ×
            </button>
          </div>
        </header>

        <div class="modal-body">
          @if (loading()) {
            <div class="status">Loading candles…</div>
          } @else if (errorMsg()) {
            <div class="status error">{{ errorMsg() }}</div>
          } @else if (chartOptions(); as opts) {
            <div echarts [options]="opts" [autoResize]="true" class="chart-instance"></div>
            <div class="chart-legend">
              <span class="legend-item">
                <span class="dot dot--entry"></span>
                {{ selection?.referenceLabel }} {{ selection?.referencePrice | number: '1.5-5' }}
              </span>
              @if (selection?.stopLoss !== null) {
                <span class="legend-item">
                  <span class="dot dot--sl"></span>SL {{ selection!.stopLoss | number: '1.5-5' }}
                </span>
              }
              @if (selection?.takeProfit !== null) {
                <span class="legend-item">
                  <span class="dot dot--tp"></span>TP {{ selection!.takeProfit | number: '1.5-5' }}
                </span>
              }
              @if (selection?.currentPrice !== null) {
                <span class="legend-item">
                  <span class="dot dot--now"></span>Now
                  {{ selection!.currentPrice | number: '1.5-5' }}
                </span>
              }
              @if (selection?.exitPrice !== null) {
                <span class="legend-item">
                  <span class="dot dot--exit"></span>Exit
                  {{ selection!.exitPrice | number: '1.5-5' }}
                </span>
              }
            </div>
          } @else {
            <div class="status">No data.</div>
          }
        </div>

        @if (selection?.action; as act) {
          <footer class="modal-foot">
            <p class="action-desc">{{ act.description }}</p>
            <div class="action-row">
              <button type="button" class="btn btn-secondary" (click)="close()" [disabled]="busy">
                Close
              </button>
              @if (!confirmArmed()) {
                <button
                  type="button"
                  class="btn btn-danger"
                  (click)="armConfirm()"
                  [disabled]="busy"
                >
                  {{ act.label }}
                </button>
              } @else {
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="disarmConfirm()"
                  [disabled]="busy"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn-danger btn-danger--armed"
                  (click)="confirmAction()"
                  [disabled]="busy"
                >
                  @if (busy) {
                    {{ act.busyLabel }}
                  } @else {
                    {{ act.confirmLabel }}
                  }
                </button>
              }
            </div>
          </footer>
        }
      </div>
    </dialog>
  `,
  styles: [
    `
      .trade-chart-dialog {
        position: fixed;
        inset: 0;
        margin: auto;
        width: min(92vw, 1100px);
        max-height: 90vh;
        padding: 0;
        border: none;
        border-radius: var(--radius-lg);
        background: var(--bg-secondary);
        color: var(--text-primary);
        overflow: hidden;
      }
      .trade-chart-dialog::backdrop {
        background: color-mix(in srgb, #000 55%, transparent);
        backdrop-filter: blur(2px);
      }
      .modal {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .modal-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .head-left h2 {
        margin: 0;
        font-size: var(--text-md);
        font-weight: var(--font-semibold);
      }
      .modal-sub {
        margin: 4px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .ref-label {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .modal-sub.latency {
        margin-top: 2px;
        color: var(--text-tertiary);
      }
      .modal-sub.latency strong {
        color: var(--accent, #0071e3);
        font-variant-numeric: tabular-nums;
      }
      .head-right {
        display: inline-flex;
        align-items: center;
        gap: var(--space-3);
      }
      .tf-toolbar {
        display: inline-flex;
        gap: 2px;
        background: var(--bg-tertiary);
        padding: 3px;
        border-radius: var(--radius-sm);
      }
      .tf-btn {
        padding: 4px 10px;
        background: transparent;
        border: none;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        border-radius: 4px;
      }
      .tf-btn:hover {
        color: var(--text-primary);
      }
      .tf-btn--active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .modal-close {
        width: 32px;
        height: 32px;
        font-size: 22px;
        line-height: 1;
        background: transparent;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        border-radius: var(--radius-sm);
      }
      .modal-close:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .modal-body {
        flex: 1;
        padding: var(--space-4) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-height: 0;
      }
      .chart-instance {
        flex: 1;
        min-height: 360px;
        height: 60vh;
      }
      .chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        padding: var(--space-2) 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        display: inline-block;
      }
      .dot--entry {
        background: #000;
      }
      .dot--sl {
        background: #c4290a;
      }
      .dot--tp {
        background: #1f8a3d;
      }
      .dot--now {
        background: #0071e3;
      }
      .dot--exit {
        background: #5e5ce6;
      }
      .status {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-secondary);
        min-height: 360px;
      }
      .status.error {
        color: #c4290a;
      }
      .modal-foot {
        padding: var(--space-3) var(--space-5) var(--space-4);
        border-top: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .action-desc {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .action-row {
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
      }
      .btn {
        height: 34px;
        padding: 0 16px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .btn-secondary {
        background: var(--bg-primary);
        border-color: var(--border);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn-danger {
        background: #c4290a;
        color: #fff;
      }
      .btn-danger:hover:not(:disabled) {
        background: #a72207;
      }
      .btn-danger--armed {
        animation: ui-confirm-pulse 1.4s ease-in-out infinite;
      }
      @keyframes ui-confirm-pulse {
        0%,
        100% {
          box-shadow: 0 0 0 0 rgba(196, 41, 10, 0.4);
        }
        50% {
          box-shadow: 0 0 0 6px rgba(196, 41, 10, 0);
        }
      }
    `,
  ],
})
export class EATradeChartModalComponent implements OnChanges, OnDestroy, AfterViewInit {
  @Input() selection: TradeChartSelection | null = null;
  @Input() open = false;
  /**
   * Emits `false` whenever the dialog closes — via the × button, the Esc
   * key (browser-native dialog cancel event), or click-outside.  The
   * parent panel binds this to its `chartOpen` signal so reopening the
   * dialog after a close works: without the emit, the parent's signal
   * stays `true` while our `open` input drifts to `false`, and the next
   * `chartOpen.set(true)` is a no-op (same-value), so ngOnChanges never
   * fires for `open` and `openDialog()` is never called.
   */
  @Output() readonly openChange = new EventEmitter<boolean>();
  /**
   * Fired after the user clicks through the inline confirm step on a
   * destructive action (close position / cancel order).  The parent panel
   * routes this to its respective service call.  The modal stays open
   * until the parent flips `[busy]` back to false and then closes us.
   */
  @Output() readonly actionConfirmed = new EventEmitter<void>();
  /** Set by the parent while the service call is in flight to disable inputs. */
  @Input() busy = false;

  @ViewChild('dialog') dialogRef!: ElementRef<HTMLDialogElement>;

  protected readonly timeframes: readonly Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
  protected readonly selectedTimeframe = signal<Timeframe>('M5');
  protected readonly candles = signal<CandleDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly errorMsg = signal<string | null>(null);
  /**
   * Two-stage confirm for the destructive action.  First click arms the
   * confirm (button swaps to the pulsing `confirmLabel`); second click
   * actually fires `actionConfirmed`.  Reset on every selection change
   * so re-opening the chart for a different row never carries an armed
   * confirm forward.
   */
  protected readonly confirmArmed = signal(false);

  private readonly marketData = inject(MarketDataService);
  private readonly cdr = inject(ChangeDetectorRef);
  private viewReady = false;

  ngAfterViewInit(): void {
    this.viewReady = true;
    if (this.open && this.selection) this.openDialog();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selection'] && this.selection) {
      // Reset to M5 on every fresh open so we don't carry a long timeframe
      // from a previous selection (which produces "no candles in window" for
      // short-lived trades).
      this.selectedTimeframe.set('M5');
      // Selection swap ⇒ never carry an armed destructive confirm into the
      // new row.  A click on a *different* row must re-arm explicitly.
      this.confirmArmed.set(false);
      this.reload();
    }
    if (changes['open'] && this.viewReady) {
      if (this.open && this.selection) this.openDialog();
      else this.closeDialog();
    }
  }

  ngOnDestroy(): void {
    this.closeDialog();
  }

  protected setTimeframe(tf: Timeframe): void {
    if (this.selectedTimeframe() === tf) return;
    this.selectedTimeframe.set(tf);
    if (this.selection) this.reload();
  }

  /**
   * Human label for the signal → order-placement latency, or null until both
   * timestamps are present. Plain method (not computed) because `selection` is
   * an @Input — re-evaluated on the OnChanges-driven CD when the parent sets a
   * new selection object carrying the fetched timing.
   */
  protected signalToOrderLabel(): string | null {
    const s = this.selection;
    if (!s?.signalAt || !s?.orderPlacedAt) return null;
    const ms = new Date(s.orderPlacedAt).getTime() - new Date(s.signalAt).getTime();
    if (!Number.isFinite(ms)) return null;

    const negative = ms < 0;
    const totalSec = Math.round(Math.abs(ms) / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    const sign = negative ? '−' : '';
    if (mins === 0) return `${sign}${secs}s`;
    return `${sign}${mins} min${mins === 1 ? '' : 's'}${secs ? ' ' + secs + 's' : ''}`;
  }

  protected close(): void {
    this.open = false;
    this.confirmArmed.set(false);
    this.closeDialog();
    this.openChange.emit(false);
  }

  protected onDialogClose(): void {
    // Browser-native close (e.g. Escape key) — sync our flag and notify the
    // parent so its `chartOpen` signal goes back to `false`.  Without the
    // emit the parent would still think the dialog is open and the next
    // click on the same row wouldn't re-trigger the open branch (same
    // signal value ⇒ no ngOnChanges).
    this.open = false;
    this.confirmArmed.set(false);
    this.openChange.emit(false);
  }

  protected armConfirm(): void {
    this.confirmArmed.set(true);
  }

  protected disarmConfirm(): void {
    this.confirmArmed.set(false);
  }

  protected confirmAction(): void {
    if (!this.confirmArmed() || this.busy) return;
    this.actionConfirmed.emit();
  }

  private openDialog(): void {
    const el = this.dialogRef?.nativeElement;
    if (el && !el.open) el.showModal();
  }

  private closeDialog(): void {
    const el = this.dialogRef?.nativeElement;
    if (el?.open) el.close();
  }

  /**
   * Fetch candles centred on the selection's reference time, with enough
   * pre-context for visual orientation and post-context to cover the
   * outcome window.  Targets ~150 bars at the chosen timeframe.
   */
  private reload(): void {
    const s = this.selection;
    if (!s) return;

    this.loading.set(true);
    this.errorMsg.set(null);
    this.candles.set([]);

    const tf = this.selectedTimeframe();
    const tfMin = this.timeframeMinutes(tf);
    const ref = new Date(s.referenceTime);
    const refMs = ref.getTime();

    // Window selection:
    //  • Closed trades  → frame entry → exit (75-bar pre / 25-bar post margins).
    //  • Open / pending → the window MUST end at "now" so the latest candle is
    //    the current bar and the live NOW line aligns with it. Start 75 bars
    //    before entry, but cap the span at ~480 bars (under the 500-row limit)
    //    so a long-open trade shows the most recent bars (entry clamps to the
    //    left edge) rather than a stale window around the entry.
    const preMin = 75 * tfMin;
    const now = Date.now();
    let from: Date;
    let to: Date;
    if (s.exitTime) {
      const exitMs = new Date(s.exitTime).getTime();
      from = new Date(refMs - preMin * 60_000);
      to = new Date(exitMs + 25 * tfMin * 60_000);
    } else {
      to = new Date(now);
      const maxSpanMin = 480 * tfMin;
      from = new Date(Math.max(refMs - preMin * 60_000, now - maxSpanMin * 60_000));
    }

    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: 500,
        sortBy: 'timestamp',
        sortDirection: 'asc',
        filter: {
          symbol: s.symbol,
          timeframe: tf,
          from: from.toISOString(),
          to: to.toISOString(),
        },
      })
      .pipe(
        catchError((err) => {
          this.errorMsg.set(err?.message ?? 'Failed to load candles.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data?.data) {
          // Defensively sort ASC by timestamp — same gotcha as the signal
          // sensitivity chart: the API's sort safelist may not honour
          // 'timestamp' here and the data can land DESC.
          const sorted = [...res.data.data].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
          );
          this.candles.set(sorted);
          if (sorted.length === 0) {
            this.errorMsg.set(
              `No ${tf} candles in the ±75-bar window. Try a higher timeframe — the trade may pre-date ${tf} candle ingest for this symbol.`,
            );
          }
        }
        this.cdr.markForCheck();
      });
  }

  private timeframeMinutes(tf: Timeframe): number {
    switch (tf) {
      case 'M1':
        return 1;
      case 'M5':
        return 5;
      case 'M15':
        return 15;
      case 'H1':
        return 60;
      case 'H4':
        return 240;
      case 'D1':
        return 1440;
    }
  }

  /**
   * ECharts candlestick chart with horizontal reference lines for entry/
   * trigger, SL, TP, current price.  Time-axis xAxis so timestamps render
   * exactly at their candle position regardless of gaps.
   */
  protected readonly chartOptions = computed<EChartsOption | null>(() => {
    const s = this.selection;
    const candles = this.candles();
    if (!s || candles.length === 0) return null;

    const refMs = new Date(s.referenceTime).getTime();
    // Category x-axis so candles are contiguous — no blank gaps for weekends or
    // missing bars. Reference markers map timestamps → the nearest candle index.
    const categories = candles.map((c) => c.timestamp);
    const candleMs = candles.map((c) => new Date(c.timestamp).getTime());
    const lastIdx = candles.length - 1;
    const idxAt = (ms: number): number => {
      let idx = 0;
      for (let i = 0; i < candleMs.length; i++) {
        if (candleMs[i] <= ms) idx = i;
        else break;
      }
      return idx;
    };
    const refIdx = idxAt(refMs);
    const candleData: [number, number, number, number][] = candles.map((c) => [
      c.open,
      c.close,
      c.low,
      c.high,
    ]);

    // 5-digit majors / 3-digit JPY pairs — same rule as the sensitivity chart.
    const pricePrecision = s.referencePrice > 50 ? 3 : 5;
    const fmt = (n: number) => n.toFixed(pricePrecision);

    // Vertical guide at the reference (entry/trigger) time.
    const refLineSeries = {
      name: s.referenceLabel,
      type: 'line' as const,
      data: [] as [number, number][],
      symbol: 'none' as const,
      markLine: {
        symbol: 'none' as const,
        silent: true,
        animation: false,
        lineStyle: { color: '#0a84ff', width: 1.5, type: 'dashed' as const },
        label: {
          show: true,
          formatter: s.referenceLabel,
          position: 'insideStartTop' as const,
          color: '#fff',
          backgroundColor: '#0a84ff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 'bold' as const,
        },
        data: [{ xAxis: refIdx }],
      },
    };

    // Filled bands from the reference time onward (TP zone above/below
    // entry, SL zone on the other side).  For Buy: TP above, SL below; Sell
    // is inverted.  We omit zones if SL/TP is null.
    const markAreaData: any[][] = [];
    if (s.takeProfit !== null) {
      markAreaData.push([
        {
          yAxis: s.referencePrice,
          xAxis: refIdx,
          itemStyle: { color: 'rgba(31, 138, 61, 0.12)' },
          name: 'TP zone',
        },
        { yAxis: s.takeProfit, xAxis: lastIdx },
      ]);
    }
    if (s.stopLoss !== null) {
      markAreaData.push([
        {
          yAxis: s.referencePrice,
          xAxis: refIdx,
          itemStyle: { color: 'rgba(196, 41, 10, 0.12)' },
          name: 'SL zone',
        },
        { yAxis: s.stopLoss, xAxis: lastIdx },
      ]);
    }

    // Reference dots at exact (timestamp, price) points.
    const markPointData: any[] = [];
    markPointData.push({
      coord: [refIdx, s.referencePrice],
      symbol: 'circle',
      symbolSize: 10,
      itemStyle: { color: '#000', borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
    });
    if (s.exitTime && s.exitPrice !== null) {
      markPointData.push({
        coord: [idxAt(new Date(s.exitTime).getTime()), s.exitPrice],
        symbol: 'circle',
        symbolSize: 10,
        itemStyle: { color: '#5e5ce6', borderColor: '#fff', borderWidth: 2 },
        label: { show: false },
      });
    }

    // Horizontal price-level lines, anchored at the reference time and
    // sweeping to the last candle so they don't appear before the trade.
    // Level lines run from the entry candle to the last (null before entry so
    // they don't appear pre-trade); NOW spans the full width. Index-aligned to
    // the category axis.
    const levelLine = (y: number): (number | null)[] =>
      categories.map((_, i) => (i >= refIdx ? y : null));
    const fullLine = (y: number): number[] => categories.map(() => y);
    const refSeries: any[] = [];
    refSeries.push({
      name: s.referenceLabel,
      type: 'line',
      data: levelLine(s.referencePrice),
      symbol: 'none',
      lineStyle: { color: '#000', width: 2.5, type: 'solid' },
      tooltip: { show: false },
      z: 10,
      endLabel: {
        show: true,
        formatter: `${s.referenceLabel} ${fmt(s.referencePrice)}`,
        backgroundColor: '#000',
        color: '#fff',
        padding: [3, 7],
        borderRadius: 3,
        fontWeight: 'bold',
        fontSize: 11,
      },
    });
    if (s.takeProfit !== null) {
      refSeries.push({
        name: 'TP',
        type: 'line',
        data: levelLine(s.takeProfit),
        symbol: 'none',
        lineStyle: { color: '#1f8a3d', width: 2, type: 'solid' },
        tooltip: { show: false },
        z: 9,
        endLabel: {
          show: true,
          formatter: `TP ${fmt(s.takeProfit)}`,
          backgroundColor: '#1f8a3d',
          color: '#fff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      });
    }
    if (s.stopLoss !== null) {
      refSeries.push({
        name: 'SL',
        type: 'line',
        data: levelLine(s.stopLoss),
        symbol: 'none',
        lineStyle: { color: '#c4290a', width: 2, type: 'solid' },
        tooltip: { show: false },
        z: 9,
        endLabel: {
          show: true,
          formatter: `SL ${fmt(s.stopLoss)}`,
          backgroundColor: '#c4290a',
          color: '#fff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      });
    }
    if (s.currentPrice !== null) {
      refSeries.push({
        name: 'Now',
        type: 'line',
        // Current price is "live" — span the full chart width to anchor
        // operator attention regardless of where the trade started.
        data: fullLine(s.currentPrice),
        symbol: 'none',
        lineStyle: { color: '#0071e3', width: 1.5, type: 'dotted' },
        tooltip: { show: false },
        z: 8,
        endLabel: {
          show: true,
          formatter: `NOW ${fmt(s.currentPrice)}`,
          backgroundColor: '#0071e3',
          color: '#fff',
          padding: [3, 7],
          borderRadius: 3,
          fontWeight: 'bold',
          fontSize: 11,
        },
      });
    }

    // Y-axis padding so reference lines outside the candle range still have
    // breathing room.
    const allYs = [
      ...candles.map((c) => c.low),
      ...candles.map((c) => c.high),
      s.referencePrice,
      ...(s.stopLoss !== null ? [s.stopLoss] : []),
      ...(s.takeProfit !== null ? [s.takeProfit] : []),
      ...(s.currentPrice !== null ? [s.currentPrice] : []),
      ...(s.exitPrice !== null ? [s.exitPrice] : []),
    ];
    const yMin = Math.min(...allYs);
    const yMax = Math.max(...allYs);
    const yPad = (yMax - yMin) * 0.15 || s.referencePrice * 0.001;

    return <EChartsOption>{
      animation: false,
      grid: { left: 60, right: 110, top: 30, bottom: 60 },
      xAxis: {
        type: 'category',
        data: categories,
        boundaryGap: true,
        axisLabel: {
          fontSize: 10,
          color: '#666',
          hideOverlap: true,
          formatter: (v: string) => {
            const d = new Date(v);
            const p = (n: number) => String(n).padStart(2, '0');
            return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: yMin - yPad,
        max: yMax + yPad,
        axisLabel: {
          formatter: (v: number) => fmt(v),
          fontSize: 10,
          color: '#666',
        },
        splitLine: { lineStyle: { color: '#eee' } },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any) => {
          const candle = Array.isArray(params)
            ? params.find((p) => p.seriesType === 'candlestick')
            : null;
          if (!candle) return '';
          // On the category axis we key off dataIndex to recover the OHLC + ts
          // (candlestick param.value shape varies with the axis encode).
          const c = candles[candle.dataIndex];
          if (!c) return '';
          return `<b>${new Date(c.timestamp).toLocaleString()}</b><br/>
            O ${fmt(c.open)} · H ${fmt(c.high)}<br/>
            L ${fmt(c.low)} · C ${fmt(c.close)}`;
        },
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: 0 },
        { type: 'slider', xAxisIndex: 0, height: 18, bottom: 22 },
      ],
      series: [
        {
          name: 'Price',
          type: 'candlestick',
          data: candleData,
          itemStyle: {
            color: '#34c759',
            color0: '#ff453a',
            borderColor: '#1f8a3d',
            borderColor0: '#c4290a',
          },
          markArea: {
            silent: true,
            data: markAreaData,
          },
          markPoint: {
            silent: true,
            data: markPointData,
          },
        },
        refLineSeries,
        ...refSeries,
      ],
    };
  });
}
