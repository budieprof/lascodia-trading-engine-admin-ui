import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { NewsIntelService } from '@core/services/news-intel.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { NewsIntelNavComponent } from '@features/news-intel/components/news-intel-nav.component';
import { NewsExposureLegsComponent } from '@features/news-intel/components/news-exposure-legs.component';
import { isMaskedValue, isSecretKey } from '@features/news-intel/news-intel.logic';
import {
  NiDbarComponent,
  NiInfoComponent,
  NiKeyComponent,
  NiMeterComponent,
  NiPanelComponent,
  NiStatComponent,
} from '@features/news-intel/components/viz/ni-primitives';
import {
  LineSeries,
  NiLinesComponent,
  NiPressureMapComponent,
  NiStackedComponent,
  PressureCell,
  StackBucket,
} from '@features/news-intel/components/viz/ni-charts';
import {
  ago,
  compact,
  kindVar,
  minutesText,
  SERIES_VARS,
  shortKey,
  signed,
  thin,
} from '@features/news-intel/components/viz/ni-viz';
import {
  NewsArticleView,
  NewsClassificationStatus,
  NewsConfigChange,
  NewsConfigEntry,
  NewsFocusResult,
  NewsPressureLeg,
  NewsPressureItem,
  NewsPressureSummaryView,
  NewsCurrencySeries,
  NewsIngestBucket,
  NEWS_READ_ONLY_KEYS,
  NewsStoryView,
  ScheduledMarketEventRow,
} from '@features/news-intel/news-intel.types';

/**
 * News Intelligence cockpit — visibility and control over the news module: what was
 * ingested, how it was labelled, what pressure that produces, and whether the analysis
 * prompt is being told about it.
 *
 * The focus panel is the centrepiece. It calls the SAME engine service the snapshot builder
 * uses, so what an operator reads here is what the model receives — including the case where
 * a real reading exists but is deliberately withheld from the prompt.
 */
