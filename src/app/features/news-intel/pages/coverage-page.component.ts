import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subscription, from, of } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';

import { NewsIntelService } from '@core/services/news-intel.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { ConfigService } from '@core/services/config.service';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { errorText } from '@features/iam/iam.logic';
import { NewsIntelNavComponent } from '../components/news-intel-nav.component';
import {
  ASSET_CLASSES,
  CoverageRow,
  MULTI_ASSET_MODE_KEY,
  MultiAssetMode,
  SymbolAssetClass,
  blackoutModeText,
  configValue,
  coverageRowFrom,
  coverageRowFromBulk,
  coverageSummary,
  exposureKindOf,
  formatMinutes,
  newestAgeByKey,
  parseExposureList,
  parseMultiAssetMode,
  pct,
  riskObservationKindLabel,
  signed,
  untrackedDemand,
} from '../news-intel.logic';
import {
  NewsArticleView,
  NewsConfigEntry,
  NewsCoverageView,
  NewsFocusResult,
  NewsRiskObservationPage,
  NewsRiskObservationView,
} from '../news-intel.types';

/** Focus calls in flight at once while the page walks the symbol universe. */
const FAN_OUT = 4;

/**
 * Coverage — every symbol in the engine's universe resolved through the exposure map (ADR-0035):
 * its legs (static or fitted), which the module tracks, the symbol bias and coverage, the freshness of
 * the newest weighted item on its legs, its calendar keys and what the multi-asset blackout does to it.
 *
 * One `GET news-intel/coverage` read (the engine computes pressure once per key, caches ~60 s) gives every
 * row, the exact legacy-enforced vs mode-governed keys and the recorded risk observations. An engine without
 * that endpoint falls back to `GET news-intel/focus` once per symbol (4 at a time, on load and on Refresh —
 * never polled). Every figure is the engine's.
 */
