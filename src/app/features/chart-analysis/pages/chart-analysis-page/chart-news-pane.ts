import { computed, signal, type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, of, type Observable } from 'rxjs';

import type { CurrencyPairDto } from '@core/api/api.types';
import type { EconomicImpact, UpcomingEconomicEvent } from '@core/services/economic-calendar.service';
import type { NewsIntelService } from '@core/services/news-intel.service';
import type { NewsArticleView, NewsFocusResult } from '@features/news-intel/news-intel.types';
import type { EventRelevance } from '../../panels/event-relevance';
import { concernsPane, mergeArticles, type NewsArticleIngestedPayload } from '../../panels/news-pane';
import type { SidePanel } from '../../panels/side/chart-panels.types';

export type ChartSidePane = 'none' | 'details' | 'news' | 'calendar' | 'datawindow';

/** What the side panes read on the chart page (accessors, so it can be built before the page's fields). */
export interface ChartNewsPaneDeps {
  symbol: () => string;
  symbols: () => CurrencyPairDto[];
  eventRelevance: () => EventRelevance;
  pairCurrencies: () => string[];
  /** The Details pane's base / quote (FX keeps the pair's two currencies on the calendar). */
  details: () => { base: string; quote: string };
  watchlistOpen: () => boolean;
  chartPanels: { close(): void; toggle(panel: SidePanel): void };
  newsIntel: Pick<NewsIntelService, 'getArticles' | 'getFocus'>;
  destroyRef: DestroyRef;
}

/**
 * b9-maint — the chart's right-hand side panes (Details / News / Calendar / Data window): which one is open, the
 * calendar pane's filters, the pair's headlines and the news module's focus read, and the modals they open — moved out
 * of ChartAnalysisPageComponent behaviour for behaviour. The page aliases these signals under their old names (its
 * template, the layout save/restore and the assistant's commands read them there); the Details pane's facts stay the
 * page's (they read its bars and labels).
 */
export class ChartNewsPane {
  constructor(private readonly deps: ChartNewsPaneDeps) {}

  readonly sidePane = signal<ChartSidePane>('none');
  /** Economic calendar pane: every currency rather than the pair's two; minimum importance. */
  readonly calendarAll = signal(false);
  readonly calendarMinImpact = signal<EconomicImpact>('Low');
  /** The calendar event whose AI reading is open. */
  readonly calendarEvent = signal<UpcomingEconomicEvent | null>(null);
  readonly calendarCurrencies = computed(
    () =>
      // UA01: FX keeps the pair's two; anything else the currencies its releases come from (AAPL → USD, BTC-USD → USD).
      this.deps.eventRelevance().kind === 'fx'
        ? [this.deps.details().base, this.deps.details().quote].filter((c) => c && c !== '—')
        : this.deps.eventRelevance().currencies,
    { equal: (a, b) => a.join() === b.join() },
  );
  readonly articles = signal<NewsArticleView[]>([]);
  /** The news item long-pressed for its AI analysis modal. */
  readonly newsAnalysis = signal<NewsArticleView | null>(null);

  readonly newsLoading = signal(false);
  readonly newsFocus = signal<NewsFocusResult | null>(null);

  openSidePane(pane: 'details' | 'news' | 'calendar' | 'datawindow'): void {
    this.sidePane.set(this.sidePane() === pane ? 'none' : pane);
    // One side pane at a time: the page's own close the SP-I9 panels.
    if (this.sidePane() !== 'none') this.deps.chartPanels.close();
    if (this.sidePane() === 'news') this.loadNews();
  }

  /** A right-rail SP-I9 panel (notes, broker depth, sentiment, account) — it replaces any open side pane. */
  openPanel(panel: SidePanel): void {
    this.sidePane.set('none');
    this.deps.chartPanels.toggle(panel);
  }

  /**
   * EV-1: a headline labelled for the pair's currencies re-reads the news pane (and the watchlist's headline). Call
   * once, from the page's constructor.
   */
  followIngested(ingested: Observable<NewsArticleIngestedPayload>): void {
    let newsTimer: ReturnType<typeof setTimeout> | undefined;
    this.deps.destroyRef.onDestroy(() => clearTimeout(newsTimer));
    ingested.pipe(takeUntilDestroyed(this.deps.destroyRef)).subscribe((article) => {
      if (this.sidePane() !== 'news' && !this.deps.watchlistOpen()) return;
      if (!concernsPane(article, this.deps.pairCurrencies())) return;
      // A classification batch pushes several at once: one re-read for all of them.
      clearTimeout(newsTimer);
      newsTimer = setTimeout(() => this.loadNews(), 1500);
    });
  }

  private newsSeq = 0;

  /**
   * Headlines for the charted pair's currencies — the base AND the quote (SP-07: it read the base only).
   *
   * Filtered to the two currencies the pair is made of, for the same reason the
   * economic events are: an operator charting EURUSD does not want JPY
   * headlines competing for the same space. Each currency is read separately so
   * each gets its own budget (a busy USD tape cannot crowd EUR out), then merged
   * once per article, newest first.
   */
  loadNews(): void {
    const d = this.deps;
    const pair = d.symbols().find((p) => (p.symbol ?? '').toUpperCase() === d.symbol().toUpperCase());
    const currencies = [...new Set([pair?.baseCurrency, pair?.quoteCurrency])]
      .map((c) => c?.toUpperCase())
      .filter((c): c is string => !!c);
    const n = ++this.newsSeq;
    this.newsLoading.set(true);
    // The news module can be disabled entirely; an empty pane says that
    // better than an error toast the operator cannot act on.
    const reads = (currencies.length ? currencies : [undefined]).map((currency) =>
      d.newsIntel.getArticles({ currency, hours: 48, take: 40 }).pipe(catchError(() => of([]))),
    );
    forkJoin(reads)
      .pipe(takeUntilDestroyed(d.destroyRef))
      .subscribe((lists) => {
        // A slower reply for the previous symbol must not replace this one's headlines.
        if (n !== this.newsSeq) return;
        this.articles.set(
          mergeArticles(...lists.map((rows) => (Array.isArray(rows) ? rows : []))).slice(0, 60),
        );
        this.newsLoading.set(false);
      });

    // The headlines above are the RECORD layer. This is the module's actual
    // read on the pair — the base-minus-quote bias and, more importantly, how
    // much of it is still live. A deeply negative score whose liveShare has
    // decayed to nothing is a story the market has finished repricing; showing
    // headlines without it invites trading news that is already in the price.
    this.newsFocus.set(null);
    d.newsIntel
      .getFocus(d.symbol().toUpperCase())
      .pipe(takeUntilDestroyed(d.destroyRef))
      .subscribe({
        next: (r) => this.newsFocus.set(r ?? null),
        error: () => this.newsFocus.set(null),
      });
  }
}
