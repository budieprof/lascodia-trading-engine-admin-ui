import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MarkdownPipe } from '@shared/pipes/markdown.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { AnalysisChatComponent } from '@shared/components/analysis-chat/analysis-chat.component';
import {
  SpotRecChartComponent,
  type SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';
import { MarketDataService } from '@core/services/market-data.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  AnalysisConversationSummaryDto,
  AnalysisConversationDetailDto,
  AnalysisFiledSignalDto,
  MarketAnalysisRecommendationDto,
} from '@core/api/api.types';

/**
 * ChatGPT-style full-page conversation view. Every LLM analysis is a resumable
 * conversation: the left rail lists them (newest first, searchable), and the
 * main pane opens the analysis brief + the full follow-up thread (tools,
 * actions, monitors) via the shared `<app-analysis-chat>`. "New analysis" runs
 * a fresh spot analysis, which becomes a new conversation.
 */
@Component({
  selector: 'app-conversations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    MarkdownPipe,
    RelativeTimePipe,
    AnalysisChatComponent,
    SpotRecChartComponent,
  ],
  template: `
    <div class="conv-page">
      <!-- ── Left rail: conversation list ── -->
      <aside class="conv-list">
        <div class="conv-list-head">
          @if (!newOpen()) {
            <button type="button" class="new-btn" (click)="newOpen.set(true)">
              + New analysis
            </button>
          } @else {
            <form class="new-form" (submit)="runNew($event)">
              <input
                class="new-symbol"
                placeholder="Symbol e.g. EURUSD"
                [(ngModel)]="newSymbol"
                name="sym"
                [disabled]="running()"
                autocomplete="off"
              />
              <select class="new-tf" [(ngModel)]="newTimeframe" name="tf" [disabled]="running()">
                @for (tf of timeframes; track tf) {
                  <option [value]="tf">{{ tf }}</option>
                }
              </select>
              <div class="new-actions">
                <button type="submit" class="new-run" [disabled]="running() || !newSymbol.trim()">
                  {{ running() ? 'Running…' : 'Run' }}
                </button>
                <button
                  type="button"
                  class="new-cancel"
                  [disabled]="running()"
                  (click)="closeNew()"
                >
                  Cancel
                </button>
              </div>
            </form>
          }

          <input
            class="conv-search"
            placeholder="Search symbol…"
            [value]="search()"
            (input)="onSearch($event)"
          />
        </div>

        <div class="conv-items">
          @for (c of conversations(); track c.llmInvocationId) {
            <button
              type="button"
              class="conv-item"
              [class.active]="selectedId() === c.llmInvocationId"
              (click)="select(c)"
            >
              <div class="conv-item-top">
                <span class="conv-kind" [attr.data-kind]="c.kind">{{ c.kind }}</span>
                <span class="conv-sym">{{ c.symbol }} {{ c.timeframe }}</span>
                <span class="conv-time">{{ c.lastActivityAtUtc | relativeTime }}</span>
              </div>
              <div class="conv-preview">{{ c.preview }}</div>
              @if (c.followUpCount > 0 || c.activeMonitorCount > 0) {
                <div class="conv-badges">
                  @if (c.followUpCount > 0) {
                    <span class="badge">💬 {{ c.followUpCount }}</span>
                  }
                  @if (c.activeMonitorCount > 0) {
                    <span class="badge mon">👁 {{ c.activeMonitorCount }}</span>
                  }
                </div>
              }
            </button>
          } @empty {
            <div class="conv-empty">
              {{ loading() ? 'Loading…' : 'No conversations yet — run a new analysis.' }}
            </div>
          }

          @if (hasMore()) {
            <button type="button" class="load-more" [disabled]="loading()" (click)="loadMore()">
              {{ loading() ? 'Loading…' : 'Load more' }}
            </button>
          }
        </div>
      </aside>

      <!-- ── Main pane: the conversation ── -->
      <main class="conv-main">
        @if (selectedId(); as id) {
          @if (detail(); as d) {
            <header class="conv-header">
              <span class="conv-kind" [attr.data-kind]="d.kind">{{ d.kind }}</span>
              <strong>{{ d.symbol }} {{ d.timeframe }}</strong>
              <span class="muted">{{ d.model }} · {{ d.invokedAt | date: 'MMM d, HH:mm' }}</span>
            </header>
          } @else if (detailLoading()) {
            <header class="conv-header"><span class="spinner"></span> Loading…</header>
          }
          @if (detail(); as d) {
            @if (chartRecs().length > 0) {
              <div class="conv-recs">
                <div class="rec-controls">
                  <div class="rec-seg">
                    <span class="rec-lbl">TF</span>
                    @for (tf of chartTimeframes; track tf) {
                      <button
                        type="button"
                        [class.active]="chartTf() === tf"
                        (click)="chartTf.set(tf)"
                      >
                        {{ tf }}
                      </button>
                    }
                  </div>
                  <div class="rec-seg">
                    <span class="rec-lbl">Bars</span>
                    @for (n of barCountOptions; track n) {
                      <button
                        type="button"
                        [class.active]="chartBars() === n"
                        (click)="chartBars.set(n)"
                      >
                        {{ n }}
                      </button>
                    }
                  </div>
                </div>
                <div class="rec-signals">
                  @for (item of actionableRecs(); track item.index) {
                    <div class="rec-signal-row">
                      <span
                        class="rs-label"
                        [class.buy]="item.r.action === 'Buy'"
                        [class.sell]="item.r.action === 'Sell'"
                        >#{{ item.index + 1 }} {{ item.r.action }}</span
                      >
                      @if (filedFor(item.r); as f) {
                        <span class="rs-filed" [attr.data-status]="f.status.toLowerCase()"
                          >✓ Signal #{{ f.signalId }} · {{ f.status }}</span
                        >
                      } @else {
                        <button
                          type="button"
                          class="rs-create"
                          [disabled]="creatingIndex() !== null"
                          (click)="createSignal(item.r, item.index)"
                        >
                          {{ creatingIndex() === item.index ? 'Creating…' : '⚡ Create signal' }}
                        </button>
                      }
                    </div>
                  }
                </div>
                <app-spot-rec-chart
                  [symbol]="d.symbol"
                  [timeframe]="chartTf()"
                  [asOfUtc]="d.invokedAt"
                  [recommendations]="chartRecs()"
                  [historyBars]="chartBars()"
                  [fullWidthLevels]="true"
                />
              </div>
            }
          }
          <div class="conv-chat">
            <app-analysis-chat [llmInvocationId]="id" [opener]="openerText()" [fillHeight]="true" />
          </div>
        } @else {
          <div class="conv-placeholder">
            <div class="placeholder-inner">
              <div class="placeholder-emoji">💬</div>
              <p>Select a conversation to resume it, or run a new analysis.</p>
              <p class="muted">
                Every LLM analysis is a conversation — ask follow-ups, pull live data, or set up
                monitors, and pick it back up any time.
              </p>
            </div>
          </div>
        }
      </main>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .conv-page {
        display: flex;
        gap: var(--space-4);
        height: calc(100vh - 160px);
        min-height: 480px;
      }
      .conv-list {
        flex: none;
        width: 320px;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 10px);
        background: var(--bg-secondary);
        overflow: hidden;
      }
      .conv-list-head {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
        border-bottom: 1px solid var(--border);
      }
      .new-btn,
      .new-run,
      .new-cancel,
      .load-more {
        font: inherit;
        cursor: pointer;
        border-radius: var(--radius-sm);
      }
      .new-btn {
        padding: 8px 12px;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
      }
      .new-form {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .new-symbol,
      .new-tf,
      .conv-search {
        font: inherit;
        font-size: var(--text-sm);
        padding: 6px 9px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .new-actions {
        display: flex;
        gap: 6px;
      }
      .new-run {
        flex: 1;
        padding: 6px 10px;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-xs);
      }
      .new-cancel {
        padding: 6px 10px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .new-run:disabled,
      .new-cancel:disabled,
      .load-more:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .conv-items {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
      }
      .conv-item {
        text-align: left;
        font: inherit;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 3px;
        padding: var(--space-3);
        border: none;
        border-bottom: 1px solid var(--border);
        border-left: 3px solid transparent;
        background: transparent;
        color: inherit;
      }
      .conv-item:hover {
        background: var(--bg-tertiary);
      }
      .conv-item.active {
        background: var(--bg-tertiary);
        border-left-color: var(--accent);
      }
      .conv-item-top {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .conv-sym {
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
      }
      .conv-time {
        margin-left: auto;
        font-size: 10px;
        color: var(--text-tertiary);
        white-space: nowrap;
      }
      .conv-kind {
        font-size: 9px;
        font-weight: var(--font-bold);
        text-transform: uppercase;
        letter-spacing: 0.03em;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .conv-kind[data-kind='Spot'] {
        background: rgba(59, 130, 246, 0.15);
        color: #2563eb;
      }
      .conv-kind[data-kind='Macro'] {
        background: rgba(139, 92, 246, 0.15);
        color: #7c3aed;
      }
      .conv-kind[data-kind='Stop'],
      .conv-kind[data-kind='Limit'] {
        background: rgba(234, 88, 12, 0.15);
        color: #ea580c;
      }
      .conv-preview {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .conv-badges {
        display: flex;
        gap: 6px;
      }
      .badge {
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .conv-empty,
      .load-more {
        padding: var(--space-4);
        text-align: center;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .load-more {
        border: none;
        background: transparent;
        color: var(--accent);
      }
      .conv-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 10px);
        background: var(--bg-primary);
        overflow: hidden;
      }
      .conv-header {
        flex: none;
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-base);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        font-weight: var(--font-normal);
      }
      .conv-recs {
        flex: none;
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
      }
      .rec-controls {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        margin-bottom: var(--space-2);
        flex-wrap: wrap;
      }
      .rec-signals {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin: var(--space-3) 0;
      }
      .rec-signal-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        font-size: var(--text-xs);
      }
      .rs-label {
        font-weight: var(--font-semibold, 600);
      }
      .rs-label.buy {
        color: var(--success, #16a34a);
      }
      .rs-label.sell {
        color: var(--danger, #dc2626);
      }
      .rs-create {
        margin-left: auto;
        padding: 5px 13px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        border-radius: var(--radius-full);
        border: 1px solid var(--accent);
        background: var(--accent);
        color: #fff;
        cursor: pointer;
      }
      .rs-create:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .rs-filed {
        margin-left: auto;
        font-weight: var(--font-medium);
        color: var(--success, #16a34a);
      }
      .rs-filed[data-status='expired'],
      .rs-filed[data-status='rejected'],
      .rs-filed[data-status='cancelled'] {
        color: var(--text-tertiary, var(--text-secondary));
      }
      .rec-seg {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .rec-lbl {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        margin-right: 4px;
      }
      .rec-seg button {
        font: inherit;
        font-size: var(--text-xs);
        padding: 3px 10px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .rec-seg button:not(:first-of-type) {
        border-left: none;
      }
      .rec-seg button:first-of-type {
        border-radius: var(--radius-sm) 0 0 var(--radius-sm);
      }
      .rec-seg button:last-of-type {
        border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
      }
      .rec-seg button.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .conv-chat {
        flex: 1;
        min-height: 0;
      }
      .conv-placeholder {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: var(--space-8);
      }
      .placeholder-inner {
        max-width: 420px;
      }
      .placeholder-emoji {
        font-size: 40px;
        margin-bottom: var(--space-3);
      }
      .placeholder-inner p {
        margin: 0 0 var(--space-2);
        color: var(--text-secondary);
        line-height: 1.5;
      }
      .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: conv-spin 0.6s linear infinite;
      }
      @keyframes conv-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class ConversationsPageComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly notify = inject(NotificationService);

  protected readonly timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

  protected readonly conversations = signal<AnalysisConversationSummaryDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly totalItems = signal(0);
  protected readonly search = signal('');
  private page = 1;
  private readonly pageSize = 30;

  protected readonly selectedId = signal<number | null>(null);
  protected readonly detail = signal<AnalysisConversationDetailDto | null>(null);
  protected readonly detailLoading = signal(false);

  protected readonly newOpen = signal(false);
  protected newSymbol = '';
  protected newTimeframe = 'H1';
  protected readonly running = signal(false);

  protected readonly hasMore = computed(() => this.conversations().length < this.totalItems());
  protected readonly openerText = computed(() => this.detail()?.analysis ?? null);

  // ── Recommendation chart ──
  protected readonly chartTimeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];
  protected readonly barCountOptions = [60, 120, 240, 500];
  /** Chart timeframe — defaults to (and resets with) the analysis timeframe. */
  protected readonly chartTf = linkedSignal(() => this.detail()?.timeframe ?? 'H1');
  /** History bars shown before the signal-fire line. */
  protected readonly chartBars = signal(120);
  /** Actionable recs mapped for the reusable spot-rec chart (Hold/no-entry dropped). */
  protected readonly chartRecs = computed<SpotRecChartRec[]>(() => {
    const d = this.detail();
    if (!d?.recommendations) return [];
    return d.recommendations
      .filter((r) => r.action !== 'Hold' && r.entryPrice != null)
      .map((r, i) => ({
        label: `#${i + 1} ${r.action}`,
        action: r.action,
        entryPrice: r.entryPrice,
        stopLoss: r.stopLoss,
        takeProfit: r.takeProfit,
      }));
  });

  /** Actionable recommendations paired with their ORIGINAL index in the full
   *  recommendation list — the index the persist-signal endpoint expects. */
  protected readonly actionableRecs = computed<
    { r: MarketAnalysisRecommendationDto; index: number }[]
  >(() => {
    const d = this.detail();
    if (!d?.recommendations) return [];
    return d.recommendations
      .map((r, index) => ({ r, index }))
      .filter(({ r }) => r.action !== 'Hold' && r.entryPrice != null);
  });

  /** Recommendation index currently being filed as a signal, or null. */
  protected readonly creatingIndex = signal<number | null>(null);

  /** The signal already filed for a recommendation (matched by direction +
   *  entry, the same keys the create path dedupes on), or null. */
  protected filedFor(rec: MarketAnalysisRecommendationDto): AnalysisFiledSignalDto | null {
    const filed = this.detail()?.filedSignals;
    if (!filed?.length || rec.entryPrice == null) return null;
    const tol = Math.abs(rec.entryPrice) * 1e-5 + 1e-9;
    return (
      filed.find(
        (f) => f.direction === rec.action && Math.abs(f.entryPrice - rec.entryPrice!) <= tol,
      ) ?? null
    );
  }

  /** File one analysis recommendation as a live signal through the risk gates,
   *  then refetch the detail so the "Signal #N" badge replaces the button. */
  protected createSignal(rec: MarketAnalysisRecommendationDto, index: number): void {
    if (this.creatingIndex() !== null) return;
    const id = this.detail()?.llmInvocationId;
    if (!id) return;
    this.creatingIndex.set(index);
    this.marketData
      .persistSignalFromAnalysis(id, index, {
        entryPrice: rec.entryPrice,
        stopLoss: rec.stopLoss,
        takeProfit: rec.takeProfit,
      })
      .subscribe({
        next: (res) => {
          this.creatingIndex.set(null);
          if (res?.status && res.data != null) {
            this.notify.success(`Signal #${res.data} created`);
            // Refetch so filedSignals + status reflect the new signal.
            this.marketData.getAnalysisConversation(id).subscribe({
              next: (d) => {
                if (this.detail()?.llmInvocationId === id && d?.status && d.data)
                  this.detail.set(d.data);
              },
            });
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

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load(true);
  }

  private load(reset: boolean): void {
    if (reset) this.page = 1;
    this.loading.set(true);
    this.marketData
      .listAnalysisConversations(this.search().trim() || null, this.page, this.pageSize)
      .subscribe({
        next: (res) => {
          this.loading.set(false);
          if (!res?.status || !res.data) return;
          this.totalItems.set(res.data.totalItems);
          this.conversations.update((list) =>
            reset ? res.data!.items : [...list, ...res.data!.items],
          );
        },
        error: () => this.loading.set(false),
      });
  }

  protected loadMore(): void {
    this.page += 1;
    this.load(false);
  }

  protected onSearch(ev: Event): void {
    this.search.set((ev.target as HTMLInputElement).value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.load(true), 300);
  }

  protected select(c: AnalysisConversationSummaryDto): void {
    if (this.selectedId() === c.llmInvocationId) return;
    this.selectedId.set(c.llmInvocationId);
    this.detail.set(null);
    this.detailLoading.set(true);
    this.marketData.getAnalysisConversation(c.llmInvocationId).subscribe({
      next: (res) => {
        this.detailLoading.set(false);
        if (this.selectedId() !== c.llmInvocationId) return;
        if (res?.status && res.data) this.detail.set(res.data);
      },
      error: () => this.detailLoading.set(false),
    });
  }

  protected closeNew(): void {
    this.newOpen.set(false);
    this.newSymbol = '';
  }

  protected runNew(ev: Event): void {
    ev.preventDefault();
    const sym = this.newSymbol.trim().toUpperCase();
    if (!sym || this.running()) return;
    this.running.set(true);
    this.marketData.analyzeMarket(sym, this.newTimeframe, false, 'closed').subscribe({
      next: (res) => {
        this.running.set(false);
        if (res?.status && res.data) {
          this.notify.success(`Analysis ready — ${sym} ${this.newTimeframe}`);
          this.closeNew();
          // Prepend the new conversation and open it.
          this.load(true);
          this.selectedId.set(res.data.llmInvocationId);
          this.detailLoading.set(true);
          this.marketData.getAnalysisConversation(res.data.llmInvocationId).subscribe({
            next: (d) => {
              this.detailLoading.set(false);
              if (d?.status && d.data) this.detail.set(d.data);
            },
            error: () => this.detailLoading.set(false),
          });
        } else {
          this.notify.error(res?.message || 'Analysis returned no result.');
        }
      },
      error: (err) => {
        this.running.set(false);
        this.notify.error(err?.message ?? 'Analysis failed. Is the engine reachable?');
      },
    });
  }
}
