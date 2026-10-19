import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, auditTime, filter, interval } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { TradeRecommendationsService } from '@core/services/trade-recommendations.service';
import { RealtimeService, RealtimeEventName } from '@core/realtime/realtime.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { RecommendationCardComponent } from '../../components/recommendation-card/recommendation-card.component';
import {
  REC_SOURCE_LABELS,
  REC_SOURCES,
  REC_STATUSES,
  TradeRecommendationCardDto,
  TradeRecommendationCardFilter,
  TradeRecommendationSummaryDto,
} from '../../trade-recommendations.types';

type RangeKey = 'all' | '24h' | '7d' | '30d' | '90d';
type SortKey = 'newest' | 'oldest' | 'confidence' | 'updated' | 'symbol';

const RANGE_HOURS: Record<RangeKey, number | null> = {
  all: null,
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '90d': 2160,
};
const SORTS: Record<SortKey, { label: string; by: string; dir: 'asc' | 'desc' }> = {
  newest: { label: 'Newest first', by: 'Id', dir: 'desc' },
  oldest: { label: 'Oldest first', by: 'Id', dir: 'asc' },
  updated: { label: 'Recently changed', by: 'UpdatedAtUtc', dir: 'desc' },
  confidence: { label: 'Highest confidence', by: 'Confidence', dir: 'desc' },
  symbol: { label: 'Symbol A→Z', by: 'Symbol', dir: 'asc' },
};
const PAGE_SIZES = [12, 24, 48, 96];

/** Engine pushes that can change a card's watch or outcome. New cards themselves are not pushed. */
const REFRESH_ON: readonly RealtimeEventName[] = [
  'tradeSignalCreated',
  'orderCreated',
  'orderFilled',
  'positionOpened',
  'positionClosed',
  'analysisMonitorFired',
  'analysisMonitorChanged',
  'analysisMonitorInvalidated',
];

/**
 * Every recommendation card the engine's analyses wrote — chat recommends, Patient Trader, spot
 * analysis, monitor reviews — a page at a time, with what became of each one. Filters live in the
 * URL so a filtered view can be shared and survives a back-navigation from a card's detail.
 */
