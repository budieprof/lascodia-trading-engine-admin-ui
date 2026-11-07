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
  NiDbarComponent,
  NiInfoComponent,
  NiKeyComponent,
  NiMeterComponent,
  NiPanelComponent,
  NiStatComponent,
} from '../components/viz/ni-primitives';
import { kindVar } from '../components/viz/ni-viz';
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
  imports: [
    DatePipe,
    RouterLink,
    NewsIntelNavComponent,
    FeatureStateComponent,
    NiDbarComponent,
    NiInfoComponent,
    NiKeyComponent,
    NiMeterComponent,
    NiPanelComponent,
    NiStatComponent,
  ],
  styleUrls: ['../news-intel-shared.scss'],
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>News coverage</h1>
          <app-ni-info text="Every tradable symbol as the news module sees it: the exposures it is made of (ADR-0035), which of them the module tracks, the symbol bias and coverage, and whether the calendar blackout can stop entries on it." />
        </div>
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
        <div class="ni-kpis kpi7">
          <app-ni-stat label="Symbols" [value]="summary().symbols" [sub]="tracked().length + ' keys tracked'" info="Every active symbol in the universe, resolved through the exposure map." />
          <app-ni-stat label="Full" [value]="summary().fullyCovered" [sub]="share(summary().fullyCovered)" tone="ok" info="Every leg of the symbol is a tracked exposure — the reading is complete." />
          <app-ni-stat label="Partial" [value]="summary().partlyCovered" [sub]="share(summary().partlyCovered)" [tone]="summary().partlyCovered ? 'warn' : null" info="Some legs untracked: the symbol bias is computed only from tracked legs (or withheld when a main leg is missing)." />
          <app-ni-stat label="None" [value]="summary().uncovered" [sub]="share(summary().uncovered)" [tone]="summary().uncovered ? 'bad' : null" info="No leg tracked — the module says nothing about this symbol." />
          <app-ni-stat label="Unplaced" [value]="summary().unplaced" info="Symbols the exposure map could not resolve to any leg." />
          <app-ni-stat label="Blackout mode" [value]="mode()" [sub]="summary().withModeGovernedKeys + ' symbols governed'" info="NewsBlackout:MultiAsset:Mode — Off / Observe (record would-blocks) / Enforce (refuse entries). Change it on the Risk use tab." />
          <app-ni-stat label="Observations 7d" [value]="observations()?.total ?? (observationsMissing() ? 'n/a' : '—')" [sub]="obsSub()" info="Recorded risk observations (would-block / blocked) over 7 days, live decisions only — never backtests." />
        </div>
        @if (progress(); as p) {
          <app-ni-meter [value]="p.done / p.total" [label]="p.done + ' / ' + p.total" />
        }

        <div class="ni-grid-main">
          <div class="ni-stack">
          <app-ni-panel title="By asset class" info="Per class: symbols with every leg tracked (green), some legs untracked (amber), none tracked (red), unplaced (grey). Click a class to filter the matrix.">
            @if (bulk(); as b) {
              <span meta data-testid="coverage-bulk">engine read {{ b.computedAtUtc | date: 'HH:mm:ss' : 'UTC' }}Z{{ b.cached ? ' (cached)' : '' }} · {{ b.pressureKeysComputed }} keys computed · tracked {{ trackedSource() }}</span>
            } @else {
              <span meta>fan-out fallback · tracked {{ trackedSource() }}</span>
            }
            <div class="classes">
              @for (c of classBreakdown(); track c.cls) {
                <button type="button" class="cls" [class.on]="assetFilter() === c.cls" (click)="setAsset(c.cls)">
                  <span class="cn">{{ c.cls }}</span>
                  <span class="cnt">{{ c.total }}</span>
                  <span class="stack" [title]="c.full + ' full · ' + c.partial + ' partial · ' + c.none + ' none · ' + c.unplaced + ' unplaced'">
                    @if (c.full) { <i class="f" [style.flex-grow]="c.full"></i> }
                    @if (c.partial) { <i class="p" [style.flex-grow]="c.partial"></i> }
                    @if (c.none) { <i class="n" [style.flex-grow]="c.none"></i> }
                    @if (c.unplaced) { <i class="u" [style.flex-grow]="c.unplaced"></i> }
                  </span>
                  <span class="pctc">{{ c.total ? ((c.full / c.total) * 100).toFixed(0) : 0 }}%</span>
                </button>
              }
            </div>
            <div class="cls-legend"><span><i class="f"></i>full</span><span><i class="p"></i>partial</span><span><i class="n"></i>none</span><span><i class="u"></i>unplaced</span></div>
          </app-ni-panel>
          <app-ni-panel title="Risk observations (7 days)" info="Would-block and blocked decisions recorded by the gates (multi-asset blackout, scheduled events, breaking-news gate, stop widening). Only live decisions are recorded." data-testid="coverage-observations">
            <a actions class="lnk" routerLink="/news-intel/risk">Risk use →</a>
            @if (observations(); as o) {
              <div class="obs">
                <span class="ob"><b>{{ o.total }}</b> total</span>
                @for (k of kindKeys(o); track k) {
                  <span class="ob"><b>{{ o.countsByKind[k] }}</b> {{ kindLabel(k) }}</span>
                }
              </div>
              @if (o.total === 0) {
                <p class="empty">Nothing recorded — no gate met an event on a tradable symbol in the window.</p>
              }
            } @else if (observationsMissing()) {
              <p class="empty">This engine build does not record observations yet (metrics/log lines only).</p>
            } @else {
              <p class="empty">Loading…</p>
            }
          </app-ni-panel>
          </div>

          <div class="ni-stack">
            <app-ni-panel title="Untracked keys the universe needs" info="Each is a leg of at least one symbol that the module does not track, so that symbol's reading is partial (or null). Number = symbols needing it. Track them on the Exposures tab.">
              <a actions class="lnk" routerLink="/news-intel/exposures">Exposures →</a>
              @if (demand().length) {
                <div class="legs">
                  @for (d of demand().slice(0, 48); track d.key) {
                    <span class="key untracked dk" [title]="d.symbols + ' symbol(s) need ' + d.key"><i [style.background]="kindColor(d.key)"></i>{{ d.key }}<b>{{ d.symbols }}</b></span>
                  }
                  @if (demand().length > 48) {
                    <span class="faint xsmall">+{{ demand().length - 48 }} more</span>
                  }
                </div>
              } @else {
                <p class="empty">Every leg the universe needs is tracked.</p>
              }
            </app-ni-panel>


          </div>
        </div>

        <app-ni-panel title="Symbols" info="Legs: dashed = untracked, ƒ = fitted loading. Coverage = share of |weight| on tracked legs. Bias = tanh(Σ weight × score), n/a when a main leg is untracked (a number would claim coverage that does not exist). Blackout: the multi-asset mode governs it, or 'legacy' = economic calendar only. Click a row for the detail." [flush]="true">
          <span meta>{{ visible().length }} of {{ rows().length }}</span>
          <div actions class="filters">
            <select class="sel" aria-label="Asset class" [value]="assetFilter() ?? ''" (change)="onAsset($event)">
              <option value="">All classes</option>
              @for (c of classes; track c) {
                <option [value]="c">{{ c }} ({{ classCount(c) }})</option>
              }
            </select>
            <input class="inp" placeholder="Filter symbol or key" aria-label="Filter symbol or key" [value]="query()" (input)="onQuery($event)" />
          </div>
          <div class="table-wrap matrix">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Legs</th>
                  <th>Coverage</th>
                  <th>Symbol bias</th>
                  <th class="num">Newest</th>
                  <th>Calendar keys</th>
                  <th>Blackout</th>
                  <th class="num" title="Recorded risk observations, 7 days">Obs</th>
                </tr>
              </thead>
              @for (g of grouped(); track g.cls) {
                <tbody>
                  <tr class="grp">
                    <td colspan="8"><span>{{ g.cls }}</span><span class="gcount">{{ g.rows.length }}</span></td>
                  </tr>
                  @for (r of g.rows; track r.symbol) {
                    <tr class="clickable" [class.sel]="open() === r.symbol" (click)="toggle(r.symbol)">
                      <td class="mono sym">{{ r.symbol }}</td>
                      <td>
                        @if (r.problem) {
                          <span class="faint xsmall">{{ r.problem }}</span>
                        } @else {
                          <div class="legs">
                            @for (l of r.legs; track l.key) {
                              <span class="lg" [class.untracked]="!l.covered" [title]="l.key + ' · ' + l.basis + (l.fitted ? ' · fitted' : '') + (l.covered ? '' : ' — not tracked')">
                                <i [style.background]="kindColor(l.key)"></i>{{ l.key }}<em>{{ weight(l.weight) }}{{ l.fitted ? 'ƒ' : '' }}</em>
                              </span>
                            }
                          </div>
                        }
                      </td>
                      <td class="w-cov">
                        <app-ni-meter [value]="r.coverage" [label]="pct(r.coverage)" [tone]="covTone(r)" />
                      </td>
                      <td class="w-bias" [title]="r.symbolBias === null ? 'Null on purpose: a main leg is untracked' : ''">
                        @if (r.symbolBias === null) {
                          <span class="faint xsmall">n/a</span>
                        } @else {
                          <app-ni-dbar [value]="r.symbolBias" [digits]="3" />
                        }
                      </td>
                      <td class="num faint">{{ shortAge(r.newestAgeMinutes) }}</td>
                      <td>
                        <div class="legs">
                          @for (k of r.calendarKeys; track k) {
                            <span class="ck">{{ k }}</span>
                          } @empty {
                            <span class="pill warn" title="The blackout never blocks this symbol">none</span>
                          }
                        </div>
                      </td>
                      <td>
                        @if (r.modeGovernedKeys.length) {
                          <span class="pill" [class.ok]="mode() === 'Enforce'" [class.info]="mode() === 'Observe'">{{ mode() }}</span>
                        } @else if (r.calendarKeys.length) {
                          <span class="pill plain">legacy</span>
                        }
                      </td>
                      <td class="num">{{ r.riskObservations7d ?? '—' }}</td>
                    </tr>
                    @if (open() === r.symbol) {
                      <tr class="row-detail">
                        <td colspan="8">
                          <div class="detail">
                            <div class="dh">
                              <p class="small">{{ modeText(r) }}</p>
                              <p class="xsmall faint">
                                Resolved from {{ r.source }}.
                                @if (r.includedInPrompt) {
                                  The spot-analysis prompt carries this reading.
                                } @else if (r.omissionReason) {
                                  Not in the prompt: {{ r.omissionReason }}
                                }
                              </p>
                            </div>
                            @if (r.exactKeys) {
                              <div class="keyrows" data-testid="coverage-keys">
                                <span class="kl">Always refuses</span>
                                <span class="legs">
                                  @for (k of r.legacyEnforcedKeys ?? []; track k) {
                                    <span class="ck">{{ k }}</span>
                                  } @empty {
                                    <span class="faint xsmall">nothing (legacy blackout never blocked it)</span>
                                  }
                                </span>
                                <span class="kl">Mode-governed</span>
                                <span class="legs">
                                  @for (k of r.modeGovernedKeys; track k) {
                                    <span class="ck dashed">{{ k }}</span>
                                  } @empty {
                                    <span class="faint xsmall">none</span>
                                  }
                                </span>
                                <span class="kl">Refusing now ({{ mode() }})</span>
                                <span class="legs">
                                  @for (k of r.blockingKeys ?? []; track k) {
                                    <span class="ck">{{ k }}</span>
                                  } @empty {
                                    <span class="faint xsmall">none</span>
                                  }
                                </span>
                              </div>
                            }
                            <div class="ni-grid-2">
                              <table class="inner">
                                <thead>
                                  <tr>
                                    <th>Leg</th>
                                    <th class="num">Weight</th>
                                    <th>Basis</th>
                                    <th>Score</th>
                                    <th class="num">Newest</th>
                                    <th></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  @for (l of r.legs; track l.key) {
                                    <tr>
                                      <td><app-ni-key [key]="l.key" [untracked]="!l.covered" /></td>
                                      <td class="num">{{ weight(l.weight) }}</td>
                                      <td class="faint">{{ l.fitted ? 'fitted' : 'static' }} · {{ l.basis }}</td>
                                      <td style="min-width: 120px">
                                        @if (l.covered) {
                                          <app-ni-dbar [value]="l.score" [digits]="3" />
                                        } @else {
                                          <span class="faint xsmall">untracked</span>
                                        }
                                      </td>
                                      <td class="num faint">{{ shortAge(l.newestAgeMinutes) }}</td>
                                      <td class="num">
                                        <button type="button" class="btn subtle tiny" (click)="showArticles(l.key); $event.stopPropagation()">Articles</button>
                                      </td>
                                    </tr>
                                  }
                                </tbody>
                              </table>
                              <div class="side">
                                @if (articleKey(); as k) {
                                  <h3>Articles labelled {{ k }} · 72h</h3>
                                  @if (articles(); as list) {
                                    <ul class="alist">
                                      @for (a of list; track a.id) {
                                        <li>
                                          <span class="faint">{{ a.firstSeenUtc | date: 'MMM d HH:mm' : 'UTC' }}</span>
                                          @if (a.url) {
                                            <a [href]="a.url" target="_blank" rel="noopener">{{ a.title }}</a>
                                          } @else {
                                            <span>{{ a.title }}</span>
                                          }
                                          <span class="faint">{{ a.sourceName }}</span>
                                        </li>
                                      } @empty {
                                        <li class="empty">No article labelled {{ k }} in 72h{{ isTracked(k) ? '' : ' — the module does not track it' }}.</li>
                                      }
                                    </ul>
                                  } @else {
                                    <p class="empty">Loading…</p>
                                  }
                                } @else if (symbolObservations(); as so) {
                                  <h3>Observations for {{ r.symbol }} · 7d</h3>
                                  <ul class="alist">
                                    @for (o of so; track o.id) {
                                      <li>
                                        <span class="faint">{{ o.observedAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</span>
                                        <span>{{ kindLabel(o.kind) }} <span class="pill plain">{{ o.mode }}</span> <span class="ck">{{ o.key ?? '—' }}</span> {{ o.detail ?? '' }}</span>
                                        @if (o.eventAtUtc) {
                                          <span class="faint">event {{ o.eventAtUtc | date: 'MMM d HH:mm' : 'UTC' }}</span>
                                        }
                                      </li>
                                    } @empty {
                                      <li class="empty">None recorded. Pick a leg's Articles to read its news.</li>
                                    }
                                  </ul>
                                } @else {
                                  <p class="empty">Pick a leg's Articles to read its news.</p>
                                }
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              } @empty {
                <tbody>
                  <tr>
                    <td colspan="8" class="empty">No symbol matches the filter.</td>
                  </tr>
                </tbody>
              }
            </table>
          </div>
        </app-ni-panel>
      }
    </div>
  `,
  styles: [
    `
      .kpi7 {
        grid-template-columns: repeat(7, minmax(0, 1fr));
      }
      @media (max-width: 1200px) {
        .kpi7 {
          grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        }
      }
      .title {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .lnk {
        font-size: 11px;
        color: var(--accent);
        text-decoration: none;
      }
      .classes {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cls {
        display: grid;
        grid-template-columns: 74px 32px minmax(0, 1fr) 40px;
        align-items: center;
        gap: 8px;
        border: 0;
        background: transparent;
        padding: 4px 6px;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        color: var(--text-primary);
        text-align: left;
      }
      .cls:hover,
      .cls.on {
        background: var(--ni-sunken);
      }
      .cls.on {
        box-shadow: inset 2px 0 0 var(--accent);
      }
      .cnt,
      .pctc {
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
        text-align: right;
        font-size: 11.5px;
      }
      .stack {
        display: flex;
        gap: 2px;
        height: 10px;
        border-radius: 3px;
        overflow: hidden;
        background: var(--ni-sunken);
      }
      .stack i,
      .cls-legend i {
        display: block;
        flex-basis: 0;
        min-width: 3px;
      }
      .f {
        background: var(--ni-ok);
      }
      .p {
        background: var(--warning, #ff9500);
      }
      .n {
        background: var(--ni-bad);
      }
      .u {
        background: var(--text-tertiary);
      }
      .cls-legend {
        display: flex;
        gap: 12px;
        font-size: 10.5px;
        color: var(--text-tertiary);
        padding-left: 6px;
      }
      .cls-legend span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .cls-legend i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .dk {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .dk i {
        width: 6px;
        height: 6px;
        border-radius: 2px;
      }
      .dk b {
        font-weight: 600;
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .obs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .ob {
        font-size: 11.5px;
        color: var(--text-secondary);
        padding: 3px 8px;
        border-radius: 6px;
        background: var(--ni-sunken);
      }
      .ob b {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .matrix {
        max-height: 720px;
      }
      .matrix th:first-child,
      .matrix td:first-child {
        padding-left: 12px;
      }
      .matrix th:last-child,
      .matrix td:last-child {
        padding-right: 12px;
      }
      tr.grp td {
        background: var(--ni-sunken);
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-secondary);
        padding-top: 4px;
        padding-bottom: 4px;
        position: sticky;
        top: 27px;
        z-index: 1;
      }
      .gcount {
        margin-left: 6px;
        color: var(--text-tertiary);
        font-weight: 500;
      }
      .inner td {
        white-space: nowrap;
      }
      .alist li.empty {
        display: block;
        border-bottom: 0;
      }
      .sym {
        font-weight: 600;
        font-size: 11.5px;
      }
      .lg {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0 5px;
        line-height: 18px;
        border-radius: 5px;
        border: 1px solid var(--border);
        background: var(--ni-panel);
        font-family: var(--ni-mono);
        font-size: 10.5px;
        white-space: nowrap;
      }
      .lg i {
        width: 6px;
        height: 6px;
        border-radius: 2px;
      }
      .lg em {
        font-style: normal;
        color: var(--text-tertiary);
      }
      .lg.untracked {
        border-style: dashed;
        border-color: var(--text-tertiary);
        background: transparent;
        color: var(--text-secondary);
      }
      .w-cov {
        width: 110px;
      }
      .w-bias {
        width: 150px;
      }
      .ck {
        font-family: var(--ni-mono);
        font-size: 10.5px;
        padding: 0 5px;
        line-height: 17px;
        border-radius: 4px;
        background: var(--ni-sunken);
        white-space: nowrap;
      }
      .ck.dashed {
        background: transparent;
        border: 1px dashed var(--text-tertiary);
      }
      .detail {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 8px 4px 10px;
      }
      .keyrows {
        display: grid;
        grid-template-columns: 130px minmax(0, 1fr);
        gap: 4px 10px;
        align-items: center;
        font-size: 11.5px;
      }
      .kl {
        color: var(--text-tertiary);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .inner th {
        position: static;
        background: transparent;
      }
      .side h3 {
        font-size: 11.5px;
        margin-bottom: 4px;
      }
      .alist {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        max-height: 240px;
        overflow-y: auto;
      }
      .alist li {
        display: grid;
        grid-template-columns: 82px minmax(0, 1fr) auto;
        gap: 8px;
        font-size: 11.5px;
        padding: 3px 0;
        border-bottom: 1px solid var(--border);
      }
      .alist a {
        color: var(--text-primary);
        text-decoration: none;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .alist a:hover {
        color: var(--accent);
      }
      .btn.tiny {
        padding: 0 7px;
        line-height: 18px;
        font-size: 11px;
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

  // ── Dense layout helpers ──
  readonly classBreakdown = computed(() => {
    const out: { cls: SymbolAssetClass; total: number; full: number; partial: number; none: number; unplaced: number }[] = [];
    for (const cls of ASSET_CLASSES) {
      const rs = this.rows().filter((r) => r.assetClass === cls);
      if (!rs.length) continue;
      let full = 0, partial = 0, none = 0, unplaced = 0;
      for (const r of rs) {
        if (!r.legs.length) unplaced++;
        else if (r.untrackedLegs === 0) full++;
        else if (r.coveredLegs === 0) none++;
        else partial++;
      }
      out.push({ cls, total: rs.length, full, partial, none, unplaced });
    }
    return out;
  });

  readonly grouped = computed(() => {
    const v = this.visible();
    return ASSET_CLASSES.map((cls) => ({ cls, rows: v.filter((r) => r.assetClass === cls) })).filter(
      (g) => g.rows.length,
    );
  });

  readonly obsSub = computed(() => {
    const o = this.observations();
    if (!o) return null;
    const ks = Object.keys(o.countsByKind);
    return ks.length ? ks.map((k) => `${o.countsByKind[k]} ${riskObservationKindLabel(k)}`).join(' · ') : 'none recorded';
  });

  share(n: number): string {
    const t = this.summary().symbols;
    return t ? `${Math.round((n / t) * 100)}% of symbols` : '';
  }

  setAsset(c: SymbolAssetClass): void {
    this.assetFilter.set(this.assetFilter() === c ? null : c);
  }

  kindColor(key: string): string {
    return kindVar(key);
  }

  covTone(r: CoverageRow): 'ok' | 'warn' | 'bad' | null {
    if (r.coverage === null) return null;
    return r.coverage >= 0.999 ? 'ok' : r.coverage > 0 ? 'warn' : 'bad';
  }

  shortAge(m: number | null): string {
    return m === null ? '—' : formatMinutes(m);
  }
}
