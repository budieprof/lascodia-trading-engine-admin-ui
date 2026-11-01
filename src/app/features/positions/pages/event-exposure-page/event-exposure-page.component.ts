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

import {
  PositionsService,
  type EventExposureDto,
  type ExposedEventDto,
} from '@core/services/positions.service';
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
          <div class="ev-list-head">
            <h3>Releases ahead</h3>
            <span class="count">{{ d.events.length }}</span>
            <span class="hint"
              >soonest first · each table lists the open positions sitting across it</span
            >
          </div>
          @for (ev of d.events; track ev.eventId) {
            <section
              class="ev-card"
              [class.imminent]="ev.minutesUntil <= 60"
              [attr.aria-label]="ev.currency + ' ' + ev.title"
            >
              <header class="ev-head">
                <div class="ev-when" [class.imminent]="ev.minutesUntil <= 60">
                  <span class="ev-in">in</span>
                  <span class="ev-countdown">{{ formatCountdown(ev.minutesUntil) }}</span>
                  <span class="ev-at"
                    >{{ ev.scheduledAtUtc | date: 'EEE MMM d · HH:mm' : 'UTC' }} UTC</span
                  >
                </div>
                <div class="ev-main">
                  <div class="ev-title">
                    <span class="ccy">{{ ev.currency }}</span>
                    <strong>{{ ev.title }}</strong>
                    <span class="impact" [class.high]="ev.impact === 'High'">{{ ev.impact }}</span>
                    @if (!ev.hasConsensus) {
                      <span
                        class="impact"
                        title="No consensus forecast is published, so this release cannot be read in surprise terms at all."
                        >no consensus</span
                      >
                    }
                  </div>
                  <div class="ev-facts">
                    <span
                      >Forecast <b>{{ ev.forecast ?? '—' }}</b></span
                    >
                    <span
                      >Previous <b>{{ ev.previous ?? '—' }}</b></span
                    >
                  </div>
                  <div
                    class="ev-track"
                    [title]="
                      'Release lands ' +
                      windowShare(ev.minutesUntil) +
                      '% of the way into the ' +
                      lookaheadLabel() +
                      ' window'
                    "
                  >
                    <span
                      class="ev-track-fill"
                      [style.width.%]="windowShare(ev.minutesUntil)"
                    ></span>
                  </div>
                </div>
                <dl class="ev-sum">
                  <div>
                    <dt>Positions</dt>
                    <dd>{{ ev.positionCount }}</dd>
                  </div>
                  <div>
                    <dt>Lots</dt>
                    <dd>{{ ev.totalLots | number: '1.0-2' }}</dd>
                  </div>
                  <div>
                    <dt>Unrealised</dt>
                    <dd
                      [class.pos]="ev.totalUnrealizedPnL > 0"
                      [class.neg]="ev.totalUnrealizedPnL < 0"
                    >
                      {{ ev.totalUnrealizedPnL | number: '1.2-2' }}
                    </dd>
                  </div>
                  <div>
                    <dt>Without a stop</dt>
                    <dd [class.neg]="ev.unprotectedPositionCount > 0">
                      {{ ev.unprotectedPositionCount }}
                    </dd>
                  </div>
                </dl>
              </header>

              <div class="table-wrap">
                <table class="ev-table">
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th>Account</th>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th class="num">Lots</th>
                      <th class="num">Unrealised</th>
                      <th class="num">Stop</th>
                      <th class="num">Target</th>
                      <th class="num">Open for</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (p of ev.positions; track p.positionId) {
                      <tr [class.unprotected]="!p.hasStopLoss">
                        <td>
                          <a class="mono" [routerLink]="['/positions', p.positionId]"
                            >#{{ p.positionId }}</a
                          >
                        </td>
                        <td class="mono dim">#{{ p.tradingAccountId }}</td>
                        <td class="strong">{{ p.symbol }}</td>
                        <td>
                          <span
                            class="side"
                            [class.long]="isLong(p.direction)"
                            [class.short]="!isLong(p.direction)"
                            >{{ p.direction }}</span
                          >
                        </td>
                        <td class="num">{{ p.lots | number: '1.0-2' }}</td>
                        <td
                          class="num strong"
                          [class.neg]="p.unrealizedPnL < 0"
                          [class.pos]="p.unrealizedPnL > 0"
                        >
                          {{ p.unrealizedPnL | number: '1.2-2' }}
                        </td>
                        <td class="num mono">
                          @if (p.hasStopLoss) {
                            {{ price(p.stopLoss, ev, p.symbol) }}
                          } @else {
                            <span class="no-stop">none</span>
                          }
                        </td>
                        <td class="num mono dim">{{ price(p.takeProfit, ev, p.symbol) }}</td>
                        <td
                          class="num dim"
                          [title]="
                            'Opened ' + (p.openedAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC') + ' UTC'
                          "
                        >
                          {{ formatCountdown(p.ageMinutes) }}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }
        }
      }
    </div>
  `,
  styleUrl: './event-exposure-page.component.scss',
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

  protected readonly lookaheadLabel = computed(
    () =>
      this.lookaheadOptions.find((o) => o.hours === this.lookaheadHours())?.label ??
      `${this.lookaheadHours()}h`,
  );

  /** How far into the look-ahead window the release lands, 0–100 (the bar under its title). */
  protected windowShare(minutesUntil: number): number {
    const total = this.lookaheadHours() * 60;
    return total > 0 ? Math.round(Math.min(100, Math.max(2, (minutesUntil / total) * 100))) : 0;
  }

  /**
   * A stop / target with as many decimals as the most precise price of that symbol in the release,
   * so "1.119" and "1.11909" line up as "1.11900" and "1.11909".
   */
  protected price(v: number | null, ev: ExposedEventDto, symbol: string): string {
    if (v === null || !Number.isFinite(v)) return '—';
    const decimals = (x: number | null) =>
      x === null ? 0 : (String(x).split('.')[1] ?? '').length;
    const places = Math.min(
      6,
      Math.max(
        ...ev.positions
          .filter((p) => p.symbol === symbol)
          .flatMap((p) => [decimals(p.stopLoss), decimals(p.takeProfit)]),
      ),
    );
    return v.toFixed(places);
  }

  protected isLong(direction: string): boolean {
    return /^(long|buy)$/i.test(direction);
  }

  protected formatCountdown(minutes: number): string {
    const m = Math.max(0, minutes);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }
}
