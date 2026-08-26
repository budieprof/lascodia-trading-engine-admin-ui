import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MarkdownPipe } from '@shared/pipes/markdown.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { AnalysisChatComponent } from '@shared/components/analysis-chat/analysis-chat.component';
import {
  SpotRecChartComponent,
  type SpotRecChartRec,
  type SpotRecChartMarker,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';
import { MarketDataService } from '@core/services/market-data.service';
import { AlgoEngineerService } from '@core/services/algo-engineer.service';
import { WireService } from '@core/services/wire.service';
import { NotificationService } from '@core/notifications/notification.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type {
  AnalysisConversationSummaryDto,
  AnalysisConversationDetailDto,
  AnalysisFiledSignalDto,
  MarketAnalysisRecommendationDto,
  ResponseData,
} from '@core/api/api.types';
import type { Observable } from 'rxjs';

/** Analysis types the New-analysis launcher supports (spot + directed
 *  limit/stop proposals + the longer-horizon macro brief + the two agents: an algo-engineer
 *  work order and a Wire market-intelligence briefing). */
type AnalysisMode =
  | 'spot'
  | 'limitBuy'
  | 'limitSell'
  | 'stopBuy'
  | 'stopSell'
  | 'macro'
  | 'engineer'
  | 'wire';

/** The agent modes — they take a free-text instruction instead of a symbol/timeframe, and launch a
 *  background run on a host service rather than returning an analysis inline. */
