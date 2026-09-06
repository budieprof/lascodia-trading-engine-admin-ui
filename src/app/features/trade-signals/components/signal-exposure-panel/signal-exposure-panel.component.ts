import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import type { LiveExposureDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

const EMPTY: LiveExposureDto = {
  asOfUtc: '',
  openCount: 0,
  pendingCount: 0,
  crowdedThreshold: 3,
  currencies: [],
  signals: [],
};

/**
 * Live Signal Book — the engine's current NET cross-currency exposure across every
 * not-yet-resolved signal, derived SOLELY from signal walk status (position-independent,
 * no account link). Surfaces the concentration that the 8659–8666 long-USD cluster hid:
 * a wall of same-direction currency legs is ONE bet, not many. Same data the analysis
 * prompt now injects, shown to the operator.
 */
@Component({
  selector: 'app-signal-exposure-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    RouterLink,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="Live signal book — net currency exposure">
      <header class="panel-head">
        <div class="panel-title">
          <h3>Live signal book</h3>
          <span
            class="muted small"
            title="Walk status, not queue status: 'in play' = entry triggered and neither SL nor TP hit yet; 'armed' = waiting for the entry to trigger. Independent of the Pending / Approved counts below."
          >
            {{ book().openCount }} in play · {{ book().pendingCount }} armed
            @if (book().asOfUtc) {
              · updated {{ book().asOfUtc | relativeTime }}
            }
          </span>
        </div>
        <button
          type="button"
          class="btn btn-ghost"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
          title="Re-walk the book now"
        >
          {{ resource.loading() ? 'Refreshing…' : 'Refresh' }}
        </button>
      </header>

      <ui-progress-bar [active]="resource.loading()" />

      @if (loading()) {
        <app-card-skeleton [lines]="4" />
      } @else if (failed()) {
        <app-error-state
          title="Could not load the signal book"
          message="The exposure walk failed — the book is unknown, not flat."
          (retry)="resource.refresh()"
        />
      } @else if (currencies().length === 0) {
        <app-empty-state
          title="Book is flat"
          description="No in-play or armed signals — no net currency exposure right now."
        />
      } @else {
        <p class="hint muted small">
          Net exposure per currency across not-yet-resolved signals. Correlated same-direction legs
          are ONE concentrated bet — a bar flagged CROWDED is where a fresh same-side signal adds
          risk rather than a new idea.
        </p>
        <ul class="ccy-list">
          @for (c of currencies(); track c.currency) {
            <li class="ccy-row" [class.crowded]="abs(c.net) >= crowded()">
              <span class="ccy">{{ c.currency }}</span>
              <span
                class="net"
                [class.long]="c.net > 0"
                [class.short]="c.net < 0"
                [class.flat]="c.net === 0"
              >
                {{ c.net > 0 ? '+' : '' }}{{ c.net }}
              </span>
              <span class="bar-track" aria-hidden="true">
                <span
                  class="bar"
                  [class.long]="c.net > 0"
                  [class.short]="c.net < 0"
                  [style.width.%]="barWidth(c.net)"
                ></span>
              </span>
              <span class="legs muted small">
                {{ c.longCount }} long / {{ c.shortCount }} short
              </span>
              @if (abs(c.net) >= crowded()) {
                <span class="badge-crowded">CROWDED</span>
              }
            </li>
          }
        </ul>

        @if (book().signals.length > 0) {
          <details class="signals">
            <summary class="muted small">{{ book().signals.length }} in-play signal(s)</summary>
            <table class="sig-table">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Symbol</th>
                  <th>Dir</th>
                  <th>Status</th>
                  <th class="num">Conf</th>
                  <th class="num">Walk pips</th>
                </tr>
              </thead>
              <tbody>
                @for (s of book().signals; track s.signalId) {
                  <tr>
                    <td>
                      <a [routerLink]="['/trade-signals', s.signalId]">#{{ s.signalId }}</a>
                    </td>
                    <td>{{ s.symbol }}</td>
                    <td [class.buy]="s.direction === 'Buy'" [class.sell]="s.direction === 'Sell'">
                      {{ s.direction }}
                    </td>
                    <td>
                      <span class="pill" [class.open]="s.status === 'Open'">{{ s.status }}</span>
                    </td>
                    <td class="num">{{ s.confidence | number: '1.2-2' }}</td>
                    <td class="num" [class.pos]="s.walkPipPnL > 0" [class.neg]="s.walkPipPnL < 0">
                      {{ s.walkPipPnL > 0 ? '+' : '' }}{{ s.walkPipPnL | number: '1.1-1' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
        }
      }
    </section>
  `,
  styles: [
    `
      /* Only app tokens here — the previous \`var(--surface, #fff)\` /
         \`var(--border-color, …)\` names do not exist in _tokens.scss, so the
         white fallbacks won and the card rendered white-on-white in the
         dark theme. */
      .panel {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        margin-bottom: var(--space-1);
      }
      .panel-title {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .panel-title h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .hint {
        margin: var(--space-1) 0 var(--space-3);
        color: var(--text-secondary);
      }
      .ccy-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .ccy-row {
        display: grid;
        grid-template-columns: 3rem 2.6rem 1fr auto auto;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-sm);
      }
      .ccy-row.crowded {
        background: rgba(255, 149, 0, 0.1);
      }
      .ccy {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .net {
        font-variant-numeric: tabular-nums;
        font-weight: var(--font-semibold);
        text-align: right;
      }
      .net.long,
      .pos {
        color: var(--profit);
      }
      .net.short,
      .neg {
        color: var(--loss);
      }
      .net.flat {
        color: var(--text-tertiary);
      }
      .bar-track {
        position: relative;
        height: 8px;
        background: var(--bg-tertiary);
        border-radius: 4px;
        overflow: hidden;
      }
      .bar {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        border-radius: 4px;
      }
      .bar.long {
        background: var(--profit);
        transform: translateX(0);
      }
      .bar.short {
        background: var(--loss);
        transform: translateX(-100%);
      }
      .legs {
        white-space: nowrap;
      }
      .badge-crowded {
        font-size: 10px;
        font-weight: var(--font-bold);
        letter-spacing: 0.04em;
        color: #fff;
        background: var(--warning);
        padding: 1px 7px;
        border-radius: var(--radius-full);
      }
      .signals {
        margin-top: var(--space-3);
      }
      .signals summary {
        cursor: pointer;
        color: var(--text-secondary);
      }
      .sig-table {
        width: 100%;
        border-collapse: collapse;
        margin-top: var(--space-2);
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .sig-table th,
      .sig-table td {
        text-align: left;
        padding: var(--space-1) var(--space-2);
        border-bottom: 1px solid var(--border);
      }
      .sig-table th {
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
      }
      .sig-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .sig-table a {
        color: var(--accent);
        text-decoration: none;
      }
      .sig-table a:hover {
        text-decoration: underline;
      }
      .buy {
        color: var(--profit);
      }
      .sell {
        color: var(--loss);
      }
      .pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        padding: 1px 7px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .pill.open {
        background: rgba(52, 199, 89, 0.15);
        color: var(--profit);
      }
      .btn {
        height: 28px;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
        border-radius: var(--radius-sm);
        padding: 0 var(--space-3);
        cursor: pointer;
        font-size: var(--text-xs);
        font-family: inherit;
      }
      .btn:hover:not(:disabled) {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
    `,
  ],
})
export class SignalExposurePanelComponent {
  private readonly marketData = inject(MarketDataService);

  protected readonly abs = Math.abs;

  readonly failed = signal(false);

  protected readonly resource = createPolledResource<LiveExposureDto>(
    () =>
      this.marketData.getSignalExposure(false).pipe(
        map((res) => {
          this.failed.set(!res.status);
          return res.data ?? EMPTY;
        }),
        catchError(() => {
          this.failed.set(true);
          return of(EMPTY);
        }),
      ),
    { intervalMs: 20_000 },
  );

  readonly book = computed(() => this.resource.value() ?? EMPTY);
  readonly currencies = computed(() => this.book().currencies);
  readonly crowded = computed(() => this.book().crowdedThreshold || 3);
  readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  /** Bar width as a % of the panel's half-track, scaled to the largest |net| in the book. */
  barWidth(net: number): number {
    const max = Math.max(1, ...this.currencies().map((c) => Math.abs(c.net)));
    return Math.round((Math.abs(net) / max) * 100);
  }
}
