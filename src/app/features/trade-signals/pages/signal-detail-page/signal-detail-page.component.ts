import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of } from 'rxjs';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { OrderDto, TradeSignalDto } from '@core/api/api.types';
import { AccountAttemptsComponent } from '../../components/account-attempts/account-attempts.component';
import {
  SpotRecChartComponent,
  SpotRecChartMarker,
  SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { NotificationService } from '@core/notifications/notification.service';
import { MissingSignalContextComponent } from '../../components/missing-signal-context/missing-signal-context.component';
import { SignalStoryPanelComponent } from '../../components/signal-story/signal-story-panel.component';
import type { SignalStory } from '../../components/signal-story/signal-story.types';
import {
  missingSignalSentence,
  SignalRange,
} from '../../components/signal-story/signal-story.logic';

/**
 * Per-signal detail surface. Two panels:
 *
 *   1. **Chart pane** (added 2026-06-20) — candle window straddling
 *      `generatedAt` with Entry / SL / TP overlaid as horizontal mark-lines,
 *      plus an "exited at" mark-point when the signal is in a terminal
 *      state (HitTP / HitSL / Expired). Lets the operator see at a glance
 *      whether the structural read played out.
 *
 *   2. **Cross-account attempts** — answers "what happened to signal X
 *      across every EA / account / broker?" without operator triangulation.
 *
 * The fuller detail view (lifecycle timeline, order linkage, ML score) is
 * queued behind this minimal scaffold. The chart panel sits at the top
 * because it's the highest-information surface for an operator triaging
 * "did this signal work?".
 */
@Component({
  selector: 'app-signal-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    RouterLink,
    AccountAttemptsComponent,
    SpotRecChartComponent,
    PageHeaderComponent,
    ErrorStateComponent,
    ConfirmDialogComponent,
    SignalStoryPanelComponent,
    MissingSignalContextComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'Signal #' + (signalId() ?? '—')"
        subtitle="Everything the engine recorded about this signal — where it came from, the gates it met, every account and EA that handled it, and how it ended."
      >
        <!-- Kept outside the @if: nodes inside a control-flow block do not
             match ng-content selectors, so the slot wrapper is always
             rendered and only its children are conditional. -->
        <span slot="title-after" class="head-chips">
          @if (signal(); as s) {
            <span class="chip mono">{{ s.symbol }}</span>
            <span
              class="chip"
              [class.chip--buy]="s.direction === 'Buy'"
              [class.chip--sell]="s.direction === 'Sell'"
            >
              {{ s.direction === 'Buy' ? '↑ Buy' : '↓ Sell' }}
            </span>
            <span class="chip" [attr.data-status]="s.status">{{ s.status }}</span>
            @if (s.orderId !== null) {
              <a class="chip chip--link" [routerLink]="['/orders', s.orderId]"
                >Order #{{ s.orderId }} ↗</a
              >
            }
          }
        </span>
        @if (signal(); as s) {
          @if (s.status !== 'Cancelled') {
            <button
              class="btn btn-danger"
              (click)="showCancelDialog.set(true)"
              title="Cancel the signal and close every position / pending order it opened"
            >
              Cancel signal
            </button>
          }
        }
        <a class="btn btn-secondary" routerLink="/trade-signals">← All signals</a>
      </app-page-header>

      <app-confirm-dialog
        [open]="showCancelDialog()"
        title="Cancel signal"
        [message]="
          'Cancel signal #' +
          (signalId() ?? '') +
          '? It will never execute again, and every open position and pending order it produced will be closed immediately on every account.'
        "
        confirmLabel="Cancel signal"
        confirmVariant="destructive"
        [loading]="cancelling()"
        (confirm)="confirmCancel()"
        (cancelled)="showCancelDialog.set(false)"
      >
        <label class="cancel-reason">
          <span>Reason (recorded in the audit trail)</span>
          <textarea
            rows="2"
            maxlength="400"
            [value]="cancelReason()"
            (input)="cancelReason.set($any($event.target).value)"
          ></textarea>
        </label>
      </app-confirm-dialog>

      @if (signalId() !== null) {
        @if (missing(); as m) {
          <!-- The id does not exist: say which ids do, instead of an error over an
               empty "no account attempts" card. -->
          <section class="missing" role="status">
            <h2>No signal #{{ signalId() }}</h2>
            <p>{{ m.sentence }}</p>
            @if (m.range.totalSignals != null) {
              <p class="muted small">
                The engine holds {{ m.range.totalSignals | number }} signal(s).
              </p>
            }
            <nav class="missing-links">
              @if (m.range.previousId) {
                <a class="btn btn-secondary" [routerLink]="['/trade-signals', m.range.previousId]"
                  >← Signal #{{ m.range.previousId }}</a
                >
              }
              @if (m.range.nextId) {
                <a class="btn btn-secondary" [routerLink]="['/trade-signals', m.range.nextId]"
                  >Signal #{{ m.range.nextId }} →</a
                >
              }
              @if (m.range.latestId && m.range.latestId !== m.range.nextId) {
                <a class="btn btn-secondary" [routerLink]="['/trade-signals', m.range.latestId]"
                  >Newest (#{{ m.range.latestId }})</a
                >
              }
              <a class="btn btn-secondary" routerLink="/trade-signals">All signals</a>
              <a class="btn btn-secondary" routerLink="/trade-signals/feedback">Signal exits</a>
            </nav>
          </section>
          <app-missing-signal-context
            [requestedId]="signalId()!"
            [earliestId]="m.range.earliestId"
            [latestId]="m.range.latestId"
            [previousId]="m.range.previousId"
            [nextId]="m.range.nextId"
            [totalSignals]="m.range.totalSignals"
          />
        } @else {
          @if (signal(); as s) {
            @if (story(); as st) {
              <app-signal-story-panel [story]="st" [signal]="s" />
            } @else if (!storyLoading()) {
              <!-- Engine without the story endpoint: still show what the signal row itself says. -->
              <section class="facts-card">
                <dl class="facts">
                  <div>
                    <dt>Strategy</dt>
                    <dd>
                      <a [routerLink]="['/strategies', s.strategyId]">#{{ s.strategyId }}</a>
                    </dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{{ sourceLabel(s) }}</dd>
                  </div>
                  <div>
                    <dt>Confidence</dt>
                    <dd>{{ s.confidence * 100 | number: '1.0-0' }}%</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{{ s.suggestedLotSize | number: '1.2-2' }} lots</dd>
                  </div>
                  <div>
                    <dt>Generated</dt>
                    <dd>{{ s.generatedAt | date: 'MMM d y, HH:mm' : 'UTC' }} UTC</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{{ s.expiresAt | date: 'MMM d y, HH:mm' : 'UTC' }} UTC</dd>
                  </div>
                  <div>
                    <dt>Accounts that picked it up</dt>
                    <dd>{{ s.accountsPickedUpCount }}</dd>
                  </div>
                  <div>
                    <dt>ML score</dt>
                    <dd>
                      {{
                        s.mlConfidenceScore != null
                          ? (s.mlConfidenceScore | number: '1.2-2') +
                            ' · ' +
                            (s.mlPredictedDirection ?? '—')
                          : 'not scored'
                      }}
                    </dd>
                  </div>
                  @if (s.rejectionReason) {
                    <div class="wide">
                      <dt>Why it stopped</dt>
                      <dd>{{ s.rejectionReason }}</dd>
                    </div>
                  }
                </dl>
              </section>
            }
            <!-- Chart pane — renders only when the signal has resolvable
                 symbol + actionable prices. Hold-only / malformed signals
                 skip the chart silently. -->
            @if (canChart(s)) {
              <section class="chart-section">
                <header class="section-head">
                  <h2>Chart — Entry / SL / TP overlay</h2>
                  <div class="section-sub muted">
                    <!-- Formatted IN UTC: the pipe's default is the browser zone, so the
                         line printed local time beside a "UTC" suffix (07:01 for 06:01Z). -->
                    {{ s.symbol }} · {{ tfLabel() }} · generated
                    {{ s.generatedAt | date: 'MMM d, HH:mm' : 'UTC' }} UTC · entry
                    <span class="mono">{{ s.entryPrice | number: priceFormat(s) }}</span> · SL
                    <span class="mono">{{ s.stopLoss | number: priceFormat(s) }}</span> · TP
                    <span class="mono">{{ s.takeProfit | number: priceFormat(s) }}</span>
                    @if (outcomeLabel(s); as t) {
                      ·
                      <span [class.warn]="t.tone === 'warn'" [class.ok]="t.tone === 'ok'">{{
                        t.text
                      }}</span>
                    }
                  </div>
                </header>
                <app-spot-rec-chart
                  [symbol]="s.symbol ?? ''"
                  [timeframe]="tfLabel()"
                  [asOfUtc]="s.generatedAt"
                  [recommendations]="chartRecs()"
                  [exitMarker]="exitMarker()"
                />
              </section>
            }
          } @else if (chartLoading()) {
            <section class="chart-section">
              <p class="muted">Loading signal…</p>
            </section>
          } @else if (chartError(); as e) {
            <app-error-state title="Could not load signal" [message]="e" (retry)="load()" />
          }

          @if (quietAttempts()) {
            <!-- No account ever saw it: the story above already says why; a full empty
                 attempts card added nothing. -->
            <p class="quiet-line muted">
              Account attempts: none — no EA polled this signal and no account created an order from
              it{{ story()?.counts?.engineRejections ? ' (the engine refused it first)' : '' }}.
            </p>
          } @else if (signal()) {
            <app-account-attempts
              [signalId]="signalId()"
              [signal]="signal()"
              (ordersLoaded)="orders.set($event)"
            />
          }
        }
      } @else {
        <p class="empty muted">Invalid signal id — route is missing the numeric segment.</p>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .head-chips {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .chip {
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 3px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        letter-spacing: 0.02em;
        text-decoration: none;
        line-height: 1.2;
      }
      .chip--buy {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .chip--sell {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .chip[data-status='Pending'] {
        background: rgba(255, 149, 0, 0.15);
        color: var(--warning);
      }
      .chip[data-status='Approved'],
      .chip[data-status='Executed'] {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .btn-danger {
        background: rgba(255, 59, 48, 0.15);
        color: #d70015;
      }
      .btn-danger:hover:not(:disabled) {
        background: rgba(255, 59, 48, 0.25);
      }
      .chip[data-status='Cancelled'] {
        background: rgba(175, 82, 222, 0.15);
        color: #8944ab;
      }
      .cancel-reason {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        margin-top: 0.75rem;
        font-size: 0.8125rem;
        color: var(--text-secondary);
      }
      .cancel-reason textarea {
        font: inherit;
        color: var(--text-primary);
        border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
        border-radius: 8px;
        padding: 0.5rem 0.625rem;
        resize: vertical;
      }
      .chip[data-status='Rejected'] {
        background: rgba(255, 59, 48, 0.15);
        color: var(--loss);
      }
      .chip--link {
        color: var(--accent);
        background: rgba(0, 113, 227, 0.12);
      }
      .chip--link:hover {
        text-decoration: underline;
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        text-decoration: none;
      }
      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover {
        background: var(--bg-tertiary);
      }
      .chart-section {
        padding: var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }
      .section-head {
        margin-bottom: var(--space-2);
      }
      .section-head h2 {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        margin: 0 0 var(--space-1);
        color: var(--text-primary);
      }
      .section-sub {
        font-size: var(--text-sm);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-secondary);
      }
      .facts-card {
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }
      .facts {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-3);
        margin: 0;
      }
      .facts .wide {
        grid-column: 1 / -1;
      }
      .facts dt {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .facts dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        overflow-wrap: anywhere;
      }
      .facts a {
        color: var(--accent);
      }
      @media (max-width: 900px) {
        .facts {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .missing {
        padding: var(--space-5);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }
      .missing h2 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-lg);
      }
      .missing p {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        line-height: 1.5;
      }
      .missing-links {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin-top: var(--space-3);
      }
      .small {
        font-size: var(--text-xs);
      }
      .quiet-line {
        font-size: var(--text-sm);
        margin: 0;
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .empty {
        font-size: var(--text-sm);
        padding: var(--space-3) 0;
      }
      .ok {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      .warn {
        color: var(--warning);
        font-weight: var(--font-semibold);
      }
    `,
  ],
})
export class SignalDetailPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly signalsService = inject(TradeSignalsService);
  private readonly notifications = inject(NotificationService);

  readonly showCancelDialog = signal(false);
  readonly cancelReason = signal('');
  readonly cancelling = signal(false);

  confirmCancel(): void {
    const id = this.signalId();
    if (id === null) return;
    this.cancelling.set(true);
    this.signalsService
      .cancel(id, this.cancelReason().trim() || 'Cancelled from admin UI')
      .subscribe({
        next: (res) => {
          this.cancelling.set(false);
          if (!res.status || !res.data) {
            this.notifications.error(res.message ?? 'Failed to cancel signal');
            return;
          }
          this.showCancelDialog.set(false);
          this.cancelReason.set('');
          if (res.data.unresolvedCount > 0) {
            this.notifications.warning(
              `Signal #${id} cancelled — ${res.data.unresolvedCount} position(s)/order(s) not reachable yet (EA offline?); the engine keeps retrying.`,
            );
          } else {
            this.notifications.success(`Signal #${id} cancelled.`);
          }
          this.load();
        },
        error: () => {
          this.cancelling.set(false);
          this.notifications.error('Failed to cancel signal');
        },
      });
  }

  /**
   * Parses :id from the route param into a number. Null when the
   * route is missing the segment or the value is non-numeric — the
   * template renders an invalid-id message in that case rather than
   * silently submitting a bogus query to the engine.
   */
  readonly signalId = toSignal(
    this.route.paramMap.pipe(
      map((params) => {
        const raw = params.get('id');
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
      }),
    ),
    { initialValue: null as number | null },
  );

  /** GET trade-signal/{id}/story — null until loaded, or when the engine lacks the endpoint. */
  readonly story = signal<SignalStory | null>(null);
  readonly storyLoading = signal(false);

  sourceLabel(s: TradeSignalDto): string {
    if (s.source === 'SpotAnalysis') return 'LLM spot analysis';
    if (s.source === 'Manual' || s.isManual) return 'Entered by hand';
    return 'Strategy';
  }
  /** Set when the id does not exist: the sentence + the range that does. */
  readonly missing = signal<{ sentence: string; range: SignalRange } | null>(null);

  /** The story says nothing reached an account: collapse the attempts card to one line. */
  readonly quietAttempts = computed(() => {
    const c = this.story()?.counts;
    return !!c && c.accountAttempts === 0 && c.orders === 0 && c.eaRejections === 0;
  });

  /** The fetched TradeSignal — null while loading / on error. */
  readonly signal = signal<TradeSignalDto | null>(null);
  readonly chartLoading = signal(false);
  readonly chartError = signal<string | null>(null);

  /**
   * Wraps the signal into the chart-rec shape. Singular array — the
   * TradeSignal carries one Entry/SL/TP triple — but the chart component
   * is the same array-driven one the spot-analysis-report drawer uses.
   */
  readonly chartRecs = computed<SpotRecChartRec[]>(() => {
    const s = this.signal();
    if (!s) return [];
    return [
      {
        label: `Signal #${s.id} ${s.direction}`,
        action: s.direction,
        entryPrice: s.entryPrice,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
      },
    ];
  });

  /**
   * "Exited at" mark-point — populated only when the signal is in a
   * terminal status the chart can pin to a price. The engine doesn't yet
   * expose the literal exit timestamp on the TradeSignal DTO, so we use
   * `expiresAt` as the right-edge anchor and label the marker with the
   * status. When the lifecycle DTO grows a `closedAt` we'll switch.
   *
   * A signal whose linked order filled is not "expired" in any sense the
   * chart should annotate — the signal row merely aged out of the poll
   * window after execution — so the marker is suppressed in that case.
   */
  readonly exitMarker = computed<SpotRecChartMarker | null>(() => {
    const s = this.signal();
    if (!s || !s.takeProfit || !s.stopLoss) return null;
    switch (s.status) {
      case 'Executed':
        // 'Executed' means the order was sent to the broker but not
        // necessarily that the trade has resolved. No exit marker.
        return null;
      case 'Expired':
        if (s.orderId !== null) return null;
        return {
          time: s.expiresAt,
          price: s.entryPrice,
          label: 'Expired',
          kind: 'fill', // neutral marker; not a TP/SL hit
        };
      default:
        return null;
    }
  });

  constructor() {
    effect(() => {
      const id = this.signalId();
      if (id == null) return;
      this.fetch(id);
    });
  }

  load(): void {
    const id = this.signalId();
    if (id != null) this.fetch(id);
  }

  private fetch(id: number): void {
    this.chartLoading.set(true);
    this.chartError.set(null);
    this.missing.set(null);
    this.story.set(null);
    this.storyLoading.set(true);
    this.signalsService
      .story(id)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.storyLoading.set(false);
        const st = res?.status ? res.data : null;
        if (!st) return;
        if (st.exists) {
          this.story.set(st);
        } else {
          this.missing.set({ sentence: missingSignalSentence(id, st), range: st });
        }
      });
    this.signalsService
      .getById(id)
      .pipe(
        catchError((err) => {
          this.chartError.set(err?.error?.message ?? err?.message ?? 'Failed to load signal.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.chartLoading.set(false);
        if (res?.status && res.data) {
          this.signal.set(res.data);
        } else {
          this.signal.set(null);
          if (!this.chartError()) this.chartError.set(res?.message ?? 'Signal not found.');
          if (/not found/i.test(this.chartError() ?? '')) this.loadRangeFallback(id);
        }
      });
  }

  /**
   * An engine without the story endpoint: work out the id range from the list instead, so a
   * missing id still gets an explanation. Skipped once the story has answered.
   */
  private loadRangeFallback(id: number): void {
    const one = (sortDirection: 'asc' | 'desc', filter?: object) =>
      this.signalsService
        .list({ currentPage: 1, itemCountPerPage: 1, sortBy: 'id', sortDirection, filter })
        .pipe(catchError(() => of(null)));
    forkJoin([one('asc'), one('desc')]).subscribe(([asc, desc]) => {
      if (this.missing() || this.story()) return;
      const first = asc?.data?.data?.[0] ?? null;
      const last = desc?.data?.data?.[0] ?? null;
      if (!asc?.status || !desc?.status) return;
      const range: SignalRange = {
        totalSignals: asc.data?.pager?.totalItemCount ?? null,
        earliestId: first?.id ?? null,
        earliestGeneratedAt: first?.generatedAt ?? null,
        latestId: last?.id ?? null,
        previousId: null,
        nextId: first && id < first.id ? first.id : null,
      };
      this.missing.set({ sentence: missingSignalSentence(id, range), range });
    });
  }

  /**
   * Chart is renderable only when the signal carries the minimum data
   * the chart needs (symbol + entry/SL/TP triple). Hold-direction or
   * incomplete signals skip the chart.
   */
  canChart(s: TradeSignalDto): boolean {
    return !!s.symbol && s.entryPrice != null && s.stopLoss != null && s.takeProfit != null;
  }

  /** Price precision by instrument family — JPY crosses 3 dp, metals 2 dp, else 5 dp. */
  priceFormat(s: TradeSignalDto): string {
    const sym = (s.symbol ?? '').toUpperCase();
    if (sym.startsWith('XAU') || sym.startsWith('XAG')) return '1.2-2';
    if (sym.includes('JPY')) return '1.3-3';
    return '1.5-5';
  }

  /**
   * Until the TradeSignalDto grows a `timeframe` field, default to H1 —
   * the by-far most-common spot-analysis cadence. The chart's candle
   * fetch tolerates a wrong timeframe (just shows fewer bars) so this
   * is safe to default.
   */
  tfLabel(): string {
    return 'H1';
  }

  /** The signal's orders as the attempts panel loaded them; null = unknown. */
  readonly orders = signal<OrderDto[] | null>(null);

  /**
   * Outcome label for the chart sub-line.  Distinguishes "the signal row
   * expired" (nobody acted on it) from "the signal aged out after its
   * order was placed" — the latter used to read as a plain "Expired"
   * next to a filled order, which contradicted the Orders panel.
   *
   * It reads the orders' own statuses: a linked order only proves an order
   * was PLACED. Signal #9363 said "Executed — order #70842" in green while
   * all five of its orders had been cancelled unfilled.
   */
  outcomeLabel(s: TradeSignalDto): { text: string; tone: 'ok' | 'warn' | 'neutral' } | null {
    if (s.status === 'Cancelled') {
      return { text: 'Cancelled', tone: 'warn' };
    }
    const orders = this.orders();
    if (orders && orders.length > 0) {
      const n = orders.length;
      const filled = orders.filter((o) => o.status === 'Filled' || o.status === 'PartialFill');
      if (filled.length > 0) {
        return {
          text:
            n === 1
              ? `Filled — order #${orders[0].id}`
              : `Filled on ${filled.length} of ${n} orders`,
          tone: 'ok',
        };
      }
      const working = orders.filter(
        (o) => o.status === 'Pending' || o.status === 'Submitted' || o.status === 'Cancelling',
      );
      if (working.length > 0) {
        return {
          text: `Working — ${working.length} of ${n} orders not yet filled`,
          tone: 'neutral',
        };
      }
      return {
        text:
          n === 1
            ? `Not filled — order #${orders[0].id} ${orders[0].status.toLowerCase()}`
            : `Not filled — all ${n} orders closed unfilled`,
        tone: 'warn',
      };
    }
    if (s.orderId !== null) {
      // Orders not loaded (or the lookup failed): all that is known is that one was placed.
      return { text: `Order #${s.orderId} placed`, tone: 'neutral' };
    }
    switch (s.status) {
      case 'Expired':
        return { text: 'Expired unfilled', tone: 'warn' };
      case 'Rejected':
        return { text: 'Rejected', tone: 'warn' };
      default:
        return null;
    }
  }
}
