import { computed, effect, signal, untracked, type WritableSignal } from '@angular/core';

import type { CurrencyPairDto } from '@core/api/api.types';
import type { InstrumentsService } from '@core/instruments/instruments.service';
import type { Bar, CandleFeedService } from '../../datafeed/candle-feed.service';
import type { InstrumentFacts } from '../../datafeed/instrument-facts';
import type { ChartEventsService } from '../../overlays/chart-events.service';
import {
  blackoutBands,
  eventsWindow,
  mergeMarks,
  missingOnTheLeft,
  type BlackoutWindow,
} from '../../overlays/chart-events';
import type { EventMark } from '../../overlays/event-marks-renderer';
import { eventRelevance, sameRelevance } from '../../panels/event-relevance';
import type { PaneScope } from '../../panels/market-panes';
import { exchangeSessionsOf, type ExchangeSessions } from '../../indicators/exchange-sessions';

/** What the events layer reads on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartEventsStateDeps {
  symbol: () => string;
  facts: () => InstrumentFacts;
  currentPair: () => CurrencyPairDto | undefined;
  bars: () => Bar[];
  replayActive: () => boolean;
  displayBars: () => Bar[];
  /** The layout-saved toggles ({@link ChartOverlaySettings}). */
  showEvents: WritableSignal<boolean>;
  minEventImpact: WritableSignal<'High' | 'Medium' | 'Low'>;
  showBlackout: () => boolean;
  feed: Pick<CandleFeedService, 'factsOf'>;
  instruments: Pick<InstrumentsService, 'calendar'>;
  eventsFeed: Pick<ChartEventsService, 'load' | 'blackout'>;
}

/**
 * b9-maint — the chart's economic events on the time axis, the news-blackout shading and what decides them (the symbol's
 * event relevance, its fundamentals pane scope, its exchange sessions), moved out of ChartAnalysisPageComponent behaviour
 * for behaviour. The page aliases these members under their old names (its template, the assistant's commands, the
 * history pager and the session store read them there); the toggles themselves stay in {@link ChartOverlaySettings}.
 * Build it as a page field: the exchange-sessions load is an effect.
 */
export class ChartEventsState {
  constructor(private readonly deps: ChartEventsStateDeps) {}