@Component({
  selector: 'app-news-coverage-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, NewsIntelNavComponent, FeatureStateComponent],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header>
        <h1>News coverage</h1>
        <p class="muted small">
          Every tradable symbol as the news module sees it: the exposures it is made of, which of
          them the module tracks, and whether the calendar blackout can stop entries on it.
        </p>
      </header>
      <app-news-intel-nav [showRefresh]="true" [refreshing]="loading()" (refresh)="load()" />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }

      @if (!loading() && rows().length === 0 && !error()) {
        <app-feature-state
          kind="waiting"
          title="No symbols to resolve"
          summary="The engine returned no active currency pairs, so there is nothing to place on the exposure map yet."
          [links]="[{ label: 'Currency pairs', route: '/currency-pairs' }]"
        />
      }

      @if (rows().length) {
        <section class="card">
          <div class="tiles">
            <div class="tile">
              <span class="v">{{ summary().symbols }}</span
              ><span class="k">symbols</span>
            </div>
            <div class="tile">
              <span class="v pos">{{ summary().fullyCovered }}</span
              ><span class="k">every leg tracked</span>
            </div>
            <div class="tile">
              <span class="v">{{ summary().partlyCovered }}</span
              ><span class="k">some legs untracked</span>
            </div>
            <div class="tile">
              <span class="v neg">{{ summary().uncovered }}</span
              ><span class="k">no leg tracked</span>
            </div>
            <div class="tile">
              <span class="v">{{ summary().unplaced }}</span
              ><span class="k">not placed</span>
            </div>
            <div class="tile">
              <span class="v">{{ mode() }}</span
              ><span class="k"
                >multi-asset blackout · <a routerLink="/news-intel/risk">change</a></span
              >
            </div>
          </div>
          @if (progress(); as p) {
            <p class="muted small">Resolving symbols… {{ p.done }} / {{ p.total }}</p>
          }
          @if (bulk(); as b) {
            <p class="muted xsmall" data-testid="coverage-bulk">
              Tracked: {{ tracked().length }} keys ({{ trackedSource() }}). One engine read at
              {{ b.computedAtUtc | date: 'HH:mm:ss' : 'UTC' }}Z{{ b.cached ? ' (cached)' : '' }},
              pressure computed once for {{ b.pressureKeysComputed }} keys.
            </p>
          } @else {
            <p class="muted xsmall">
              Tracked: {{ tracked().length }} keys ({{ trackedSource() }}). This engine has no bulk
              coverage read, so rows come from one focus call per symbol and the legacy/governed
              split below is approximated (non-currency keys counted as mode-governed).
            </p>
          }
        </section>

        <section class="card" data-testid="coverage-observations">
          <div class="card-head">
            <h2>Recorded risk observations (7 days)</h2>
            <a class="xsmall" routerLink="/news-intel/risk">Risk use →</a>
          </div>
          @if (observations(); as o) {
            <div class="tiles">
              <div class="tile">
                <span class="v">{{ o.total }}</span
                ><span class="k">observations</span>
              </div>
              @for (k of kindKeys(o); track k) {
                <div class="tile">
                  <span class="v">{{ o.countsByKind[k] }}</span
                  ><span class="k">{{ kindLabel(k) }}</span>
                </div>
              }
            </div>
            @if (o.total === 0) {
              <p class="muted small">
                Nothing recorded in the window: no gate in Observe or Enforce met an event on a
                tradable symbol (only live decisions are recorded, never backtests).
              </p>
            }
          } @else if (observationsMissing()) {
            <p class="muted small">
              This engine build does not record observations yet — "would have blocked" lives only
              in the <code>trading.news_blackout.*</code> metrics and log lines.
            </p>
          } @else {
            <p class="muted xsmall">Loading…</p>
          }
        </section>

        @if (demand().length) {
          <section class="card">
            <h2>Untracked keys the universe needs</h2>
            <p class="muted small">
              Each is a leg of at least one symbol that the module does not track, so that symbol's
              reading is partial (or null). Track them on the
              <a routerLink="/news-intel/exposures">Exposures</a> tab.
            </p>
            <div class="legs">
              @for (d of demand().slice(0, 40); track d.key) {
                <span class="key untracked" [title]="d.symbols + ' symbol(s)'"
                  >{{ d.key }} · {{ d.symbols }}</span
                >
              }
            </div>
          </section>
        }

        <section class="card">
          <div class="card-head">
            <h2>Symbols</h2>
            <div class="filters">
              <select
                class="sel"
                aria-label="Asset class"
                [value]="assetFilter() ?? ''"
                (change)="onAsset($event)"
              >
                <option value="">All classes</option>
                @for (c of classes; track c) {
                  <option [value]="c">{{ c }} ({{ classCount(c) }})</option>
                }
              </select>
              <input
                class="inp"
                placeholder="Filter symbol or key"
                aria-label="Filter symbol or key"
                [value]="query()"
                (input)="onQuery($event)"
              />
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Class</th>
                  <th>Legs (dashed = untracked)</th>
                  <th class="num">Coverage</th>
                  <th class="num">Symbol bias</th>
                  <th class="num">Newest item</th>
                  <th>Calendar keys</th>
                  <th>Blackout</th>
                  <th class="num" title="Recorded risk observations, 7 days">Obs 7d</th>
                </tr>
              </thead>
              <tbody>
                @for (r of visible(); track r.symbol) {
                  <tr class="clickable" (click)="toggle(r.symbol)">
                    <td class="mono">{{ r.symbol }}</td>
                    <td>{{ r.assetClass }}</td>
                    <td>
                      @if (r.problem) {
                        <span class="muted xsmall">{{ r.problem }}</span>
                      } @else {
                        <div class="legs">
                          @for (l of r.legs; track l.key) {
                            <span
                              class="key"
                              [class.untracked]="!l.covered"
                              [title]="l.basis + (l.covered ? '' : ' — not tracked')"
                              >{{ l.key }} {{ weight(l.weight) }}{{ l.fitted ? ' ƒ' : '' }}</span
                            >
                          }
                        </div>
                      }
                    </td>
                    <td class="num">{{ pct(r.coverage) }}</td>
                    <td
                      class="num"
                      [class.pos]="(r.symbolBias ?? 0) > 0"
                      [class.neg]="(r.symbolBias ?? 0) < 0"
                      [title]="
                        r.symbolBias === null
                          ? 'Null on purpose: a main leg is untracked, so a number would claim coverage that does not exist'
                          : ''
                      "
                    >
                      {{ r.symbolBias === null ? 'n/a' : signed(r.symbolBias) }}
                    </td>
                    <td class="num">{{ age(r.newestAgeMinutes) }}</td>
                    <td>
                      <div class="legs">
                        @for (k of r.calendarKeys; track k) {
                          <span class="key">{{ k }}</span>
                        } @empty {
                          <span class="pill warn" title="The blackout never blocks this symbol"
                            >none</span
                          >
                        }
                      </div>
                    </td>
                    <td class="xsmall">
                      @if (r.modeGovernedKeys.length) {
                        <span class="pill" [class.ok]="mode() === 'Enforce'">{{ mode() }}</span>
                      } @else if (r.calendarKeys.length) {
                        <span class="pill">legacy</span>
                      }
                    </td>
                    <td class="num">{{ r.riskObservations7d ?? '—' }}</td>
                  </tr>
                  @if (open() === r.symbol) {
                    <tr class="row-detail">
                      <td colspan="9">
                        <div class="detail">
                          <p class="small">{{ modeText(r) }}</p>
                          @if (r.exactKeys) {
                            <p class="xsmall" data-testid="coverage-keys">
                              Always refuses on:
                              @for (k of r.legacyEnforcedKeys ?? []; track k) {
                                <span class="key">{{ k }}</span>
                              } @empty {
                                <span class="muted"
                                  >nothing (the legacy blackout never blocked it)</span
                                >
                              }
                              · Mode-governed:
                              @for (k of r.modeGovernedKeys; track k) {
                                <span class="key untracked">{{ k }}</span>
                              } @empty {
                                <span class="muted">none</span>
                              }
                              · Refusing now ({{ mode() }}):
                              @for (k of r.blockingKeys ?? []; track k) {
                                <span class="key">{{ k }}</span>
                              } @empty {
                                <span class="muted">none</span>
                              }
                            </p>
                          }
                          <p class="xsmall muted">
                            Resolved from: {{ r.source }}.
                            @if (r.includedInPrompt) {
                              The spot-analysis prompt carries this reading.
                            } @else if (r.omissionReason) {
                              Not in the prompt: {{ r.omissionReason }}
                            }
                          </p>
                          <table>
                            <thead>
                              <tr>
                                <th>Leg</th>
                                <th>Kind</th>
                                <th class="num">Weight</th>
                                <th>Basis</th>
                                <th>Tracked</th>
                                <th class="num">Score</th>
                                <th class="num">Newest item</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (l of r.legs; track l.key) {
                                <tr>
                                  <td class="mono">{{ l.key }}</td>
                                  <td>{{ l.kind ?? '?' }}</td>
                                  <td class="num">{{ weight(l.weight) }}</td>
                                  <td>{{ l.fitted ? 'fitted' : 'static' }} · {{ l.basis }}</td>
                                  <td>
                                    <span class="pill" [class.ok]="l.covered">{{
                                      l.covered ? 'yes' : 'no'
                                    }}</span>
                                  </td>
                                  <td class="num">{{ l.covered ? signed(l.score) : '—' }}</td>
                                  <td class="num">{{ age(l.newestAgeMinutes) }}</td>
                                  <td>
                                    <button
                                      type="button"
                                      class="btn subtle"
                                      (click)="showArticles(l.key); $event.stopPropagation()"
                                    >
                                      Articles
                                    </button>
                                  </td>
                                </tr>
                              }
                            </tbody>
                          </table>
                          @if (symbolObservations(); as so) {
                            <h3>Recorded observations for {{ r.symbol }} (7 days)</h3>
                            @for (o of so; track o.id) {
                              <div class="xsmall">
                                <span class="muted"
                                  >{{ o.observedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span
                                >
                                · {{ kindLabel(o.kind) }} · <span class="pill">{{ o.mode }}</span> ·
                                <span class="key">{{ o.key ?? '—' }}</span>
                                {{ o.detail ?? '' }}
                                @if (o.eventAtUtc) {
                                  <span class="muted"
                                    >· event {{ o.eventAtUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span
                                  >
                                }
                              </div>
                            } @empty {
                              <p class="muted xsmall">None recorded.</p>
                            }
                          }
                          @if (articleKey(); as k) {
                            <h3>Articles labelled {{ k }} (72 h)</h3>
                            @if (articles(); as list) {
                              @for (a of list; track a.id) {
                                <div class="xsmall">
                                  <span class="muted"
                                    >{{ a.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}Z</span
                                  >
                                  · {{ a.sourceName }} ·
                                  @if (a.url) {
                                    <a [href]="a.url" target="_blank" rel="noopener">{{
                                      a.title
                                    }}</a>
                                  } @else {
                                    {{ a.title }}
                                  }
                                </div>
                              } @empty {
                                <p class="empty">
                                  No article labelled {{ k }} in the last 72 hours{{
                                    isTracked(k) ? '' : ' — the module does not track it'
                                  }}.
                                </p>
                              }
                            } @else {
                              <p class="muted xsmall">Loading…</p>
                            }
                          }
                        </div>
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr>
                    <td colspan="9" class="empty">No symbol matches the filter.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .detail {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-2) 0;
      }
    `,
  ],
})
export class NewsCoveragePageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly pairs = inject(CurrencyPairsService);
  private readonly configs = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly classes = ASSET_CLASSES;
  protected readonly pct = pct;
  protected readonly signed = signed;

  readonly symbols = signal<string[]>([]);
  readonly focus = signal<ReadonlyMap<string, NewsFocusResult | string>>(new Map());
  readonly config = signal<NewsConfigEntry[]>([]);
  readonly ages = signal<ReadonlyMap<string, number>>(new Map());
  readonly mode = signal<MultiAssetMode>('Observe');
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly assetFilter = signal<SymbolAssetClass | null>(null);
  readonly query = signal('');
  readonly open = signal<string | null>(null);
  readonly articleKey = signal<string | null>(null);
  readonly articles = signal<NewsArticleView[] | null>(null);
  /** The engine's bulk read; null when the engine has no such endpoint (fan-out fallback in use). */
  readonly bulk = signal<NewsCoverageView | null>(null);
  readonly observations = signal<NewsRiskObservationPage | null>(null);
  readonly observationsMissing = signal(false);
  readonly symbolObservations = signal<NewsRiskObservationView[] | null>(null);

  private fanOut: Subscription | null = null;

  readonly tracked = computed(() => {
    const b = this.bulk();
    if (b) return b.tracked.map((k) => k.toUpperCase());
    const exp = parseExposureList(configValue(this.config(), 'NewsIntel:Exposures'));
    return exp.length ? exp : parseExposureList(configValue(this.config(), 'NewsIntel:Currencies'));
  });
  readonly trackedSource = computed(() =>
    this.bulk()
      ? 'as the engine resolves NewsIntel:Exposures'
      : parseExposureList(configValue(this.config(), 'NewsIntel:Exposures')).length
        ? 'NewsIntel:Exposures'
        : 'NewsIntel:Currencies — Exposures is empty',
  );

  readonly rows = computed<CoverageRow[]>(() => {
    const b = this.bulk();
    if (b) return b.symbols.map(coverageRowFromBulk);
    const tracked = new Set(this.tracked());
    const ages = this.ages();
    const f = this.focus();
    return this.symbols().map((s) => {
      const v = f.get(s);
      if (v === undefined) return coverageRowFrom(s, null, tracked, ages, 'Resolving…');
      if (typeof v === 'string') return coverageRowFrom(s, null, tracked, ages, v);
      return coverageRowFrom(s, v, tracked, ages);
    });
  });
  readonly summary = computed(() =>
    coverageSummary(this.rows().filter((r) => !r.problem || r.legs.length)),
  );
  readonly demand = computed(() => untrackedDemand(this.rows()));
  readonly progress = computed(() => {
    const total = this.symbols().length;
    const done = this.focus().size;
    return this.loading() && total ? { done, total } : null;
  });
  readonly visible = computed(() => {
    const c = this.assetFilter();
    const q = this.query().trim().toUpperCase();
    return this.rows().filter(
      (r) =>
        (!c || r.assetClass === c) &&
        (!q || r.symbol.includes(q) || r.legs.some((l) => l.key.includes(q))),
    );
  });

  constructor() {
    this.load();
    this.destroyRef.onDestroy(() => this.fanOut?.unsubscribe());
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.fanOut?.unsubscribe();

    this.svc
      .getConfig()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (entries) => {
          this.config.set(entries);
          this.svc
            .getPressureReadings({ keys: this.tracked(), topItems: 25 })
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: (r) => this.ages.set(newestAgeByKey(r)),
              error: () => this.ages.set(new Map()),
            });
        },
        error: (e) => this.error.set(errorText(e, 'Could not load the module configuration.')),
      });

    this.configs
      .getByKey(MULTI_ASSET_MODE_KEY, { silent: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.mode.set(parseMultiAssetMode(r.data?.value)),
        error: () => this.mode.set('Observe'),
      });

    this.svc
      .getRiskObservations({ take: 1 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (o) => {
          this.observations.set(o);
          this.observationsMissing.set(false);
        },
        error: () => {
          this.observations.set(null);
          this.observationsMissing.set(true);
        },
      });

    this.svc
      .getCoverage()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (view) => {
          this.bulk.set(view);
          this.symbols.set(view.symbols.map((s) => s.symbol));
          this.mode.set(parseMultiAssetMode(view.multiAssetMode));
          this.loading.set(false);
        },
        // An engine without the bulk read: one focus call per symbol, as before.
        error: () => {
          this.bulk.set(null);
          this.loadByFanOut();
        },
      });
  }

  private loadByFanOut(): void {
    this.pairs.list({ currentPage: 1, itemCountPerPage: 500 }).subscribe({
      next: (res) => {
        const syms = [
          ...new Set(
            (res.data?.data ?? [])
              .filter((p) => p.isActive && p.symbol)
              .map((p) => p.symbol!.toUpperCase()),
          ),
        ].sort();
        this.symbols.set(syms);
        this.focus.set(new Map());
        this.resolve(syms);
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(errorText(e, 'Could not load the symbol list.'));
      },
    });
  }

  private resolve(symbols: string[]): void {
    if (!symbols.length) {
      this.loading.set(false);
      return;
    }
    this.fanOut = from(symbols)
      .pipe(
        mergeMap(
          (s) =>
            this.svc.getFocus(s, undefined, { silent: true }).pipe(
              map((f): [string, NewsFocusResult | string] => [s, f]),
              catchError((e) => of<[string, string]>([s, errorText(e, 'Focus failed.')])),
            ),
          FAN_OUT,
        ),
      )
      .subscribe({
        next: ([s, v]) => {
          const next = new Map(this.focus());
          next.set(s, v);
          this.focus.set(next);
        },
        complete: () => this.loading.set(false),
      });
  }

  classCount(c: SymbolAssetClass): number {
    return this.rows().filter((r) => r.assetClass === c).length;
  }

  onAsset(ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    this.assetFilter.set(v ? (v as SymbolAssetClass) : null);
  }

  onQuery(ev: Event): void {
    this.query.set((ev.target as HTMLInputElement).value);
  }

  toggle(symbol: string): void {
    this.open.set(this.open() === symbol ? null : symbol);
    this.articleKey.set(null);
    this.articles.set(null);
    this.symbolObservations.set(null);
    if (this.open() === symbol && !this.observationsMissing()) {
      this.svc
        .getRiskObservations({ symbol, take: 50 })
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: (p) => this.symbolObservations.set(p.items),
          error: () => this.symbolObservations.set(null),
        });
    }
  }

  kindKeys(o: NewsRiskObservationPage): string[] {
    return Object.keys(o.countsByKind).sort();
  }

  kindLabel = riskObservationKindLabel;

  showArticles(key: string): void {
    this.articleKey.set(key);
    this.articles.set(null);
    this.svc
      .getArticles({ currency: key, hours: 72, take: 20 })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => this.articles.set(list),
        error: () => this.articles.set([]),
      });
  }

  isTracked(key: string): boolean {
    return this.tracked().includes(key);
  }

  modeText(r: CoverageRow): string {
    return blackoutModeText(this.mode(), r.modeGovernedKeys);
  }

  weight(w: number): string {
    return `${w > 0 ? '+' : w < 0 ? '−' : ''}${
      Math.abs(w)
        .toFixed(2)
        .replace(/\.?0+$/, '') || '0'
    }`;
  }

  age(m: number | null): string {
    return m === null ? '—' : `${formatMinutes(m)} ago`;
  }

  kind = exposureKindOf;
}
