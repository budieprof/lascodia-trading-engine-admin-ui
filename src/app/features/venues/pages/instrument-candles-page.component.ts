import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';

import { VenuesApiService } from '../venues-api.service';
import { lagText } from '../venues.logic';
import { ADJUSTMENTS, candleChain, candleTiles, rollRows, utcDay } from '../instrument-candles.logic';
import type { FuturesCatalogRoot, InstrumentCandleReadiness, InstrumentCandleState } from '../venues.types';

const EMPTY: InstrumentCandleState = { builderEnabled: false, continuousAdjustment: null, cursors: [], rolls: [], statusCounts: {} };
const ROLL_ROWS_COLLAPSED = 12;
const SOURCE_KIND: Record<string, string> = {
  CmeFutures: 'futures',
  CryptoExchange: 'crypto',
  ExchangeFeed: 'stocks',
  FixVenue: 'FX venues',
};
const CANDIDATE_ROWS_COLLAPSED = 15;

/**
 * Instrument candles (multi-asset WS7 7.10; pages program 2026-10-28): where the non-FX candle builder stands (engine
 * md-candles, `MarketData:InstrumentCandles:Enabled`). Top: the builder's chain link by link (switch → worker → sources
 * enabled → trades stored → receiving today → symbols claimed, from `GET instrument-candles/readiness`) and a summary
 * strip. Then the symbols built (`instrument-candles/state` cursors), the instruments that WOULD be built (eligible master
 * symbols a non-MT5 source maps or stores) with their source status, the continuous-futures roll calendar (master roots
 * from readiness, every other catalog root from `futures/catalog`), the rolls recorded and the adjustment method.
 * Read-only (`marketdata.read`). Without the readiness endpoint (older engine) the links only it knows show "unknown".
 */
