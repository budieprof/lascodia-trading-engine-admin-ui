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
import {
  EconomicCalendarService,
  type EconomicImpact,
  type UpcomingEconomicEvent,
} from '@core/services/economic-calendar.service';
import { ServerClock } from '@core/time/server-clock';
import {
  currencyFlag,
  eventCountdown,
  eventSurprise,
  groupByDay,
  impactDots,
  isEventPast,
  refreshInterval,
  releaseStatus,
  SLOW_REFRESH_MS,
} from './economic-calendar';
import { ZonedDatePipe, zoneLabel } from './zoned-time';

/** Currencies the pane offers to add beside the pair's two. */
const EXTRA_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY'];
const EXTRAS_KEY = 'lascodia.chart.calendar.extraCurrencies';
/** Hovering a row this long opens its card (a quick pass over the list does not). */
const HOVER_OPEN_MS = 250;

/**
 * The chart's economic-calendar side pane: upcoming releases (the last 6 hours through 7 days), the chart pair's two
 * currencies plus any the operator adds — filtered by the engine, not in the browser — or all currencies on a toggle,
 * grouped by day IN THE CHART'S TIME ZONE (SP-09) with importance dots, previous / forecast / actual and a live
 * countdown. Hovering (or focusing, or the ⓘ toggle on touch) opens a row's card — the date and time, the release
 * status, the surprise against the forecast; clicking a row opens the event's AI reading (SP-I7).
 *
 * There is no push for new actuals (the engine publishes no event when an actual is recorded), so the list re-reads
 * every 5 minutes, and every 30 seconds while a release is imminent or due without its actual.
 */