@Component({
  selector: 'app-news-intel-page',
  standalone: true,
  imports: [
    DatePipe,
    DecimalPipe,
    ConfirmDialogComponent,
    RefreshButtonComponent,
    RouterLink,
    NewsIntelNavComponent,
    NewsExposureLegsComponent,
    NiDbarComponent,
    NiInfoComponent,
    NiKeyComponent,
    NiMeterComponent,
    NiPanelComponent,
    NiStatComponent,
    NiLinesComponent,
    NiPressureMapComponent,
    NiStackedComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div class="title">
          <h1>{{ settingsView ? 'News Intelligence · Settings' : 'News Intelligence' }}</h1>
          <div class="state-pills">
            @if (moduleEnabled() !== null) {
              <span class="pill" [class.ok]="moduleEnabled()" [class.bad]="!moduleEnabled()">{{ moduleEnabled() ? 'Running' : 'Stopped' }}</span>
            }
            @if (knob('NewsIntel:Prompt:DirectionMode'); as dm) {
              <span class="pill plain" title="How much of the news reading reaches the analysis prompt">direction <b>{{ dm }}</b></span>
            }
            @if (knob('NewsIntel:BreakingGate:Mode'); as bg) {
              <span class="pill plain" title="Breaking-news entry gate">breaking gate <b>{{ bg }}</b></span>
            }
            @if (knob('NewsIntel:Story:Mode'); as sm) {
              <span class="pill plain" title="Story clustering effect on weights">stories <b>{{ sm }}</b></span>
            }
            @if (knob('NewsIntel:Classify:TriageMode'); as tm) {
              <span class="pill plain" title="Two-stage classification triage">triage <b>{{ tm }}</b></span>
            }
          </div>
        </div>
        <div class="head-actions">
          @if (moduleEnabled() !== null) {
            <button type="button" class="power-btn" [class.on]="moduleEnabled()" [disabled]="saving()" (click)="toggleModule()">
              {{ moduleEnabled() ? '■ Stop module' : '▶ Start module' }}
            </button>
          }
          @if (promptEnabled() !== null) {
            <!-- A switch, not a status pill: it flips the prompt injection. -->
            <button
              type="button"
              class="pill-btn"
              role="switch"
              [attr.aria-checked]="promptEnabled()"
              [class.on]="promptEnabled()"
              [disabled]="saving()"
              [title]="promptEnabled() ? 'The newsPressure block is reaching the analysis prompt' : 'Collecting only — the model is not being shown this data'"
              (click)="togglePrompt()"
            >
              {{ promptEnabled() ? '● In prompt' : '○ Not in prompt' }}
            </button>
          }
        </div>
      </header>

      <app-news-intel-nav />

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }
      @if (moduleEnabled() === false) {
        <div class="banner warn">
          The module is stopped — nothing is ingested, classified or scored; the numbers below are the last run's.
        </div>
      } @else if (promptEnabled() === false) {
        <div class="banner info">
          Collecting, not injecting — the <code>newsPressure</code> block is off, so analyses run without it. Flip
          <strong>In prompt</strong> when the scores look defensible.
        </div>
      }

      @if (!settingsView) {
        <!-- ───────── KPI strip ───────── -->
        <div class="ni-kpis" data-testid="ni-kpis">
          <app-ni-stat
            label="Articles"
            [value]="kpi().articles24h"
            [spark]="kpi().ingestSpark"
            [sparkLabels]="kpi().ingestLabels"
            [sub]="kpi().articlesSub"
            info="Articles first seen per hour across every channel (bars = last 48 h). A dead feed shows as a band going flat while the others carry on."
          />
          <app-ni-stat
            label="Labelled"
            [value]="kpi().labelled"
            [sub]="kpi().labelledSub"
            [tone]="kpi().pendingTone"
            info="Completed = labelled against at least one tracked exposure. Skipped = nothing tracked in it (by design). Pending = waiting for the classifier."
          />
          <app-ni-stat
            label="Channels"
            [value]="kpi().channels"
            [sub]="kpi().channelsSub"
            [tone]="kpi().channelsTone"
            info="Discovery channels with fresh articles vs. stale ones. The engine judges staleness against each channel's own cadence."
          />
          <app-ni-stat
            label="Latency"
            [value]="kpi().p50"
            [sub]="kpi().p50Sub"
            info="Median minutes from a publisher's timestamp to the engine first seeing the article (24 h, count-weighted across channels)."
          />
          <app-ni-stat
            label="Exposures"
            [value]="kpi().keys"
            [sub]="kpi().keysSub"
            info="Exposure keys with a pressure reading now (currencies, commodities, indices, stocks, crypto, factors)."
          />
          <app-ni-stat
            label="Strongest"
            [value]="kpi().strongest"
            [sub]="kpi().strongestSub"
            info="The exposure with the largest absolute signed pressure right now."
          />
          <app-ni-stat
            label="Risk factor"
            [value]="kpi().risk"
            [sub]="kpi().riskSub"
            [spark]="kpi().riskSpark"
            sparkKind="line"
            info="F:RISK pressure — positive = risk-on news flow, negative = risk-off. Line = its recent path."
          />
          <app-ni-stat
            label="Stories"
            [value]="kpi().stories"
            [sub]="kpi().storiesSub"
            info="Story clusters seen in the last 48 h. Developing = still unconfirmed; Confirmed = 3+ independent publishers or an official source."
          />
          <app-ni-stat
            label="Events"
            [value]="kpi().events"
            [sub]="kpi().eventsSub"
            [tone]="kpi().eventsTone"
            info="Scheduled market events (earnings, inventories, OPEC, expiries, extra-country data) in the next 24 h. High impact ones drive the blackout."
          />
        </div>

        <!-- ───────── Map + Compare | Focus ───────── -->
        <div class="ni-grid-main">
          <div class="ni-stack">
          <app-ni-panel
            title="Pressure map"
            info="Every tracked exposure, grouped by kind. Fill = signed pressure (green bullish, red bearish, grey none) — the number carries the sign too. Bottom bar = how much news is in play regardless of direction. Line = recent path. Click a cell to focus it and add it to Compare."
          >
            <span meta>{{ pressureCells().length }} keys · as of {{ (status.value()?.latestPressure?.[0]?.asOfUtc | date: 'HH:mm') ?? '—' }}</span>
            <div actions class="seg" role="tablist" aria-label="Map or table">
              <button type="button" [class.on]="mapView() === 'map'" (click)="mapView.set('map')">Map</button>
              <button type="button" [class.on]="mapView() === 'table'" (click)="mapView.set('table')">Table</button>
            </div>
            @if (mapView() === 'map') {
              <app-ni-pressure-map
                [cells]="pressureCells()"
                [selected]="compareKeys()"
                [seriesColors]="seriesVars"
                (pick)="pickKey($event)"
              />
              <div class="map-legend">
                <span class="grad"><i class="neg">−1</i><span class="bar"></span><i class="pos">+1</i></span>
                <span>bearish ← pressure → bullish</span>
                <span class="sep">·</span>
                <span><span class="absdemo"></span> in play</span>
              </div>
            } @else {
              <div class="table-wrap scroll">
                <table data-testid="pressure-table">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Score</th>
                      <th class="num">In play</th>
                      <th class="num">Live</th>
                      <th class="num">Stories</th>
                      <th>Dominant</th>
                      <th class="num">As of</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of sortedPressure(); track row.currency) {
                      <tr class="clickable" (click)="pickKey(row.currency)" [class.sel]="row.currency === focusSymbol()">
                        <td><app-ni-key [key]="row.currency" /></td>
                        <td style="min-width: 140px"><app-ni-dbar [value]="row.weightedScore" /></td>
                        <td class="num">{{ row.absolutePressure | number: '1.3-3' }}</td>
                        <td class="num" [title]="boardLiveHint(row)">
                          @if (row.liveShare === null) { <span class="faint">—</span> } @else { {{ row.liveShare * 100 | number: '1.0-0' }}% }
                        </td>
                        <td class="num">{{ row.storyCount }} / {{ row.articleCount }}</td>
                        <td>{{ row.dominantCategory || '—' }}</td>
                        <td class="num faint">{{ row.asOfUtc | date: 'HH:mm' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </app-ni-panel>
          <app-ni-panel
            title="Compare"
            info="Up to six exposures on one ±1 axis, read from the same roll-ups. A pair trade lives in the GAP between two legs, not in either score alone. Pick keys on the map; hover a label to isolate it."
          >
            <div actions class="ni-toolbar">
              @for (k of compareKeys(); track k; let i = $index) {
                <button type="button" class="cmp-chip" (click)="toggleCompare(k)" [title]="'Remove ' + k">
                  <i [style.background]="seriesVars[i]"></i>{{ k }} ✕
                </button>
              }
              <span class="seg">
                @for (h of [24, 48, 168]; track h) {
                  <button type="button" [class.on]="historyHours() === h" (click)="setHistoryHours(h)">{{ h }}h</button>
                }
              </span>
            </div>
            @if (compareSeries().length) {
              <app-ni-lines [series]="compareSeries()" [height]="210" [fromMs]="compareFrom()" />
            } @else if (allSeries.value()) {
              <p class="empty">No roll-up history for the selected keys in this window.</p>
            } @else {
              <p class="empty">Loading…</p>
            }
          </app-ni-panel>
          </div>

          <!-- ───────── Focus ───────── -->
          <app-ni-panel
            class="focus-card"
            title="Focus"
            info="Exactly what an analysis of this instrument would be told — the same engine call the snapshot builder makes. Any symbol (EURUSD, NAS100, AAPL, USOIL, BTCUSD) or one exposure key (USD, WTI, IDX:US500)."
          >
            <div actions class="focus-input">
              <input
                type="text"
                class="sym-input mono"
                placeholder="EURUSD"
                [value]="focusInput()"
                (input)="onFocusInput($event)"
                (keydown.enter)="applyFocus()"
                maxlength="32"
                aria-label="Symbol or currency to focus on"
              />
              <button type="button" class="btn" (click)="applyFocus()">Focus</button>
            </div>
            @if (chips().length) {
              <div class="chips">
                @for (chip of chips(); track chip) {
                  <button type="button" class="chip" [class.active]="chip === focusSymbol()" (click)="selectFocus(chip)">{{ chip }}</button>
                }
              </div>
            }

            @if (focus.loading() && !focus.value()) {
              <p class="empty">Loading…</p>
            }
            @if (focus.value(); as f) {
              <div class="verdict" [class.included]="f.includedInPrompt" [class.withheld]="!f.includedInPrompt">
                @if (f.includedInPrompt) {
                  <strong>Reaching the model.</strong> An analysis of {{ focusSymbol() }} now carries this block.
                } @else {
                  <strong>Withheld.</strong> {{ f.omissionReason || 'Not currently included in the prompt.' }}
                }
              </div>

              @if (f.context; as ctx) {
                @if (f.quoteCurrency) {
                  <div class="bias">
                    <span class="bias-label">Pair bias</span>
                    @if (ctx.pairBias !== null) {
                      <span class="bias-value" [class.pos]="ctx.pairBias > 0.02" [class.neg]="ctx.pairBias < -0.02">
                        {{ ctx.pairBias > 0 ? '+' : '' }}{{ ctx.pairBias | number: '1.3-3' }}
                      </span>
                      <app-ni-dbar class="bias-bar" [value]="ctx.pairBias" [showValue]="false" />
                      <app-ni-info align="right" [text]="'tanh(base − quote), squashed to ±1; positive favours a long ' + focusSymbol() + '. Context, not a signal.'" />
                    } @else {
                      <span class="bias-value faint">n/a</span>
                      <app-ni-info align="right" text="One leg is not a tracked key, so there is no second score to subtract — read the legs individually." />
                    }
                  </div>
                }

                @for (leg of legsOf(f); track leg.currency) {
                  <div class="leg">
                    <div class="leg-head">
                      <app-ni-key [key]="leg.currency" />
                      <span class="score" [class.pos]="leg.score > 0.02" [class.neg]="leg.score < -0.02">{{ leg.score > 0 ? '+' : '' }}{{ leg.score | number: '1.3-3' }}</span>
                      <app-ni-dbar class="leg-bar" [value]="leg.score" [showValue]="false" />
                    </div>
                    <div class="leg-meta">
                      <span title="Unsigned weight — how much news is active regardless of direction">in play <b>{{ leg.absolutePressure | number: '1.2-2' }}</b></span>
                      <span title="Distinct story clusters / articles">stories <b>{{ leg.storyCount }}/{{ leg.articleCount }}</b></span>
                      <span>{{ leg.dominantCategory || '—' }}</span>
                      <span title="Of the directional stories whose post-publication hour has closed: confirmed ✓ / contradicted ✗ / muted —">
                        tape @if (leg.responseMeasured) { <b>{{ leg.responseConfirmed }}✓ {{ leg.responseContradicted }}✗ {{ leg.responseMuted }}—</b> } @else { <b class="faint">n/m</b> }
                      </span>
                      <span [class.stale]="isFullyPriced(leg)" [title]="liveEdgeHint(leg)">live
                        @if (leg.liveShare === null) { <b>—</b> } @else { <b>{{ leg.liveShare * 100 | number: '1.0-0' }}%</b> }
                      </span>
                    </div>
                    @if (isFullyPriced(leg)) {
                      <p class="conflict">Fully priced — none of this score comes from news the market has not already answered.</p>
                    } @else if (isThinEdge(leg)) {
                      <p class="conflict">Thin live edge — {{ (leg.liveShare ?? 0) * 100 | number: '1.0-0' }}% still open, {{ liveLeanText(leg) }}.</p>
                    }
                    @if (isMostlyDiscounted(leg)) {
                      <p class="conflict">Mostly stories the market did not move on — read the number quietly.</p>
                    }
                    @if (isConflicted(leg)) {
                      <p class="conflict">Heavy two-sided news — near-zero is cancellation, not calm.</p>
                    }
                    @if (leg.topItems.length) {
                      <ul class="items">
                        @for (item of itemsFor(leg); track item.headline) {
                          <li>
                            <span class="dir" [class.bull]="item.direction === 'Bullish'" [class.bear]="item.direction === 'Bearish'" [title]="item.direction">{{ item.direction === 'Bullish' ? '▲' : item.direction === 'Bearish' ? '▼' : '●' }}</span>
                            <span class="ih">
                              <span class="headline">{{ item.headline }}</span>
                              <span class="im">
                                {{ item.source }} · {{ item.category }} ·
                                <span [class.rumor]="item.certainty === 'Rumor'" [title]="certaintyHint(item.certainty)">{{ item.certainty }}</span>
                                @if (item.marketResponse !== 'NotMeasured') {
                                  · <span [class.rumor]="item.marketResponse === 'Contradicted'" [title]="responseHint(item)">{{ responseLabel(item.marketResponse) }}</span>
                                }
                                @if (item.novelty !== 'New') { · <span class="faint">{{ item.novelty }}</span> }
                              </span>
                            </span>
                            <span class="iw"><b>{{ item.weight | number: '1.3-3' }}</b><span>{{ formatAge(item.ageMinutes) }}</span></span>
                          </li>
                        }
                      </ul>
                      @if (leg.topItems.length > 3) {
                        <button type="button" class="more" (click)="toggleLegItems(leg.currency)">
                          {{ expandedLegs().has(leg.currency) ? 'Show top 3' : '+' + (leg.topItems.length - 3) + ' more headlines' }}
                        </button>
                      }
                    } @else {
                      <p class="empty">No contributing headlines above the weight floor.</p>
                    }
                  </div>
                }

                <app-news-exposure-legs [focus]="f" />

                @if (f.risk; as r) {
                  <div class="focus-risk" data-testid="focus-risk">
                    <span>range <b>×{{ r.volatility.multiplier | number: '1.2-2' }}</b> / {{ r.volatility.horizonMinutes }}m</span>
                    <span><b>{{ r.volatility.scheduledHighEvents }}</b> high event(s)</span>
                    <span><b>{{ r.breakingStories.length }}</b> breaking</span>
                    <app-ni-info align="right" [text]="'News as risk: expected range vs normal over the horizon. Coefficients from ' + r.volatility.source + '.'" />
                    <a routerLink="/news-intel/risk">Risk use →</a>
                    @for (b of r.breakingStories; track b.articleId + b.key) {
                      <div class="brk"><app-ni-key [key]="b.key" /> {{ b.headline }} <span class="faint">· {{ b.category }} · {{ b.certainty }} · until {{ b.pauseUntilUtc | date: 'HH:mm' : 'UTC' }}Z</span></div>
                    }
                  </div>
                }
                <p class="fingerprint">params <code>{{ ctx.paramsFingerprint }}</code></p>
              } @else {
                <p class="empty">No classified news for these exposures in the window.</p>
              }
            }
          </app-ni-panel>
        </div>




        <!-- ───────── Movers · Events · Stories ───────── -->
        <div class="ni-grid-3">
          <app-ni-panel
            title="Movers"
            info="Largest change in signed pressure over the selected window (latest roll-up minus the first in the window). Bar = change; right = current score."
          >
            <span meta>Δ over {{ historyHours() }}h</span>
            @if (movers().length) {
              <div class="movers">
                @for (m of movers(); track m.key) {
                  <button type="button" class="mv" (click)="pickKey(m.key)">
                    <app-ni-key [key]="m.key" [short]="true" />
                    <app-ni-dbar [value]="m.delta" [max]="moverMax()" />
                    <span class="cur" [class.pos]="m.last > 0.02" [class.neg]="m.last < -0.02">{{ sign(m.last) }}</span>
                  </button>
                }
              </div>
            } @else {
              <p class="empty">Not enough history yet.</p>
            }
          </app-ni-panel>
          <app-ni-panel title="Next events" info="Scheduled market events from the calendar (earnings, EIA inventories, rig count, expiries, OPEC, extra-country data). High-impact events on a symbol's calendar keys drive the multi-asset blackout.">
            <a actions class="lnk" routerLink="/news-intel/calendar">Calendar →</a>
            @if (upcoming().length) {
              <ul class="agenda">
                @for (e of upcoming(); track e.id) {
                  <li [class.high]="e.impact === 'High'">
                    <span class="when"><b>{{ e.scheduledAtUtc | date: 'EEE' }}</b> {{ e.scheduledAtUtc | date: 'HH:mm' }}</span>
                    <span class="imp" [class.high]="e.impact === 'High'" [title]="e.impact + ' impact'"></span>
                    <app-ni-key [key]="e.exposureKey" [short]="true" />
                    <span class="et" [title]="e.title">{{ e.title }}</span>
                    <span class="in faint">{{ until(e.scheduledAtUtc) }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="empty">No scheduled events in the next 7 days.</p>
            }
          </app-ni-panel>

          <app-ni-panel title="Live stories" info="Story clusters (same event, any wording) seen in the last 48 h, most-corroborated first. Corroboration counts independent publishers, not copies.">
            <a actions class="lnk" routerLink="/news-intel/stories">Stories →</a>
            <div class="state-bar">
              @for (s of storyStates(); track s.state) {
                <span [style.flex-grow]="s.count" [class]="'sb ' + s.state" [title]="s.state + ': ' + s.count"></span>
              }
            </div>
            <div class="state-legend">
              @for (s of storyStates(); track s.state) {
                <span><i [class]="s.state"></i>{{ s.state }} <b>{{ s.count }}</b></span>
              }
            </div>
            @if (topStories().length) {
              <ul class="stories">
                @for (s of topStories(); track s.id) {
                  <li>
                    <span class="st-state" [class]="'st-state ' + s.state" [title]="s.state"></span>
                    <span class="st-title" [title]="s.title">{{ s.title }}</span>
                    <span class="st-pubs" [title]="(s.publishers || []).join(', ')">{{ s.publisherCount }}<small>pub</small></span>
                    <span class="faint st-age">{{ agoText(s.lastSeenUtc) }}</span>
                  </li>
                }
              </ul>
            } @else {
              <p class="empty">No stories in the last 48 h.</p>
            }
          </app-ni-panel>


        </div>


        <!-- ───────── Ingestion · History · Publishers ───────── -->
        <div class="ni-grid-3">
          <app-ni-panel title="Ingestion" info="Articles first seen per hour, stacked by channel — where a silently dead feed shows up (one band goes flat while the others carry on). Below: each channel's freshness against its own cadence.">
            <a actions class="lnk" routerLink="/news-intel/sources">Sources →</a>
            @if (ingestBuckets().length) {
              <app-ni-stacked [buckets]="ingestBuckets()" [categories]="channelOrder" [colors]="seriesVars" [height]="84" [showLegend]="false" />
            } @else {
              <p class="empty">No articles ingested in this window.</p>
            }
            @if (status.value(); as st) {
              <div class="channels">
                @for (ch of st.channelBreakdown; track ch.kind) {
                  <div class="ch" [class.stale]="ch.stale">
                    <span class="cn"><i [style.background]="channelColor(ch.kind)"></i>{{ ch.kind }}</span>
                    <span class="num"><b>{{ ch.count }}</b></span>
                    <span class="faint">{{ ch.publishers }} pub · last {{ formatAge(ch.staleMinutes) }} · p50 {{ channelP50(ch.kind) }}</span>
                    <span class="pill" [class.ok]="!ch.stale" [class.bad]="ch.stale">{{ ch.stale ? 'stale' : 'fresh' }}</span>
                  </div>
                }
              </div>
            }
          </app-ni-panel>
          <app-ni-panel
            title="Pressure history"
            info="One key's score over time with the share still live beneath it. A score holding flat while the bars drain is a move that has finished without the evidence changing. Grey gaps = rows from before liveness tracking (unknown, not zero)."
          >
            <div actions class="ni-toolbar">
              <select class="sel" [value]="historyCurrency()" (change)="onHistoryCurrency($event)" aria-label="Exposure key">
                @for (c of historyCurrencies(); track c) {
                  <option [value]="c" [selected]="c === historyCurrency()">{{ c }}</option>
                }
              </select>
              @if (liveUnknownCount() > 0) {
                <button type="button" class="btn subtle" [disabled]="backfilling()" (click)="runBackfill()" title="Recompute liveness for older rows at their OWN timestamp — point-in-time honest.">
                  {{ backfilling() ? 'Backfilling…' : 'Backfill liveness' }}
                </button>
              }
            </div>
            @if (history.value(); as pts) {
              @if (pts.length > 1) {
                <div class="chart">
                  <div class="y-axis dual" aria-hidden="true">
                    <div class="ticks"><span>+1</span><span>0</span><span>−1</span></div>
                    <span class="panel-tag">live</span>
                  </div>
                  <svg class="hist" [attr.viewBox]="'0 0 ' + plot.w + ' ' + plotHeight" preserveAspectRatio="none" role="img" aria-label="News pressure score and live share over time">
                    @for (g of scoreGridlines; track g) {
                      <line class="grid" x1="0" [attr.y1]="g" [attr.x2]="plot.w" [attr.y2]="g" />
                    }
                    <line class="axis" x1="0" [attr.y1]="plot.scoreH / 2" [attr.x2]="plot.w" [attr.y2]="plot.scoreH / 2" />
                    <path class="score-line" [attr.d]="scorePath()" />
                    <line class="axis faint" x1="0" [attr.y1]="plotHeight" [attr.x2]="plot.w" [attr.y2]="plotHeight" />
                    @for (b of liveBars(); track b.x) {
                      <rect class="live-bar" [class.zero]="b.zero" [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h"><title>{{ b.title }}</title></rect>
                    }
                  </svg>
                </div>
                <div class="x-axis"><span>−{{ historyHours() }}h</span><span>now</span></div>
                @if (backfillNote(); as note) {
                  <p class="faint xsmall">{{ note }}</p>
                }
                @if (liveUnknownCount() > 0) {
                  <p class="faint xsmall">{{ liveUnknownCount() }} of {{ pts.length }} points predate liveness tracking.</p>
                }
              } @else {
                <p class="empty">Not enough roll-ups yet to plot {{ historyCurrency() }}.</p>
              }
            } @else {
              <p class="empty">Loading…</p>
            }
          </app-ni-panel>

          @if (status.value(); as st) {
            <app-ni-panel title="Publishers" info="Last 24 h per publisher. A source whose count drops to zero looks exactly like a quiet news day in the score alone. Skip rate = share with nothing tracked in it." [flush]="true">
              <span meta>{{ st.sourceBreakdown.length }} publishers</span>
              @if (hiddenSourceCount() > 0 || showAllSources()) {
                <button actions type="button" class="btn subtle" (click)="toggleAllSources()">
                  {{ showAllSources() ? 'Top only' : '+' + hiddenSourceCount() + ' more' }}
                </button>
              }
              <div class="table-wrap scroll pubs">
                <table>
                  <thead>
                    <tr>
                      <th>Publisher</th>
                      <th class="num">Articles</th>
                      <th>Labelled</th>
                      <th class="num">Newest</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (src of visibleSources(); track src.source + src.kind) {
                      <tr>
                        <td class="ellipsis" [title]="src.source + ' · ' + src.kind">{{ src.source }}</td>
                        <td class="num">{{ src.count }}</td>
                        <td style="min-width: 110px">
                          <app-ni-meter [value]="src.count ? src.labelled / src.count : 0" [label]="src.labelled + ''" [tone]="src.skipRate >= 0.8 ? 'warn' : null" />
                        </td>
                        <td class="num faint">{{ src.newest | date: 'HH:mm' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </app-ni-panel>
          }
        </div>
        <!-- ───────── Tape ───────── -->
        <app-ni-panel
          title="Tape"
          info="The record layer — newest first. 'Seen' is the point-in-time anchor every historical read filters on, not publication time. Each chip = one exposure label (▲ bullish, ▼ bearish, ● neutral); hover a chip for the classifier's rationale."
          [flush]="true"
        >
          <span meta>{{ (articles.value() ?? []).length }} articles · {{ statusLine() }}</span>
          <div actions class="filters">
            <select class="sel" [value]="articleStatus() ?? ''" (change)="onStatusFilter($event)" aria-label="Filter by classification status">
              <option value="">All statuses</option>
              <option value="Pending">Pending</option>
              <option value="Completed">Completed</option>
              <option value="Skipped">Skipped</option>
              <option value="Failed">Failed</option>
            </select>
            <app-refresh-button variant="outline" [refreshing]="articles.refreshing()" (refresh)="articles.refresh()" />
          </div>
          @if (articles.value(); as list) {
            @if (list.length) {
              <div class="table-wrap tape-wrap">
                <table class="tape">
                  <thead>
                    <tr>
                      <th class="num">Seen</th>
                      <th>Headline</th>
                      <th>Labels</th>
                      <th>Source</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (a of visibleArticles(); track a.id) {
                      <tr>
                        <td class="num faint" [title]="'Published ' + (a.publishedAtUtc | date: 'medium') + ' · first seen ' + (a.firstSeenUtc | date: 'medium')">{{ a.firstSeenUtc | date: 'HH:mm' }}</td>
                        <td class="hl-cell">
                          @if (a.url) {
                            <a class="headline" [href]="a.url" target="_blank" rel="noopener">{{ a.title }}</a>
                          } @else {
                            <span class="headline">{{ a.title }}</span>
                          }
                          @if (a.lastError && !a.labels.length) {
                            <span class="err">{{ a.lastError }}</span>
                          }
                        </td>
                        <td class="labels-cell">
                          @for (l of a.labels; track l.currency) {
                            <span class="lab" [class.bull]="l.direction === 'Bullish'" [class.bear]="l.direction === 'Bearish'" [title]="l.category + ' · ' + l.direction + ' · ' + l.certainty + (l.novelty !== 'New' ? ' · ' + l.novelty : '') + ' · rel ' + (l.relevance | number: '1.2-2') + ' · mag ' + (l.magnitude | number: '1.2-2') + (l.rationale ? ' — ' + l.rationale : '')">
                              <i [style.background]="kindOf(l.currency)"></i>{{ short(l.currency) }}<b>{{ l.direction === 'Bullish' ? '▲' : l.direction === 'Bearish' ? '▼' : '●' }}</b>
                            </span>
                          } @empty {
                            @if (a.classificationStatus === 'Skipped') {
                              <span class="faint">nothing tracked</span>
                            }
                          }
                        </td>
                        <td class="src" [title]="a.sourceName + ' · ' + a.sourceKind">
                          <span>{{ a.sourceName }} <span class="faint">· {{ a.sourceKind }}@if (a.classifierModel?.startsWith('lexicon')) { · <span class="rumor" title="Keyword fallback — the model was unavailable. Low confidence by design.">lexicon</span> }</span></span>
                        </td>
                        <td>
                          <span class="pill" [class.ok]="a.classificationStatus === 'Completed'" [class.bad]="a.classificationStatus === 'Failed'" [class.warn]="a.classificationStatus === 'Pending'">{{ a.classificationStatus }}</span>
                        </td>
                        <td class="num">
                          <button type="button" class="btn tiny subtle" [disabled]="busyArticle() === a.id" title="Clear labels and send back to the classification queue" (click)="reclassify(a)">
                            {{ busyArticle() === a.id ? '…' : '↻' }}
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (hiddenArticleCount() > 0 || showAllArticles()) {
                <div class="feed-more">
                  <button type="button" class="btn subtle" (click)="toggleAllArticles()">
                    {{ showAllArticles() ? 'Show fewer' : 'Show ' + hiddenArticleCount() + ' more' }}
                  </button>
                </div>
              }
            } @else {
              <p class="empty pad">No articles in the window.</p>
            }
          }
        </app-ni-panel>
      } @else {
        <!-- ───────── Settings (configuration editor, moved off the overview) ───────── -->
        <section class="card cfg-card">
          <div class="card-head">
            <div class="pt">
              <h2>Configuration</h2>
              <app-ni-info text="Every knob, live. Weight terms multiply into one score — a change here re-scores everything on the next roll-up and changes the params fingerprint. Risk-loosening changes route through cooling-off governance." />
              <span class="faint xsmall">{{ configEntries().length }} knobs · {{ configGroups().length }} groups</span>
            </div>
            <div class="filters">
              <input type="search" class="inp" placeholder="Filter knobs…" [value]="cfgFilter()" (input)="cfgFilter.set($any($event.target).value)" aria-label="Filter knobs" />
              <button type="button" class="btn subtle" (click)="cfgOpenAll.set(!cfgOpenAll())">{{ cfgOpenAll() ? 'Collapse all' : 'Expand all' }}</button>
              @if (dirtyCount() > 0) {
                <span class="dirty-count">{{ dirtyCount() }} unsaved</span>
                <button type="button" class="btn subtle" (click)="resetConfig()">Discard</button>
                <button type="button" class="btn primary" [disabled]="saving()" (click)="saveConfig()">{{ saving() ? 'Saving…' : 'Save changes' }}</button>
              }
            </div>
          </div>

          @if (dirtyCount() > 0) {
            <div class="governance-box">
              <label class="small">
                Reason (required for risk-loosening changes; they are queued for cooling-off otherwise)
                <input type="text" class="reason-input" [value]="reason()" (input)="onReason($event)" placeholder="e.g. widening the intraday half-life after the Aug backtest" />
              </label>
              <label class="small inline">
                <input type="checkbox" [checked]="immediate()" (change)="toggleImmediate()" />
                Break-glass — apply immediately instead of queuing
              </label>
            </div>
          }

          @if (saveMessages().length) {
            <div class="banner info">
              @for (m of saveMessages(); track m) {
                <div class="mono small">{{ m }}</div>
              }
            </div>
          }

          <div class="cfg-grid">
            @for (group of filteredConfigGroups(); track group.title) {
              <details class="cfg-group" [open]="cfgOpenAll() || cfgFilter() !== '' || group.title === 'Module'">
                <summary>
                  <span class="chev" aria-hidden="true">›</span>
                  <span class="cfg-title">{{ group.title }}</span>
                  <span class="cfg-count">{{ group.entries.length }}</span>
                  <span class="cfg-blurb">{{ group.blurb }}</span>
                </summary>
                <div class="cfg-rows">
                  @for (entry of group.entries; track entry.key) {
                    <div class="cfg-row" [class.dirty]="isDirty(entry.key)">
                      <div class="cfg-label">
                        <label [attr.for]="entry.key">{{ label(entry.key) }}</label>
                        <code class="mono faint xsmall" [title]="entry.description || ''">{{ entry.key }}</code>
                      </div>
                      <div class="cfg-input">
                        @if (isReadOnly(entry.key)) {
                          <textarea class="ta mono" [id]="entry.key" rows="3" readonly [value]="entry.value" title="Derived by the engine — read-only"></textarea>
                          <span class="faint xsmall">Read-only (derived). Track keys on the <a routerLink="/news-intel/exposures">Exposures</a> tab.</span>
                        } @else if (isSecret(entry)) {
                          <span class="small mono">{{ entry.value === '***SET' ? 'set' : 'not set' }}</span>
                          <span class="faint xsmall">Write-only secret — change it on the <a routerLink="/news-intel/sources">Sources</a> tab.</span>
                        } @else if (entry.dataType === 'Bool') {
                          <select class="sel" [id]="entry.key" [value]="currentValue(entry)" (change)="onConfigChange(entry, $event)">
                            <option value="true">Enabled</option>
                            <option value="false">Disabled</option>
                          </select>
                        } @else if (entry.dataType === 'Json' || isLongValue(entry)) {
                          <textarea class="ta mono" [id]="entry.key" rows="5" [value]="currentValue(entry)" (input)="onConfigChange(entry, $event)"></textarea>
                        } @else {
                          <input type="text" class="inp mono" [id]="entry.key" [value]="currentValue(entry)" (input)="onConfigChange(entry, $event)" />
                        }
                      </div>
                    </div>
                  }
                </div>
              </details>
            } @empty {
              <p class="empty">No knobs match “{{ cfgFilter() }}”.</p>
            }
          </div>
        </section>
      }

      <!-- The two header switches change what every live analysis is told; one stray click used
           to write the knob at once. -->
      <app-confirm-dialog
        [open]="pendingSwitch() !== null"
        [title]="switchDialog().title"
        [message]="switchDialog().message"
        [confirmLabel]="switchDialog().confirmLabel"
        [confirmVariant]="switchDialog().destructive ? 'destructive' : 'primary'"
        [loading]="saving()"
        (confirm)="confirmSwitch()"
        (cancelled)="pendingSwitch.set(null)"
      />
    </div>
  `,
  styleUrls: ['../../news-intel-shared.scss'],
  styles: [
    `
      /* Overview-only styles; the shared frame, tables, pills and --ni-* tokens come from news-intel-shared.scss. */
      .state-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .state-pills b {
        color: var(--text-primary);
        font-weight: 600;
        margin-left: 3px;
      }
      .head-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .power-btn,
      .pill-btn {
        border: 1px solid var(--border);
        background: var(--ni-panel);
        color: var(--text-primary);
        border-radius: var(--radius-full);
        padding: 4px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }
      .power-btn.on {
        border-color: color-mix(in oklab, var(--ni-bad) 50%, transparent);
        color: var(--ni-bad);
      }
      .power-btn.on:hover:not(:disabled) {
        background: color-mix(in oklab, var(--ni-bad) 8%, transparent);
      }
      .pill-btn.on {
        border-color: color-mix(in oklab, var(--accent) 50%, transparent);
        color: var(--accent);
        background: color-mix(in oklab, var(--accent) 8%, transparent);
      }
      .power-btn:disabled,
      .pill-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn.tiny {
        padding: 0 7px;
        line-height: 20px;
        font-size: 12px;
      }
      .xsmall {
        font-size: 11px;
      }
      .pt {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .lnk {
        font-size: 11px;
        color: var(--accent);
        text-decoration: none;
      }
      .lnk:hover {
        text-decoration: underline;
      }

      /* Map legend */
      .map-legend {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 10.5px;
        color: var(--text-tertiary);
        margin-top: 2px;
      }
      .map-legend .grad {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-style: normal;
      }
      .map-legend .grad i {
        font-style: normal;
        font-variant-numeric: tabular-nums;
      }
      .map-legend .bar {
        width: 90px;
        height: 7px;
        border-radius: 4px;
        background: linear-gradient(90deg, var(--ni-down), var(--ni-mid) 50%, var(--ni-up));
        box-shadow: inset 0 0 0 1px var(--border);
      }
      .map-legend .absdemo {
        display: inline-block;
        width: 18px;
        height: 3px;
        border-radius: 2px;
        background: var(--text-tertiary);
        vertical-align: middle;
      }
      .map-legend .sep {
        opacity: 0.5;
      }

      /* Focus */
      .focus-input {
        display: flex;
        gap: 4px;
      }
      .sym-input {
        width: 110px;
        border: 1px solid var(--border);
        background: var(--ni-sunken);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 3px 8px;
        font-size: 12px;
        text-transform: uppercase;
      }
      .chips {
        display: flex;
        flex-wrap: nowrap;
        gap: 3px;
        overflow-x: auto;
        scrollbar-width: none;
        mask-image: linear-gradient(90deg, #000 85%, transparent);
      }
      .chip {
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
        border-radius: 5px;
        padding: 0 6px;
        line-height: 18px;
        font-size: 10.5px;
        font-family: var(--ni-mono);
        cursor: pointer;
        white-space: nowrap;
      }
      .chip.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .verdict {
        font-size: 11.5px;
        padding: 5px 8px;
        border-radius: 7px;
        border-left: 3px solid;
      }
      .verdict.included {
        border-color: var(--ni-ok);
        background: color-mix(in oklab, var(--ni-ok) 8%, transparent);
      }
      .verdict.withheld {
        border-color: var(--ni-warn);
        background: color-mix(in oklab, var(--ni-warn) 8%, transparent);
      }
      .bias {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
      .bias-label {
        color: var(--text-tertiary);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 600;
      }
      .bias-value {
        font-size: 18px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .bias-bar {
        flex: 1;
      }
      .leg {
        border-top: 1px solid var(--border);
        padding-top: 7px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .leg-head {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .leg-head .score {
        font-size: 15px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        min-width: 58px;
      }
      .leg-bar {
        flex: 1;
      }
      .leg-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 10px;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .leg-meta b {
        color: var(--text-primary);
        font-weight: 500;
        font-variant-numeric: tabular-nums;
      }
      .leg-meta .stale b {
        color: var(--ni-warn);
      }
      .conflict {
        font-size: 11px;
        color: var(--ni-warn);
        margin: 0;
      }
      .items {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      .items li {
        display: grid;
        grid-template-columns: 14px minmax(0, 1fr) auto;
        gap: 6px;
        padding: 4px 0;
        border-top: 1px dashed var(--border);
        align-items: start;
      }
      .items li:first-child {
        border-top: 0;
      }
      .dir {
        font-size: 10px;
        line-height: 16px;
        color: var(--text-tertiary);
      }
      .dir.bull {
        color: var(--ni-up);
      }
      .dir.bear {
        color: var(--ni-down);
      }
      .ih {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .headline {
        font-size: 12px;
        line-height: 16px;
        color: var(--text-primary);
        text-decoration: none;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      a.headline:hover {
        color: var(--accent);
      }
      .im {
        font-size: 10.5px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rumor {
        color: var(--ni-warn);
      }
      .iw {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        font-size: 10.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .iw b {
        font-size: 11.5px;
        color: var(--text-primary);
        font-weight: 500;
      }
      .focus-risk {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px 10px;
        font-size: 11px;
        color: var(--text-secondary);
        padding: 6px 8px;
        border-radius: 7px;
        background: var(--ni-sunken);
      }
      .focus-risk b {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .focus-risk a {
        margin-left: auto;
        color: var(--accent);
        text-decoration: none;
      }
      .brk {
        flex-basis: 100%;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .fingerprint {
        font-size: 10.5px;
        color: var(--text-tertiary);
      }

      /* Compare */
      .cmp-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 1px solid var(--border);
        background: var(--ni-panel);
        color: var(--text-primary);
        border-radius: 6px;
        padding: 0 6px;
        line-height: 20px;
        font-size: 10.5px;
        font-family: var(--ni-mono);
        cursor: pointer;
      }
      .cmp-chip i {
        width: 10px;
        height: 3px;
        border-radius: 2px;
      }
      .cmp-chip:hover {
        border-color: var(--text-tertiary);
      }

      /* Movers */
      .movers {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .mv {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr) 46px;
        align-items: center;
        gap: 8px;
        border: 0;
        background: transparent;
        padding: 3px 4px;
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
        color: inherit;
        text-align: left;
      }
      .mv:hover {
        background: var(--ni-sunken);
      }
      .cur {
        font-size: 11.5px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        text-align: right;
      }

      /* Agenda */
      .agenda,
      .stories {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        max-height: 268px;
        overflow-y: auto;
      }
      .agenda li {
        display: grid;
        grid-template-columns: 74px 8px auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
        font-size: 11.5px;
      }
      .agenda li:last-child,
      .stories li:last-child {
        border-bottom: 0;
      }
      .when {
        font-variant-numeric: tabular-nums;
        color: var(--text-secondary);
      }
      .when b {
        color: var(--text-primary);
        font-weight: 500;
      }
      .imp {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
        opacity: 0.5;
      }
      .imp.high {
        background: var(--ni-warn);
        opacity: 1;
      }
      .et {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .in {
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
      }

      /* Stories */
      .state-bar {
        display: flex;
        gap: 2px;
        height: 6px;
        border-radius: 3px;
        overflow: hidden;
      }
      .state-bar .sb {
        flex-basis: 0;
        min-width: 3px;
      }
      .Developing {
        background: var(--ni-k-currency);
      }
      .Confirmed {
        background: var(--ni-ok);
      }
      .Denied {
        background: var(--ni-bad);
      }
      .Resolved {
        background: var(--text-tertiary);
      }
      .state-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 2px 10px;
        font-size: 10.5px;
        color: var(--text-tertiary);
      }
      .state-legend span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .state-legend i {
        width: 7px;
        height: 7px;
        border-radius: 2px;
      }
      .state-legend b {
        color: var(--text-primary);
        font-weight: 500;
      }
      .stories li {
        display: grid;
        grid-template-columns: 6px minmax(0, 1fr) auto 28px;
        align-items: center;
        gap: 7px;
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
        font-size: 11.5px;
      }
      .st-state {
        width: 6px;
        height: 16px;
        border-radius: 3px;
      }
      .st-title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .st-pubs {
        font-variant-numeric: tabular-nums;
        font-weight: 600;
      }
      .st-pubs small {
        font-weight: 400;
        color: var(--text-tertiary);
        margin-left: 1px;
      }
      .st-age {
        font-size: 10.5px;
        text-align: right;
      }

      /* Ingestion channels */
      .channels {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .ch {
        display: grid;
        grid-template-columns: 104px 40px minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px;
        font-size: 11px;
      }
      .cn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .cn i {
        width: 8px;
        height: 8px;
        border-radius: 2px;
      }
      .more {
        align-self: flex-start;
        border: 0;
        background: transparent;
        color: var(--accent);
        font-size: 11px;
        padding: 0;
        cursor: pointer;
      }
      .ni-kpis {
        grid-template-columns: repeat(9, minmax(0, 1fr));
      }
      @media (max-width: 1320px) {
        .ni-kpis {
          grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
        }
      }
      .ch .num b {
        font-variant-numeric: tabular-nums;
      }

      /* Tape */
      .tape-wrap {
        max-height: 560px;
      }
      .tape td {
        padding-top: 4px;
        padding-bottom: 4px;
      }
      .tape th:first-child,
      .tape td:first-child {
        padding-left: 12px;
        width: 44px;
      }
      .tape th:last-child,
      .tape td:last-child {
        padding-right: 12px;
      }
      .hl-cell {
        min-width: 280px;
      }
      .hl-cell .headline {
        -webkit-line-clamp: 1;
      }
      .err {
        display: block;
        font-size: 10.5px;
        color: var(--ni-bad);
      }
      .labels-cell {
        max-width: 280px;
      }
      .lab {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        margin: 1px 3px 1px 0;
        padding: 0 5px;
        line-height: 17px;
        border-radius: 5px;
        border: 1px solid var(--border);
        font-family: var(--ni-mono);
        font-size: 10.5px;
        white-space: nowrap;
        cursor: help;
      }
      .lab i {
        width: 6px;
        height: 6px;
        border-radius: 2px;
      }
      .lab b {
        font-size: 9px;
        color: var(--text-tertiary);
      }
      .lab.bull b {
        color: var(--ni-up);
      }
      .lab.bear b {
        color: var(--ni-down);
      }
      .src {
        font-size: 11px;
        white-space: nowrap;
        max-width: 170px;
      }
      .src > span {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .feed-more {
        display: flex;
        justify-content: center;
        padding: 6px;
        border-top: 1px solid var(--border);
      }
      .empty.pad {
        padding: 12px;
      }
      .pubs {
        max-height: 300px;
      }

      /* Pressure history (single key + live share) */
      .chart {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr);
        gap: 6px;
      }
      .y-axis {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-tertiary);
        text-align: right;
      }
      .y-axis.dual .ticks {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        height: 66%;
      }
      .y-axis.dual .panel-tag {
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .x-axis {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: var(--text-tertiary);
        padding-left: 34px;
      }
      .hist {
        width: 100%;
        height: 180px;
        display: block;
      }
      .hist .grid {
        stroke: var(--ni-grid);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .hist .axis {
        stroke: var(--text-tertiary);
        stroke-width: 1;
        opacity: 0.5;
        vector-effect: non-scaling-stroke;
      }
      .hist .axis.faint {
        opacity: 0.25;
      }
      .hist .score-line {
        fill: none;
        stroke: var(--ni-s1);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
      }
      .hist .live-bar {
        fill: var(--ni-s3);
        opacity: 0.75;
      }
      .hist .live-bar.zero {
        fill: var(--ni-warn);
      }

      /* Settings */
      .cfg-card {
        gap: 12px;
      }
      .cfg-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        align-items: start;
      }
      @media (max-width: 1100px) {
        .cfg-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .cfg-group {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--ni-panel);
        overflow: hidden;
      }
      .cfg-group summary {
        display: grid;
        grid-template-columns: 12px auto auto minmax(0, 1fr);
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        cursor: pointer;
        list-style: none;
      }
      .cfg-group summary::-webkit-details-marker {
        display: none;
      }
      .cfg-group summary:hover {
        background: var(--ni-sunken);
      }
      .chev {
        color: var(--text-tertiary);
        transition: transform 0.12s ease;
        display: inline-block;
      }
      .cfg-group[open] > summary .chev {
        transform: rotate(90deg);
      }
      .cfg-title {
        font-size: 12px;
        font-weight: 600;
      }
      .cfg-count {
        font-size: 10.5px;
        color: var(--text-tertiary);
        background: var(--ni-sunken);
        border-radius: 9px;
        padding: 0 6px;
        line-height: 16px;
      }
      .cfg-blurb {
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cfg-rows {
        display: flex;
        flex-direction: column;
        border-top: 1px solid var(--border);
      }
      .cfg-row {
        display: grid;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
        gap: 10px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        align-items: center;
      }
      .cfg-row:last-child {
        border-bottom: 0;
      }
      .cfg-row.dirty {
        background: color-mix(in oklab, var(--accent) 6%, transparent);
        box-shadow: inset 2px 0 0 var(--accent);
      }
      .cfg-label {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .cfg-label label {
        font-size: 12px;
        font-weight: 500;
      }
      .cfg-label code {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cfg-input {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .cfg-input .inp,
      .cfg-input .sel {
        width: 100%;
        box-sizing: border-box;
      }
      .dirty-count {
        font-size: 11px;
        color: var(--accent);
        font-weight: 600;
      }
      .governance-box {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 8px 10px;
        border-radius: 8px;
        background: var(--ni-sunken);
      }
      .governance-box label {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .governance-box label.inline {
        flex-direction: row;
        align-items: center;
        gap: 6px;
      }
      .reason-input {
        border: 1px solid var(--border);
        background: var(--ni-panel);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 4px 8px;
        font-size: 12px;
      }
    `,
  ],
})
export class NewsIntelPageComponent {
  private readonly route = inject(ActivatedRoute);
  /** The same component serves the cockpit (overview) and the Settings tab (configuration editor). */
  readonly settingsView = this.route.snapshot.data['view'] === 'settings';
  /** Cockpit resources do not poll on the Settings tab. */
  readonly cockpitActive = signal(!this.settingsView);
  private readonly svc = inject(NewsIntelService);
  private readonly pairs = inject(CurrencyPairsService);

  // ── Focus ───────────────────────────────────────────────────────────
  readonly focusSymbol = signal('EURUSD');
  readonly focusInput = signal('EURUSD');

  readonly focus = createPolledResource(() => this.svc.getFocus(this.focusSymbol()), {
    intervalMs: 30_000,
    active: this.cockpitActive,
  });

  // ── Pressure history ────────────────────────────────────────────────
  readonly historyCurrency = signal('USD');
  readonly historyHours = signal(48);
  readonly history = createPolledResource(
    () => this.svc.getTimeseries(this.historyCurrency(), this.historyHours()),
    { intervalMs: 60_000, active: this.cockpitActive },
  );

  /** Plot geometry. Two stacked panels on one x axis: score above, liveness below. */
  private static readonly PLOT = {
    w: 1000,
    scoreH: 140,
    gap: 14,
    liveH: 46,
  };

  /** Height of the ingestion panel's own viewBox. */
  private static readonly INGEST_H = 120;
  readonly ingestH = NewsIntelPageComponent.INGEST_H;

  readonly plot = NewsIntelPageComponent.PLOT;
  readonly plotHeight =
    NewsIntelPageComponent.PLOT.scoreH +
    NewsIntelPageComponent.PLOT.gap +
    NewsIntelPageComponent.PLOT.liveH;

  /** x for point i. Index-spaced, not time-spaced — roll-up cadence is uniform, and index
   *  spacing keeps a gap in the series visible rather than silently interpolated across. */
  private plotX(i: number, n: number): number {
    return n <= 1 ? 0 : (i / (n - 1)) * NewsIntelPageComponent.PLOT.w;
  }

  /** Score path over a symmetric ±1 axis; 0 sits on the midline. */
  readonly scorePath = computed(() => {
    const pts = this.history.value() ?? [];
    const { scoreH } = NewsIntelPageComponent.PLOT;
    return pts
      .map((p, i) => {
        const y = ((1 - Math.max(-1, Math.min(1, p.weightedScore))) / 2) * scoreH;
        return `${i === 0 ? 'M' : 'L'}${this.plotX(i, pts.length).toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

  /**
   * Liveness as filled bars rather than a line, because the series is legitimately gappy.
   *
   * A null liveShare is a row recorded before liveness was tracked — unknown, not zero. Drawing
   * a line across it would interpolate a value nobody measured, and the flat segment would read
   * as "steadily priced" precisely where we know least. Bars simply do not appear.
   */
  readonly liveBars = computed(() => {
    const pts = this.history.value() ?? [];
    const { w, scoreH, gap, liveH } = NewsIntelPageComponent.PLOT;
    const top = scoreH + gap;
    const barW = pts.length > 1 ? Math.max(1, (w / pts.length) * 0.7) : 6;
    return pts
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p.liveShare !== null && p.liveShare !== undefined)
      .map(({ p, i }) => {
        const share = Math.max(0, Math.min(1, p.liveShare as number));
        const h = Math.max(share > 0 ? 1 : 0, share * liveH);
        return {
          x: this.plotX(i, pts.length) - barW / 2,
          y: top + (liveH - h),
          w: barW,
          h,
          zero: share === 0,
          title: `${new Date(p.asOfUtc).toISOString().slice(11, 16)}Z — score ${p.weightedScore.toFixed(3)}, live ${(share * 100).toFixed(0)}%`,
        };
      });
  });

  /** How much of the window predates liveness tracking — stated rather than left to be inferred. */
  readonly liveUnknownCount = computed(
    () =>
      (this.history.value() ?? []).filter((p) => p.liveShare === null || p.liveShare === undefined)
        .length,
  );

  readonly historyCurrencies = computed(() =>
    (this.status.value()?.latestPressure ?? []).map((r) => r.currency),
  );

  onHistoryCurrency(ev: Event): void {
    this.selectHistory((ev.target as HTMLSelectElement).value);
  }

  selectHistory(currency: string): void {
    if (this.historyCurrency() === currency) return;
    this.historyCurrency.set(currency);
    this.history.refresh();
  }

  setHistoryHours(hours: number): void {
    if (this.historyHours() === hours) return;
    this.historyHours.set(hours);
    this.history.refresh();
    this.allSeries.refresh();
    this.ingestHistory.refresh();
  }

  // ── Divergence: every currency on one axis ──────────────────────────
  readonly allSeries = createPolledResource(
    () => this.svc.getAllTimeseries(this.historyHours(), 300),
    { intervalMs: 60_000, active: this.cockpitActive },
  );

  /**
   * Fixed hue order — assigned to a currency once (see currencyColor) and never cycled by
   * position. A hue has to mean the same leg on every render.
   */
  private static readonly PALETTE = [
    '#2563eb',
    '#dc2626',
    '#0d9488',
    '#7c3aed',
    '#ea580c',
    '#0891b2',
    '#65a30d',
    '#c026d3',
    '#b45309',
  ];

  /**
   * Colour belongs to the ENTITY, not to its row number. The API returns currencies in whatever
   * order it likes, so indexing the palette by position meant one currency dropping out of the
   * response shifted the hue of every currency after it: the legend would still agree with the
   * chart, but not with the chart the operator read a minute earlier.
   *
   * Codes are pinned in palette order; anything unlisted falls back to a stable hash, so a newly
   * tracked currency still gets a consistent colour rather than a moving one.
   */
  private static readonly CURRENCY_HUE: ReadonlyMap<string, string> = new Map([
    ['USD', '#2563eb'],
    ['JPY', '#dc2626'],
    ['XAU', '#0d9488'],
    ['CAD', '#7c3aed'],
    ['CHF', '#ea580c'],
    ['EUR', '#0891b2'],
    ['GBP', '#65a30d'],
    ['AUD', '#c026d3'],
    ['NZD', '#b45309'],
  ]);

  private static currencyColor(code: string): string {
    const pinned = NewsIntelPageComponent.CURRENCY_HUE.get(code);
    if (pinned) return pinned;
    let hash = 0;
    for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
    return NewsIntelPageComponent.PALETTE[hash % NewsIntelPageComponent.PALETTE.length];
  }

  /** Gridlines at +0.5 / −0.5 on the ±1 axis; zero keeps its own darker axis line. */
  readonly scoreGridlines = [
    NewsIntelPageComponent.PLOT.scoreH * 0.25,
    NewsIntelPageComponent.PLOT.scoreH * 0.75,
  ];

  /** One path per currency over a shared ±1 axis, so legs are directly comparable. */
  readonly divergenceLines = computed(() => {
    const series = this.allSeries.value() ?? [];
    const { w, scoreH } = NewsIntelPageComponent.PLOT;
    return series.map((s: NewsCurrencySeries) => {
      const pts = s.points;
      const d = pts
        .map((p, i) => {
          const x = pts.length <= 1 ? 0 : (i / (pts.length - 1)) * w;
          const y = ((1 - Math.max(-1, Math.min(1, p.weightedScore))) / 2) * scoreH;
          return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      const last = pts.length ? pts[pts.length - 1].weightedScore : 0;
      return {
        currency: s.currency,
        d,
        color: NewsIntelPageComponent.currencyColor(s.currency),
        last,
        dim: this.dimmed().has(s.currency),
      };
    });
  });

  /** Currencies the operator has clicked off. Nine overlaid lines is a hairball; this is the comb. */
  readonly dimmed = signal<ReadonlySet<string>>(new Set<string>());

  /** Legacy positional accessor kept for callers that genuinely have only an index. */
  paletteAt(i: number): string {
    return NewsIntelPageComponent.PALETTE[i % NewsIntelPageComponent.PALETTE.length];
  }

  /** Prefer this: a currency's hue must not depend on where it landed in the response. */
  colorFor(currency: string): string {
    return NewsIntelPageComponent.currencyColor(currency);
  }

  toggleCurrency(currency: string): void {
    const next = new Set(this.dimmed());
    if (!next.delete(currency)) next.add(currency);
    this.dimmed.set(next);
  }

  // ── Ingestion volume: where a dead feed becomes visible ─────────────
  readonly ingestHistory = createPolledResource(
    () => this.svc.getIngestHistory(this.historyHours()),
    { intervalMs: 60_000, active: this.cockpitActive },
  );

  readonly ingestChannels = computed(() => {
    const buckets = this.ingestHistory.value() ?? [];
    const names = new Set<string>();
    for (const b of buckets) for (const k of Object.keys(b.byChannel)) names.add(k);
    return [...names].sort();
  });

  /**
   * Stacked hourly bars per channel.
   *
   * Stacked rather than grouped because the question is "did THIS channel stop", and a channel
   * keeps its own band position across the whole chart when stacked — a gap in one band is
   * obvious, where grouped bars just look sparser.
   */
  readonly ingestBars = computed(() => {
    const buckets = this.ingestHistory.value() ?? [];
    const channels = this.ingestChannels();
    const { w } = NewsIntelPageComponent.PLOT;
    const h = NewsIntelPageComponent.INGEST_H;
    if (!buckets.length) return [];
    const peak = Math.max(1, ...buckets.map((b) => b.total));
    const barW = Math.max(1, (w / buckets.length) * 0.8);

    return buckets.flatMap((b: NewsIngestBucket, i: number) => {
      const x = (i / Math.max(1, buckets.length - 1)) * (w - barW);
      let acc = 0;
      return channels
        .map((ch, ci) => {
          const n = b.byChannel[ch] ?? 0;
          if (n === 0) return null;
          const segH = (n / peak) * h;
          const y = h - acc - segH;
          acc += segH;
          return {
            key: `${b.hourUtc}-${ch}`,
            x,
            y,
            w: barW,
            h: segH,
            color: NewsIntelPageComponent.PALETTE[ci % NewsIntelPageComponent.PALETTE.length],
            title: `${b.hourUtc.slice(11, 16)}Z — ${ch}: ${n} (hour total ${b.total})`,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
    });
  });

  readonly ingestPeak = computed(() =>
    Math.max(0, ...(this.ingestHistory.value() ?? []).map((b) => b.total)),
  );

  // ── Backfill ────────────────────────────────────────────────────────
  readonly backfilling = signal(false);
  readonly backfillNote = signal<string | null>(null);

  /** Runs passes until the queue drains, so the operator clicks once rather than N times. */
  runBackfill(): void {
    if (this.backfilling()) return;
    this.backfilling.set(true);
    this.backfillNote.set('Recomputing liveness at each row&apos;s own timestamp…');

    const pass = (filledSoFar: number): void => {
      this.svc.backfillLiveness(150, false).subscribe({
        next: (r) => {
          const filled = filledSoFar + r.rowsFilled;
          if (r.remainingRows > 0 && r.rowsFilled + r.rowsWithoutReading > 0) {
            this.backfillNote.set(`Filled ${filled}… ${r.remainingRows} rows remaining.`);
            pass(filled);
            return;
          }
          this.backfilling.set(false);
          this.backfillNote.set(
            `Done — ${filled} rows filled` +
              (r.remainingRows > 0
                ? `, ${r.remainingRows} left with no reading at their instant.`
                : '.'),
          );
          this.history.refresh();
          this.allSeries.refresh();
        },
        error: (e) => {
          this.backfilling.set(false);
          this.backfillNote.set(e?.error?.message ?? e?.message ?? 'Backfill failed.');
        },
      });
    };
    pass(0);
  }

  // ── Status + articles ───────────────────────────────────────────────
  readonly status = createPolledResource(() => this.svc.getStatus(24), { intervalMs: 30_000, active: this.cockpitActive });

  readonly articleStatus = signal<NewsClassificationStatus | null>(null);
  readonly articles = createPolledResource(
    () =>
      this.svc.getArticles({
        status: this.articleStatus() ?? undefined,
        hours: 24,
        take: 60,
      }),
    { intervalMs: 60_000, active: this.cockpitActive },
  );

  // ── Config ──────────────────────────────────────────────────────────
  readonly configEntries = signal<NewsConfigEntry[]>([]);
  readonly edits = signal<Record<string, string>>({});
  readonly reason = signal('');
  readonly immediate = signal(false);
  readonly saveMessages = signal<string[]>([]);

  readonly saving = signal(false);
  readonly busyArticle = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  /** Pair symbols from the engine's currency-pair list, for the focus chips. */
  private readonly pairSymbols = signal<string[]>([]);

  constructor() {
    this.loadConfig();

    this.pairs.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
      next: (res) => {
        const symbols = (res.data?.data ?? [])
          .filter((p) => p.isActive && p.symbol)
          .map((p) => p.symbol!.toUpperCase());
        this.pairSymbols.set([...new Set(symbols)].sort());
      },
      // A missing pair list only costs the convenience chips; the free-text
      // input still reaches every instrument, so this must not surface as an error.
      error: () => this.pairSymbols.set([]),
    });
  }

  // ── Derived ─────────────────────────────────────────────────────────

  readonly configGroups = computed(() => NewsIntelService.groupConfig(this.configEntries()));

  readonly moduleEnabled = computed(() => this.boolKnob('NewsIntel:Enabled'));
  readonly promptEnabled = computed(() => this.boolKnob('NewsIntel:Prompt:Enabled'));

  /** Focus shortcuts: tracked currencies first (they have data), then active pairs. */
  readonly chips = computed(() => {
    const currencies = (this.status.value()?.latestPressure ?? []).map((p) => p.currency);
    return [...currencies, ...this.pairSymbols()].slice(0, 24);
  });

  readonly statusCounts = computed(() => {
    const byStatus = this.status.value()?.articlesByStatus ?? {};
    const order = ['Pending', 'InProgress', 'Completed', 'Skipped', 'Failed'];
    return order
      .filter((k) => byStatus[k] !== undefined)
      .map((k) => ({ label: k, count: byStatus[k] }));
  });

  readonly dirtyCount = computed(() => Object.keys(this.edits()).length);

  /** Publishers shown before the "show more" cut. */
  private static readonly TOP_SOURCES = 15;
  private static readonly FEED_PREVIEW = 20;

  readonly showAllSources = signal(false);
  readonly showAllArticles = signal(false);

  readonly visibleArticles = computed(() => {
    const all = this.articles.value() ?? [];
    return this.showAllArticles() ? all : all.slice(0, NewsIntelPageComponent.FEED_PREVIEW);
  });

  readonly hiddenArticleCount = computed(() =>
    Math.max(0, (this.articles.value()?.length ?? 0) - this.visibleArticles().length),
  );

  toggleAllArticles(): void {
    this.showAllArticles.update((v) => !v);
  }

  /**
   * The certainty tag and the market-response tag both had a value spelled
   * "Confirmed", which rendered as "Confirmed · Confirmed" on the same row.
   * The response is about the tape, so its label says so.
   */
  responseLabel(response: string): string {
    switch (response) {
      case 'Confirmed':
        return 'Tape agreed';
      case 'Contradicted':
        return 'Tape disagreed';
      case 'Muted':
        return 'Tape ignored';
      default:
        return response;
    }
  }

  /** "pointing bullish at 0.000" is a contradiction; below the display precision there is no lean. */
  liveLeanText(leg: NewsPressureLeg): string {
    const w = leg.liveSignedWeight;
    if (Math.abs(w) < 0.0005) return 'with no directional lean left';
    const dir = w > 0 ? 'bullish' : 'bearish';
    return `pointing ${dir} at ${w > 0 ? '+' : ''}${w.toFixed(3)}`;
  }

  readonly visibleSources = computed(() => {
    const all = this.status.value()?.sourceBreakdown ?? [];
    return this.showAllSources() ? all : all.slice(0, NewsIntelPageComponent.TOP_SOURCES);
  });

  readonly hiddenSourceCount = computed(() => {
    const total = this.status.value()?.sourceBreakdown?.length ?? 0;
    return Math.max(0, total - NewsIntelPageComponent.TOP_SOURCES);
  });

  // ── Focus actions ───────────────────────────────────────────────────

  onFocusInput(ev: Event): void {
    this.focusInput.set((ev.target as HTMLInputElement).value.toUpperCase());
  }

  applyFocus(): void {
    const next = this.focusInput().trim().toUpperCase();
    if (!next) return;
    this.focusSymbol.set(next);
    this.focus.refresh();
  }

  selectFocus(symbol: string): void {
    this.focusInput.set(symbol);
    this.focusSymbol.set(symbol);
    this.focus.refresh();
  }

  /** Both legs, skipping nulls — a single-currency focus has only a base. */
  legsOf(f: NewsFocusResult): NewsPressureLeg[] {
    const legs: NewsPressureLeg[] = [];
    if (f.context?.baseLeg) legs.push(f.context.baseLeg);
    if (f.context?.quoteLeg) legs.push(f.context.quoteLeg);
    return legs;
  }

  /**
   * Heavy news that nets out. A signed score near zero means either a quiet tape or genuine
   * two-sided conflict, and those are opposite trading states — worth calling out where the
   * single number cannot.
   */
  isConflicted(leg: NewsPressureLeg): boolean {
    return Math.abs(leg.score) < 0.05 && leg.absolutePressure > 0.25;
  }

  /**
   * True when most of this leg's MEASURED stories drew no market response.
   *
   * <para>Scored over the measured subset, not every contributor: a leg whose stories are all
   * too fresh to have a verdict is not "discounted", it is unknown, and warning about it would
   * teach the operator to ignore the warning.</para>
   */
  isMostlyDiscounted(leg: NewsPressureLeg): boolean {
    return leg.responseMeasured >= 3 && leg.responseMuted / leg.responseMeasured > 0.6;
  }

  /**
   * True when nothing behind this score is still open.
   *
   * Distinct from {@link isMostlyDiscounted}, which infers "priced" from the muted SHARE. This is
   * the direct measurement: zero weight inside the freshness window that the tape has not already
   * answered. A leg can be mostly-discounted and still hold a live tail; this says there is none.
   *
   * Guards on liveShare === 0 rather than falsy, because null means "no weight to divide" — an
   * absence of measurement, not a confident zero.
   */
  isFullyPriced(leg: NewsPressureLeg): boolean {
    return leg.liveShare === 0;
  }

  /** Some edge left, but little. Suppressed when fully priced, which has its own louder callout. */
  isThinEdge(leg: NewsPressureLeg): boolean {
    return leg.liveShare !== null && leg.liveShare > 0 && leg.liveShare < 0.15;
  }

  liveEdgeHint(leg: NewsPressureLeg): string {
    const hours = Math.round(leg.freshWindowMinutes / 60);
    if (leg.liveShare === null) {
      return 'No weight behind this leg to divide — nothing to measure, which is not the same as nothing live.';
    }
    return (
      `Share of this leg's weight from news inside the last ${hours}h that the market has NOT already ` +
      `absorbed or contradicted. ${leg.liveCount} of ${leg.freshCount} recent contributors are still ` +
      `open, summing to ${leg.liveSignedWeight.toFixed(3)} signed. Stories with no verdict yet count ` +
      'as live on purpose: for genuinely fresh news the response window has not closed, and requiring ' +
      'a confirmed move would exclude exactly the items with the most edge left.'
    );
  }

  /** Board tooltip. Null liveness is pre-liveness history, not a zero — say so rather than imply a reading. */
  boardLiveHint(row: NewsPressureSummaryView): string {
    if (row.liveShare === null) {
      return 'Recorded before liveness was tracked — unknown, not zero.';
    }
    const hours = Math.round((row.freshWindowMinutes ?? 0) / 60);
    return (
      `${row.liveCount ?? 0} of ${row.freshCount ?? 0} contributors inside the last ${hours}h are ` +
      `still open (not muted or contradicted by the tape), summing to ` +
      `${(row.liveSignedWeight ?? 0).toFixed(3)} signed. 0% means the direction is real but the ` +
      'move is behind us.'
    );
  }

  responseHint(item: NewsPressureItem): string {
    const move =
      item.marketResponsePct === null
        ? ''
        : ` Realised move ${item.marketResponsePct > 0 ? '+' : ''}${item.marketResponsePct}.`;

    switch (item.marketResponse) {
      case 'Muted':
        return `The market did not move in the hour after this published — priced in, or nobody cared. Weight reduced.${move}`;
      case 'Contradicted':
        return `Price moved AGAINST this reading. Either the label is wrong or the market disagrees; both are reasons to trust it less. Weight reduced.${move}`;
      case 'Confirmed':
        return `Price moved as labelled. Consistent, but NOT extra evidence — it cannot tell a repricing that is starting from one that is ending, so the weight is unchanged.${move}`;
      default:
        return 'The hour after publication has not closed yet, or no strength history covers it. Not a quiet tape — simply unknown.';
    }
  }

  /** Half-width bar: score is already bounded to [−1, 1], so 50% is full deflection. */
  barWidth(score: number): number {
    return Math.min(50, Math.abs(score) * 50);
  }

  /** Expands or collapses the long tail of low-volume publishers. */
  toggleAllSources(): void {
    this.showAllSources.update((v) => !v);
  }

  /**
   * A channel with nothing new for hours is broken, not quiet. The threshold is generous
   * because the sweep only runs hourly and central banks publish on their own schedule —
   * flagging those two as often as the fast feeds would train the operator to ignore it.
   */
  formatAge(minutes: number): string {
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / (60 * 24))}d`;
  }

  certaintyHint(certainty: string): string {
    switch (certainty) {
      case 'Official':
        return 'Stated by the principal itself — central bank, ministry, statistical agency.';
      case 'Confirmed':
        return 'Corroborated by multiple independent outlets, or confirmed by a participant.';
      case 'Reported':
        return 'An outlet citing sources; not confirmed by the principal.';
      default:
        return 'Unsourced or speculative — heavily discounted, and a reason for caution rather than conviction.';
    }
  }

  // ── Article actions ─────────────────────────────────────────────────

  onStatusFilter(ev: Event): void {
    const v = (ev.target as HTMLSelectElement).value;
    this.articleStatus.set(v ? (v as NewsClassificationStatus) : null);
    this.articles.refresh();
  }

  reclassify(a: NewsArticleView): void {
    this.busyArticle.set(a.id);
    this.error.set(null);
    this.svc.reclassify(a.id).subscribe({
      next: (msg) => {
        this.busyArticle.set(null);
        this.notice.set(msg);
        this.articles.refresh();
      },
      error: () => {
        this.busyArticle.set(null);
        this.error.set(`Could not re-queue article ${a.id}.`);
      },
    });
  }

  // ── Config actions ──────────────────────────────────────────────────

  private loadConfig(): void {
    this.svc.getConfig().subscribe({
      next: (entries) => this.configEntries.set(entries),
      error: () => this.error.set('Could not load the module configuration.'),
    });
  }

  label(key: string): string {
    return NewsIntelService.shortLabel(key);
  }

  /** Derived keys the engine lists but refuses to write (e.g. Exposures:Recommended). */
  isReadOnly(key: string): boolean {
    return NEWS_READ_ONLY_KEYS.has(key);
  }

  /** Secrets are never edited in the bulk panel: their value is a ***SET/***UNSET mask. */
  isSecret(entry: NewsConfigEntry): boolean {
    return isSecretKey(entry.key) || isMaskedValue(entry.value);
  }

  currentValue(entry: NewsConfigEntry): string {
    return this.edits()[entry.key] ?? entry.value;
  }

  isDirty(key: string): boolean {
    return key in this.edits();
  }

  isLongValue(entry: NewsConfigEntry): boolean {
    return entry.value.length > 80 || entry.value.includes('\n');
  }

  onConfigChange(entry: NewsConfigEntry, ev: Event): void {
    const value = (ev.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    const next = { ...this.edits() };
    // Editing back to the stored value clears the dirty flag rather than queuing a no-op
    // write — a no-op still spends an audit row and a governance evaluation.
    if (value === entry.value) delete next[entry.key];
    else next[entry.key] = value;
    this.edits.set(next);
  }

  onReason(ev: Event): void {
    this.reason.set((ev.target as HTMLInputElement).value);
  }

  toggleImmediate(): void {
    this.immediate.update((v) => !v);
  }

  resetConfig(): void {
    this.edits.set({});
    this.reason.set('');
    this.immediate.set(false);
  }

  saveConfig(): void {
    const edits = this.edits();
    const changes: NewsConfigChange[] = Object.entries(edits).map(([key, value]) => ({
      key,
      value,
      dataType: this.configEntries().find((e) => e.key === key)?.dataType,
    }));
    if (!changes.length) return;
    this.persist(changes, { clearEdits: true });
  }

  /** Which header switch is waiting on the confirm dialog. */
  readonly pendingSwitch = signal<'module' | 'prompt' | null>(null);

  readonly switchDialog = computed(() => {
    if (this.pendingSwitch() === 'module') {
      return this.moduleEnabled()
        ? {
            title: 'Stop the news module?',
            message:
              'Polling, classification and scoring stop, and analyses lose the newsPressure block until it is started again.',
            confirmLabel: 'Stop module',
            destructive: true,
          }
        : {
            title: 'Start the news module?',
            message:
              'Feeds are polled and articles classified by the model again — that spends LLM budget.',
            confirmLabel: 'Start module',
            destructive: false,
          };
    }
    return this.promptEnabled()
      ? {
          title: 'Take news out of the prompt?',
          message:
            'Collecting carries on, but spot analyses stop receiving the newsPressure block from their next run.',
          confirmLabel: 'Remove from prompt',
          destructive: true,
        }
      : {
          title: 'Put news into the prompt?',
          message: 'Every spot analysis from its next run is told the newsPressure block.',
          confirmLabel: 'Add to prompt',
          destructive: false,
        };
  });

  toggleModule(): void {
    this.pendingSwitch.set('module');
  }

  togglePrompt(): void {
    this.pendingSwitch.set('prompt');
  }

  confirmSwitch(): void {
    const which = this.pendingSwitch();
    if (which === 'module') {
      const next = this.moduleEnabled() ? 'false' : 'true';
      this.persist([{ key: 'NewsIntel:Enabled', value: next, dataType: 'Bool' }]);
    } else if (which === 'prompt') {
      const next = this.promptEnabled() ? 'false' : 'true';
      this.persist([{ key: 'NewsIntel:Prompt:Enabled', value: next, dataType: 'Bool' }]);
    }
  }

  /**
   * Writes changes and re-reads the config.
   *
   * The re-read is load-bearing, not a nicety: the engine's governance may QUEUE a
   * risk-loosening change for cooling-off instead of applying it, so the optimistic value is
   * not necessarily what is in force. Re-reading makes the panel show the PERSISTED state,
   * and the per-key messages explain any difference.
   */
  private persist(changes: NewsConfigChange[], opts?: { clearEdits?: boolean }): void {
    this.saving.set(true);
    this.error.set(null);
    this.saveMessages.set([]);

    this.svc
      .saveConfig(changes, { reason: this.reason() || undefined, immediate: this.immediate() })
      .subscribe({
        next: (messages) => {
          this.saving.set(false);
          this.pendingSwitch.set(null);
          this.saveMessages.set(messages);
          if (opts?.clearEdits) this.resetConfig();
          this.loadConfig();
          this.focus.refresh();
        },
        error: () => {
          this.saving.set(false);
          this.pendingSwitch.set(null);
          this.error.set('Save failed — the configuration was not changed.');
        },
      });
  }

  private boolKnob(key: string): boolean | null {
    const entry = this.configEntries().find((e) => e.key === key);
    if (!entry) return null;
    return (this.edits()[key] ?? entry.value).toLowerCase() === 'true';
  }

  // ══════════ Dense redesign (2026-11-07): map, compare, movers, events, stories, KPIs ══════════

  readonly seriesVars = SERIES_VARS;
  readonly expandedLegs = signal<ReadonlySet<string>>(new Set<string>());

  itemsFor(leg: NewsPressureLeg): NewsPressureItem[] {
    return this.expandedLegs().has(leg.currency) ? leg.topItems : leg.topItems.slice(0, 3);
  }
  toggleLegItems(key: string): void {
    const next = new Set(this.expandedLegs());
    if (!next.delete(key)) next.add(key);
    this.expandedLegs.set(next);
  }
  channelP50(kind: string): string {
    const l = (this.status.value()?.latency ?? []).find(
      (x) => x.source === null && x.windowHours === 24 && x.channel === kind,
    );
    return l ? minutesText(l.p50Minutes) : '—';
  }
  channelColor(kind: string): string {
    const i = this.channelOrder.indexOf(kind);
    return i >= 0 ? SERIES_VARS[i] : 'var(--text-tertiary)';
  }
  /** Fixed channel order for the ingestion stack (colour follows the channel); the rest fold into Other. */
  readonly channelOrder = ['Rss', 'Search', 'CentralBank', 'LlmSweep', 'PressWire', 'Energy'];
  readonly mapView = signal<'map' | 'table'>('map');
  /** Keys picked for Compare, in selection order (null = default: the four strongest). */
  readonly compareSel = signal<string[] | null>(null);
  readonly cfgFilter = signal('');
  readonly cfgOpenAll = signal(false);

  readonly pressure = createPolledResource(() => this.svc.getPressure({ topItems: 1 }), {
    intervalMs: 60_000,
    active: this.cockpitActive,
  });
  readonly stories = createPolledResource(() => this.svc.getStories({ hours: 48, take: 200 }), {
    intervalMs: 60_000,
    active: this.cockpitActive,
  });
  readonly events = createPolledResource(
    () =>
      this.svc.getScheduledEvents({
        from: new Date(Date.now() - 3600_000).toISOString(),
        to: new Date(Date.now() + 7 * 86400_000).toISOString(),
        take: 500,
      }),
    { intervalMs: 300_000, active: this.cockpitActive },
  );

  knob(key: string): string | null {
    const e = this.configEntries().find((x) => x.key === key);
    return e && e.value !== '' ? e.value : null;
  }

  readonly pressureCells = computed<PressureCell[]>(() => {
    const rows = this.status.value()?.latestPressure ?? [];
    const heads = new Map(
      (this.pressure.value() ?? []).map((p) => [
        p.currency,
        (p as unknown as { topContributors?: { title?: string }[] }).topContributors?.[0]?.title ?? null,
      ]),
    );
    const spark = new Map(
      (this.allSeries.value() ?? []).map((s) => [s.currency, thin(s.points.map((p) => p.weightedScore), 40)]),
    );
    return rows.map((r) => ({
      key: r.currency,
      score: r.weightedScore,
      absolute: r.absolutePressure,
      articles: r.articleCount,
      stories: r.storyCount,
      category: r.dominantCategory,
      liveShare: r.liveShare ?? null,
      asOfUtc: r.asOfUtc,
      spark: spark.get(r.currency),
      headline: heads.get(r.currency) ?? null,
    }));
  });

  readonly sortedPressure = computed(() =>
    [...(this.status.value()?.latestPressure ?? [])].sort(
      (a, b) => Math.abs(b.weightedScore) - Math.abs(a.weightedScore),
    ),
  );

  readonly compareKeys = computed<string[]>(() => {
    const sel = this.compareSel();
    if (sel) return sel;
    return this.sortedPressure()
      .slice(0, 4)
      .map((r) => r.currency);
  });

  /** One gesture: focus the key, plot its history, and add it to Compare (≤ 6, oldest drops out). */
  pickKey(key: string): void {
    this.selectFocus(key);
    this.selectHistory(key);
    const cur = this.compareKeys();
    if (!cur.includes(key)) this.compareSel.set([...cur, key].slice(-6));
  }

  toggleCompare(key: string): void {
    const cur = this.compareKeys();
    this.compareSel.set(cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key].slice(-6));
  }

  readonly compareFrom = computed(() => Date.now() - this.historyHours() * 3600_000);

  readonly compareSeries = computed<LineSeries[]>(() => {
    const by = new Map((this.allSeries.value() ?? []).map((s) => [s.currency, s]));
    return this.compareKeys().flatMap((key, i): LineSeries[] => {
      const s = by.get(key);
      if (!s || !s.points.length) return [];
      return [
        { key, color: SERIES_VARS[i], points: s.points.map((p) => ({ t: Date.parse(p.asOfUtc), v: p.weightedScore })) },
      ];
    });
  });

  readonly movers = computed(() =>
    (this.allSeries.value() ?? [])
      .filter((s) => s.points.length > 1)
      .map((s) => {
        const first = s.points[0].weightedScore;
        const last = s.points[s.points.length - 1].weightedScore;
        return { key: s.currency, delta: last - first, last };
      })
      .filter((m) => Math.abs(m.delta) >= 0.005)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 12),
  );
  readonly moverMax = computed(() => Math.max(0.05, ...this.movers().map((m) => Math.abs(m.delta))));

  sign(v: number | null | undefined, digits = 2): string {
    return signed(v, digits);
  }

  readonly upcoming = computed<ScheduledMarketEventRow[]>(() => {
    const from = Date.now() - 15 * 60_000;
    return [...(this.events.value() ?? [])]
      .filter((e) => Date.parse(e.scheduledAtUtc) >= from)
      .sort((a, b) => Date.parse(a.scheduledAtUtc) - Date.parse(b.scheduledAtUtc) || (a.impact === 'High' ? -1 : 1))
      .slice(0, 16);
  });

  until(iso: string): string {
    const m = (Date.parse(iso) - Date.now()) / 60_000;
    if (!Number.isFinite(m)) return '';
    if (m < 0) return 'now';
    return `in ${minutesText(m)}`;
  }

  private static readonly STORY_STATES = ['Developing', 'Confirmed', 'Denied', 'Resolved'];
  readonly storyStates = computed(() => {
    const counts = new Map<string, number>();
    for (const s of this.stories.value() ?? []) counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
    return NewsIntelPageComponent.STORY_STATES.filter((s) => counts.get(s)).map((state) => ({
      state,
      count: counts.get(state)!,
    }));
  });
  readonly topStories = computed<NewsStoryView[]>(() =>
    [...(this.stories.value() ?? [])]
      .filter((s) => s.state !== 'Resolved')
      .sort(
        (a, b) =>
          b.publisherCount - a.publisherCount ||
          b.articleCount - a.articleCount ||
          Date.parse(b.lastSeenUtc) - Date.parse(a.lastSeenUtc),
      )
      .slice(0, 14),
  );

  agoText(iso: string): string {
    return ago(iso);
  }
  kindOf(key: string): string {
    return kindVar(key);
  }
  short(key: string): string {
    return shortKey(key);
  }

  readonly ingestBuckets = computed<StackBucket[]>(() =>
    (this.ingestHistory.value() ?? []).map((b) => ({
      label: new Date(b.hourUtc).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
      parts: b.byChannel,
    })),
  );

  readonly statusLine = computed(() =>
    this.statusCounts()
      .map((s) => `${s.label} ${s.count}`)
      .join(' · '),
  );

  readonly kpi = computed(() => {
    const st = this.status.value();
    const buckets = this.ingestHistory.value() ?? [];
    const cutoff = Date.now() - 24 * 3600_000;
    const last24 = buckets.filter((b) => Date.parse(b.hourUtc) >= cutoff);
    const articles24h = last24.reduce((s, b) => s + b.total, 0);
    const peak = Math.max(0, ...buckets.map((b) => b.total));
    const by = st?.articlesByStatus ?? {};
    const completed = by['Completed'] ?? 0;
    const skipped = by['Skipped'] ?? 0;
    const pending = (by['Pending'] ?? 0) + (by['InProgress'] ?? 0);
    const failed = by['Failed'] ?? 0;
    const processed = completed + skipped;
    const channels = st?.channelBreakdown ?? [];
    const stale = channels.filter((c) => c.stale);
    const lat = (st?.latency ?? []).filter((l) => l.source === null && l.windowHours === 24 && l.count > 0);
    const n = lat.reduce((s, l) => s + l.count, 0);
    const p50 = n ? lat.reduce((s, l) => s + l.p50Minutes * l.count, 0) / n : null;
    const p90 = n ? lat.reduce((s, l) => s + l.p90Minutes * l.count, 0) / n : null;
    const rows = this.sortedPressure();
    const strongest = rows[0];
    const riskRow = rows.find((r) => r.currency === 'F:RISK');
    const riskSeries = (this.allSeries.value() ?? []).find((s) => s.currency === 'F:RISK');
    const storiesList = this.stories.value() ?? [];
    const dev = storiesList.filter((s) => s.state === 'Developing').length;
    const conf = storiesList.filter((s) => s.state === 'Confirmed').length;
    const in24 = Date.now() + 24 * 3600_000;
    const ev = (this.events.value() ?? []).filter((e) => {
      const t = Date.parse(e.scheduledAtUtc);
      return t >= Date.now() - 15 * 60_000 && t <= in24;
    });
    const high = ev.filter((e) => e.impact === 'High').length;
    return {
      articles24h: st ? compact(articles24h) : '—',
      ingestSpark: thin(
        buckets.map((b) => b.total),
        48,
      ),
      ingestLabels: thin(
        buckets.map((b) => new Date(b.hourUtc).toLocaleString(undefined, { weekday: 'short', hour: '2-digit' })),
        48,
      ),
      articlesSub: buckets.length ? `24h · peak ${peak}/h` : null,
      labelled: st ? compact(completed) : '—',
      labelledSub: st ? `${processed ? Math.round((completed / processed) * 100) : 0}% · ${pending} queued${failed ? ` · ${failed} failed` : ''}` : null,
      pendingTone: (failed > 0 ? 'bad' : pending > 60 ? 'warn' : null) as 'bad' | 'warn' | null,
      channels: st ? `${channels.length - stale.length}/${channels.length}` : '—',
      channelsSub: stale.length ? `stale: ${stale.map((c) => c.kind).join(', ')}` : channels.length ? 'all fresh' : null,
      channelsTone: (st ? (stale.length ? 'bad' : 'ok') : null) as 'bad' | 'ok' | null,
      p50: p50 === null ? '—' : minutesText(p50),
      p50Sub: p90 === null ? null : `p90 ${minutesText(p90)}`,
      keys: st ? String(rows.length) : '—',
      keysSub: st ? `${rows.filter((r) => Math.abs(r.weightedScore) >= 0.1).length} with |s| ≥ 0.1` : null,
      strongest: strongest ? `${shortKey(strongest.currency)} ${signed(strongest.weightedScore)}` : '—',
      strongestSub: strongest ? (strongest.dominantCategory ?? null) : null,
      risk: riskRow ? signed(riskRow.weightedScore) : '—',
      riskSub: riskRow
        ? riskRow.weightedScore > 0.1
          ? 'risk-on flow'
          : riskRow.weightedScore < -0.1
            ? 'risk-off flow'
            : 'balanced'
        : 'F:RISK not tracked',
      riskSpark: riskSeries ? thin(riskSeries.points.map((p) => p.weightedScore), 40) : null,
      stories: this.stories.value() ? String(storiesList.length) : '—',
      storiesSub: this.stories.value() ? `${dev} dev · ${conf} conf` : null,
      events: this.events.value() ? String(ev.length) : '—',
      eventsSub: this.events.value() ? `24h · ${high} high` : null,
      eventsTone: (high > 0 ? 'warn' : null) as 'warn' | null,
    };
  });

  readonly filteredConfigGroups = computed(() => {
    const q = this.cfgFilter().trim().toLowerCase();
    const groups = this.configGroups();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        entries: g.entries.filter(
          (e) =>
            e.key.toLowerCase().includes(q) ||
            this.label(e.key).toLowerCase().includes(q) ||
            (e.description ?? '').toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.entries.length > 0);
  });
}