@Component({
  selector: 'app-instrument-candles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, FeatureStateComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', '../../market-data/md-summary.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Instrument candles"
        subtitle="The futures, crypto and stock candle builder: one source per symbol, the built span, lag and continuous-futures rolls. Forex candles come from the EA."
      >
        <a class="btn btn-secondary" routerLink="/market-data/sources">Sources</a>
        <a class="btn btn-secondary" routerLink="/docs/multi-asset-setup">Guide</a>
        <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="state.loading()">
          {{ state.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (state.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      }

      <app-feature-state
        title="Instrument candle builder"
        summary="Builds one-minute to daily candles for futures contracts, crypto markets and stocks from the trade prints a market-data source stores — one source per symbol, on each instrument's own trading sessions — and joins futures contracts into continuous series (6E1!, ES1!). Forex and CFD candles always come from the EA and are never touched."
        switchKey="MarketData:InstrumentCandles:Enabled"
        [kind]="chain().kind"
        [detail]="chain().detail"
        [requirements]="chain().requirements"
        [links]="links"
      />

      <div class="tiles" aria-label="Summary">
        @for (t of tiles(); track t.label) {
          <div class="tile" [attr.data-tone]="t.tone ?? null">
            <span class="t-label">{{ t.label }}</span>
            <span class="t-value">{{ t.value }}</span>
            <span class="t-hint">{{ t.hint }}</span>
          </div>
        }
      </div>

      <section class="card" aria-label="Symbols built">
        <header class="card-head">
          <h3>Symbols built</h3>
          @for (s of statuses(); track s.status) {
            <span class="chip" [class.bad]="s.status === 'Blocked' || s.status === 'Stalled'" [class.ok]="s.status === 'Live'">
              {{ s.status }} {{ s.count }}
            </span>
          }
          <span class="spacer"></span>
          <label class="field">
            <span class="sr-only">Symbol or root starts with</span>
            <input class="input search" name="f-sym" placeholder="Filter: symbol or root starts with" [ngModel]="symbol()" (ngModelChange)="symbol.set($event)" (keydown.enter)="state.reload()" />
          </label>
        </header>
        @if (state.value().cursors.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Kind · source</th>
                  <th>Status</th>
                  <th>Built span (UTC)</th>
                  <th title="Minutes between the newest built bar and now">Lag</th>
                  <th title="Candle rows written · trade prints read (excluded: odd lots, outside session)">Bars · prints (excluded)</th>
                </tr>
              </thead>
              <tbody>
                @for (c of state.value().cursors; track c.id) {
                  <tr>
                    <td><code>{{ c.symbol }}</code></td>
                    <td class="small">{{ kindLabel(c.kind) }}<span class="sub">{{ c.sourceId ?? c.root ?? '—' }}</span></td>
                    <td>
                      <span class="chip" [class.ok]="c.status === 'Live'" [class.bad]="c.status === 'Blocked' || c.status === 'Stalled'">{{ c.status }}</span>
                      @if (c.note) {
                        <span class="sub">{{ c.note }}</span>
                      }
                    </td>
                    <td class="small">{{ when(c.builtFromUtc) }} → {{ when(c.builtToUtc) }}</td>
                    <td class="small">{{ lag(c.lagMinutes) }}</td>
                    <td class="small">{{ c.barsWritten }} · {{ c.tradesRead }} ({{ c.tradesExcluded }})</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="pad muted">
            @if (symbol().trim()) {
              No built symbol starts with “{{ symbol().trim() }}”.
            } @else {
              No symbol is built yet. The builder claims a symbol on the first cycle after a source has stored trades for it
              @if (readiness(); as r) {
                — {{ readyCount() }} of the {{ r.candidateTotal }} instruments below have stored trades now.
              } @else {
                — the instruments below are the ones it would build.
              }
            }
          </p>
        }
      </section>

      <div class="two-col">
        <section class="card" aria-label="Instruments that would be built">
          <header class="card-head">
            <h3>Instruments it would build</h3>
            @if (readiness(); as r) {
              <span class="chip">{{ r.candidateTotal }} mapped or stored</span>
            }
          </header>
          @if (readiness(); as r) {
            @if (r.candidates.length) {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Instrument</th>
                      <th>Stage</th>
                      <th>Sources (stored up to, UTC)</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of shownCandidates(); track c.symbol) {
                      <tr>
                        <td><code>{{ c.symbol }}</code><span class="sub" title="The instrument-master row's exchange; candles come from the source chosen per symbol">{{ c.assetClass }} · master row {{ c.exchange }} · {{ c.tradingCalendarCode }}</span></td>
                        <td>
                          <span class="chip" [class.ok]="c.stage === 'building'" [class.info]="c.stage === 'ready'">{{ stageLabel(c.stage) }}</span>
                          @if (c.cursorStatus) {
                            <span class="sub">{{ c.cursorStatus }}</span>
                          }
                        </td>
                        <td>
                          <div class="chips">
                            @for (s of c.sources; track s.sourceId) {
                              <span class="chip" [class.ok]="s.storedTo === today()" [class.warn]="s.enabled && !s.storedTo" [title]="sourceTitle(s)">
                                {{ s.sourceId }}{{ s.storedTo ? ' · ' + s.storedTo : s.enabled ? ' · mapped, its feed sends no trades' : ' · disabled' }}
                              </span>
                            }
                          </div>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (r.candidates.length > candidateLimit) {
                <button type="button" class="toggle-more" (click)="allCandidates.set(!allCandidates())">
                  {{ allCandidates() ? 'Show fewer' : 'Show all ' + r.candidates.length }}
                </button>
              }
            } @else {
              <p class="pad muted">
                No futures, crypto or stock data source maps or stores any of the {{ eligible() }} eligible instruments. Map
                symbols on a source (Market data → Sources) and run its feed.
              </p>
            }
            <p class="note">
              Eligible = an instrument-master future, crypto market, stock or ETF with no forex pair row. “Stored” = the
              source has trade prints for it in the market-data store; “mapped only” = the source lists it but nothing is
              stored yet.
            </p>
          } @else {
            <p class="pad muted">{{ readinessNote() }}</p>
          }
        </section>

        <section class="card" aria-label="Sources">
          <header class="card-head">
            <h3>Futures, crypto and stock sources</h3>
            <span class="spacer"></span>
            <a class="small" routerLink="/market-data/sources">Manage</a>
          </header>
          @if (readiness(); as r) {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>State</th>
                    <th title="Symbols mapped that are eligible instruments · symbols with stored data">Mapped · stored</th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of shownSources(); track s.sourceId) {
                    <tr>
                      <td><code>{{ s.sourceId }}</code><span class="sub">{{ s.displayName }}</span></td>
                      <td>
                        <span class="chip" [class.ok]="s.lastStoredDay === today()" [class.warn]="s.enabled && s.lastStoredDay !== today()">
                          {{ sourceState(s) }}
                        </span>
                      </td>
                      <td class="small">
                        {{ s.mappedEligible }} · {{ s.storedSymbols }}
                        @if (s.lastStoredDay) {
                          <span class="sub">last stored {{ s.lastStoredDay }}</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (idleSources().length) {
              <p class="pad muted small">
                @if (!allSources()) {
                  {{ idleSources().length }} more registered but disabled (never used): {{ idleSummary() }}.
                }
                <button type="button" class="toggle-more" (click)="allSources.set(!allSources())">
                  {{ allSources() ? 'Hide disabled' : 'Show them' }}
                </button>
              </p>
            }
          } @else {
            <p class="pad muted">{{ readinessNote() }}</p>
          }
        </section>
      </div>

      <section class="card" aria-label="Roll calendar">
        <header class="card-head">
          <h3>Continuous futures roll calendar</h3>
          <span class="chip">{{ rolls().length }} roots</span>
          @if (readiness()) {
            <span class="chip ok">{{ masterRoots() }} in the instrument master</span>
          }
        </header>
        @if (rolls().length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Root · series</th>
                  <th>Exchange</th>
                  <th title="The continuous series moves to the next contract on this date (the roll rule's business days before the last trade)">Next roll (UTC)</th>
                  <th>Then</th>
                  <th>Last rolled</th>
                  <th>Built by the builder</th>
                </tr>
              </thead>
              <tbody>
                @for (x of shownRolls(); track x.root) {
                  <tr>
                    <td><code>{{ x.continuousSymbol }}</code><span class="sub">{{ x.root }} · {{ x.description }}</span></td>
                    <td class="small">{{ x.exchange }}<span class="sub">{{ x.group }} · {{ x.rollRule }}</span></td>
                    <td class="small">
                      @if (x.next) {
                        <strong>{{ x.next.contract }}</strong> {{ x.next.rollUtc.slice(0, 10) }}
                        <span class="sub">in {{ x.next.days }} days</span>
                      } @else {
                        —
                      }
                    </td>
                    <td class="small">{{ x.following ? x.following.contract + ' ' + x.following.rollUtc.slice(0, 10) : '—' }}</td>
                    <td class="small">{{ x.lastRolled ? x.lastRolled.contract + ' ' + x.lastRolled.rollUtc.slice(0, 10) : '—' }}</td>
                    <td class="small">
                      @if (x.inMaster) {
                        <span class="chip" [class.ok]="x.continuousStatus === 'Live'">{{ x.continuousStatus ?? 'yes — waiting for contract candles' }}</span>
                      } @else if (readiness()) {
                        <span class="muted">not in the instrument master</span>
                      } @else {
                        <span class="muted" title="Which roots are in the instrument master comes with the engine update (instrument-candles/readiness)">not known yet</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (rolls().length > rollLimit) {
            <button type="button" class="toggle-more" (click)="allRolls.set(!allRolls())">
              {{ allRolls() ? 'Show fewer' : 'Show all ' + rolls().length + ' roots' }}
            </button>
          }
        } @else if (!catalog.loading()) {
          <p class="pad muted">The engine returned no futures roots.</p>
        }
        <p class="note">
          Roots in the instrument master (FutureRoot rows) get continuous series from the builder once their contracts'
          candles exist. The other roots are in the futures feed catalog only: their contracts stream when a futures source
          runs, but no continuous series is stitched until the instrument reference sync adds them to the master.
        </p>
      </section>

      <section class="card" aria-label="Rolls recorded">
        <header class="card-head">
          <h3>Rolls recorded</h3>
          <span class="chip">{{ state.value().rolls.length }}</span>
        </header>
        @if (state.value().rolls.length) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Series</th>
                  <th>Roll (UTC)</th>
                  <th>From → to</th>
                  <th>Prices</th>
                  <th title="Panama adds the gap; Ratio multiplies by the ratio">Gap · ratio</th>
                  <th>Observed from</th>
                </tr>
              </thead>
              <tbody>
                @for (r of state.value().rolls; track r.id) {
                  <tr>
                    <td><code>{{ r.continuousSymbol }}</code></td>
                    <td class="small">{{ when(r.rollUtc) }}</td>
                    <td class="small">{{ r.fromContract }} → {{ r.toContract }}</td>
                    <td class="small">{{ r.fromPrice ?? '—' }} → {{ r.toPrice ?? '—' }}</td>
                    <td class="small">{{ r.gap }} · {{ r.ratio }}</td>
                    <td class="small">
                      <span class="chip" [class.warn]="r.priceSource === 'unobserved'">{{ r.priceSource }}</span>
                      <span class="sub">{{ when(r.observedAtUtc) }}</span>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <p class="pad muted">
            None yet. A roll is recorded when the builder stitches a continuous series across a contract change, with the
            settlement (or last common one-minute close) of both contracts.
            @if (nextMasterRoll(); as n) {
              Next one due: <strong>{{ n.continuousSymbol }}</strong> {{ n.next!.contract }} on {{ n.next!.rollUtc.slice(0, 10) }}
              — recorded only if that contract's candles are being built by then.
            }
          </p>
        }
        <div class="card-body">
          <div class="methods" aria-label="Adjustment methods">
            @for (m of adjustments; track m.method) {
              <div class="method" [class.current]="m.method === adjustment()">
                <strong>{{ m.title }}{{ m.method === adjustment() ? ' — in use' : '' }}</strong>
                {{ m.text }}
              </div>
            }
          </div>
          <p class="note">
            Each root gets two series: <code>6E1!</code> adjusted with the method in use
            (<code>MarketData:InstrumentCandles:Continuous:Adjustment</code>) and <code>6E1!U</code> always unadjusted.
            Changing the method rebuilds the adjusted series from the start.
            @if (readiness(); as r) {
              Continuous series are {{ r.continuousEnabled ? 'on' : 'off' }}; backfill reaches {{ r.backfillMaxDays }} days;
              stock odd lots are {{ r.excludeEquityOddLots ? 'excluded' : 'included' }}.
            }
          </p>
        </div>
      </section>
    </div>
  `,
})
export class InstrumentCandlesPageComponent {
  private readonly api = inject(VenuesApiService);

  protected readonly when = when;
  protected readonly lag = lagText;
  protected readonly adjustments = ADJUSTMENTS;
  protected readonly rollLimit = ROLL_ROWS_COLLAPSED;
  protected readonly candidateLimit = CANDIDATE_ROWS_COLLAPSED;
  protected readonly links = [
    { label: 'Market-data sources', route: '/market-data/sources' },
    { label: 'Candle coverage', route: '/market-data/coverage' },
    { label: 'Builder settings', route: '/engine-config', query: { search: 'MarketData:InstrumentCandles' } },
    { label: 'Guide: switching on futures, crypto and stocks', route: '/docs/multi-asset-setup' },
  ];

  readonly symbol = signal('');
  readonly allRolls = signal(false);
  readonly allCandidates = signal(false);
  private readonly now = signal(Date.now());

  readonly state = iamResource<InstrumentCandleState>(
    () => this.api.instrumentCandleState({ symbol: this.symbol().trim() || undefined }),
    EMPTY,
    'Could not load the instrument candle state.',
  );
  /** Null while the engine has no readiness endpoint (404) or the read failed — the page then says so. */
  readonly readinessRes = iamResource<InstrumentCandleReadiness | null>(
    () => this.api.instrumentCandleReadiness().pipe(catchError(() => of(null))),
    null,
  );
  readonly catalog = iamResource<FuturesCatalogRoot[]>(
    () => this.api.futuresCatalog().pipe(catchError(() => of([]))),
    [],
  );

  readonly readiness = computed(() => this.readinessRes.value());
  readonly today = computed(() => utcDay(this.now()));
  readonly statuses = computed(() =>
    Object.entries(this.state.value().statusCounts ?? {}).map(([status, count]) => ({ status, count })),
  );
  readonly chain = computed(() => candleChain(this.state.value(), this.readiness(), this.now()));
  readonly rolls = computed(() => rollRows(this.readiness(), this.catalog.value(), this.now()));
  readonly tiles = computed(() => candleTiles(this.state.value(), this.readiness(), this.rolls(), this.now()));
  readonly masterRoots = computed(() => this.rolls().filter((r) => r.inMaster).length);
  readonly shownRolls = computed(() => (this.allRolls() ? this.rolls() : this.rolls().slice(0, ROLL_ROWS_COLLAPSED)));
  readonly nextMasterRoll = computed(() => this.rolls().find((r) => r.inMaster && r.next) ?? null);
  readonly shownCandidates = computed(() => {
    const all = this.readiness()?.candidates ?? [];
    return this.allCandidates() ? all : all.slice(0, CANDIDATE_ROWS_COLLAPSED);
  });
  readonly readyCount = computed(() => (this.readiness()?.candidates ?? []).filter((c) => c.stage !== 'mapped').length);
  readonly eligible = computed(() =>
    Object.values(this.readiness()?.eligibleByClass ?? {}).reduce((a, b) => a + b, 0).toLocaleString('en-US'),
  );
  readonly sortedSources = computed(() =>
    [...(this.readiness()?.sources ?? [])].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || b.storedSymbols - a.storedSymbols || a.sourceId.localeCompare(b.sourceId),
    ),
  );
  readonly allSources = signal(false);
  /** Disabled sources that never stored anything — one line unless asked for. */
  readonly idleSources = computed(() => this.sortedSources().filter((s) => !s.enabled && s.storedSymbols === 0));
  readonly shownSources = computed(() =>
    this.allSources() ? this.sortedSources() : this.sortedSources().filter((s) => s.enabled || s.storedSymbols > 0),
  );
  readonly idleSummary = computed(() => {
    const by = new Map<string, string[]>();
    for (const s of this.idleSources()) {
      const k = SOURCE_KIND[s.kind] ?? s.kind;
      by.set(k, [...(by.get(k) ?? []), s.sourceId + (s.mappedEligible ? ` (${s.mappedEligible} mapped)` : '')]);
    }
    return [...by.entries()].map(([k, ids]) => `${k}: ${ids.join(', ')}`).join(' · ');
  });
  readonly adjustment = computed(
    () => this.readiness()?.continuousAdjustment ?? this.state.value().continuousAdjustment ?? 'Panama',
  );
  readonly readinessNote = computed(() =>
    this.readinessRes.loading() && !this.readinessRes.loaded()
      ? 'Loading…'
      : 'The engine on this server does not report source readiness yet (instrument-candles/readiness arrives with the next engine update). The sources page shows each source meanwhile.',
  );

  constructor() {
    this.reload();
  }

  reload(): void {
    this.now.set(Date.now());
    this.state.reload();
    this.readinessRes.reload();
    this.catalog.reload();
  }

  kindLabel(kind: string): string {
    return kind === 'Continuous' ? 'Continuous (adjusted)' : kind === 'ContinuousUnadjusted' ? 'Continuous (raw)' : kind;
  }

  stageLabel(stage: string): string {
    return stage === 'building' ? 'Building' : stage === 'ready' ? 'Trades stored' : 'Mapped only';
  }

  sourceTitle(s: { enabled: boolean; mapped: boolean; storedFrom: string | null; storedTo: string | null }): string {
    return `${s.enabled ? 'enabled' : 'disabled'} · ${s.mapped ? 'in its symbol map' : 'not in its symbol map'} · ${
      s.storedFrom ? `stored ${s.storedFrom} → ${s.storedTo}` : 'nothing stored'
    }`;
  }

  sourceState(s: { enabled: boolean; writers: number; lastStoredDay: string | null }): string {
    if (s.lastStoredDay === this.today()) return 'Receiving today';
    if (!s.enabled) return s.lastStoredDay ? `Disabled · last ${s.lastStoredDay}` : 'Disabled';
    if (s.writers === 0) return 'Enabled · no writer';
    return s.lastStoredDay ? `Quiet since ${s.lastStoredDay}` : 'Enabled · nothing stored yet';
  }
}
