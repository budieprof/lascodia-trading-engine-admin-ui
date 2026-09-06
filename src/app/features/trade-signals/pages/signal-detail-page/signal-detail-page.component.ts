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
import { catchError, map, of } from 'rxjs';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { TradeSignalDto } from '@core/api/api.types';
import { AccountAttemptsComponent } from '../../components/account-attempts/account-attempts.component';
import {
  SpotRecChartComponent,
  SpotRecChartMarker,
  SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

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
  ],
  template: `
    <div class="page">
      <app-page-header
        [title]="'Signal #' + (signalId() ?? '—')"
        subtitle="Cross-account attempts for this signal — every EA that polled it, every rejection it hit, and every engine / broker outcome that followed."
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
        <a class="btn btn-secondary" routerLink="/trade-signals">← All signals</a>
      </app-page-header>

      @if (signalId() !== null) {
        @if (signal(); as s) {
          <!-- Chart pane — renders only when the signal has resolvable
               symbol + actionable prices. Hold-only / malformed signals
               skip the chart silently. -->
          @if (canChart(s)) {
            <section class="chart-section">
              <header class="section-head">
                <h2>Chart — Entry / SL / TP overlay</h2>
                <div class="section-sub muted">
                  {{ s.symbol }} · {{ tfLabel() }} · generated
                  {{ s.generatedAt | date: 'MMM d, HH:mm' }} UTC · entry
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

        <app-account-attempts [signalId]="signalId()" [signal]="signal()" />
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
        } else if (!this.chartError()) {
          this.chartError.set(res?.message ?? 'Signal not found.');
        }
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

  /**
   * Outcome label for the chart sub-line.  Distinguishes "the signal row
   * expired" (nobody acted on it) from "the signal aged out after its
   * order was placed" — the latter used to read as a plain "Expired"
   * next to a filled order, which contradicted the Orders panel.
   */
  outcomeLabel(s: TradeSignalDto): { text: string; tone: 'ok' | 'warn' | 'neutral' } | null {
    if (s.orderId !== null) {
      return { text: `Executed — order #${s.orderId}`, tone: 'ok' };
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