@Component({
  selector: 'app-recommendations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    PercentPipe,
    PageHeaderComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    CardSkeletonComponent,
    RecommendationCardComponent,
  ],
  styleUrls: ['../../rec-shared.scss', './recommendations-page.component.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Recommendations"
        subtitle="Every trade card an analysis wrote — chat, Patient Trader, spot analysis and monitor reviews — with what became of it."
      >
        <span slot="title-after" class="live muted" [class.live--busy]="refreshing()">
          {{ refreshing() ? 'Refreshing…' : updatedLabel() }}
        </span>
        <button class="btn" type="button" (click)="reload()" [disabled]="refreshing()">
          ↻ Refresh
        </button>
      </app-page-header>

      <!-- KPI strip: the whole filter, not just this page -->
      @if (summary(); as s) {
        <section class="kpis" aria-label="Summary for the current filter">
          <div class="kpi">
            <span class="kpi-label">Cards</span>
            <span class="kpi-value mono">{{ s.total | number }}</span>
            <span class="kpi-sub muted">{{ spanLabel() }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Filed</span>
            <span class="kpi-value mono">{{ s.byStatus['Filed'] ?? 0 | number }}</span>
            <span class="kpi-sub muted">{{ share(s.byStatus['Filed'], s.total) }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Refused</span>
            <span class="kpi-value mono">{{ s.byStatus['Rejected'] ?? 0 | number }}</span>
            <span class="kpi-sub muted">{{ share(s.byStatus['Rejected'], s.total) }}</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Watching</span>
            <span class="kpi-value mono">{{ s.watched | number }}</span>
            <span class="kpi-sub muted">active monitors</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Became signals</span>
            <span class="kpi-value mono">{{ s.withSignal | number }}</span>
            <span class="kpi-sub muted">{{ s.withPosition }} reached a position</span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Positions won / lost</span>
            <span class="kpi-value mono">
              <span class="profit">{{ s.wins }}</span> / <span class="loss">{{ s.losses }}</span>
            </span>
            <!-- Won + lost need not add up to closed: say how many closes were
                 neither (breakeven, or P&L the engine could not recover). -->
            <span class="kpi-sub wrap muted"
              >{{ s.openPositions }} open · {{ s.closedPositions }} closed{{
                s.closedPositions - s.wins - s.losses > 0
                  ? ' · ' + (s.closedPositions - s.wins - s.losses) + ' neither'
                  : ''
              }}</span
            >
          </div>
          <div
            class="kpi"
            title="Summed across every account the cards traded on, demo and real alike"
          >
            <span class="kpi-label">Realized P&amp;L · all accounts</span>
            <span
              class="kpi-value mono"
              [class.profit]="s.realizedPnL > 0"
              [class.loss]="s.realizedPnL < 0"
            >
              {{ s.realizedPnL > 0 ? '+' : '' }}{{ s.realizedPnL | number: '1.2-2' }}
            </span>
            <span class="kpi-sub muted">
              open {{ s.unrealizedPnL > 0 ? '+' : '' }}{{ s.unrealizedPnL | number: '1.2-2' }}
            </span>
          </div>
          <div class="kpi">
            <span class="kpi-label">Avg R:R · Conf.</span>
            <span class="kpi-value mono">
              {{ s.avgRewardRisk !== null ? (s.avgRewardRisk | number: '1.2-2') : '—' }}
            </span>
            <span class="kpi-sub muted">
              {{ s.avgConfidence !== null ? (s.avgConfidence | percent: '1.0-0') : '—' }} confidence
            </span>
          </div>
        </section>
      }

      <!-- Filters -->
      <section class="filters panel" aria-label="Filters">
        <div class="filter-row">
          <label class="search">
            <span class="sr-only">Search</span>
            <input
              type="search"
              placeholder="Search symbol, rationale, reason — or #id (card, analysis, signal, plan)"
              [value]="searchDraft()"
              (input)="onSearch($any($event.target).value)"
            />
          </label>
          <div class="seg" role="group" aria-label="Written within">
            @for (r of rangeKeys; track r) {
              <button type="button" [class.on]="range() === r" (click)="set(range, r)">
                {{ r === 'all' ? 'All' : r }}
              </button>
            }
          </div>
          <!-- [selected] per option, not [value] on the select: options rendered by @for land
               after the select's value is applied, which left "12 / page" showing over a 24-card page. -->
          <select (change)="set(hasSignal, $any($event.target).value)" aria-label="Became a signal">
            <option value="any" [selected]="hasSignal() === 'any'">Signal: any</option>
            <option value="yes" [selected]="hasSignal() === 'yes'">Became a signal</option>
            <option value="no" [selected]="hasSignal() === 'no'">Never a signal</option>
          </select>
          <select (change)="set(sort, $any($event.target).value)" aria-label="Sort">
            @for (k of sortKeys; track k) {
              <option [value]="k" [selected]="sort() === k">{{ sorts[k].label }}</option>
            }
          </select>
          <select (change)="setPageSize(+$any($event.target).value)" aria-label="Cards per page">
            @for (n of pageSizes; track n) {
              <option [value]="n" [selected]="pageSize() === n">{{ n }} / page</option>
            }
          </select>
          @if (hasFilters()) {
            <button type="button" class="btn btn--sm" (click)="clearFilters()">
              Clear filters
            </button>
          }
        </div>

        <div class="facet">
          <span class="facet-label">Status</span>
          @for (st of statusOptions; track st) {
            <button
              type="button"
              class="chip"
              [class.on]="statuses().includes(st)"
              (click)="toggle(statuses, st)"
            >
              {{ st }} <span class="n">{{ summary()?.byStatus?.[st] ?? 0 }}</span>
            </button>
          }
        </div>
        <div class="facet">
          <span class="facet-label">Source</span>
          @for (src of sourceOptions(); track src) {
            <button
              type="button"
              class="chip"
              [class.on]="sources().includes(src)"
              (click)="toggle(sources, src)"
            >
              {{ sourceLabels[src] ?? src }}
              <span class="n">{{ summary()?.bySource?.[src] ?? 0 }}</span>
            </button>
          }
        </div>
        <div class="facet">
          <span class="facet-label">Direction</span>
          @for (d of ['Buy', 'Sell']; track d) {
            <button
              type="button"
              class="chip"
              [class.on]="directions().includes(d)"
              [class.chip--buy]="d === 'Buy'"
              [class.chip--sell]="d === 'Sell'"
              (click)="toggle(directions, d)"
            >
              {{ d === 'Buy' ? '↑' : '↓' }} {{ d }}
              <span class="n">{{ summary()?.byDirection?.[d] ?? 0 }}</span>
            </button>
          }
          @if (symbolOptions().length > 0) {
            <span class="facet-label facet-label--gap">Symbol</span>
            @for (sym of symbolOptions(); track sym) {
              <button
                type="button"
                class="chip mono"
                [class.on]="symbols().includes(sym)"
                (click)="toggle(symbols, sym)"
              >
                {{ sym }} <span class="n">{{ summary()?.bySymbol?.[sym] ?? 0 }}</span>
              </button>
            }
          }
        </div>
      </section>

      <!-- Cards -->
      @if (loading()) {
        <div class="grid">
          @for (i of [1, 2, 3, 4, 5, 6]; track i) {
            <app-card-skeleton [lines]="5" />
          }
        </div>
      } @else if (error() && cards().length === 0) {
        <app-error-state
          title="Could not load recommendations"
          [message]="error()"
          (retry)="reload()"
        />
      } @else if (cards().length === 0) {
        <app-empty-state
          title="No recommendation cards"
          [description]="
            hasFilters()
              ? 'Nothing matches these filters.'
              : 'No analysis has written a trade card yet.'
          "
          [actionLabel]="hasFilters() ? 'Clear filters' : null"
          (actionClick)="clearFilters()"
        />
      } @else {
        @if (error()) {
          <p class="stale muted">
            Showing the last good page — the latest refresh failed: {{ error() }}
          </p>
        }
        <div class="grid" [class.grid--busy]="refreshing()">
          @for (c of cards(); track c.id) {
            <app-recommendation-card [card]="c" />
          }
        </div>

        <nav class="pager" aria-label="Pages">
          <span class="muted range-label">
            {{ firstShown() | number }}–{{ lastShown() | number }} of {{ total() | number }}
          </span>
          <div class="pager-btns">
            <button
              type="button"
              class="btn btn--sm"
              [disabled]="page() <= 1"
              (click)="goTo(1)"
              aria-label="First page"
            >
              «
            </button>
            <button
              type="button"
              class="btn btn--sm"
              [disabled]="page() <= 1"
              (click)="goTo(page() - 1)"
              aria-label="Previous page"
            >
              ‹
            </button>
            @for (p of pageWindow(); track $index) {
              @if (p === null) {
                <span class="gap muted">…</span>
              } @else {
                <button
                  type="button"
                  class="btn btn--sm"
                  [class.btn--primary]="p === page()"
                  [attr.aria-current]="p === page() ? 'page' : null"
                  (click)="goTo(p)"
                >
                  {{ p }}
                </button>
              }
            }
            <button
              type="button"
              class="btn btn--sm"
              [disabled]="page() >= pageCount()"
              (click)="goTo(page() + 1)"
              aria-label="Next page"
            >
              ›
            </button>
            <button
              type="button"
              class="btn btn--sm"
              [disabled]="page() >= pageCount()"
              (click)="goTo(pageCount())"
              aria-label="Last page"
            >
              »
            </button>
          </div>
        </nav>
      }
    </div>
  `,
})
export class RecommendationsPageComponent {
  private readonly service = inject(TradeRecommendationsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly realtime = inject(RealtimeService, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  readonly statusOptions = REC_STATUSES;
  readonly sourceLabels = REC_SOURCE_LABELS;
  readonly rangeKeys = Object.keys(RANGE_HOURS) as RangeKey[];
  readonly sorts = SORTS;
  readonly sortKeys = Object.keys(SORTS) as SortKey[];
  readonly pageSizes = PAGE_SIZES;

  // ── Filter state (mirrored in the URL) ──
  readonly searchDraft = signal('');
  readonly search = signal('');
  readonly statuses = signal<string[]>([]);
  readonly sources = signal<string[]>([]);
  readonly directions = signal<string[]>([]);
  readonly symbols = signal<string[]>([]);
  readonly range = signal<RangeKey>('all');
  readonly hasSignal = signal<'any' | 'yes' | 'no'>('any');
  readonly sort = signal<SortKey>('newest');
  readonly page = signal(1);
  readonly pageSize = signal(24);

  // ── Data ──
  readonly cards = signal<TradeRecommendationCardDto[]>([]);
  readonly total = signal(0);
  readonly summary = signal<TradeRecommendationSummaryDto | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly error = signal<string | null>(null);
  readonly lastUpdated = signal<number | null>(null);
  private readonly now = signal(Date.now());

  readonly filter = computed<TradeRecommendationCardFilter>(() => {
    const hours = RANGE_HOURS[this.range()];
    return {
      search: this.search().trim() || null,
      statuses: this.statuses(),
      sources: this.sources(),
      directions: this.directions(),
      symbols: this.symbols(),
      fromUtc: hours == null ? null : new Date(Date.now() - hours * 3600_000).toISOString(),
      hasSignal: this.hasSignal() === 'any' ? null : this.hasSignal() === 'yes',
    };
  });

  /** Stable identity of everything that changes the result set (not the clock inside fromUtc). */
  private readonly queryKey = computed(() =>
    JSON.stringify([
      this.search().trim(),
      this.statuses(),
      this.sources(),
      this.directions(),
      this.symbols(),
      this.range(),
      this.hasSignal(),
      this.sort(),
      this.page(),
      this.pageSize(),
    ]),
  );

  readonly hasFilters = computed(
    () =>
      !!this.search().trim() ||
      this.statuses().length > 0 ||
      this.sources().length > 0 ||
      this.directions().length > 0 ||
      this.symbols().length > 0 ||
      this.range() !== 'all' ||
      this.hasSignal() !== 'any',
  );

  /** Known sources plus any the engine reports that this build has no label for. */
  readonly sourceOptions = computed(() => {
    const extra = Object.keys(this.summary()?.bySource ?? {}).filter(
      (s) => !(REC_SOURCES as readonly string[]).includes(s),
    );
    return [...REC_SOURCES, ...extra];
  });

  readonly symbolOptions = computed(() => {
    const fromSummary = Object.keys(this.summary()?.bySymbol ?? {});
    return [...new Set([...fromSummary, ...this.symbols()])];
  });

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  readonly firstShown = computed(() =>
    this.total() === 0 ? 0 : (this.page() - 1) * this.pageSize() + 1,
  );
  readonly lastShown = computed(() => Math.min(this.total(), this.page() * this.pageSize()));

  /** 1 … 4 5 [6] 7 8 … 20 */
  readonly pageWindow = computed<(number | null)[]>(() => {
    const n = this.pageCount();
    const p = this.page();
    const out: (number | null)[] = [];
    const lo = Math.max(2, p - 2);
    const hi = Math.min(n - 1, p + 2);
    out.push(1);
    if (lo > 2) out.push(null);
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < n - 1) out.push(null);
    if (n > 1) out.push(n);
    return out;
  });

  readonly updatedLabel = computed(() => {
    const t = this.lastUpdated();
    if (t == null) return '';
    const s = Math.max(0, Math.round((this.now() - t) / 1000));
    return s < 5
      ? 'Updated just now'
      : s < 60
        ? `Updated ${s}s ago`
        : `Updated ${Math.round(s / 60)}m ago`;
  });

  readonly spanLabel = computed(() => {
    const s = this.summary();
    if (!s?.firstAtUtc || !s.lastAtUtc) return '';
    const fmt = (iso: string) =>
      new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
    return `${fmt(s.firstAtUtc)} – ${fmt(s.lastAtUtc)}`;
  });

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private pageSub: Subscription | null = null;
  private summarySub: Subscription | null = null;
  private lastSummaryKey = '';

  constructor() {
    this.readUrl();

    // One load per distinct query. The body is untracked so the signals the loaders read are not
    // dependencies of this effect — only queryKey is.
    effect(() => {
      this.queryKey();
      untracked(() => {
        this.writeUrl();
        this.load(false);
      });
    });

    interval(30_000)
      .pipe(
        filter(() => document.visibilityState === 'visible'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.load(true));
    interval(5_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.now.set(Date.now()));

    this.realtime?.events$
      .pipe(
        filter((m) => REFRESH_ON.includes(m.name)),
        auditTime(1_500),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.load(true));

    this.destroyRef.onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.pageSub?.unsubscribe();
      this.summarySub?.unsubscribe();
    });
  }

  reload(): void {
    this.load(true, true);
  }

  /**
   * Loads the page and, when the filter (not just the page) changed, the summary. A background
   * refresh keeps the current cards on screen; only the very first load shows skeletons.
   */
  private load(background: boolean, forceSummary = false): void {
    if (!background || this.cards().length > 0) this.refreshing.set(true);
    const sort = SORTS[this.sort()];
    const f = this.filter();

    this.pageSub?.unsubscribe();
    this.pageSub = this.service
      .paged({
        currentPage: this.page(),
        itemCountPerPage: this.pageSize(),
        sortBy: sort.by,
        sortDirection: sort.dir,
        filter: f,
      })
      .subscribe({
        next: (res) => {
          this.loading.set(false);
          this.refreshing.set(false);
          if (!res?.status || !res.data) {
            this.error.set(res?.message ?? 'The engine refused the request.');
            return;
          }
          this.error.set(null);
          this.cards.set(res.data.data);
          this.total.set(res.data.pager?.totalItemCount ?? res.data.data.length);
          this.lastUpdated.set(Date.now());
          // A filter that shrank the result set can leave us past the last page.
          if (this.page() > 1 && res.data.data.length === 0 && this.total() > 0) {
            this.page.set(this.pageCount());
          }
        },
        error: (err) => {
          this.loading.set(false);
          this.refreshing.set(false);
          this.error.set(err?.error?.message ?? err?.message ?? 'Request failed.');
        },
      });

    const summaryKey = JSON.stringify({ ...f, fromUtc: this.range() });
    if (background || forceSummary || summaryKey !== this.lastSummaryKey) {
      this.lastSummaryKey = summaryKey;
      this.summarySub?.unsubscribe();
      this.summarySub = this.service.summary(f).subscribe({
        next: (res) => {
          if (res?.status && res.data) this.summary.set(res.data);
        },
        error: () => {
          /* the KPI strip keeps its last value; the grid reports errors */
        },
      });
    }
  }

  // ── Interactions ──

  onSearch(v: string): void {
    this.searchDraft.set(v);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.search.set(v);
    }, 300);
  }

  set<T>(sig: { set(v: T): void }, v: T): void {
    this.page.set(1);
    sig.set(v);
  }

  toggle(sig: { (): string[]; set(v: string[]): void }, v: string): void {
    const cur = sig();
    this.page.set(1);
    sig.set(cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]);
  }

  setPageSize(n: number): void {
    this.page.set(1);
    this.pageSize.set(PAGE_SIZES.includes(n) ? n : 24);
  }

  goTo(p: number): void {
    const target = Math.min(Math.max(1, p), this.pageCount());
    if (target === this.page()) return;
    this.page.set(target);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  clearFilters(): void {
    this.searchDraft.set('');
    this.search.set('');
    this.statuses.set([]);
    this.sources.set([]);
    this.directions.set([]);
    this.symbols.set([]);
    this.range.set('all');
    this.hasSignal.set('any');
    this.page.set(1);
  }

  share(n: number | undefined, total: number): string {
    if (!total) return '—';
    return `${Math.round(((n ?? 0) / total) * 100)}% of cards`;
  }

  // ── URL sync ──

  private readUrl(): void {
    const q = this.route.snapshot.queryParamMap;
    const list = (k: string) => (q.get(k) ? q.get(k)!.split(',').filter(Boolean) : []);
    const s = q.get('q') ?? '';
    this.searchDraft.set(s);
    this.search.set(s);
    this.statuses.set(list('status'));
    this.sources.set(list('source'));
    this.directions.set(list('dir'));
    this.symbols.set(list('sym'));
    const r = q.get('range') as RangeKey | null;
    if (r && r in RANGE_HOURS) this.range.set(r);
    const sig = q.get('signal');
    if (sig === 'yes' || sig === 'no') this.hasSignal.set(sig);
    const so = q.get('sort') as SortKey | null;
    if (so && so in SORTS) this.sort.set(so);
    const size = Number(q.get('size'));
    if (PAGE_SIZES.includes(size)) this.pageSize.set(size);
    const p = Number(q.get('page'));
    if (Number.isInteger(p) && p > 0) this.page.set(p);
  }

  private writeUrl(): void {
    const join = (xs: string[]) => (xs.length ? xs.join(',') : null);
    void this.router.navigate([], {
      relativeTo: this.route,
      replaceUrl: true,
      queryParams: {
        q: this.search().trim() || null,
        status: join(this.statuses()),
        source: join(this.sources()),
        dir: join(this.directions()),
        sym: join(this.symbols()),
        range: this.range() === 'all' ? null : this.range(),
        signal: this.hasSignal() === 'any' ? null : this.hasSignal(),
        sort: this.sort() === 'newest' ? null : this.sort(),
        size: this.pageSize() === 24 ? null : this.pageSize(),
        page: this.page() === 1 ? null : this.page(),
      },
    });
  }
}
