import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CandleDto,
  MarketAnalysisRecommendationDto,
  MarketAnalysisResultDto,
} from '@core/api/api.types';

type AnalysisMode = 'spot' | 'limitBuy' | 'limitSell' | 'stopBuy' | 'stopSell';

/**
 * Self-contained LLM spot-analysis overlay for a single symbol/timeframe. Mirrors the
 * trading chart's analysis capability so it can be launched per-tile from the watchlist
 * grid without opening the full chart. Runs the engine's spot analysis on open and lets the
 * operator re-run as a directed limit/stop proposal. Read-only — no signal persistence here
 * (use the full chart for that).
 */
@Component({
  selector: 'app-spot-analysis-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
        <header class="head">
          <div class="title">
            <strong>{{ symbol() }}</strong>
            <span class="tf">{{ timeframe() }}</span>
            <span class="muted">· LLM spot analysis</span>
          </div>
          <button type="button" class="x" (click)="closed.emit()" aria-label="Close">×</button>
        </header>

        <div class="modes">
          <button
            type="button"
            [class.active]="mode() === 'spot'"
            [disabled]="running()"
            (click)="run('spot')"
          >
            Spot
          </button>
          <button
            type="button"
            [class.active]="mode() === 'limitBuy'"
            [disabled]="running()"
            (click)="run('limitBuy')"
          >
            Limit Buy
          </button>
          <button
            type="button"
            [class.active]="mode() === 'limitSell'"
            [disabled]="running()"
            (click)="run('limitSell')"
          >
            Limit Sell
          </button>
          <button
            type="button"
            [class.active]="mode() === 'stopBuy'"
            [disabled]="running()"
            (click)="run('stopBuy')"
          >
            Stop Buy
          </button>
          <button
            type="button"
            [class.active]="mode() === 'stopSell'"
            [disabled]="running()"
            (click)="run('stopSell')"
          >
            Stop Sell
          </button>
        </div>

        <label
          class="autogen"
          title="Auto-create signals from viable recommendations for any analysis mode"
        >
          <input type="checkbox" [checked]="autoGenerate()" (change)="toggleAutoGenerate($event)" />
          Auto-create signals
        </label>

        <div class="body">
          @if (running()) {
            <div class="state">
              <span class="spinner"></span> Analyzing {{ symbol() }} {{ timeframe() }} ({{
                modeLabel()
              }})…
            </div>
          } @else if (error()) {
            <div class="state error">{{ error() }}</div>
          } @else if (result(); as r) {
            <div class="meta muted">
              {{ r.provider }} · {{ r.model }} · {{ r.latencyMs }}ms · {{ modeLabel() }}
            </div>

            @if (r.generatedSignalIds && r.generatedSignalIds.length > 0) {
              <div class="signal-banner ok">
                Auto-created {{ r.generatedSignalIds.length }} signal{{
                  r.generatedSignalIds.length === 1 ? '' : 's'
                }}: #{{ r.generatedSignalIds.join(', #') }}
              </div>
            }

            @if (recommendations(r).length > 0) {
              <div class="recs">
                @for (rec of recommendations(r); track $index) {
                  <div class="rec" [attr.data-action]="rec.action">
                    <div class="rec-head">
                      <span class="action" [attr.data-action]="rec.action">{{ rec.action }}</span>
                      <span class="conf">{{ (rec.confidence * 100).toFixed(0) }}% confidence</span>
                    </div>
                    @if (rec.action !== 'Hold') {
                      <div class="levels">
                        <span><label>Entry</label>{{ fmt(rec.entryPrice) }}</span>
                        <span class="sl"><label>SL</label>{{ fmt(rec.stopLoss) }}</span>
                        <span class="tp">
                          <label>TP</label>{{ fmt(rec.takeProfit) }}
                          @if (
                            rec.originalTakeProfit !== null &&
                            rec.originalTakeProfit !== undefined &&
                            rec.originalTakeProfit !== rec.takeProfit
                          ) {
                            <span
                              class="shrink-note"
                              [title]="
                                'Engine shrinkage moved the LLM TP from ' +
                                fmt(rec.originalTakeProfit) +
                                ' to ' +
                                fmt(rec.takeProfit) +
                                ' before persistence (SpotAnalysisTakeProfitShrinkage knob).'
                              "
                              >shrunk from {{ fmt(rec.originalTakeProfit) }}</span
                            >
                          }
                        </span>
                      </div>

                      <!-- Inline preview chart: candles + entry/SL/TP horizontal
                           lines + (when shrinkage applied) the LLM's original
                           TP as a dashed line so the operator sees exactly
                           how much the engine pulled the target in before
                           clicking Create signal. -->
                      <div class="preview-chart-wrap">
                        @if (candlesLoading()) {
                          <div class="preview-chart-state muted">Loading bar history…</div>
                        } @else if (chartFor(rec); as opts) {
                          <div
                            echarts
                            [options]="opts"
                            [autoResize]="true"
                            class="preview-chart"
                          ></div>
                        } @else {
                          <div class="preview-chart-state muted">
                            No candle data available to preview this signal.
                          </div>
                        }
                      </div>
                    }
                    <p class="rationale">{{ rec.rationale }}</p>

                    @if (rec.action !== 'Hold') {
                      <div class="rec-actions">
                        @if (createdSignal($index); as sigId) {
                          <span class="signal-banner ok">Signal #{{ sigId }} created ✓</span>
                        } @else {
                          <button
                            type="button"
                            class="create-btn"
                            [disabled]="creatingIndex() !== null || autoCreating()"
                            (click)="createSignal(r, $index)"
                          >
                            {{ creatingIndex() === $index ? 'Creating…' : 'Create signal' }}
                          </button>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            } @else {
              <div class="state muted">No actionable setup — the model returned analysis only.</div>
            }

            @if (r.analysis) {
              <details class="analysis">
                <summary>Full analysis</summary>
                <pre>{{ r.analysis }}</pre>
              </details>
            }
          } @else {
            <div class="state muted">Pick an analysis type above to begin.</div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: var(--space-4);
      }
      .modal {
        width: 100%;
        /* Bumped from 560 → 720 so the inline candle preview has room to
           render readably under each recommendation. The chart itself is
           the densest content here; everything else is narrower text. */
        max-width: 720px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg, 12px);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
      }
      .preview-chart-wrap {
        margin: var(--space-2) 0;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      .preview-chart {
        width: 100%;
        height: 200px;
      }
      .preview-chart-state {
        padding: var(--space-3);
        font-size: var(--text-xs);
        text-align: center;
      }
      .shrink-note {
        margin-left: 6px;
        padding: 1px 6px;
        font-size: 10px;
        font-weight: var(--font-medium);
        background: rgba(255, 149, 0, 0.16);
        color: #b45309;
        border-radius: var(--radius-full);
        cursor: help;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .title {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
        font-size: var(--text-base);
      }
      .title .tf {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .x {
        appearance: none;
        background: transparent;
        border: none;
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
        color: var(--text-tertiary);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }
      .x:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .modes {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .modes button {
        padding: 5px 10px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        border-radius: var(--radius-full);
        cursor: pointer;
      }
      .modes button.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .modes button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .body {
        padding: var(--space-4);
        overflow-y: auto;
      }
      .state {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        padding: var(--space-4) 0;
      }
      .state.error {
        color: var(--loss);
      }
      .meta {
        margin-bottom: var(--space-3);
      }
      .autogen {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: var(--space-2) var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .signal-banner {
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        margin-bottom: var(--space-3);
      }
      .signal-banner.ok {
        color: #1d8a3e;
        background: rgba(29, 138, 62, 0.1);
      }
      .rec-actions {
        margin-top: var(--space-2);
        display: flex;
        justify-content: flex-end;
      }
      .rec-actions .signal-banner {
        margin-bottom: 0;
      }
      .create-btn {
        padding: 5px 12px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        border-radius: var(--radius-full);
        cursor: pointer;
      }
      .create-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .recs {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .rec {
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        padding: var(--space-3);
      }
      .rec[data-action='Buy'] {
        border-left-color: #1d8a3e;
      }
      .rec[data-action='Sell'] {
        border-left-color: #c93631;
      }
      .rec[data-action='Hold'] {
        border-left-color: var(--text-tertiary);
      }
      .rec-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: var(--space-2);
      }
      .action {
        font-weight: var(--font-bold);
        font-size: var(--text-sm);
      }
      .action[data-action='Buy'] {
        color: #1d8a3e;
      }
      .action[data-action='Sell'] {
        color: #c93631;
      }
      .conf {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .levels {
        display: flex;
        gap: var(--space-4);
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
        margin-bottom: var(--space-2);
      }
      .levels label {
        display: block;
        font-size: 10px;
        text-transform: uppercase;
        color: var(--text-tertiary);
      }
      .levels .sl {
        color: #c93631;
      }
      .levels .tp {
        color: #1d8a3e;
      }
      .rationale {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .analysis {
        margin-top: var(--space-3);
      }
      .analysis summary {
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .analysis pre {
        white-space: pre-wrap;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        background: var(--bg-tertiary);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        margin-top: var(--space-2);
        max-height: 240px;
        overflow: auto;
      }
      .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class SpotAnalysisModalComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly notify = inject(NotificationService);

  readonly symbol = input.required<string>();
  readonly timeframe = input.required<string>();
  readonly barPosition = input<string>('closed');
  /** When true, run a spot analysis as soon as the modal opens. Default false —
   *  the operator picks the analysis mode (Spot / Limit / Stop) first. */
  readonly autoRun = input<boolean>(false);

  readonly closed = output<void>();

  protected readonly running = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<MarketAnalysisResultDto | null>(null);
  protected readonly mode = signal<AnalysisMode | null>(null);

  /**
   * Bar history used to render the preview chart under each Buy/Sell
   * recommendation. Fetched once per analysis (after the result lands) so
   * the operator can VISUALISE entry/SL/TP — and the engine's TP shrinkage
   * gap when applicable — against actual price action before clicking
   * Create signal. Empty until the fetch completes; the chart renders an
   * empty state in that window.
   */
  protected readonly candles = signal<CandleDto[]>([]);
  protected readonly candlesLoading = signal(false);

  /** Auto-create signals from viable recommendations during a Spot analysis. */
  protected readonly autoGenerate = signal(false);
  /** Recommendation index currently being persisted, or null. */
  protected readonly creatingIndex = signal<number | null>(null);
  /** True while an auto-create pass (limit/stop modes) is persisting recommendations. */
  protected readonly autoCreating = signal(false);
  /** Map of recommendation index → created TradeSignal id (manual or shown after create). */
  private readonly createdByIndex = signal<Record<number, number>>({});

  protected readonly modeLabel = computed(() => {
    switch (this.mode()) {
      case 'limitBuy':
        return 'limit buy proposal';
      case 'limitSell':
        return 'limit sell proposal';
      case 'stopBuy':
        return 'stop buy proposal';
      case 'stopSell':
        return 'stop sell proposal';
      default:
        return 'spot';
    }
  });

  constructor() {
    // input() values aren't readable in field initializers, so kick off the
    // initial run on the next microtask once bindings are set.
    queueMicrotask(() => {
      if (this.autoRun()) this.run('spot');
    });
  }

  protected toggleAutoGenerate(ev: Event): void {
    this.autoGenerate.set((ev.target as HTMLInputElement).checked);
  }

  protected run(mode: AnalysisMode): void {
    if (this.running()) return;
    this.mode.set(mode);
    this.running.set(true);
    this.error.set(null);
    this.createdByIndex.set({}); // fresh result → reset manual-create state
    this.candles.set([]); // stale candles would mis-visualise a new analysis

    const sym = this.symbol();
    const tf = this.timeframe();
    const bar = this.barPosition();

    // Fetch recent bars in parallel with the LLM call so the preview chart
    // is ready by the time the result lands. The LLM call usually takes
    // 5-15 s; candle fetch lands in well under a second.
    this.loadCandles(sym, tf);

    const call$ =
      mode === 'spot'
        ? this.marketData.analyzeMarket(sym, tf, this.autoGenerate(), bar)
        : mode === 'limitBuy'
          ? this.marketData.proposeLimit(sym, tf, 'Buy', bar)
          : mode === 'limitSell'
            ? this.marketData.proposeLimit(sym, tf, 'Sell', bar)
            : mode === 'stopBuy'
              ? this.marketData.proposeStop(sym, tf, 'Buy', bar)
              : this.marketData.proposeStop(sym, tf, 'Sell', bar);

    call$.subscribe({
      next: (res) => {
        this.running.set(false);
        if (res?.status && res.data) {
          this.result.set(res.data);
          // Spot auto-creates server-side (generateSignals flag → generatedSignalIds).
          // Limit/Stop proposals have no server flag, so persist their viable recs here.
          if (this.autoGenerate() && mode !== 'spot') this.autoPersist(res.data);
        } else {
          this.result.set(null);
          this.error.set(res?.message || 'No viable analysis returned.');
        }
      },
      error: (err) => {
        this.running.set(false);
        this.error.set(err?.message ?? 'Analysis failed. Is the engine reachable?');
      },
    });
  }

  protected recommendations(r: MarketAnalysisResultDto): MarketAnalysisRecommendationDto[] {
    if (r.recommendations?.length) return r.recommendations;
    return r.recommendation ? [r.recommendation] : [];
  }

  /** Created TradeSignal id for a recommendation index, or null if not yet created. */
  protected createdSignal(index: number): number | null {
    return this.createdByIndex()[index] ?? null;
  }

  /** Auto-persist every viable (non-Hold) recommendation — used for Limit/Stop proposals,
   *  which the engine doesn't auto-generate server-side. */
  private autoPersist(r: MarketAnalysisResultDto): void {
    const indices = this.recommendations(r)
      .map((rec, i) => ({ rec, i }))
      .filter((x) => x.rec.action !== 'Hold')
      .map((x) => x.i);
    if (indices.length === 0) return;

    this.autoCreating.set(true);
    let pending = indices.length;
    const created: number[] = [];

    const done = () => {
      if (--pending > 0) return;
      this.autoCreating.set(false);
      if (created.length > 0) {
        this.notify.success(
          `Auto-created ${created.length} signal${created.length === 1 ? '' : 's'}: #${created.join(', #')}`,
        );
      }
    };

    for (const idx of indices) {
      this.marketData.persistSignalFromAnalysis(r.llmInvocationId, idx).subscribe({
        next: (res) => {
          if (res?.status && res.data != null) {
            this.createdByIndex.update((m) => ({ ...m, [idx]: res.data as number }));
            created.push(res.data as number);
          }
          done();
        },
        error: () => done(),
      });
    }
  }

  /** Manually promote one recommendation to a live TradeSignal (persist-signal endpoint). */
  protected createSignal(r: MarketAnalysisResultDto, index: number): void {
    if (this.creatingIndex() !== null || this.createdSignal(index) !== null) return;
    this.creatingIndex.set(index);
    this.marketData.persistSignalFromAnalysis(r.llmInvocationId, index).subscribe({
      next: (res) => {
        this.creatingIndex.set(null);
        if (res?.status && res.data != null) {
          this.createdByIndex.update((m) => ({ ...m, [index]: res.data as number }));
          this.notify.success(`Signal #${res.data} created`);
        } else {
          this.notify.error(res?.message || 'Could not create signal from this recommendation.');
        }
      },
      error: (err) => {
        this.creatingIndex.set(null);
        this.notify.error(err?.message ?? 'Failed to create signal.');
      },
    });
  }

  protected fmt(price: number | null): string {
    if (price == null) return '—';
    const dp = this.symbol().includes('JPY') ? 3 : 5;
    return price.toFixed(dp);
  }

  /**
   * Pull a window of recent bars for the chart preview. We ask for 60 bars
   * — enough to give the entry/SL/TP horizontal lines visible context (≈ 2-3
   * days on H1, ≈ 5 hours on M5) without making the chart cramped.
   * Backend returns newest-first; we flip to chronological order so the
   * candlestick renders left-to-right.
   */
  private loadCandles(symbol: string, timeframe: string): void {
    if (!symbol || !timeframe) return;
    this.candlesLoading.set(true);
    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: 60,
        filter: { symbol, timeframe },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.candlesLoading.set(false);
        const rows = res?.data?.data ?? [];
        const ordered = [...rows].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
        this.candles.set(ordered);
      });
  }

  /**
   * Build the ECharts option for one recommendation's preview chart. Category
   * x-axis (same as the EA detail modal) so weekend / no-data gaps collapse
   * away. Lines drawn:
   *   * Entry — black solid
   *   * SL — red solid
   *   * TP (executed) — green solid; this is the level the signal will fire at
   *   * Original TP — green DASHED, only when shrinkage moved it; the gap
   *     between this dashed line and the solid TP IS the visible shrinkage
   *   * Entry→TP zone — light green fill
   *   * Entry→SL zone — light red fill
   * Returns null when there's nothing to chart (no candles, or a Hold rec).
   */
  protected chartFor(rec: MarketAnalysisRecommendationDto): EChartsOption | null {
    const candles = this.candles();
    if (candles.length === 0) return null;
    if (rec.action === 'Hold' || rec.entryPrice == null) return null;

    const categories = candles.map((c) => c.timestamp);
    const lastIdx = candles.length - 1;
    const candleData: [number, number, number, number][] = candles.map((c) => [
      c.open,
      c.close,
      c.low,
      c.high,
    ]);

    const entry = rec.entryPrice;
    const sl = rec.stopLoss;
    const tp = rec.takeProfit;
    // OriginalTakeProfit is on the DTO but optional — present only when the
    // engine's shrinkage knob actually moved the TP.
    const originalTp = rec.originalTakeProfit ?? null;
    const showShrinkage = originalTp !== null && originalTp !== tp;

    const isJpy = this.symbol().includes('JPY');
    const fmt = (n: number) => n.toFixed(isJpy ? 3 : 5);

    // y-range padding from extreme of all reference levels + bar highs/lows
    // so SL/TP that sit outside the visible candle window still render with
    // a 15% margin.
    const lows = candles.map((c) => c.low);
    const highs = candles.map((c) => c.high);
    const allYs = [
      ...lows,
      ...highs,
      entry,
      ...(sl !== null ? [sl] : []),
      ...(tp !== null ? [tp] : []),
      ...(originalTp !== null ? [originalTp] : []),
    ];
    const yMin = Math.min(...allYs);
    const yMax = Math.max(...allYs);
    const yPad = (yMax - yMin) * 0.15 || entry * 0.001;

    // Mark areas: entry → TP (profit zone) and entry → SL (risk zone),
    // anchored at the right edge so they extend across the whole chart.
    const markAreaData: any[] = [];
    if (tp !== null) {
      markAreaData.push([
        { yAxis: entry, xAxis: 0, itemStyle: { color: 'rgba(31, 138, 61, 0.10)' } },
        { yAxis: tp, xAxis: lastIdx },
      ]);
    }
    if (sl !== null) {
      markAreaData.push([
        { yAxis: entry, xAxis: 0, itemStyle: { color: 'rgba(196, 41, 10, 0.10)' } },
        { yAxis: sl, xAxis: lastIdx },
      ]);
    }
    // When shrinkage applied, shade the gap between the LLM's original TP
    // and the executed TP in an attention-grabbing tint so the operator
    // immediately sees "this is what was given up to shrinkage".
    if (showShrinkage) {
      markAreaData.push([
        { yAxis: tp ?? originalTp!, xAxis: 0, itemStyle: { color: 'rgba(255, 149, 0, 0.18)' } },
        { yAxis: originalTp!, xAxis: lastIdx },
      ]);
    }

    // Horizontal price-level lines via markLine, with right-edge endLabel
    // so each label sits next to the line it labels.
    const markLineData: any[] = [
      {
        yAxis: entry,
        lineStyle: { color: '#000', width: 1.6, type: 'solid' },
        label: {
          show: true,
          position: 'insideEndTop',
          formatter: `ENTRY ${fmt(entry)}`,
          backgroundColor: '#000',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 'bold' as const,
        },
      },
    ];
    if (sl !== null) {
      markLineData.push({
        yAxis: sl,
        lineStyle: { color: '#c4290a', width: 1.4, type: 'solid' },
        label: {
          show: true,
          position: 'insideEndTop',
          formatter: `SL ${fmt(sl)}`,
          backgroundColor: '#c4290a',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 'bold' as const,
        },
      });
    }
    if (tp !== null) {
      markLineData.push({
        yAxis: tp,
        lineStyle: { color: '#1f8a3d', width: 1.6, type: 'solid' },
        label: {
          show: true,
          position: 'insideEndTop',
          formatter: `TP ${fmt(tp)}`,
          backgroundColor: '#1f8a3d',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 'bold' as const,
        },
      });
    }
    if (showShrinkage) {
      markLineData.push({
        yAxis: originalTp!,
        lineStyle: { color: '#1f8a3d', width: 1.2, type: 'dashed', opacity: 0.75 },
        label: {
          show: true,
          position: 'insideEndTop',
          formatter: `LLM TP ${fmt(originalTp!)}`,
          backgroundColor: '#1f8a3d',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 9,
          fontWeight: 'bold' as const,
          offset: [0, 14],
        },
      });
    }

    return {
      animation: false,
      grid: { left: 56, right: 96, top: 8, bottom: 24 },
      xAxis: {
        type: 'category',
        data: categories,
        boundaryGap: true,
        axisLabel: {
          fontSize: 9,
          color: '#888',
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
        scale: true,
        min: yMin - yPad,
        max: yMax + yPad,
        axisLabel: {
          fontSize: 9,
          color: '#888',
          formatter: (v: number) => fmt(v),
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.05)' } },
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (params: any) => {
          const arr = Array.isArray(params) ? params : [params];
          const candle = arr.find((p: any) => p.seriesType === 'candlestick');
          if (!candle) return '';
          const c = candles[candle.dataIndex];
          if (!c) return '';
          return `<b>${new Date(c.timestamp).toLocaleString()}</b><br/>
            O ${fmt(c.open)} · H ${fmt(c.high)}<br/>
            L ${fmt(c.low)} · C ${fmt(c.close)}`;
        },
      },
      series: [
        {
          type: 'candlestick',
          data: candleData,
          itemStyle: {
            color: '#1f8a3d',
            color0: '#c4290a',
            borderColor: '#1f8a3d',
            borderColor0: '#c4290a',
          },
          markArea: { silent: true, z: 0, data: markAreaData },
          markLine: { silent: true, symbol: 'none', animation: false, data: markLineData },
        } as any,
      ],
    };
  }
}
