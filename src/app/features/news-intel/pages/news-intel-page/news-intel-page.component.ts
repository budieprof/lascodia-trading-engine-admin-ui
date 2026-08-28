import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { NewsIntelService } from '@core/services/news-intel.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { createPolledResource } from '@core/polling/polled-resource';
import {
  NewsArticleView,
  NewsClassificationStatus,
  NewsConfigChange,
  NewsConfigEntry,
  NewsFocusResult,
  NewsPressureLeg,
  NewsPressureItem,
  NewsPressureSummaryView,
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
  imports: [DatePipe, DecimalPipe, PercentPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>News Intelligence</h1>
          <p class="muted">
            Sources, classifies and weights market news — planned and unplanned — into a
            per-currency pressure reading the spot-analysis prompt can reason from.
          </p>
        </div>
        <div class="head-actions">
          @if (moduleEnabled() !== null) {
            <button
              type="button"
              class="power-btn"
              [class.on]="moduleEnabled()"
              [disabled]="saving()"
              (click)="toggleModule()"
            >
              {{ moduleEnabled() ? '■ Stop module' : '▶ Start module' }}
            </button>
          }
          @if (promptEnabled() !== null) {
            <button
              type="button"
              class="pill-btn"
              [class.on]="promptEnabled()"
              [disabled]="saving()"
              [title]="
                promptEnabled()
                  ? 'The newsPressure block is reaching the analysis prompt'
                  : 'Collecting only — the model is not being shown this data'
              "
              (click)="togglePrompt()"
            >
              {{ promptEnabled() ? '● In prompt' : '○ Not in prompt' }}
            </button>
          }
        </div>
      </header>

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }
      @if (notice(); as n) {
        <div class="banner info">{{ n }}</div>
      }
      @if (moduleEnabled() === false) {
        <div class="banner warn">
          The module is stopped. Nothing is being ingested, classified or scored, and the numbers
          below are whatever was left from the last run.
        </div>
      } @else if (promptEnabled() === false) {
        <div class="banner info subtle">
          Collecting, but not injecting — the <code>newsPressure</code> block is switched off, so
          analyses are running without it. Useful while you judge whether the scores are defensible;
          flip <strong>In prompt</strong> when you're satisfied.
        </div>
      }

      <!-- ───────── Focus ───────── -->
      <section class="card focus-card">
        <div class="card-head">
          <div>
            <h2>Focus</h2>
            <p class="muted small">
              Exactly what an analysis of this instrument would be told. Enter a pair
              (<code>EURUSD</code>) or a single currency (<code>USD</code>).
            </p>
          </div>
          <div class="focus-input">
            <input
              type="text"
              class="sym-input mono"
              placeholder="EURUSD"
              [value]="focusInput()"
              (input)="onFocusInput($event)"
              (keydown.enter)="applyFocus()"
              maxlength="12"
              aria-label="Symbol or currency to focus on"
            />
            <button type="button" class="btn" (click)="applyFocus()">Focus</button>
          </div>
        </div>

        @if (chips().length) {
          <div class="chips">
            @for (chip of chips(); track chip) {
              <button
                type="button"
                class="chip"
                [class.active]="chip === focusSymbol()"
                (click)="selectFocus(chip)"
              >
                {{ chip }}
              </button>
            }
          </div>
        }

        @if (focus.loading() && !focus.value()) {
          <p class="muted small">Loading…</p>
        }

        @if (focus.value(); as f) {
          <div
            class="verdict"
            [class.included]="f.includedInPrompt"
            [class.withheld]="!f.includedInPrompt"
          >
            @if (f.includedInPrompt) {
              <strong>Reaching the model.</strong>
              An analysis of {{ focusSymbol() }} right now carries this block.
            } @else {
              <strong>Withheld.</strong>
              {{ f.omissionReason || 'Not currently included in the prompt.' }}
            }
          </div>

          @if (f.context; as ctx) {
            <div class="leg-grid">
              @for (leg of legsOf(f); track leg.currency) {
                <div class="leg-card">
                  <div class="leg-head">
                    <span class="ccy mono">{{ leg.currency }}</span>
                    <span
                      class="score"
                      [class.pos]="leg.score > 0.02"
                      [class.neg]="leg.score < -0.02"
                    >
                      {{ leg.score > 0 ? '+' : '' }}{{ leg.score | number: '1.3-3' }}
                    </span>
                  </div>

                  <div class="bar-wrap" [title]="'Signed pressure: ' + leg.score">
                    <div class="bar-mid"></div>
                    <div
                      class="bar-fill"
                      [class.pos]="leg.score >= 0"
                      [style.width.%]="barWidth(leg.score)"
                      [style.left.%]="leg.score >= 0 ? 50 : 50 - barWidth(leg.score)"
                    ></div>
                  </div>

                  <dl class="leg-meta">
                    <div>
                      <dt>In play</dt>
                      <dd
                        class="mono"
                        title="Unsigned weight — how much news is active regardless of direction"
                      >
                        {{ leg.absolutePressure | number: '1.3-3' }}
                      </dd>
                    </div>
                    <div>
                      <dt>Stories</dt>
                      <dd
                        class="mono"
                        title="Distinct story clusters, de-duplicated across outlets"
                      >
                        {{ leg.storyCount }} / {{ leg.articleCount }}
                      </dd>
                    </div>
                    <div>
                      <dt>Dominant</dt>
                      <dd>{{ leg.dominantCategory || '—' }}</dd>
                    </div>
                    <div>
                      <dt>Tape</dt>
                      <dd
                        class="mono"
                        title="Of the directional stories whose post-publication hour has closed: how many the market moved on, and how many it ignored"
                      >
                        @if (leg.responseMeasured) {
                          {{ leg.responseConfirmed }}✓ / {{ leg.responseContradicted }}✗ /
                          {{ leg.responseMuted }}—
                        } @else {
                          not yet measurable
                        }
                      </dd>
                    </div>
                    <div>
                      <dt>Live edge</dt>
                      <dd
                        class="mono"
                        [class.stale]="isFullyPriced(leg)"
                        [title]="liveEdgeHint(leg)"
                      >
                        @if (leg.liveShare === null) {
                          —
                        } @else {
                          {{ leg.liveShare * 100 | number: '1.0-0' }}%
                          <span class="sub">({{ leg.liveCount }}/{{ leg.freshCount }})</span>
                        }
                      </dd>
                    </div>
                  </dl>

                  @if (isFullyPriced(leg)) {
                    <p class="conflict small">
                      <strong>Fully priced.</strong> None of this score comes from news the market
                      has not already answered. The direction is real; the opportunity is behind us.
                      Initiating here is betting on a move that already happened.
                    </p>
                  } @else if (isThinEdge(leg)) {
                    <p class="conflict small">
                      Thin live edge — {{ (leg.liveShare ?? 0) * 100 | number: '1.0-0' }}% of this
                      score rests on news still open, pointing
                      {{ leg.liveSignedWeight >= 0 ? 'bullish' : 'bearish' }} at
                      {{ leg.liveSignedWeight | number: '1.3-3' }}. Most of the move is behind us.
                    </p>
                  }

                  @if (isMostlyDiscounted(leg)) {
                    <p class="conflict small">
                      Most of this score rests on stories the market did not move on — already
                      priced, or ignored. Read the number quietly.
                    </p>
                  }

                  @if (isConflicted(leg)) {
                    <p class="conflict small">
                      Heavy two-sided news — the near-zero score is cancellation, not calm. That is
                      a headline-risk regime, not a quiet one.
                    </p>
                  }

                  @if (leg.topItems.length) {
                    <table class="items">
                      <thead>
                        <tr>
                          <th>Headline</th>
                          <th>Read</th>
                          <th class="num">Age</th>
                          <th class="num">Weight</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (item of leg.topItems; track item.headline) {
                          <tr>
                            <td>
                              <span class="headline">{{ item.headline }}</span>
                              <span class="muted small">{{ item.source }}</span>
                            </td>
                            <td>
                              <span
                                class="tag"
                                [class.bull]="item.direction === 'Bullish'"
                                [class.bear]="item.direction === 'Bearish'"
                                >{{ item.direction }}</span
                              >
                              <span class="tag subtle">{{ item.category }}</span>
                              <span
                                class="tag subtle"
                                [class.rumor]="item.certainty === 'Rumor'"
                                [title]="certaintyHint(item.certainty)"
                                >{{ item.certainty }}</span
                              >
                              @if (item.marketResponse !== 'NotMeasured') {
                                <span
                                  class="tag subtle"
                                  [class.echo]="item.marketResponse === 'Muted'"
                                  [class.rumor]="item.marketResponse === 'Contradicted'"
                                  [title]="responseHint(item)"
                                  >{{ item.marketResponse }}</span
                                >
                              }
                              @if (item.novelty !== 'New') {
                                <span
                                  class="tag subtle echo"
                                  title="Already-known story — discounted as a restatement"
                                  >{{ item.novelty }}</span
                                >
                              }
                            </td>
                            <td class="num mono">{{ formatAge(item.ageMinutes) }}</td>
                            <td class="num mono">{{ item.weight | number: '1.3-3' }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else {
                    <p class="muted small">No contributing headlines above the weight floor.</p>
                  }
                </div>
              }
            </div>

            @if (f.quoteCurrency) {
              <div class="bias">
                <span class="bias-label">Pair bias</span>
                @if (ctx.pairBias !== null) {
                  <span
                    class="bias-value mono"
                    [class.pos]="ctx.pairBias > 0.02"
                    [class.neg]="ctx.pairBias < -0.02"
                  >
                    {{ ctx.pairBias > 0 ? '+' : '' }}{{ ctx.pairBias | number: '1.3-3' }}
                  </span>
                  <span class="muted small">
                    base − quote; positive favours a long {{ focusSymbol() }}. Context, not a
                    signal.
                  </span>
                } @else {
                  <span class="bias-value mono muted">n/a</span>
                  <span class="muted small">
                    one leg is not a tracked currency, so there is no second score to subtract —
                    read the legs individually.
                  </span>
                }
              </div>
            }

            <p class="muted small fingerprint">
              Weight params <code class="mono">{{ ctx.paramsFingerprint }}</code> — readings
              computed under different fingerprints are not comparable.
            </p>
          } @else {
            <p class="muted small">No classified news for these currencies in the window.</p>
          }
        }
      </section>

      <!-- ───────── Pressure board ───────── -->
      @if (status.value(); as st) {
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Pressure board</h2>
              <p class="muted small">
                Latest roll-up per tracked currency. <strong>Live</strong> is the share of each
                score still coming from news the market has not already answered — a strong score at
                0% is real, and already behind us.
              </p>
            </div>
          </div>

          @if (st.latestPressure.length) {
            <table class="board">
              <thead>
                <tr>
                  <th>Currency</th>
                  <th class="num">Score</th>
                  <th>Direction</th>
                  <th class="num">In play</th>
                  <th class="num">Live</th>
                  <th class="num">Stories</th>
                  <th>Dominant</th>
                  <th class="num">As of</th>
                </tr>
              </thead>
              <tbody>
                @for (row of st.latestPressure; track row.currency) {
                  <tr class="clickable" (click)="selectFocus(row.currency)">
                    <td class="mono strong">{{ row.currency }}</td>
                    <td
                      class="num mono"
                      [class.pos]="row.weightedScore > 0.02"
                      [class.neg]="row.weightedScore < -0.02"
                    >
                      {{ row.weightedScore > 0 ? '+' : ''
                      }}{{ row.weightedScore | number: '1.3-3' }}
                    </td>
                    <td>
                      <div class="bar-wrap slim">
                        <div class="bar-mid"></div>
                        <div
                          class="bar-fill"
                          [class.pos]="row.weightedScore >= 0"
                          [style.width.%]="barWidth(row.weightedScore)"
                          [style.left.%]="
                            row.weightedScore >= 0 ? 50 : 50 - barWidth(row.weightedScore)
                          "
                        ></div>
                      </div>
                    </td>
                    <td
                      class="num mono"
                      [class.stale]="row.liveShare === 0"
                      [title]="boardLiveHint(row)"
                    >
                      @if (row.liveShare === null) {
                        <span class="muted">—</span>
                      } @else {
                        {{ row.liveShare * 100 | number: '1.0-0' }}%
                      }
                    </td>
                    <td class="num mono">{{ row.storyCount }} / {{ row.articleCount }}</td>
                    <td>{{ row.dominantCategory || '—' }}</td>
                    <td class="num muted small">{{ row.asOfUtc | date: 'HH:mm' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="muted small">
              No roll-ups yet. Either the module has not completed a cycle or nothing has been
              classified.
            </p>
          }
        </section>

        <!-- ───────── Pressure history ───────── -->
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Pressure history</h2>
              <p class="muted small">
                Score over time, with the share still live beneath it. The pair matters more than
                either line: a score holding flat while the bars drain is a move that has finished
                without the evidence changing.
              </p>
            </div>
            <div class="hist-controls">
              <select
                class="hist-select"
                [value]="historyCurrency()"
                (change)="onHistoryCurrency($event)"
                aria-label="Currency"
              >
                @for (c of historyCurrencies(); track c) {
                  <option [value]="c" [selected]="c === historyCurrency()">{{ c }}</option>
                }
              </select>
              @for (h of [24, 48, 168]; track h) {
                <button
                  type="button"
                  class="chip"
                  [class.active]="historyHours() === h"
                  (click)="setHistoryHours(h)"
                >
                  {{ h }}h
                </button>
              }
            </div>
          </div>

          @if (history.value(); as pts) {
            @if (pts.length > 1) {
              <svg
                class="hist"
                [attr.viewBox]="'0 0 ' + plot.w + ' ' + plotHeight"
                preserveAspectRatio="none"
                role="img"
                aria-label="News pressure score and live share over time"
              >
                <line
                  class="axis"
                  x1="0"
                  [attr.y1]="plot.scoreH / 2"
                  [attr.x2]="plot.w"
                  [attr.y2]="plot.scoreH / 2"
                />
                <path class="score-line" [attr.d]="scorePath()" />

                <line
                  class="axis faint"
                  x1="0"
                  [attr.y1]="plotHeight"
                  [attr.x2]="plot.w"
                  [attr.y2]="plotHeight"
                />
                @for (b of liveBars(); track b.x) {
                  <rect
                    class="live-bar"
                    [class.zero]="b.zero"
                    [attr.x]="b.x"
                    [attr.y]="b.y"
                    [attr.width]="b.w"
                    [attr.height]="b.h"
                  >
                    <title>{{ b.title }}</title>
                  </rect>
                }
              </svg>

              <div class="hist-legend small muted">
                <span><i class="key score"></i> score (−1 … +1, midline is zero)</span>
                <span><i class="key live"></i> live share (0 … 100%)</span>
                @if (liveUnknownCount() > 0) {
                  <span class="unknown">
                    {{ liveUnknownCount() }} of {{ pts.length }} points predate liveness tracking —
                    drawn as gaps, because unknown is not zero.
                  </span>
                }
              </div>
            } @else {
              <p class="muted small">Not enough roll-ups yet to plot a history.</p>
            }
          } @else {
            <p class="muted small">Loading…</p>
          }
        </section>

        <!-- ───────── Ingestion health ───────── -->
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Ingestion health</h2>
              <p class="muted small">
                Last {{ st.windowHours }}h. A source whose count drops to zero looks exactly like a
                quiet news day in the score alone — this is where a dead feed shows up.
              </p>
            </div>
          </div>

          <div class="status-pills">
            @for (kv of statusCounts(); track kv.label) {
              <div class="stat-pill" [class.warn]="kv.label === 'Failed' && kv.count > 0">
                <span class="stat-num mono">{{ kv.count }}</span>
                <span class="stat-label">{{ kv.label }}</span>
              </div>
            }
          </div>

          @if (st.channelBreakdown.length) {
            <div class="channels">
              @for (ch of st.channelBreakdown; track ch.kind) {
                <div class="channel-card" [class.stale]="ch.stale">
                  <div class="channel-head">
                    <span class="channel-name">{{ ch.kind }}</span>
                    <span class="mono channel-count">{{ ch.count }}</span>
                  </div>
                  <span class="muted xsmall">{{ ch.publishers }} publisher(s)</span>
                  <span class="muted xsmall">
                    newest {{ ch.newest | date: 'MMM d HH:mm' }} ({{ formatAge(ch.staleMinutes) }}
                    ago)
                    @if (ch.stale) {
                      — stale
                    }
                  </span>
                </div>
              }
            </div>
          }

          @if (st.sourceBreakdown.length) {
            <table class="board">
              <thead>
                <tr>
                  <th>Publisher</th>
                  <th>Channel</th>
                  <th class="num">Articles</th>
                  <th class="num">Labelled</th>
                  <th class="num">Skip rate</th>
                  <th class="num">Newest</th>
                </tr>
              </thead>
              <tbody>
                @for (src of visibleSources(); track src.source + src.kind) {
                  <tr>
                    <td>{{ src.source }}</td>
                    <td>
                      <span class="tag subtle">{{ src.kind }}</span>
                    </td>
                    <td class="num mono">{{ src.count }}</td>
                    <td class="num mono">{{ src.labelled }}</td>
                    <td class="num mono" [class.neg]="src.skipRate >= 0.8">
                      {{ src.skipRate | percent: '1.0-0' }}
                    </td>
                    <td class="num muted small">{{ src.newest | date: 'MMM d HH:mm' }}</td>
                  </tr>
                }
              </tbody>
            </table>
            @if (hiddenSourceCount() > 0) {
              <button type="button" class="btn subtle" (click)="toggleAllSources()">
                {{
                  showAllSources()
                    ? 'Show top publishers only'
                    : 'Show ' + hiddenSourceCount() + ' more publisher(s)'
                }}
              </button>
            }
          }
        </section>
      }

      <!-- ───────── Article feed ───────── -->
      <section class="card">
        <div class="card-head">
          <div>
            <h2>Articles</h2>
            <p class="muted small">
              The record layer. <code>First seen</code> is the point-in-time anchor every historical
              read filters on — not publication time.
            </p>
          </div>
          <div class="filters">
            <select
              class="sel"
              [value]="articleStatus() ?? ''"
              (change)="onStatusFilter($event)"
              aria-label="Filter by classification status"
            >
              <option value="">All statuses</option>
              <option value="Pending">Pending</option>
              <option value="Completed">Completed</option>
              <option value="Skipped">Skipped</option>
              <option value="Failed">Failed</option>
            </select>
            <button type="button" class="btn subtle" (click)="articles.refresh()">Refresh</button>
          </div>
        </div>

        @if (articles.value(); as list) {
          @if (list.length) {
            <div class="feed">
              @for (a of list; track a.id) {
                <article class="feed-item">
                  <div class="feed-main">
                    @if (a.url) {
                      <a class="headline" [href]="a.url" target="_blank" rel="noopener">{{
                        a.title
                      }}</a>
                    } @else {
                      <span class="headline">{{ a.title }}</span>
                    }
                    <div class="feed-meta muted small">
                      <span>{{ a.sourceName }}</span>
                      <span class="tag subtle">{{ a.sourceKind }}</span>
                      <span [title]="'Published ' + (a.publishedAtUtc | date: 'medium')"
                        >pub {{ a.publishedAtUtc | date: 'MMM d HH:mm' }}</span
                      >
                      <span
                        [title]="'First seen by the engine ' + (a.firstSeenUtc | date: 'medium')"
                        >seen {{ a.firstSeenUtc | date: 'MMM d HH:mm' }}</span
                      >
                      @if (a.classifierModel) {
                        <span
                          class="tag subtle"
                          [class.lexicon]="a.classifierModel.startsWith('lexicon')"
                          [title]="
                            a.classifierModel.startsWith('lexicon')
                              ? 'Keyword fallback — the model was unavailable. Low confidence by design.'
                              : 'Model-classified'
                          "
                          >{{ a.classifierModel }}</span
                        >
                      }
                    </div>

                    @if (a.labels.length) {
                      <div class="labels">
                        @for (l of a.labels; track l.currency) {
                          <span
                            class="label-chip"
                            [class.bull]="l.direction === 'Bullish'"
                            [class.bear]="l.direction === 'Bearish'"
                            [title]="l.rationale || ''"
                          >
                            <strong class="mono">{{ l.currency }}</strong>
                            {{ l.category }} · {{ l.direction }} · {{ l.certainty }}
                            @if (l.novelty !== 'New') {
                              · {{ l.novelty }}
                            }
                            <span class="muted"
                              >rel {{ l.relevance | number: '1.2-2' }} · mag
                              {{ l.magnitude | number: '1.2-2' }}</span
                            >
                          </span>
                        }
                      </div>
                    } @else if (a.classificationStatus === 'Skipped') {
                      <p class="muted small">No tracked currency — deliberately not labelled.</p>
                    } @else if (a.lastError) {
                      <p class="err small">{{ a.lastError }}</p>
                    }
                  </div>

                  <div class="feed-side">
                    <span
                      class="tag status"
                      [class.ok]="a.classificationStatus === 'Completed'"
                      [class.bad]="a.classificationStatus === 'Failed'"
                      >{{ a.classificationStatus }}</span
                    >
                    <button
                      type="button"
                      class="btn tiny subtle"
                      [disabled]="busyArticle() === a.id"
                      title="Clear labels and send back to the classification queue"
                      (click)="reclassify(a)"
                    >
                      {{ busyArticle() === a.id ? '…' : 'Re-classify' }}
                    </button>
                  </div>
                </article>
              }
            </div>
          } @else {
            <p class="muted small">No articles in the window.</p>
          }
        }
      </section>

      <!-- ───────── Config ───────── -->
      <section class="card">
        <div class="card-head">
          <div>
            <h2>Configuration</h2>
            <p class="muted small">
              Every knob, live. Weight terms multiply into one score — a change here re-scores
              everything on the next roll-up and changes the params fingerprint.
            </p>
          </div>
          <div class="filters">
            @if (dirtyCount() > 0) {
              <span class="dirty-count">{{ dirtyCount() }} unsaved</span>
              <button type="button" class="btn subtle" (click)="resetConfig()">Discard</button>
              <button
                type="button"
                class="btn primary"
                [disabled]="saving()"
                (click)="saveConfig()"
              >
                {{ saving() ? 'Saving…' : 'Save changes' }}
              </button>
            }
          </div>
        </div>

        @if (dirtyCount() > 0) {
          <div class="governance-box">
            <label class="small">
              Reason (required for risk-loosening changes; they are queued for cooling-off
              otherwise)
              <input
                type="text"
                class="reason-input"
                [value]="reason()"
                (input)="onReason($event)"
                placeholder="e.g. widening the intraday half-life after the Aug backtest"
              />
            </label>
            <label class="small inline">
              <input type="checkbox" [checked]="immediate()" (change)="toggleImmediate()" />
              Break-glass — apply immediately instead of queuing
            </label>
          </div>
        }

        @if (saveMessages().length) {
          <div class="banner info subtle">
            @for (m of saveMessages(); track m) {
              <div class="mono small">{{ m }}</div>
            }
          </div>
        }

        @for (group of configGroups(); track group.title) {
          <details class="cfg-group" [open]="group.title === 'Module'">
            <summary>
              <span class="cfg-title">{{ group.title }}</span>
              <span class="muted small">{{ group.blurb }}</span>
            </summary>
            <div class="cfg-rows">
              @for (entry of group.entries; track entry.key) {
                <div class="cfg-row" [class.dirty]="isDirty(entry.key)">
                  <div class="cfg-label">
                    <label [attr.for]="entry.key">{{ label(entry.key) }}</label>
                    <code class="mono muted xsmall">{{ entry.key }}</code>
                    @if (entry.description) {
                      <p class="muted xsmall">{{ entry.description }}</p>
                    }
                  </div>
                  <div class="cfg-input">
                    @if (entry.dataType === 'Bool') {
                      <select
                        class="sel"
                        [id]="entry.key"
                        [value]="currentValue(entry)"
                        (change)="onConfigChange(entry, $event)"
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </select>
                    } @else if (entry.dataType === 'Json' || isLongValue(entry)) {
                      <textarea
                        class="ta mono"
                        [id]="entry.key"
                        rows="6"
                        [value]="currentValue(entry)"
                        (input)="onConfigChange(entry, $event)"
                      ></textarea>
                    } @else {
                      <input
                        type="text"
                        class="inp mono"
                        [id]="entry.key"
                        [value]="currentValue(entry)"
                        (input)="onConfigChange(entry, $event)"
                      />
                    }
                  </div>
                </div>
              }
            </div>
          </details>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-6) var(--space-8);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .page-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
      }
      h1 {
        margin: 0;
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
      }
      h2 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      p {
        margin: 0;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .xsmall {
        font-size: 11px;
        line-height: 1.45;
      }
      .strong {
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .num {
        text-align: right;
      }
      .head-actions {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        flex-shrink: 0;
      }
      .power-btn,
      .pill-btn {
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-full);
        padding: 8px 18px;
        font-weight: var(--font-semibold);
        cursor: pointer;
        font-size: var(--text-xs);
      }
      .power-btn.on {
        background: var(--profit);
        border-color: var(--profit);
        color: #fff;
      }
      .pill-btn.on {
        background: rgba(0, 122, 255, 0.14);
        border-color: rgba(0, 122, 255, 0.5);
        color: var(--accent, #0a66c2);
      }
      .power-btn:disabled,
      .pill-btn:disabled,
      .btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .banner {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
      }
      .banner.error {
        background: rgba(255, 59, 48, 0.12);
        color: var(--loss);
      }
      .banner.warn {
        background: rgba(255, 149, 0, 0.14);
        color: #b25e00;
      }
      .banner.info {
        background: rgba(0, 122, 255, 0.1);
        color: var(--accent, #0a66c2);
      }
      .banner.subtle {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-4);
      }
      .btn {
        border: 1px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        padding: 6px 12px;
        cursor: pointer;
        font-size: var(--text-xs);
      }
      .btn.primary {
        background: var(--accent, #0a66c2);
        border-color: var(--accent, #0a66c2);
        color: #fff;
        font-weight: var(--font-semibold);
      }
      .btn.tiny {
        padding: 3px 8px;
        font-size: 11px;
      }

      /* ── Focus ── */
      .focus-input {
        display: flex;
        gap: var(--space-2);
        flex-shrink: 0;
      }
      .sym-input {
        width: 130px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        text-transform: uppercase;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chip {
        border: 1px solid var(--border);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border-radius: var(--radius-full);
        padding: 3px 10px;
        font-size: 11px;
        cursor: pointer;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .chip.active {
        background: var(--accent, #0a66c2);
        border-color: var(--accent, #0a66c2);
        color: #fff;
      }
      .verdict {
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }
      .verdict.included {
        background: rgba(52, 199, 89, 0.12);
        color: var(--profit, #1f8b4c);
      }
      .verdict.withheld {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .leg-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: var(--space-3);
      }
      .leg-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        background: var(--bg-primary);
      }
      .leg-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .ccy {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .score {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-weight: var(--font-semibold);
      }
      .score.pos,
      .pos {
        color: var(--profit, #1f8b4c);
      }
      .score.neg,
      .neg {
        color: var(--loss, #d1435b);
      }
      .bar-wrap {
        position: relative;
        height: 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .bar-wrap.slim {
        height: 6px;
        min-width: 90px;
      }
      .bar-mid {
        position: absolute;
        left: 50%;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--border);
      }
      .bar-fill {
        position: absolute;
        top: 0;
        bottom: 0;
        background: var(--loss, #d1435b);
      }
      .bar-fill.pos {
        background: var(--profit, #1f8b4c);
      }
      .leg-meta {
        display: flex;
        gap: var(--space-4);
        margin: 0;
      }
      .leg-meta div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .leg-meta dt {
        font-size: 11px;
        color: var(--text-secondary);
      }
      .leg-meta dd {
        margin: 0;
        font-size: var(--text-xs);
      }
      /* A zero live share is the one reading here an operator must not skim past. */
      /* ── Pressure history ── */
      .hist-controls {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .hist-select {
        padding: 4px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--surface);
        color: var(--text-primary);
        font-size: var(--text-xs);
      }
      .hist {
        display: block;
        width: 100%;
        height: 200px;
        margin-top: var(--space-3);
        overflow: visible;
      }
      /* Strokes must not scale with preserveAspectRatio="none", or the line thins as the card widens. */
      .hist .score-line {
        fill: none;
        stroke: #2563eb;
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        stroke-linejoin: round;
      }
      .hist .axis {
        stroke: var(--border);
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .hist .axis.faint {
        opacity: 0.6;
      }
      .hist .live-bar {
        fill: #0d9488;
        opacity: 0.75;
      }
      /* A measured zero is a real reading, not a missing one — keep it visible as a floor tick. */
      .hist .live-bar.zero {
        fill: #b25e00;
        opacity: 0.5;
      }
      .hist-legend {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        margin-top: var(--space-2);
        align-items: center;
      }
      .hist-legend .key {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 2px;
        margin-right: 4px;
        vertical-align: middle;
      }
      .hist-legend .key.score {
        background: #2563eb;
      }
      .hist-legend .key.live {
        background: #0d9488;
      }
      .hist-legend .unknown {
        color: #b25e00;
      }
      .board td.stale {
        color: #b25e00;
        font-weight: 600;
      }
      .leg-meta dd.stale {
        color: #b25e00;
        font-weight: 600;
      }
      .leg-meta dd .sub {
        color: var(--text-secondary);
        font-weight: 400;
      }
      .leg-meta {
        flex-wrap: wrap;
      }
      .conflict {
        color: #b25e00;
        margin: 0;
      }
      .bias {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
      }
      .bias-label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .bias-value {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .fingerprint {
        margin: 0;
      }

      /* ── Tables ── */
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      th {
        text-align: left;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
        font-size: 11px;
      }
      th.num {
        text-align: right;
      }
      td {
        padding: 5px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      tr.clickable {
        cursor: pointer;
      }
      tr.clickable:hover {
        background: var(--bg-tertiary);
      }
      .items td .headline {
        display: block;
      }
      .headline {
        font-weight: var(--font-medium, 500);
        color: var(--text-primary);
        text-decoration: none;
      }
      a.headline:hover {
        text-decoration: underline;
      }
      .tag {
        display: inline-block;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        font-size: 10px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        margin-right: 4px;
        white-space: nowrap;
      }
      .tag.bull {
        background: rgba(52, 199, 89, 0.16);
        color: var(--profit, #1f8b4c);
      }
      .tag.bear {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss, #d1435b);
      }
      .tag.rumor {
        background: rgba(255, 149, 0, 0.18);
        color: #b25e00;
      }
      .tag.echo {
        opacity: 0.7;
      }
      .tag.lexicon {
        background: rgba(255, 149, 0, 0.16);
        color: #b25e00;
      }
      .tag.status.ok {
        background: rgba(52, 199, 89, 0.16);
        color: var(--profit, #1f8b4c);
      }
      .tag.status.bad {
        background: rgba(255, 59, 48, 0.14);
        color: var(--loss, #d1435b);
      }

      /* ── Status pills ── */
      .status-pills {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .stat-pill {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 6px 12px;
        display: flex;
        flex-direction: column;
        min-width: 78px;
        background: var(--bg-primary);
      }
      .stat-pill.warn {
        border-color: rgba(255, 149, 0, 0.5);
        background: rgba(255, 149, 0, 0.07);
      }
      .stat-num {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .stat-label {
        font-size: 11px;
        color: var(--text-secondary);
      }

      .channels {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-2);
      }
      .channel-card {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        display: flex;
        flex-direction: column;
        gap: 2px;
        background: var(--bg-primary);
      }
      .channel-card.stale {
        border-color: rgba(255, 149, 0, 0.5);
        background: rgba(255, 149, 0, 0.07);
      }
      .channel-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
      }
      .channel-name {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .channel-count {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }

      /* ── Feed ── */
      .filters {
        display: flex;
        gap: var(--space-2);
        align-items: center;
        flex-shrink: 0;
      }
      .sel,
      .inp,
      .ta,
      .reason-input {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: 5px 8px;
        font-size: var(--text-xs);
        width: 100%;
      }
      .ta {
        resize: vertical;
        line-height: 1.5;
      }
      .feed {
        display: flex;
        flex-direction: column;
      }
      .feed-item {
        display: flex;
        gap: var(--space-3);
        padding: var(--space-3) 0;
        border-bottom: 1px solid var(--border);
      }
      .feed-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .feed-meta {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
        align-items: center;
      }
      .feed-side {
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: flex-end;
        flex-shrink: 0;
      }
      .labels {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .label-chip {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .label-chip.bull {
        background: rgba(52, 199, 89, 0.12);
      }
      .label-chip.bear {
        background: rgba(255, 59, 48, 0.1);
      }
      .err {
        color: var(--loss, #d1435b);
        margin: 0;
      }

      /* ── Config ── */
      .cfg-group {
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: var(--space-2) var(--space-3);
        background: var(--bg-primary);
      }
      .cfg-group summary {
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cfg-title {
        font-weight: var(--font-semibold);
        font-size: var(--text-sm);
      }
      .cfg-rows {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        margin-top: var(--space-3);
      }
      .cfg-row {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
        gap: var(--space-3);
        padding: var(--space-2);
        border-radius: var(--radius-sm);
      }
      .cfg-row.dirty {
        background: rgba(255, 149, 0, 0.07);
        outline: 1px solid rgba(255, 149, 0, 0.35);
      }
      .cfg-label {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .cfg-label label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .dirty-count {
        font-size: var(--text-xs);
        color: #b25e00;
        font-weight: var(--font-semibold);
      }
      .governance-box {
        padding: var(--space-3);
        border: 1px solid rgba(255, 149, 0, 0.4);
        border-radius: var(--radius-md);
        background: rgba(255, 149, 0, 0.06);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
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
    `,
  ],
})
export class NewsIntelPageComponent {
  private readonly svc = inject(NewsIntelService);
  private readonly pairs = inject(CurrencyPairsService);

  // ── Focus ───────────────────────────────────────────────────────────
  readonly focusSymbol = signal('EURUSD');
  readonly focusInput = signal('EURUSD');

  readonly focus = createPolledResource(() => this.svc.getFocus(this.focusSymbol()), {
    intervalMs: 30_000,
  });

  // ── Pressure history ────────────────────────────────────────────────
  readonly historyCurrency = signal('USD');
  readonly historyHours = signal(48);
  readonly history = createPolledResource(
    () => this.svc.getTimeseries(this.historyCurrency(), this.historyHours()),
    { intervalMs: 60_000 },
  );

  /** Plot geometry. Two stacked panels on one x axis: score above, liveness below. */
  private static readonly PLOT = {
    w: 1000,
    scoreH: 140,
    gap: 14,
    liveH: 46,
  };

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
  }

  // ── Status + articles ───────────────────────────────────────────────
  readonly status = createPolledResource(() => this.svc.getStatus(24), { intervalMs: 30_000 });

  readonly articleStatus = signal<NewsClassificationStatus | null>(null);
  readonly articles = createPolledResource(
    () =>
      this.svc.getArticles({
        status: this.articleStatus() ?? undefined,
        hours: 24,
        take: 60,
      }),
    { intervalMs: 60_000 },
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

  readonly showAllSources = signal(false);

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

  toggleModule(): void {
    const next = this.moduleEnabled() ? 'false' : 'true';
    this.persist([{ key: 'NewsIntel:Enabled', value: next, dataType: 'Bool' }]);
  }

  togglePrompt(): void {
    const next = this.promptEnabled() ? 'false' : 'true';
    this.persist([{ key: 'NewsIntel:Prompt:Enabled', value: next, dataType: 'Bool' }]);
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
          this.saveMessages.set(messages);
          if (opts?.clearEdits) this.resetConfig();
          this.loadConfig();
          this.focus.refresh();
        },
        error: () => {
          this.saving.set(false);
          this.error.set('Save failed — the configuration was not changed.');
        },
      });
  }

  private boolKnob(key: string): boolean | null {
    const entry = this.configEntries().find((e) => e.key === key);
    if (!entry) return null;
    return (this.edits()[key] ?? entry.value).toLowerCase() === 'true';
  }
}