const AGENT_MODES: ReadonlySet<AnalysisMode> = new Set<AnalysisMode>(['engineer', 'wire']);

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
              <select class="new-mode" [(ngModel)]="newMode" name="mode" [disabled]="running()">
                @for (m of analysisModes; track m.value) {
                  <option [value]="m.value">{{ m.label }}</option>
                }
              </select>
              @if (isAgentMode) {
                <textarea
                  class="new-instruction"
                  [(ngModel)]="newInstruction"
                  name="instr"
                  rows="3"
                  [disabled]="running()"
                  [placeholder]="instructionPlaceholder"
                ></textarea>
              } @else {
                <select
                  class="new-symbol"
                  [(ngModel)]="newSymbol"
                  name="sym"
                  [disabled]="running() || symbols().length === 0"
                >
                  @if (symbols().length === 0) {
                    <option value="" disabled>Loading symbols…</option>
                  } @else {
                    <option value="" disabled>Symbol…</option>
                    @for (s of symbols(); track s) {
                      <option [value]="s">{{ s }}</option>
                    }
                  }
                </select>
                <select
                  class="new-tf"
                  [(ngModel)]="newTimeframe"
                  name="tf"
                  [disabled]="running() || newMode === 'macro'"
                  [title]="newMode === 'macro' ? 'Macro analysis always anchors on D1' : ''"
                >
                  @for (tf of timeframes; track tf) {
                    <option [value]="tf">{{ tf }}</option>
                  }
                </select>
              }
              <div class="new-actions">
                <button
                  type="submit"
                  class="new-run"
                  [disabled]="
                    running() ||
                    (newMode === 'engineer' ? !newInstruction.trim() : !newSymbol.trim())
                  "
                >
                  @if (newMode === 'engineer') {
                    {{ running() ? 'Launching…' : 'Launch' }}
                  } @else {
                    {{ running() ? 'Running…' : 'Run' }}
                  }
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
            placeholder="Search symbol, #id, or signal:id…"
            title="Symbol (EURUSD) · a number or #id matches both a conversation id and a signal id (labelled) · force one with signal:8566 or conv:19120"
            [value]="search()"
            (input)="onSearch($event)"
          />

          <div class="conv-kinds" role="group" aria-label="Filter by conversation type">
            @for (k of kindFilters; track k.value) {
              <button
                type="button"
                class="kind-chip"
                [class.active]="kindFilter() === k.value"
                [attr.data-kind]="k.value || null"
                [title]="
                  k.value
                    ? 'Show only ' + k.label + ' conversations'
                    : 'Show all conversation types'
                "
                (click)="setKind(k.value)"
              >
                {{ k.label }}
              </button>
            }
          </div>
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
              @if (c.matchReason) {
                <div class="conv-match">{{ c.matchReason }}</div>
              }
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
              <button
                type="button"
                class="conv-id"
                (click)="copyId(id)"
                [title]="copiedId() === id ? 'Copied' : 'Copy conversation ID'"
              >
                #{{ id }} <span class="conv-id-copy">{{ copiedId() === id ? '✓' : '⧉' }}</span>
              </button>
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
                <app-spot-rec-chart
                  [symbol]="d.symbol"
                  [timeframe]="chartTf()"
                  [asOfUtc]="d.chartAsOfUtc ?? d.invokedAt"
                  [recommendations]="chartRecs()"
                  [historyBars]="chartBars()"
                  [fullWidthLevels]="true"
                  [collapsible]="true"
                  [live]="!d.chartAsOfUtc"
                  [fillMarker]="chartFillMarker()"
                  [exitMarker]="chartExitMarker()"
                >
                  <div legendActions class="rec-signals">
                    @for (item of actionableRecs(); track item.index) {
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
                    }
                  </div>
                </app-spot-rec-chart>
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
      .new-mode,
      .new-instruction,
      .conv-search {
        font: inherit;
        font-size: var(--text-sm);
        padding: 6px 9px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .new-instruction {
        resize: vertical;
        min-height: 60px;
        line-height: 1.4;
      }
      .conv-kinds {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }
      .kind-chip {
        font: inherit;
        font-size: var(--text-xs);
        line-height: 1;
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--bg-primary);
        color: var(--text-secondary);
        cursor: pointer;
      }
      .kind-chip:hover {
        border-color: var(--accent);
        color: var(--text-primary);
      }
      .kind-chip.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
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
      .conv-kind[data-kind='Guard'] {
        background: rgba(13, 148, 136, 0.15);
        color: #0d9488;
      }
      .conv-kind[data-kind='Engineer'] {
        background: rgba(217, 70, 239, 0.15);
        color: #c026d3;
      }
      .conv-kind[data-kind='Wire'] {
        background: rgba(202, 138, 4, 0.15);
        color: #ca8a04;
      }
      .conv-match {
        display: inline-block;
        margin: 2px 0 3px;
        padding: 1px 7px;
        border-radius: var(--radius-full);
        background: color-mix(in srgb, var(--accent) 14%, transparent);
        color: var(--accent);
        font-size: 10px;
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
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
      .conv-id {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 9px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-family: var(--font-mono, monospace);
        font-variant-numeric: tabular-nums;
        cursor: pointer;
      }
      .conv-id:hover {
        border-color: var(--accent);
        color: var(--text-primary);
      }
      .conv-id-copy {
        color: var(--text-tertiary);
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
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: var(--text-xs);
      }
      .rs-create {
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
  private readonly pairsService = inject(CurrencyPairsService);
  private readonly realtime = inject(RealtimeService);
  private readonly algoEngineer = inject(AlgoEngineerService);
  private readonly wire = inject(WireService);

  protected readonly timeframes = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

  /** Active currency-pair symbols for the New-analysis dropdown (from the
   *  engine's CurrencyPair catalogue). */
  protected readonly symbols = signal<readonly string[]>([]);

  protected readonly conversations = signal<AnalysisConversationSummaryDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly totalItems = signal(0);
  protected readonly search = signal('');
  private page = 1;
  private readonly pageSize = 30;

  /** Conversation-type filter. '' = all. Values are the server Kind labels (see KindLabel). */
  protected readonly kindFilter = signal<string>('');
  protected readonly kindFilters: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: 'All' },
    { value: 'Spot', label: 'Spot' },
    { value: 'Macro', label: 'Macro' },
    { value: 'Guard', label: 'Guard' },
    { value: 'Journal', label: 'Journal' },
    { value: 'Memory', label: 'Memory' },
    { value: 'Stop', label: 'Stop' },
    { value: 'Limit', label: 'Limit' },
    { value: 'Engineer', label: 'Engineer' },
    { value: 'Wire', label: 'Wire' },
  ];

  protected readonly selectedId = signal<number | null>(null);
  protected readonly detail = signal<AnalysisConversationDetailDto | null>(null);
  protected readonly detailLoading = signal(false);
  /** Conversation id most recently copied to the clipboard (for the ✓ tick). */
  protected readonly copiedId = signal<number | null>(null);

  protected readonly newOpen = signal(false);
  protected newSymbol = '';
  protected newTimeframe = 'H1';
  protected newMode: AnalysisMode = 'spot';
  /** Free-text instruction for the agent modes (ignored by the analysis modes). */
  protected newInstruction = '';

  /** True for the agent modes, which take an instruction rather than a symbol + timeframe. */
  protected get isAgentMode(): boolean {
    return AGENT_MODES.has(this.newMode);
  }

  /** Prompt text for the instruction box — each agent gets an example in its own idiom. */
  protected get instructionPlaceholder(): string {
    return this.newMode === 'wire'
      ? "Ask Wire — e.g. 'USD pressure is \u22120.44 today. Decompose it, and tell me whether it is already priced.'"
      : "Work order for the algo-engineer \u2014 e.g. 'EURUSD Buy in London is bleeding; investigate the stop geometry and propose a fix.'";
  }
  protected readonly running = signal(false);

  /** Analysis types the "New analysis" launcher supports — mirrors the
   *  spot-analysis modal / watchlist actions (spot + directed limit/stop
   *  proposals + the longer-horizon macro brief). */
  protected readonly analysisModes: { value: AnalysisMode; label: string }[] = [
    { value: 'spot', label: 'Spot' },
    { value: 'limitBuy', label: 'Limit Buy' },
    { value: 'limitSell', label: 'Limit Sell' },
    { value: 'stopBuy', label: 'Stop Buy' },
    { value: 'stopSell', label: 'Stop Sell' },
    { value: 'macro', label: 'Macro' },
    { value: 'engineer', label: 'Engineer' },
    { value: 'wire', label: 'Wire' },
  ];

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

  /** Where the journal's signal filled (blue triangle) — null for a normal analysis. */
  protected readonly chartFillMarker = computed<SpotRecChartMarker | null>(() =>
    this.toChartMarker(this.detail()?.fillMarker),
  );
  /** Where the journal's signal exited — TP star / SL x — null for a normal analysis. */
  protected readonly chartExitMarker = computed<SpotRecChartMarker | null>(() =>
    this.toChartMarker(this.detail()?.exitMarker),
  );

  private toChartMarker(
    m: { timeUtc: string; price: number; label: string; kind: string } | null | undefined,
  ): SpotRecChartMarker | null {
    if (!m) return null;
    const kind = m.kind === 'tp' ? 'tp' : m.kind === 'sl' ? 'sl' : 'fill';
    return { time: m.timeUtc, price: m.price, label: m.label, kind };
  }

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

  /** Coalesces a burst of realtime tickles (an ask loop persists several turns
   *  in quick succession) into one refresh pass. */
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingChangedIds = new Set<number>();

  constructor() {
    this.load(true);
    this.loadSymbols();

    // Live conversation list: the engine tickles `analysisConversationChanged`
    // with an anchor id whenever a conversation is created or its thread changes
    // (a turn added by any operator/tab, a monitor firing, a new analysis run
    // elsewhere). Coalesce and refresh so the rail stays current hands-free.
    this.realtime.connect();
    this.realtime
      .on<{ llmInvocationId: number }>('analysisConversationChanged')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => {
        if (!p?.llmInvocationId) return;
        this.pendingChangedIds.add(p.llmInvocationId);
        this.scheduleLiveRefresh();
      });
  }

  private scheduleLiveRefresh(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => this.applyLiveRefresh(), 500);
  }

  /**
   * Apply a coalesced batch of conversation-changed tickles to the rail.
   *  - Unfiltered first page (the common case): reload page 1 so brand-new
   *    conversations appear at the top and bumps/counts are canonical.
   *  - Searching or paginated: update only the already-visible rows in place
   *    (preserving the search's match labels + pagination), so a badge/bump
   *    still lands without yanking the view.
   * Always refresh the open conversation's detail so the main-pane chart's
   * filed-signal badges stay live.
   */
  private applyLiveRefresh(): void {
    const ids = [...this.pendingChangedIds];
    this.pendingChangedIds.clear();
    if (ids.length === 0) return;

    const selected = this.selectedId();
    if (selected != null && ids.includes(selected)) this.refreshDetail(selected);

    if (!this.search().trim() && this.page === 1) {
      this.load(true);
      return;
    }

    const visible = new Set(this.conversations().map((c) => c.llmInvocationId));
    ids.filter((id) => visible.has(id)).forEach((id) => this.refreshRow(id));
  }

  /** Refetch one conversation's live-changing fields (counts, last activity,
   *  preview) by id and merge them in place, then re-sort newest-first. Keeps the
   *  row's existing kind/symbol/match label from the current search. */
  private refreshRow(id: number): void {
    this.marketData.listAnalysisConversations({ conversationId: id }, 1, 1).subscribe({
      next: (res) => {
        const updated = res?.data?.items?.[0];
        if (!updated) return;
        this.conversations.update((list) =>
          list
            .map((c) =>
              c.llmInvocationId === id
                ? {
                    ...c,
                    followUpCount: updated.followUpCount,
                    activeMonitorCount: updated.activeMonitorCount,
                    lastActivityAtUtc: updated.lastActivityAtUtc,
                    preview: updated.preview,
                  }
                : c,
            )
            .slice()
            .sort(
              (a, b) =>
                new Date(b.lastActivityAtUtc).getTime() - new Date(a.lastActivityAtUtc).getTime(),
            ),
        );
      },
      error: () => {
        /* transient — the next tickle refreshes */
      },
    });
  }

  /** Silently refetch the open conversation's detail (recommendations, filed
   *  signals) so main-pane badges reflect a chat-filed signal without a reselect. */
  private refreshDetail(id: number): void {
    this.marketData.getAnalysisConversation(id).subscribe({
      next: (res) => {
        if (this.selectedId() !== id) return;
        if (res?.status && res.data) this.detail.set(res.data);
      },
      error: () => {
        /* non-fatal */
      },
    });
  }

  /** Load active currency-pair symbols for the New-analysis dropdown. */
  private loadSymbols(): void {
    this.pairsService.list({ currentPage: 1, itemCountPerPage: 500 }).subscribe({
      next: (res) => {
        const syms = Array.from(
          new Set(
            (res?.data?.data ?? [])
              .filter((p) => p.isActive && (p.symbol ?? '').trim().length > 0)
              .map((p) => (p.symbol ?? '').trim().toUpperCase()),
          ),
        ).sort();
        this.symbols.set(syms);
        // Default the launcher to the first symbol so Run is immediately usable.
        if (!this.newSymbol && syms.length > 0) this.newSymbol = syms[0];
      },
      error: () => {
        /* leave the dropdown empty — the operator can still type via search */
      },
    });
  }

  /**
   * Parse the single search box into a typed filter. Signal-id and
   * conversation-id spaces OVERLAP (the same number can be both), so a bare or
   * "#"-prefixed number searches BOTH and the results are labelled (matchReason).
   * Explicit prefixes force one interpretation:
   *  - "signal:8565" / "sig 8565"   → signal id only (the conversation that produced it)
   *  - "conv:8565" / "c:8565"       → conversation id only (the "#N" chip)
   *  - "#8565" / "8565"             → ambiguous → match both, labelled
   *  - "eurusd" / "gbp"             → symbol substring (default)
   */
  private parseSearch(raw: string): {
    symbol?: string;
    conversationId?: number;
    signalId?: number;
    anyId?: number;
  } {
    const s = raw.trim();
    if (!s) return {};
    const sig = s.match(/^(?:signal|sig)\s*[:#]?\s*(\d+)$/i);
    if (sig) return { signalId: Number(sig[1]) };
    const conv = s.match(/^(?:conv(?:ersation)?|c)\s*[:#]?\s*(\d+)$/i);
    if (conv) return { conversationId: Number(conv[1]) };
    const num = s.match(/^#?\s*(\d+)$/);
    if (num) return { anyId: Number(num[1]) };
    return { symbol: s };
  }

  /** Select a conversation-type filter chip and reload from page 1. Re-clicking is a no-op. */
  protected setKind(value: string): void {
    if (this.kindFilter() === value) return;
    this.kindFilter.set(value);
    this.load(true);
  }

  private load(reset: boolean): void {
    if (reset) this.page = 1;
    this.loading.set(true);
    const filter = { ...this.parseSearch(this.search()), kind: this.kindFilter() || null };
    this.marketData.listAnalysisConversations(filter, this.page, this.pageSize).subscribe({
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

  /** Copy the conversation id to the clipboard so it can be quoted in a review. */
  protected copyId(id: number): void {
    navigator.clipboard
      ?.writeText(String(id))
      .then(() => {
        this.copiedId.set(id);
        setTimeout(() => this.copiedId.set(null), 1500);
      })
      .catch(() => {
        /* clipboard blocked — the id stays visible in the header */
      });
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
    const syms = this.symbols();
    this.newSymbol = syms.length > 0 ? syms[0] : '';
  }

  protected runNew(ev: Event): void {
    ev.preventDefault();
    if (this.running()) return;

    // The agent modes are a different beast: they launch a background run on a host service (no
    // symbol/timeframe) and return the anchor conversation to open.
    if (this.newMode === 'engineer') {
      this.launchWorkOrder();
      return;
    }
    if (this.newMode === 'wire') {
      this.launchBriefing();
      return;
    }

    const sym = this.newSymbol.trim().toUpperCase();
    if (!sym) return;
    const tf = this.newTimeframe;
    const mode = this.newMode;
    this.running.set(true);

    // Route to the matching analysis endpoint. All variants return a result
    // carrying llmInvocationId, so the success path is shared.
    const call$ = (
      mode === 'limitBuy'
        ? this.marketData.proposeLimit(sym, tf, 'Buy', 'closed')
        : mode === 'limitSell'
          ? this.marketData.proposeLimit(sym, tf, 'Sell', 'closed')
          : mode === 'stopBuy'
            ? this.marketData.proposeStop(sym, tf, 'Buy', 'closed')
            : mode === 'stopSell'
              ? this.marketData.proposeStop(sym, tf, 'Sell', 'closed')
              : mode === 'macro'
                ? this.marketData.analyzeMacro(sym, tf)
                : this.marketData.analyzeMarket(sym, tf, false, 'closed')
    ) as Observable<ResponseData<{ llmInvocationId: number }>>;

    const label = this.analysisModes.find((m) => m.value === mode)?.label ?? 'Analysis';

    call$.subscribe({
      next: (res) => {
        this.running.set(false);
        if (res?.status && res.data) {
          this.notify.success(`${label} ready — ${sym}${mode === 'macro' ? '' : ' ' + tf}`);
          this.closeNew();
          this.load(true); // prepend the new conversation to the list
          this.openConversation(res.data.llmInvocationId);
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

  /** Launch an algo-engineer work order (Engineer mode). Fire-and-forget on the host: the endpoint
   *  returns as soon as the Engineer conversation exists; the agent's reasoning then streams onto it
   *  live via SignalR. */
  private launchWorkOrder(): void {
    const instruction = this.newInstruction.trim();
    if (!instruction) return;
    this.running.set(true);
    this.algoEngineer.startWorkOrder(instruction).subscribe({
      next: (res) => {
        this.running.set(false);
        if (res?.status && res.data) {
          this.notify.success('Algo-engineer work order launched.');
          this.newInstruction = '';
          this.closeNew();
          this.load(true); // prepend the new Engineer conversation to the list
          this.openConversation(res.data.sessionLlmInvocationId);
        } else {
          this.notify.error(res?.message || 'Could not launch the work order.');
        }
      },
      error: (err) => {
        this.running.set(false);
        this.notify.error(
          err?.error?.message ??
            err?.message ??
            'Work order failed. Is the algo-engineer service running?',
        );
      },
    });
  }

  /** Ask Wire (Wire mode). Fire-and-forget on the host, same shape as a work order: the endpoint
   *  returns as soon as the Wire conversation exists; Wire's reasoning then streams onto it live
   *  via SignalR. */
  private launchBriefing(): void {
    const instruction = this.newInstruction.trim();
    if (!instruction) return;
    this.running.set(true);
    this.wire.askWire(instruction).subscribe({
      next: (res) => {
        this.running.set(false);
        if (res?.status && res.data) {
          this.notify.success('Wire briefing launched.');
          this.newInstruction = '';
          this.closeNew();
          this.load(true); // prepend the new Wire conversation to the list
          this.openConversation(res.data.sessionLlmInvocationId);
        } else {
          this.notify.error(res?.message || 'Could not launch the briefing.');
        }
      },
      error: (err) => {
        this.running.set(false);
        this.notify.error(
          err?.error?.message ?? err?.message ?? 'Briefing failed. Is the Wire service running?',
        );
      },
    });
  }

  /** Select + load a conversation by its anchor invocation id. */
  private openConversation(llmInvocationId: number): void {
    this.selectedId.set(llmInvocationId);
    this.detailLoading.set(true);
    this.marketData.getAnalysisConversation(llmInvocationId).subscribe({
      next: (d) => {
        this.detailLoading.set(false);
        if (d?.status && d.data) this.detail.set(d.data);
      },
      error: () => this.detailLoading.set(false),
    });
  }
}
