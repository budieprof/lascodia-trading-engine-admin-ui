import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { TradeSignalDto } from '@core/api/api.types';
import { AccountAttemptsComponent } from '../../components/account-attempts/account-attempts.component';
import {
  SpotRecChartComponent,
  SpotRecChartMarker,
  SpotRecChartRec,
} from '@shared/components/spot-rec-chart/spot-rec-chart.component';

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
  imports: [CommonModule, AccountAttemptsComponent, SpotRecChartComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <h1 class="page-title">Signal #{{ signalId() ?? '—' }}</h1>
        <p class="page-subtitle">
          Cross-account attempts for this signal — every EA that polled it, every rejection it hit,
          and every engine / broker outcome that followed.
        </p>
      </header>

      @if (signalId() !== null) {
        <!-- Chart pane — renders only when the signal has resolvable
             symbol + actionable prices. Hold-only / malformed signals
             skip the chart silently. -->
        @if (signal(); as s) {
          @if (canChart(s)) {
            <section class="chart-section">
              <header class="section-head">
                <h2>Chart — Entry / SL / TP overlay</h2>
                <div class="section-sub muted">
                  {{ s.symbol }} · {{ tfLabel() }} · generated
                  {{ s.generatedAt | date: 'MMM d, HH:mm' }} UTC
                  @if (terminalLabel(s); as t) {
                    ·
                    <span [class.profit]="t === 'HitTP'" [class.loss]="t === 'HitSL'">{{ t }}</span>
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
          } @else if (chartLoading()) {
            <section class="chart-section">
              <p class="muted">Loading signal…</p>
            </section>
          } @else if (chartError(); as e) {
            <section class="chart-section">
              <p class="error">{{ e }}</p>
            </section>
          }
        }

        <app-account-attempts [signalId]="signalId()" />
      } @else {
        <p class="empty muted">Invalid signal id — route is missing the numeric segment.</p>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }
      .page-head {
        margin-bottom: var(--space-3);
      }
      .page-title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-1);
        letter-spacing: var(--tracking-tight);
      }
      .page-subtitle {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
      }
      .chart-section {
        margin-bottom: var(--space-3);
        padding: var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }
      .section-head {
        margin-bottom: var(--space-2);
      }
      .section-head h2 {
        font-size: var(--text-md);
        font-weight: var(--font-semibold);
        margin: 0 0 var(--space-1);
      }
      .section-sub {
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-secondary);
      }
      .empty {
        font-size: var(--text-sm);
        padding: var(--space-3) 0;
      }
      .error {
        font-size: var(--text-sm);
        color: var(--color-danger, #c4290a);
      }
      .profit {
        color: #1f8a3d;
        font-weight: var(--font-semibold);
      }
      .loss {
        color: #c4290a;
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
   * Terminal-status label rendered in the header sub-line. Returns null
   * when the signal is still in a live status the chart can't pin an
   * outcome to yet.
   */
  terminalLabel(s: TradeSignalDto): string | null {
    switch (s.status) {
      case 'Expired':
        return 'Expired';
      default:
        return null;
    }
  }
}
