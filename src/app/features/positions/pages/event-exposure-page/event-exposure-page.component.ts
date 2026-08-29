import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { PositionsService, type EventExposureDto } from '@core/services/positions.service';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/**
 * Which open positions are about to straddle a high-impact release.
 *
 * <p>Deliberately a reporting screen with no close button. Positions spanning a Tier-1 release in
 * one of their own currencies won 14.0pp less often over 90 days, but the same study could not
 * establish a P&L cost — so the page shows the exposure and stops there. The engine's `basis`
 * string is rendered verbatim beneath the tiles rather than paraphrased, because a paraphrase is
 * where the caveat would quietly go missing.</p>
 */
@Component({
  selector: 'app-event-exposure-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Event exposure"
        subtitle="Open positions sitting across an upcoming high-impact release"
      >
        <a routerLink="/positions" class="btn btn-secondary">← Positions</a>
      </app-page-header>

      <div class="filter-row">
        <label>
          Look ahead
          <select [(ngModel)]="lookaheadHours">
            <option [ngValue]="4">4 hours</option>
            <option [ngValue]="8">8 hours</option>
            <option [ngValue]="24">24 hours</option>
            <option [ngValue]="72">3 days</option>
            <option [ngValue]="168">7 days</option>
          </select>
        </label>
        <label class="check">
          <input type="checkbox" [(ngModel)]="includeMedium" />
          Include medium impact
        </label>
        @if (data(); as d) {
          <span class="stamp">as of {{ d.generatedAtUtc | date: 'HH:mm:ss' : 'UTC' }} UTC</span>
        }
      </div>

      @if (resource.loading() && !data()) {
        <app-card-skeleton />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load event exposure"
          message="The engine did not answer. Exposure may exist that is not shown here."
          (retry)="resource.refresh()"
        />
      } @else if (data(); as d) {
        <div class="kpi-strip">
          <app-metric-card label="Open positions" [value]="d.openPositionCount" />
          <app-metric-card
            label="Exposed to a release"
            [value]="d.exposedPositionCount"
            [dotColor]="d.exposedPositionCount > 0 ? 'var(--warn)' : undefined"
          />
          <app-metric-card label="Exposed lots" [value]="d.exposedLots" />
          <app-metric-card
            label="Unrealised on exposed"
            [value]="d.exposedUnrealizedPnL"
            format="currency"
            [colorByValue]="true"
          />
          <app-metric-card
            label="Without a stop"
            [value]="unprotectedTotal()"
            [dotColor]="unprotectedTotal() > 0 ? 'var(--danger)' : undefined"
          />
        </div>

        <p class="basis">{{ d.basis }}</p>

        @if (d.events.length === 0) {
          <app-empty-state
            title="Nothing exposed"
            [description]="
              d.openPositionCount === 0
                ? 'The book is flat — no open positions to expose.'
                : 'No high-impact release lands in this window for the currencies you are holding.'
            "
          />
        } @else {
          @for (ev of d.events; track ev.eventId) {
            <div class="data-table-card">
              <div class="board-head">
                <div class="ev-title">
                  <span class="ccy">{{ ev.currency }}</span>
                  <strong>{{ ev.title }}</strong>
                  <span class="impact" [class.high]="ev.impact === 'High'">{{ ev.impact }}</span>
                  @if (!ev.hasConsensus) {
                    <span
                      class="no-consensus"
                      title="No consensus forecast is published, so this release cannot be read in surprise terms at all."
                      >no consensus</span
                    >
                  }
                </div>
                <div class="ev-meta">
                  <span class="countdown" [class.imminent]="ev.minutesUntil <= 60">
                    in {{ formatCountdown(ev.minutesUntil) }}
                  </span>
                  <span>{{ ev.scheduledAtUtc | date: 'MMM d HH:mm' : 'UTC' }} UTC</span>
                  <span
                    >{{ ev.positionCount }} position(s) ·
                    {{ ev.totalLots | number: '1.0-2' }} lots</span
                  >
                  @if (ev.unprotectedPositionCount > 0) {
                    <span class="danger">{{ ev.unprotectedPositionCount }} without a stop</span>
                  }
                </div>
              </div>

              <table class="board-table">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Symbol</th>
                    <th>Dir</th>
                    <th class="num">Lots</th>
                    <th class="num">Unrealised</th>
                    <th class="num">Age</th>
                    <th>Stop</th>
                    <th class="num">Acct</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of ev.positions; track p.positionId) {
                    <tr [class.unprotected]="!p.hasStopLoss">
                      <td>
                        <a [routerLink]="['/positions', p.positionId]">#{{ p.positionId }}</a>
                      </td>
                      <td>{{ p.symbol }}</td>
                      <td>{{ p.direction }}</td>
                      <td class="num">{{ p.lots | number: '1.0-2' }}</td>
                      <td
                        class="num"
                        [class.neg]="p.unrealizedPnL < 0"
                        [class.pos]="p.unrealizedPnL > 0"
                      >
                        {{ p.unrealizedPnL | number: '1.2-2' }}
                      </td>
                      <td class="num">{{ formatCountdown(p.ageMinutes) }}</td>
                      <td>
                        @if (p.hasStopLoss) {
                          {{ p.stopLoss }}
                        } @else {
                          <span class="danger">none</span>
                        }
                      </td>
                      <td class="num">{{ p.tradingAccountId }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      .filter-row {
        display: flex;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
        margin-bottom: 1rem;
      }
      .filter-row label {
        display: flex;
        gap: 0.4rem;
        align-items: center;
        font-size: 0.875rem;
      }
      .filter-row .stamp {
        margin-left: auto;
        font-size: 0.8125rem;
        opacity: 0.65;
      }
      .basis {
        font-size: 0.8125rem;
        line-height: 1.5;
        opacity: 0.75;
        margin: 0.75rem 0 1.5rem;
        max-width: 90ch;
      }
      .data-table-card {
        margin-bottom: 1.25rem;
      }
      .board-head {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        align-items: baseline;
      }
      .ev-title {
        display: flex;
        gap: 0.5rem;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .ev-meta {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
        font-size: 0.8125rem;
        opacity: 0.8;
      }
      .ccy {
        font-weight: 600;
        opacity: 0.7;
      }
      .impact,
      .no-consensus {
        font-size: 0.6875rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.1rem 0.4rem;
        border-radius: 3px;
        border: 1px solid currentColor;
        opacity: 0.7;
      }
      .impact.high {
        color: var(--warn, #d08700);
        opacity: 1;
      }
      .countdown.imminent {
        color: var(--warn, #d08700);
        font-weight: 600;
      }
      .danger {
        color: var(--danger, #c0392b);
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      td.pos {
        color: var(--success, #1a7f37);
      }
      td.neg {
        color: var(--danger, #c0392b);
      }
      tr.unprotected td {
        background: color-mix(in srgb, var(--danger, #c0392b) 6%, transparent);
      }
    `,
  ],
})
export class EventExposurePageComponent {
  private readonly positions = inject(PositionsService);

  protected readonly lookaheadHours = signal(24);
  protected readonly includeMedium = signal(false);

  protected readonly resource = createPolledResource<EventExposureDto | null>(
    () =>
      this.positions.getEventExposure(this.lookaheadHours(), this.includeMedium()).pipe(
        map((res) => res.data ?? null),
        catchError(() => of(null)),
      ),
    // Matches the open-positions P&L cadence in PRD §10: the countdown ticks in minutes, and a
    // faster poll would add load without changing any decision this screen supports.
    { intervalMs: 15_000 },
  );

  protected readonly data = this.resource.value;

  /**
   * Summed across events on purpose, unlike the exposed-position count. A position with no stop
   * that straddles three releases is three separate occasions to be run over, and collapsing it to
   * one would understate the thing this tile exists to flag.
   */
  protected readonly unprotectedTotal = computed(
    () => this.data()?.events.reduce((n, e) => n + e.unprotectedPositionCount, 0) ?? 0,
  );

  constructor() {
    effect(() => {
      this.lookaheadHours();
      this.includeMedium();
      this.resource.refresh();
    });
  }

  protected formatCountdown(minutes: number): string {
    const m = Math.max(0, minutes);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }
}