  /** Economic events on the time axis. */
  readonly events = signal<EventMark[]>([]);
  /** The blackout window live applies (`economic-event/news-blackout`), and when it was read. */
  readonly blackout = signal<BlackoutWindow | null>(null);
  private blackoutAt = 0;
  /**
   * UA01: which scheduled events concern the symbol, by asset class (`panels/event-relevance.ts`): FX its two
   * currencies (unchanged), crypto the quote's fiat + the coin's events + funding, indices their currency + expiries,
   * equities USD + earnings, futures + expiry. Drives the chart's marks, the blackout shading and the calendar pane.
   */
  readonly eventRelevance = computed(
    () => {
      const f = this.deps.facts();
      const pair = this.deps.currentPair();
      return eventRelevance({
        symbol: this.deps.symbol(),
        assetClass: f.resolving ? null : f.assetClass,
        pairBase: pair?.baseCurrency,
        pairQuote: pair?.quoteCurrency,
        instrument: f.instrument,
      });
    },
    { equal: sameRelevance },
  );
  /**
   * UA03: what decides the symbol's fundamentals panes — FX panes for pairs, derivatives panes for perpetuals (read
   * from the chart's venue source), roll yield for futures, COT per currency.
   */
  readonly paneScope = computed<PaneScope>(
    () => {
      const r = this.eventRelevance();
      const f = this.deps.facts();
      const source = this.deps.feed.factsOf(this.deps.symbol())?.source ?? f.instrument.candleSource ?? null;
      return {
        symbol: this.deps.symbol().toUpperCase(),
        kind: r.kind,
        perpetual: r.funding,
        sourceId: source && source.kind !== 'mt5' && source.id !== 'mt5' ? source.id : null,
        futureRoot: f.instrument.future?.root ?? null,
        currencies: r.kind === 'fx' || r.kind === 'future' ? r.currencies.filter((c) => c.length === 3) : [],
      };
    },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  /**
   * UA02: the symbol's own Pre / Regular / Post sessions, from its trading calendar (C1 `calendarCode`, else the
   * instrument's) — the Exchange-sessions study and the pre / regular / post session profiles.
   */
  readonly exchangeSessions = signal<ExchangeSessions | null>(null);
  private readonly exchangeCalendarCode = computed(
    () =>
      this.deps.feed.factsOf(this.deps.symbol())?.calendarCode ??
      this.deps.facts().instrument.tradingCalendarCode ??
      null,
  );
  private readonly exchangeSessionsLoad = effect(() => {
    const code = this.exchangeCalendarCode();
    untracked(() => {
      if (!code) {
        this.exchangeSessions.set(null);
        return;
      }
      if (this.exchangeSessions()?.code === code) return;
      void this.deps.instruments.calendar(code).then((cal) => {
        if (this.exchangeCalendarCode() !== code) return;
        this.exchangeSessions.set(cal ? exchangeSessionsOf(cal) : null);
      });
    });
  });
  /** UA05: how the Technicals view's session bars are cut, in words (FX unchanged). */
  readonly technicalsSessionWords = computed(() => {
    if (this.eventRelevance().kind === 'fx') return 'days roll at 17:00 New York';
    const code = this.deps.feed.factsOf(this.deps.symbol())?.calendarCode;
    return code ? `trading days of the ${code} calendar` : "the instrument's trading days";
  });
  /** The economic-calendar currencies the chart asks for (FX: the pair's two, as before). */
  readonly pairCurrencies = computed(() => this.eventRelevance().currencies, {
    equal: (a, b) => a.join() === b.join(),
  });
  /**
   * The events the chart draws: in replay, none after the head — the calendar of the replayed past,
   * not its future (their actuals would be look-ahead).
   */
  readonly chartEvents = computed(() => {
    const events = this.events();
    if (!this.deps.replayActive()) return events;
    const shown = this.deps.displayBars();
    const head = shown[shown.length - 1];
    return head ? events.filter((e) => e.time <= head.time) : [];
  });
  /** What the blackout chip shades, in the policy's numbers. */
  readonly blackoutTitle = computed(() => {
    const w = this.blackout();
    if (!w) return 'Shade the news blackout around high-impact events';
    if (!w.active)
      return `The news blackout is off (${w.explanation ?? 'no window'}): nothing is refused around events`;
    const enforced = this.eventRelevance().blackoutCurrencies;
    if (!enforced.length)
      return `Live's news blackout does not block ${this.deps.symbol().toUpperCase()}: no calendar currency is enforced for it`;
    const ccy = enforced.join('/');
    return `Shade the ${w.minutesBefore} min before and ${w.minutesAfter} min after each high-impact ${ccy} event: live refuses new entries then`;
  });
  /** The blackout spans to shade (UTC ms). */
  readonly eventBands = computed(() =>
    this.deps.showEvents() && this.deps.showBlackout()
      ? blackoutBands(this.chartEvents(), this.blackout(), this.eventRelevance().blackoutCurrencies)
      : [],
  );

  /** What the events on the chart were fetched for, and the window they cover (UTC ms). */
  private eventsHeld: { key: string; from: number; to: number } | null = null;
  /** Bumped by every full load: a reply for an older one (another symbol, importance) is dropped. */
  private eventsLoad = 0;

  /** Whether the events held were fetched for `symbol` (any currencies or importance). */
  holdsEventsFor(symbol: string): boolean {
    return !!this.eventsHeld?.key.startsWith(`${symbol.toUpperCase()}|`);
  }

  /**
   * Load the pair's economic events onto the time axis (CC-07, SP-08, contract C3): the loaded bars'
   * window through two weeks ahead, the pair's currencies and the chart's minimum importance filtered
   * on the engine. `extend` (scroll-back loaded older bars): fetch only what the held window does not
   * cover on the left, and merge it — the events used to stay at the first load's window.
   */
  loadEvents(extend = false): void {
    const d = this.deps;
    if (!d.showEvents()) {
      this.eventsLoad++;
      this.eventsHeld = null;
      this.events.set([]);
      return;
    }
    const currencies = this.pairCurrencies();
    const minImpact = d.minEventImpact();
    const symbol = d.symbol().toUpperCase();
    const relevance = this.eventRelevance();
    const sourceId = d.feed.factsOf(symbol)?.source?.id ?? null;
    const key = `${symbol}|${currencies.join(',')}|${minImpact}|${relevance.marketKeys.join(',')}|${relevance.expiryMs}|${relevance.funding}|${sourceId}`;
    const loaded = d.bars();
    const wanted = eventsWindow(loaded.length ? loaded[0].time : null, Date.now());
    const held = this.eventsHeld?.key === key ? this.eventsHeld : null;
    const span = extend ? (held ? missingOnTheLeft(held, wanted) : null) : wanted;
    if (!span) return;
    const load = extend ? this.eventsLoad : ++this.eventsLoad;
    if (!extend) this.eventsHeld = null;
    this.refreshBlackout();
    void d.eventsFeed
      .load({ currencies, minImpact, from: span.from, to: span.to, relevance, symbol, sourceId })
      .then((marks) => {
        // A newer load (another symbol, importance or toggle) owns the layer now.
        if (load !== this.eventsLoad || !marks) return;
        if (extend) {
          const now = this.eventsHeld;
          if (!now || now.key !== key) return;
          this.events.set(mergeMarks(this.events(), marks));
          this.eventsHeld = { key, from: Math.min(now.from, span.from), to: now.to };
        } else {
          this.events.set(marks);
          this.eventsHeld = { key, from: span.from, to: span.to };
          // History loaded on the left while this was in flight.
          this.loadEvents(true);
        }
      });
  }

  /** Read the blackout window again when it is older than ten minutes (it is config). */
  private refreshBlackout(): void {
    if (Date.now() - this.blackoutAt < 600_000) return;
    this.blackoutAt = Date.now();
    void this.deps.eventsFeed.blackout().then((w) => {
      if (w) this.blackout.set(w);
      else this.blackoutAt = 0;
    });
  }

  toggleEvents(): void {
    this.deps.showEvents.set(!this.deps.showEvents());
    this.loadEvents();
  }

  /** The minimum importance is filtered on the engine: a change asks again. */
  cycleEventImpact(): void {
    const order: Array<'High' | 'Medium' | 'Low'> = ['High', 'Medium', 'Low'];
    const next = order[(order.indexOf(this.deps.minEventImpact()) + 1) % order.length];
    this.deps.minEventImpact.set(next);
    this.loadEvents();
  }
}
