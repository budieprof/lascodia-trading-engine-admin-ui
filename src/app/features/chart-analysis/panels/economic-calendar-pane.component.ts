import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';

import {
  EconomicCalendarService,
  type EconomicImpact,
  type UpcomingEconomicEvent,
} from '@core/services/economic-calendar.service';
import { ServerClock } from '@core/time/server-clock';
import { currencyFlag, eventCountdown, groupByDay, impactDots } from './economic-calendar';

/**
 * The chart's economic-calendar side pane: upcoming releases (the last 6 hours through 7 days),
 * the chart pair's two currencies by default, all currencies on a toggle, grouped by day with
 * importance dots, previous / forecast / actual and a live countdown for soon events. Clicking a
 * row asks the page to open the event's AI reading.
 */
@Component({
  selector: 'app-economic-calendar-pane',
  standalone: true,
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree-title">
      Economic calendar · {{ allCurrencies() ? 'all' : currencies().join(' / ') }}
    </div>
    <div class="ec-filters">
      <label
        ><input
          type="checkbox"
          [checked]="allCurrencies()"
          (change)="allCurrencies.set($any($event.target).checked)"
          data-testid="ec-all"
        />
        All currencies</label
      >
      <select
        [value]="minImpact()"
        (change)="minImpact.set($any($event.target).value)"
        aria-label="Minimum importance"
      >
        <option value="Low">All importance</option>
        <option value="Medium">Medium +</option>
        <option value="High">High only</option>
      </select>
    </div>
    @if (loading() && !events().length) {
      <div class="pane-empty">Loading…</div>
    } @else if (error()) {
      <div class="pane-empty">{{ error() }}</div>
    } @else if (!events().length) {
      <div class="pane-empty">No events in the next 7 days.</div>
    } @else {
      @for (day of days(); track day.key) {
        <div class="ec-day">{{ day.dayMs | date: 'EEE d MMM' }}</div>
        <ul class="ec-list">
          @for (e of day.events; track e.id) {
            <li
              class="ec-row"
              [class.released]="!!e.actual"
              (click)="opened.emit(e)"
              data-testid="ec-event"
              [title]="'Open the AI reading of ' + e.title"
            >
              <div class="ec-top">
                <span class="ec-time">{{ e.scheduledAt | date: 'HH:mm' }}</span>
                <span class="ec-ccy">{{ flag(e.currency) }} {{ e.currency }}</span>
                <span class="ec-dots" [attr.aria-label]="e.impact + ' importance'">
                  @for (i of [1, 2, 3]; track i) {
                    <i [class.on]="i <= dots(e.impact)" [class.high]="dots(e.impact) === 3"></i>
                  }
                </span>
                @if (countdown(e); as c) {
                  <span class="ec-count">{{ c }}</span>
                }
              </div>
              <div class="ec-title">{{ e.title }}</div>
              <div class="ec-nums">
                <span
                  >Prev <b>{{ e.previous ?? '—' }}</b></span
                >
                <span
                  [title]="
                    e.forecastProvenance === 'PreRelease' || !e.forecast
                      ? ''
                      : 'Forecast not captured before the release (' + e.forecastProvenance + ')'
                  "
                  >Fcst <b>{{ e.forecast ?? '—' }}</b
                  >{{ e.forecast && e.forecastProvenance !== 'PreRelease' ? '*' : '' }}</span
                >
                <span
                  >Act <b class="ec-act">{{ e.actual ?? '—' }}</b></span
                >
              </div>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .tree-title {
        padding: 2px 10px 6px;
        font-weight: 600;
        color: var(--text-muted, #787b86);
      }
      .ec-filters {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: space-between;
        padding: 0 10px 8px;
        font-size: 12px;
        color: var(--tv-muted, #787b86);
      }
      .ec-filters select {
        font: inherit;
        color: inherit;
        background: transparent;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 4px;
        padding: 1px 4px;
      }
      .ec-day {
        padding: 8px 12px 4px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--tv-muted, #787b86);
      }
      .ec-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .ec-row {
        padding: 7px 12px;
        border-bottom: 1px solid var(--tv-line, #e0e3eb);
        cursor: pointer;
        font-size: 12px;
      }
      .ec-row:hover {
        background: var(--tv-hover, #f0f3fa);
      }
      .ec-top {
        display: flex;
        gap: 8px;
        align-items: center;
        color: var(--tv-muted, #787b86);
      }
      .ec-time {
        font-variant-numeric: tabular-nums;
        color: var(--tv-ink, #131722);
        font-weight: 600;
      }
      .ec-dots {
        display: inline-flex;
        gap: 2px;
      }
      .ec-dots i {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--tv-line, #e0e3eb);
      }
      .ec-dots i.on {
        background: #f7a600;
      }
      .ec-dots i.on.high {
        background: #f23645;
      }
      .ec-count {
        margin-left: auto;
        font-variant-numeric: tabular-nums;
        color: var(--tv-blue, #2962ff);
      }
      .ec-title {
        margin: 2px 0;
        color: var(--tv-ink, #131722);
        line-height: 1.35;
      }
      .ec-nums {
        display: flex;
        gap: 12px;
        color: var(--tv-muted, #787b86);
        font-variant-numeric: tabular-nums;
      }
      .ec-nums b {
        font-weight: 600;
        color: var(--tv-ink, #131722);
      }
      .released .ec-act {
        color: var(--tv-blue, #2962ff);
      }
    `,
  ],
})
export class EconomicCalendarPaneComponent {
  /** The chart pair's currencies (base, quote). */
  readonly currencies = input<string[]>([]);
  readonly allCurrencies = model(false);
  readonly minImpact = model<EconomicImpact>('Low');
  readonly opened = output<UpcomingEconomicEvent>();

  private readonly calendar = inject(EconomicCalendarService);
  private readonly clock = inject(ServerClock);
  private readonly destroyRef = inject(DestroyRef);

  readonly events = signal<UpcomingEconomicEvent[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private readonly now = signal(Date.now());
  readonly days = computed(() => groupByDay(this.events()));
  private seq = 0;

  constructor() {
    effect(() => {
      const all = this.allCurrencies();
      const ccy = this.currencies();
      const min = this.minImpact();
      untracked(() => this.load(all ? [] : ccy, min));
    });
    // Countdowns tick each second; the list itself refreshes every 5 minutes (actuals land).
    const tick = setInterval(() => {
      if (!document.hidden) this.now.set(this.clock.now());
    }, 1000);
    const refresh = setInterval(() => {
      if (!document.hidden)
        this.load(this.allCurrencies() ? [] : this.currencies(), this.minImpact());
    }, 300_000);
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      clearInterval(refresh);
    });
  }

  private load(currencies: string[], minImpact: EconomicImpact): void {
    const n = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    const sub = this.calendar
      .upcoming({ currencies: currencies.filter((c) => c && c !== '—'), minImpact })
      .subscribe({
        next: (rows) => {
          if (n !== this.seq) return;
          this.events.set(rows ?? []);
          this.loading.set(false);
        },
        error: (e: unknown) => {
          if (n !== this.seq) return;
          this.error.set(e instanceof Error ? e.message : 'The calendar could not be loaded.');
          this.loading.set(false);
        },
      });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  protected flag = currencyFlag;
  protected dots = impactDots;
  protected countdown(e: UpcomingEconomicEvent): string | null {
    return eventCountdown(e, this.now());
  }
}
