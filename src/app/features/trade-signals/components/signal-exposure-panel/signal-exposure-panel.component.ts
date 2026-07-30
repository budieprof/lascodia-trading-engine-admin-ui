import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import type { LiveExposureDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
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
    CardSkeletonComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="Live signal book — net currency exposure">
      <header class="panel-head">
        <div class="panel-title">
          <h3>Live signal book</h3>
          <span class="muted small">
            {{ book().openCount }} open · {{ book().pendingCount }} armed
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
      } @else if (currencies().length === 0) {
        <app-empty-state
          title="Book is flat"
          description="No open or armed signals — no net currency exposure right now."
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
                    <td>#{{ s.signalId }}</td>
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
      .panel {
        border: 1px solid var(--border-color, #e5e5ea);
        border-radius: 12px;
        padding: 1rem 1.15rem;
        background: var(--surface, #fff);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: 0.35rem;
      }
      .panel-title {
        display: flex;
        align-items: baseline;
        gap: 0.6rem;
      }
      .panel-title h3 {
        margin: 0;
        font-size: 1rem;
      }
      .muted {
        color: var(--text-muted, #8e8e93);
      }
      .small {
        font-size: 0.8rem;
      }
      .hint {
        margin: 0.3rem 0 0.7rem;
      }
      .ccy-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .ccy-row {
        display: grid;
        grid-template-columns: 3rem 2.6rem 1fr auto auto;
        align-items: center;
        gap: 0.6rem;
        padding: 0.2rem 0.4rem;
        border-radius: 8px;
      }
      .ccy-row.crowded {
        background: rgba(255, 149, 0, 0.08);
      }
      .ccy {
        font-weight: 600;
      }
      .net {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        text-align: right;
      }
      .net.long,
      .pos {
        color: #34c759;
      }
      .net.short,
      .neg {
        color: #ff3b30;
      }
      .net.flat {
        color: #8e8e93;
      }
      .bar-track {
        position: relative;
        height: 8px;
        background: rgba(142, 142, 147, 0.15);
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
        background: #34c759;
        transform: translateX(0);
      }
      .bar.short {
        background: #ff3b30;
        transform: translateX(-100%);
      }
      .badge-crowded {
        font-size: 0.66rem;
        font-weight: 700;
        letter-spacing: 0.03em;
        color: #fff;
        background: #ff9500;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
      }
      .signals {
        margin-top: 0.8rem;
      }
      .signals summary {
        cursor: pointer;
      }
      .sig-table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 0.5rem;
        font-size: 0.82rem;
      }
      .sig-table th,
      .sig-table td {
        text-align: left;
        padding: 0.25rem 0.4rem;
        border-bottom: 1px solid var(--border-color, #f0f0f2);
      }
      .sig-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .buy {
        color: #34c759;
      }
      .sell {
        color: #ff3b30;
      }
      .pill {
        font-size: 0.7rem;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: rgba(142, 142, 147, 0.15);
      }
      .pill.open {
        background: rgba(52, 199, 89, 0.15);
        color: #248a3d;
      }
      .btn {
        border: 1px solid var(--border-color, #e5e5ea);
        background: transparent;
        border-radius: 8px;
        padding: 0.3rem 0.7rem;
        cursor: pointer;
        font-size: 0.85rem;
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

  protected readonly resource = createPolledResource<LiveExposureDto>(
    () =>
      this.marketData.getSignalExposure(false).pipe(
        map((res) => res.data ?? EMPTY),
        catchError(() => of(EMPTY)),
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
