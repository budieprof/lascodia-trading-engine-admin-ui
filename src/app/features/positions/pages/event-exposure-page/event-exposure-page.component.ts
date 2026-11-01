import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { map } from 'rxjs';

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

      <!-- Filter toolbar — venue-page family: segmented look-ahead pills and a
           toggle chip for medium-impact releases. -->
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Look ahead">
          @for (o of lookaheadOptions; track o.hours) {
            <button
              type="button"
              [class.on]="lookaheadHours() === o.hours"
              [attr.aria-pressed]="lookaheadHours() === o.hours"
              (click)="lookaheadHours.set(o.hours)"
            >
              {{ o.label }}
            </button>
          }
        </div>
        <label class="toggle" [class.on]="includeMedium()">
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
          <app-metric-card
            label="Open positions"
            [value]="d.openPositionCount"
            [dotColor]="d.openPositionCount > 0 ? '#0071E3' : '#8E8E93'"
            caption="In the selected scope"
          />
          <app-metric-card
            label="Releases ahead"
            [value]="d.events.length"
            [dotColor]="d.events.length > 0 ? '#FF9500' : '#8E8E93'"
            caption="With positions across them"
          />
          <app-metric-card
            label="Exposed to a release"
            [value]="d.exposedPositionCount"
            [dotColor]="d.exposedPositionCount > 0 ? '#FF9500' : '#8E8E93'"
            caption="Positions spanning one"
          />
          <app-metric-card
            label="Exposed lots"
            [value]="d.exposedLots"
            [dotColor]="d.exposedLots > 0 ? '#FF9500' : '#8E8E93'"
            caption="Volume across releases"
          />
          <app-metric-card
            label="Unrealised on exposed"
            [value]="d.exposedUnrealizedPnL"
            format="currency"
            [colorByValue]="true"
            caption="Open P&L at risk"
          />
          <app-metric-card
            label="Without a stop"
            [value]="unprotectedTotal()"
            [dotColor]="unprotectedTotal() > 0 ? '#FF3B30' : '#8E8E93'"
            caption="Summed per release"
          />
        </div>

        <!-- The engine's caveat, verbatim (see the class comment) — a quiet note, not a wall of text. -->
        <aside class="basis" aria-label="How to read this page">
          <span class="basis-icon" aria-hidden="true">i</span>
          <div>
            <span class="basis-title">How to read this</span>
            <p>{{ d.basis }}</p>
          </div>
        </aside>

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
      /* No global .btn-secondary exists (styles.scss only adds the press feel), so
         "← Positions" rendered as bare text. Same pill as Signal exits. */
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
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
      /* Filter toolbar — venue-page family. */
      .toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
        margin-bottom: var(--space-4);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-sm);
      }
      .seg {
        display: inline-flex;
        gap: 2px;
        padding: 3px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .seg button {
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        padding: 4px 12px;
        border-radius: var(--radius-full);
        cursor: pointer;
        white-space: nowrap;
      }
      .seg button:hover {
        color: var(--text-primary);
      }
      .seg button.on {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 32px;
        padding: 0 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
      }
      .toggle input {
        margin: 0;
        accent-color: var(--accent);
      }
      .toggle.on {
        border-color: var(--accent);
        color: var(--accent);
        background: rgba(0, 113, 227, 0.08);
      }
      .stamp {
        margin-left: auto;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .kpi-strip {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 640px) {
        .kpi-strip {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      /* The engine's statistical caveat — a quiet note card. */
      .basis {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
        margin: 0 0 var(--space-5);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-tertiary);
        border-radius: var(--radius-md);
        color: var(--text-secondary);
      }
      .basis-icon {
        flex: none;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        font-style: italic;
        font-family: Georgia, serif;
        color: var(--text-secondary);
        border: 1px solid var(--text-tertiary);
        margin-top: 1px;
      }
      .basis-title {
        display: block;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        margin-bottom: 2px;
      }
      .basis p {
        margin: 0;
        font-size: var(--text-xs);
        line-height: 1.55;
        max-width: 110ch;
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
  /** Same choices the old select offered. */
  protected readonly lookaheadOptions = [
    { hours: 4, label: '4h' },
    { hours: 8, label: '8h' },
    { hours: 24, label: '24h' },
    { hours: 72, label: '3d' },
    { hours: 168, label: '7d' },
  ];
  protected readonly includeMedium = signal(false);

  protected readonly resource = createPolledResource<EventExposureDto | null>(
    () =>
      // No catchError: a swallowed failure left the last good snapshot (or
      // nothing) on screen with no error surfaced. The polled resource records
      // the error and the template renders the retry state.
      this.positions
        .getEventExposure(this.lookaheadHours(), this.includeMedium())
        .pipe(map((res) => res.data ?? null)),
    // The countdown ticks in minutes, so nothing here needs a fast poll — the
    // exposure set only changes when a position opens or closes, which is pushed.
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 60_000,
      refreshOn: ['positionOpened', 'positionClosed', 'positionLifecycleEvent', 'orderFilled'],
      // The effect below runs once on creation and issues the first fetch;
      // running immediately as well sent the request twice on every open, the
      // first aborted by the effect's refresh() (the crawl's "FAILED" entry).
      runImmediately: false,
    },
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
      untracked(() => this.resource.refresh());
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
