import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MarketDataService } from '@core/services/market-data.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { MarketAnalysisRecommendationDto, MarketAnalysisResultDto } from '@core/api/api.types';

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
          title="Auto-create signals from viable recommendations (Spot analysis only)"
        >
          <input type="checkbox" [checked]="autoGenerate()" (change)="toggleAutoGenerate($event)" />
          Auto-create signals on Spot analysis
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
                        <span class="tp"><label>TP</label>{{ fmt(rec.takeProfit) }}</span>
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
                            [disabled]="creatingIndex() !== null"
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
        max-width: 560px;
        max-height: 85vh;
        display: flex;
        flex-direction: column;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg, 12px);
        box-shadow: var(--shadow-lg);
        overflow: hidden;
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

  /** Auto-create signals from viable recommendations during a Spot analysis. */
  protected readonly autoGenerate = signal(false);
  /** Recommendation index currently being persisted, or null. */
  protected readonly creatingIndex = signal<number | null>(null);
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

    const sym = this.symbol();
    const tf = this.timeframe();
    const bar = this.barPosition();

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
}