@Component({
  selector: 'app-economic-calendar-pane',
  standalone: true,
  imports: [ZonedDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tree-title">
      Economic calendar · {{ allCurrencies() ? 'all' : filterCurrencies().join(' / ') }}
      <span class="ec-zone" [title]="'Times in ' + zoneName()">· {{ zoneName() }}</span>
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
    @if (!allCurrencies()) {
      <div class="ec-ccys" aria-label="Also show">
        @for (c of extras(); track c) {
          <button type="button" class="ec-chip on" (click)="toggleExtra(c)" [title]="'Stop showing ' + c">
            {{ flag(c) }} {{ c }} ×
          </button>
        }
        <select
          class="ec-add"
          (change)="addExtra($any($event.target).value); $any($event.target).value = ''"
          aria-label="Also show a currency"
          data-testid="ec-add-currency"
        >
          <option value="">+ currency</option>
          @for (c of addable(); track c) {
            <option [value]="c">{{ c }}</option>
          }
        </select>
      </div>
    }
    @if (loading() && !events().length) {
      <div class="pane-empty">Loading…</div>
    } @else if (error()) {
      <div class="pane-empty">{{ error() }}</div>
    } @else if (!events().length) {
      <div class="pane-empty">No events today or in the next 7 days.</div>
    } @else {
      @for (day of days(); track day.key) {
        <div class="ec-day">{{ day.dayMs | zonedDate: timeZone() : 'day' }}</div>
        <ul class="ec-list">
          @for (e of day.events; track e.id; let i = $index) {
            @if (i > 0 && past(day.events[i - 1]) && !past(e)) {
              <li class="ec-now" aria-hidden="true"><span>Now</span></li>
            }
            <li
              class="ec-row"
              tabindex="0"
              [class.released]="!!e.actual"
              [class.past]="past(e)"
              [class.open]="expanded() === e.id"
              (click)="opened.emit(e)"
              (keydown.enter)="opened.emit(e)"
              (mouseenter)="hoverIn(e.id)"
              (mouseleave)="hoverOut(e.id)"
              (focusin)="expanded.set(e.id)"
              data-testid="ec-event"
              [title]="'Open the AI reading of ' + e.title"
            >
              <div class="ec-top">
                <span class="ec-time">{{ e.scheduledAt | zonedDate: timeZone() : 'time' }}</span>
                <span class="ec-ccy">{{ flag(e.currency) }} {{ e.currency }}</span>
                <span class="ec-dots" [attr.aria-label]="e.impact + ' importance'">
                  @for (i of [1, 2, 3]; track i) {
                    <i [class.on]="i <= dots(e.impact)" [class.high]="dots(e.impact) === 3"></i>
                  }
                </span>
                @if (countdown(e); as c) {
                  <span class="ec-count">{{ c }}</span>
                } @else if (past(e)) {
                  <span class="ec-done" title="Event has happened — open for the post-event reading"
                    >✓ done</span
                  >
                }
                <button
                  type="button"
                  class="ec-more"
                  [attr.aria-expanded]="expanded() === e.id"
                  [attr.aria-label]="'Details of ' + e.title"
                  (click)="toggleCard(e.id, $event)"
                >
                  ⓘ
                </button>
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
                  >Act
                  <b
                    class="ec-act"
                    [class.beat]="e.result === 'Beat'"
                    [class.miss]="e.result === 'Miss'"
                    [title]="e.result ? e.result + ' for ' + e.currency : ''"
                    >{{ e.actual ?? '—' }}</b
                  ></span
                >
              </div>
              @if (expanded() === e.id) {
                <div class="ec-card" data-testid="ec-card">
                  <div class="ec-card-when">
                    {{ e.scheduledAt | zonedDate: timeZone() : 'day' }},
                    {{ e.scheduledAt | zonedDate: timeZone() : 'time' }} {{ zoneName() }} ·
                    <b>{{ status(e) }}</b>
                  </div>
                  <dl>
                    <dt>Importance</dt>
                    <dd>{{ e.impact }}</dd>
                    <dt>Previous</dt>
                    <dd>{{ e.previous ?? '—' }}</dd>
                    <dt>Forecast</dt>
                    <dd>
                      {{ e.forecast ?? '—' }}
                      @if (e.forecast && e.forecastProvenance !== 'PreRelease') {
                        <span class="muted">(captured after the release)</span>
                      }
                    </dd>
                    <dt>Actual</dt>
                    <dd>{{ e.actual ?? 'not yet' }}</dd>
                    @if (surprise(e); as sp) {
                      <dt>Surprise</dt>
                      <dd
                        [class.beat]="e.result === 'Beat'"
                        [class.miss]="e.result === 'Miss'"
                        [title]="
                          e.result
                            ? e.result + ' for ' + e.currency + (e.polarity === 'Inverse' ? ' (lower is better)' : '')
                            : 'Whether this is good for ' + e.currency + ' is not known for this figure'
                        "
                      >
                        {{ sp.text }} vs forecast{{ e.result ? ' · ' + e.result : '' }}
                      </dd>
                    }
                  </dl>
                  <button type="button" class="ec-open" (click)="opened.emit(e); $event.stopPropagation()">
                    Open the AI reading
                  </button>
                </div>
              }
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
      .ec-act.beat {
        color: #089981;
      }
      .ec-act.miss {
        color: #f23645;
      }
      .ec-row.past .ec-title,
      .ec-row.past .ec-time {
        color: var(--tv-muted, #787b86);
      }
      .ec-done {
        margin-left: auto;
        font-size: 11px;
        color: #089981;
      }
      .ec-now {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 12px;
        font-size: 10px;
        font-weight: 600;
        color: #f23645;
        text-transform: uppercase;
      }
      .ec-now::before,
      .ec-now::after {
        content: '';
        flex: 1;
        height: 1px;
        background: #f23645;
      }
      .ec-zone {
        font-weight: 400;
      }
      .ec-ccys {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        padding: 0 10px 8px;
        font-size: 11px;
      }
      .ec-chip,
      .ec-add {
        font: inherit;
        color: inherit;
        background: transparent;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 10px;
        padding: 1px 8px;
        cursor: pointer;
      }
      .ec-chip.on {
        border-color: var(--tv-blue, #2962ff);
      }
      .ec-more {
        margin-left: auto;
        font: inherit;
        color: var(--tv-muted, #787b86);
        background: transparent;
        border: 0;
        padding: 0 2px;
        cursor: pointer;
      }
      /* The countdown / done mark already takes the free space; the toggle sits right after it. */
      .ec-count + .ec-more,
      .ec-done + .ec-more {
        margin-left: 4px;
      }
      .ec-row:focus-visible {
        outline: 2px solid var(--tv-blue, #2962ff);
        outline-offset: -2px;
      }
      .ec-row.open {
        background: var(--tv-hover, #f0f3fa);
      }
      .ec-card {
        margin-top: 6px;
        padding: 6px 8px;
        border: 1px solid var(--tv-line, #e0e3eb);
        border-radius: 4px;
        cursor: default;
      }
      .ec-card-when {
        margin-bottom: 4px;
        color: var(--tv-muted, #787b86);
      }
      .ec-card dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px 10px;
        margin: 0 0 6px;
      }
      .ec-card dt {
        color: var(--tv-muted, #787b86);
      }
      .ec-card dd {
        margin: 0;
        font-variant-numeric: tabular-nums;
      }
      .ec-card .beat {
        color: #089981;
      }
      .ec-card .miss {
        color: #f23645;
      }
      .ec-open {
        font: inherit;
        color: var(--tv-blue, #2962ff);
        background: transparent;
        border: 0;
        padding: 0;
        cursor: pointer;
      }
    `,
  ],
})
export class EconomicCalendarPaneComponent {
  /** The chart pair's currencies (base, quote). */
  readonly currencies = input<string[]>([]);
  /** The chart's time zone (IANA id or 'UTC'); null = the browser's own zone. */
  readonly timeZone = input<string | null>(null);
  readonly allCurrencies = model(false);
  readonly minImpact = model<EconomicImpact>('Low');
  readonly opened = output<UpcomingEconomicEvent>();

  private readonly calendar = inject(EconomicCalendarService);
  private readonly clock = inject(ServerClock);
  private readonly destroyRef = inject(DestroyRef);

  readonly events = signal<UpcomingEconomicEvent[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Currencies shown beside the pair's two (the engine filters; persisted per viewer). */
  readonly extras = signal<string[]>(this.loadExtras());
  /** The row whose card is open. */
  readonly expanded = signal<number | null>(null);
  private readonly now = signal(Date.now());
  readonly days = computed(() => groupByDay(this.events(), this.timeZone()));
  readonly zoneName = computed(() => zoneLabel(this.timeZone()));
  readonly filterCurrencies = computed(
    () => [...new Set([...this.currencies().filter((c) => c && c !== '—'), ...this.extras()])],
    { equal: (a, b) => a.join() === b.join() },
  );
  readonly addable = computed(() => EXTRA_CURRENCIES.filter((c) => !this.filterCurrencies().includes(c)));
  private seq = 0;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const all = this.allCurrencies();
      const ccy = this.filterCurrencies();
      const min = this.minImpact();
      untracked(() => this.load(all ? [] : ccy, min));
    });
    // Countdowns tick each second while the tab is visible.
    const tick = setInterval(() => {
      if (!document.hidden) this.now.set(this.clock.now());
    }, 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(tick);
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
    });
  }

  private load(currencies: string[], minImpact: EconomicImpact): void {
    const n = ++this.seq;
    this.loading.set(true);
    this.error.set(null);
    const sub = this.calendar.upcoming({ currencies, minImpact }).subscribe({
      next: (rows) => {
        if (n !== this.seq) return;
        this.events.set(rows ?? []);
        this.loading.set(false);
        this.scheduleRefresh();
      },
      error: (e: unknown) => {
        if (n !== this.seq) return;
        this.error.set(e instanceof Error ? e.message : 'The calendar could not be loaded.');
        this.loading.set(false);
        this.scheduleRefresh();
      },
    });
    this.destroyRef.onDestroy(() => sub.unsubscribe());
  }

  /** The next re-read: soon while a release is imminent or due without its actual, else in 5 minutes. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = this.error() ? SLOW_REFRESH_MS : refreshInterval(this.events(), this.clock.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (document.hidden) {
        this.scheduleRefresh();
        return;
      }
      this.load(this.allCurrencies() ? [] : this.filterCurrencies(), this.minImpact());
    }, delay);
  }

  // ── cards ──
  hoverIn(id: number): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.expanded.set(id);
    }, HOVER_OPEN_MS);
  }

  hoverOut(id: number): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (this.expanded() === id) this.expanded.set(null);
  }

  /** The ⓘ toggle — the way to a card on touch screens, where nothing hovers. */
  toggleCard(id: number, ev: Event): void {
    ev.stopPropagation();
    this.expanded.set(this.expanded() === id ? null : id);
  }

  // ── extra currencies ──
  addExtra(ccy: string): void {
    if (!ccy) return;
    this.setExtras([...this.extras(), ccy]);
  }

  toggleExtra(ccy: string): void {
    this.setExtras(this.extras().filter((c) => c !== ccy));
  }

  private setExtras(next: string[]): void {
    const clean = [...new Set(next.map((c) => c.toUpperCase()))].slice(0, 6);
    this.extras.set(clean);
    try {
      localStorage.setItem(EXTRAS_KEY, JSON.stringify(clean));
    } catch {
      // Per-viewer convenience only.
    }
  }

  private loadExtras(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(EXTRAS_KEY) ?? '[]') as unknown;
      return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string').slice(0, 6) : [];
    } catch {
      return [];
    }
  }

  protected flag = currencyFlag;
  protected dots = impactDots;
  protected past(e: UpcomingEconomicEvent): boolean {
    return isEventPast(e, this.now());
  }

  protected countdown(e: UpcomingEconomicEvent): string | null {
    return eventCountdown(e, this.now());
  }

  protected status(e: UpcomingEconomicEvent): string {
    return releaseStatus(e, this.now());
  }

  protected surprise(e: UpcomingEconomicEvent): { value: number; text: string } | null {
    return eventSurprise(e);
  }
}
