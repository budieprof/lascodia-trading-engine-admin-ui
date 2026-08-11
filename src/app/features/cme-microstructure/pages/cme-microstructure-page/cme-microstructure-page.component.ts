import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, of } from 'rxjs';

import { CmeMicrostructureService } from '@core/services/cme-microstructure.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CmeExperimentRunDto,
  CmeFeedHealthDto,
  CmeOrderflowExperimentResultDto,
  CmeStatusDto,
  ExperimentArmDto,
  SyntheticFlowRegime,
} from '@features/cme-microstructure/cme-microstructure.types';

/** One bar in a history panel. Geometry is precomputed so the template stays declarative. */
interface ChartBar {
  key: string;
  series: 'real' | 'proxy';
  x: number;
  y: number;
  width: number;
  height: number;
  tooltip: string;
}

/** One chart panel — a single measure on its own axis. */
interface ChartPanel {
  key: string;
  title: string;
  caption: string;
  zeroY: number;
  bars: ChartBar[];
  xLabels: { key: string; text: string }[];
}

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * CME Microstructure operator panel (engine ADR-0021 / ADR-0022).
 *
 * The engine captures real CME futures tape + depth — the only place FX has a genuine centralized
 * book and aggressor-tagged trades — and bridges it to the spot symbol we trade. Everything is gated
 * on one decisive experiment: does REAL aggressor delta beat the tick-rule proxy out-of-sample? This
 * page is where an operator seeds the contract calendar, back-adjusts the roll gaps, runs that
 * experiment, and reads what the shadow monitor would have traded.
 */
@Component({
  selector: 'app-cme-microstructure-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CME Microstructure"
        subtitle="Real futures tape + depth bridged to spot — gated on the real-vs-proxy experiment (ADR-0021/0022)"
      >
        <button type="button" class="btn btn-secondary" [disabled]="loading()" (click)="load()">
          Refresh
        </button>
      </app-page-header>

      @if (loading() && !status()) {
        <app-card-skeleton [lines]="6" />
      } @else if (loadError()) {
        <app-error-state
          title="Could not load CME status"
          [message]="loadError()!"
          (retry)="load()"
        />
      } @else if (status(); as s) {
        <section class="kpis">
          <app-metric-card
            label="Contracts seeded"
            [value]="s.contractCount"
            format="number"
            [dotColor]="s.contractCount > 0 ? '#34C759' : '#FF9500'"
          />
          <app-metric-card
            label="Trades ingested"
            [value]="s.tradeCount"
            format="number"
            [dotColor]="s.tradeCount > 0 ? '#34C759' : '#8E8E93'"
          />
          <app-metric-card
            label="Book snapshots"
            [value]="s.bookSnapshotCount"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Derived bars"
            [value]="s.barCount"
            format="number"
            dotColor="#8b5cf6"
          />
          <app-metric-card
            label="Shadow would-haves"
            [value]="s.shadowSignalCount"
            format="number"
            dotColor="#FF9500"
          />
        </section>

        <!-- ── Feed health ───────────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Feed health</h3>
            <span class="feed-pill" [attr.data-status]="s.feedHealth.status">
              {{ feedStatusLabel(s.feedHealth.status) }}
            </span>
          </header>

          <p class="muted small">{{ feedStatusExplanation(s.feedHealth) }}</p>

          <div class="health-grid">
            <div class="health-cell">
              <span class="hc-label">Newest bar age</span>
              <span class="hc-value">{{ formatAge(s.feedHealth.latestBarAgeSeconds) }}</span>
              <span class="hc-sub">gate {{ s.feedHealth.maxFlowStalenessSeconds }}s</span>
            </div>
            <div class="health-cell">
              <span class="hc-label">Trades / 24h</span>
              <span class="hc-value">{{ s.feedHealth.tradesLast24h | number }}</span>
            </div>
            <div class="health-cell">
              <span class="hc-label">Books / 24h</span>
              <span class="hc-value">{{ s.feedHealth.booksLast24h | number }}</span>
            </div>
            <div class="health-cell">
              <span class="hc-label">Bars / 24h</span>
              <span class="hc-value">{{ s.feedHealth.barsLast24h | number }}</span>
            </div>
            <div class="health-cell">
              <span class="hc-label">Ingest worker</span>
              <span class="hc-value">{{ s.feedHealth.ingestEnabled ? 'On' : 'Off' }}</span>
            </div>
            <div class="health-cell">
              <span class="hc-label">Shadow monitor</span>
              <span class="hc-value">{{ s.feedHealth.shadowMonitorEnabled ? 'On' : 'Off' }}</span>
            </div>
          </div>
        </section>

        <!-- ── V11 model status ──────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>V11 CME-flow models</h3>
            <span class="muted small">Active models carrying the real-flow feature block</span>
          </header>

          @if (s.v11Models.length === 0) {
            <p class="muted small">
              No active model uses the V11 CME feature block yet. This is the expected state until a
              training run completes with <code>MLTraining:UseV11CmeFlow</code> on — it is not a
              fault, and models on earlier schemas keep serving normally.
            </p>
          } @else {
            <p class="muted small">
              <strong>Requires real flow</strong> means the model was trained against observed CME
              flow, so serving it without flow is a source mismatch and the scorer suppresses it. A
              V11 model trained with no flow coverage reads “no” and scores normally.
            </p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Symbol</th>
                    <th>TF</th>
                    <th>Version</th>
                    <th>Requires real flow</th>
                    <th>Trained</th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of s.v11Models; track m.modelId) {
                    <tr>
                      <td class="mono">#{{ m.modelId }}</td>
                      <td>{{ m.symbol }}</td>
                      <td>{{ m.timeframe }}</td>
                      <td class="mono">{{ m.modelVersion }}</td>
                      <td>
                        <span class="flow-pill" [attr.data-on]="m.requiresRealFlow">
                          {{ m.requiresRealFlow ? 'Yes' : 'No' }}
                        </span>
                      </td>
                      <td>{{ m.trainedAt ? (m.trainedAt | date: 'short') : '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!--
          The hot tables are only a recent window; bulk-imported research slices live in the Parquet
          warm tier. Reporting "no data" off the hot counts alone told an operator the purchase had
          failed while 31M records sat on disk and the experiment was running against them.
        -->
        @if (status()?.warmTier?.sessionCount) {
          <section class="banner" data-tone="info">
            <strong
              >Warm tier holds {{ status()!.warmTier.sessionCount }} imported session(s).</strong
            >
            {{ status()!.warmTier.contracts.join(', ') }} ·
            {{ status()!.warmTier.earliestSession }} → {{ status()!.warmTier.latestSession }}. Raw
            tape and book live in Parquet (the system of record); the hot tables above hold only the
            recent window the retention worker keeps, so a zero there is expected after a bulk
            import — the experiment reads both tiers.
          </section>
        } @else if (!hasData()) {
          <section class="banner">
            <strong>No CME data ingested yet.</strong>
            The subsystem ships disabled and inert: it needs a Databento slice plus
            <code>Microstructure:Enabled=true</code> and an API key. Seeding the contract calendar
            below is the prerequisite that makes the futures→spot resolver return anything.
          </section>
        }

        <!-- ── Setup: seed + back-adjust ─────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Contract calendar</h3>
            <span class="muted small">
              Front month:
              <strong>{{ s.frontMonthContract ?? '—' }}</strong>
              @if (s.latestBarUtc) {
                · latest bar {{ s.latestBarUtc | relativeTime }}
              }
            </span>
          </header>

          <div class="toolbar">
            <input class="input sm" placeholder="Root (6E)" [(ngModel)]="seedRoot" />
            <input class="input sm" placeholder="Spot (EURUSD)" [(ngModel)]="seedSpot" />
            <input class="input sm" type="date" [(ngModel)]="seedFrom" />
            <input class="input sm" type="date" [(ngModel)]="seedTo" />
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || !seedRoot || !seedSpot"
              (click)="seed()"
            >
              Seed calendar
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="busy() || !seedRoot"
              (click)="backAdjust()"
              title="Compute roll-gap offsets so a multi-quarter series is continuous"
            >
              Back-adjust rolls
            </button>
          </div>

          @if (s.contracts.length === 0) {
            <app-empty-state
              title="No contracts seeded"
              description="Seed a root → spot mapping (e.g. 6E → EURUSD) so the futures→spot resolver has a chain to resolve."
            />
          } @else {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Spot</th>
                    <th>Expiry</th>
                    <th>Roll</th>
                    <th class="num">Back-adjust</th>
                    <th>Ingested through</th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of s.contracts; track c.contractCode) {
                    <tr [class.front]="c.isFrontMonth">
                      <td>
                        <code>{{ c.contractCode }}</code>
                        @if (c.isFrontMonth) {
                          <span class="pill">front</span>
                        }
                      </td>
                      <td>{{ c.spotSymbol }}</td>
                      <td>{{ c.expiryDate | date: 'yyyy-MM-dd' }}</td>
                      <td>{{ c.rollDate ? (c.rollDate | date: 'yyyy-MM-dd') : '—' }}</td>
                      <td class="num">{{ c.priceAdjustment | number: '1.0-5' }}</td>
                      <td>
                        {{
                          c.lastTradeEventTimestamp
                            ? (c.lastTradeEventTimestamp | relativeTime)
                            : '—'
                        }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!-- ── The decisive experiment ───────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Decisive experiment — real delta vs tick-rule proxy</h3>
            <span class="muted small">
              Same strategy, same events, one variable. A positive and fold-consistent delta is the
              go/no-go for the whole data spend.
            </span>
          </header>

          <div class="toolbar">
            <input class="input sm" placeholder="Contract (6EU5)" [(ngModel)]="expContract" />
            <input class="input sm" type="date" [(ngModel)]="expFrom" />
            <input class="input sm" type="date" [(ngModel)]="expTo" />
            <input class="input xs" type="number" min="1" max="50" [(ngModel)]="expFolds" />
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || !expContract"
              (click)="runExperiment()"
            >
              Run experiment
            </button>
          </div>

          @if (experiment(); as x) {
            @if (!x.ran) {
              <p class="muted small">
                Not scored — <code>{{ x.reason }}</code>
                @if (x.reason === 'no_data') {
                  · ingest a Databento slice for this contract/window first.
                }
              </p>
            } @else {
              <div class="verdict" [attr.data-good]="verdictIsClean(x)">
                <div class="verdict-headline">{{ verdictHeadline(x) }}</div>
                <div class="verdict-sub muted small">
                  OOS net-PnL delta {{ x.oosNetPnlDelta | number: '1.2-2' }} · PF delta
                  {{ x.oosProfitFactorDelta | number: '1.2-2' }} ·
                  {{ x.fractionFoldsRealBeatsProxy * 100 | number: '1.0-0' }}% of
                  {{ x.foldsScored }} sessions · {{ x.eventsLoaded | number }} events
                </div>

                @if (perTradeDisagrees(x)) {
                  <!--
                    The selectivity trap. Total PnL is trade-count sensitive: when the underlying
                    strategy loses money, whichever arm trades LESS loses less overall while losing
                    MORE on each trade. Reporting the headline delta alone calls that "real flow
                    beat the proxy" — the first real 6E run did exactly this.
                  -->
                  <p class="verdict-caveat">
                    <span aria-hidden="true">⚠</span>
                    <span>
                      <strong>Aggregate and per-trade disagree.</strong> Real took
                      {{ x.real.tradeCount | number }} trades vs the proxy's
                      {{ x.proxy.tradeCount | number }}, so the headline delta reflects selectivity
                      rather than signal quality. Per trade real is
                      {{ perTrade(x.real) | number: '1.2-2' }} against the proxy's
                      {{ perTrade(x.proxy) | number: '1.2-2' }}. This run does
                      <strong>not</strong> show real flow carrying edge.
                    </span>
                  </p>
                }

                @if (bothArmsLose(x)) {
                  <p class="verdict-caveat">
                    <span aria-hidden="true">⚠</span>
                    <span>
                      Both arms lose money (profit factor
                      {{ x.real.profitFactor | number: '1.2-2' }} and
                      {{ x.proxy.profitFactor | number: '1.2-2' }}). This compares two losing
                      configurations — it measures which way a losing system fails, not whether real
                      flow carries edge.
                    </span>
                  </p>
                }
              </div>

              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Arm</th>
                      <th class="num">Net PnL</th>
                      <th class="num">Profit factor</th>
                      <th class="num">Trades</th>
                      <th class="num">Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (arm of [x.real, x.proxy]; track arm.name) {
                      <tr>
                        <td>
                          <strong>{{
                            arm.name === 'real' ? 'Real aggressor' : 'Tick-rule proxy'
                          }}</strong>
                        </td>
                        <td class="num">{{ arm.netPnl | number: '1.2-2' }}</td>
                        <td class="num">{{ arm.profitFactor | number: '1.2-2' }}</td>
                        <td class="num">{{ arm.tradeCount }}</td>
                        <td class="num">{{ arm.winRate * 100 | number: '1.0-1' }}%</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          } @else {
            <p class="muted small">
              Run the experiment for an ingested contract/window to get a verdict.
            </p>
          }
        </section>

        <!-- ── Verdict history ───────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Verdict history</h3>
            <span class="muted small">
              Every recorded run, newest first. A verdict that exists only in one HTTP response
              can't be revisited or compared — and a decision that gates real money should be
              auditable long after the run.
            </span>
          </header>

          @if (runs().length === 0) {
            <p class="muted small">No runs recorded yet.</p>
          } @else {
            <!--
              TWO charts, never one with two y-scales. Total PnL is in dollars and per-trade PnL is
              dollars-per-trade — plotting them on a shared axis would make their relative sizes
              meaningless. Separate panels keep each honest, and put the two comparisons side by
              side where a disagreement between them is visible at a glance.
            -->
            <div class="chart-grid">
              @for (panel of chartPanels(); track panel.key) {
                <figure class="chart">
                  <figcaption>
                    <span class="chart-title">{{ panel.title }}</span>
                    <span class="muted small">{{ panel.caption }}</span>
                  </figcaption>

                  <svg
                    class="chart-svg"
                    [attr.viewBox]="'0 0 ' + chartWidth + ' ' + chartHeight"
                    role="img"
                    [attr.aria-label]="panel.title + ' — real aggressor versus tick-rule proxy'"
                    preserveAspectRatio="xMidYMid meet"
                  >
                    <!-- zero line: the reference that makes a loss legible as a loss -->
                    <line
                      class="axis-zero"
                      [attr.x1]="0"
                      [attr.x2]="chartWidth"
                      [attr.y1]="panel.zeroY"
                      [attr.y2]="panel.zeroY"
                    />

                    @for (bar of panel.bars; track bar.key) {
                      <rect
                        [attr.x]="bar.x"
                        [attr.y]="bar.y"
                        [attr.width]="bar.width"
                        [attr.height]="bar.height"
                        [attr.rx]="3"
                        [attr.fill]="
                          bar.series === 'real' ? 'var(--series-real)' : 'var(--series-proxy)'
                        "
                      >
                        <title>{{ bar.tooltip }}</title>
                      </rect>
                    }
                  </svg>

                  <div class="chart-xaxis">
                    @for (label of panel.xLabels; track label.key) {
                      <span class="muted small">{{ label.text }}</span>
                    }
                  </div>
                </figure>
              }
            </div>

            <div class="legend">
              <span class="legend-item">
                <span class="swatch" style="background: var(--series-real)"></span>Real aggressor
              </span>
              <span class="legend-item">
                <span class="swatch" style="background: var(--series-proxy)"></span>Tick-rule proxy
              </span>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Window</th>
                    <th class="num">Sessions</th>
                    <th class="num">Real PF</th>
                    <th class="num">Proxy PF</th>
                    <th class="num">Net Δ</th>
                    <th class="num">Per-trade Δ</th>
                    <th>Entry</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of runs(); track r.id) {
                    <tr>
                      <td>
                        {{ r.createdAtUtc | date: 'MMM d, HH:mm' }}
                        <span class="muted small">· {{ r.contract }}</span>
                      </td>
                      <td class="muted small">
                        {{ r.fromUtc | date: 'MMM d' }} – {{ r.toUtc | date: 'MMM d' }}
                      </td>
                      <td class="num">{{ r.foldsScored }}</td>
                      <td class="num">{{ r.realProfitFactor | number: '1.2-2' }}</td>
                      <td class="num">{{ r.proxyProfitFactor | number: '1.2-2' }}</td>
                      <td class="num">{{ r.oosNetPnlDelta | number: '1.2-2' }}</td>
                      <td class="num">{{ r.oosPnlPerTradeDelta | number: '1.2-2' }}</td>
                      <!-- Cost model, not signal. A crossing run and a passive run are different
                           experiments: on 6EM6 the round-trip spread was ~$12.50 against a ~$20-25
                           average trade, so execution dominated the result. -->
                      <td class="muted small">{{ r.passiveEntry ? 'Passive' : 'Crossing' }}</td>
                      <td>
                        <!-- Icon + label, never colour alone. -->
                        @if (!r.ran) {
                          <span class="tag" data-state="skipped">
                            <span aria-hidden="true">○</span> {{ r.reason }}
                          </span>
                        } @else if (r.aggregateAndPerTradeDisagree) {
                          <span class="tag" data-state="ambiguous">
                            <span aria-hidden="true">⚠</span> Inconclusive
                          </span>
                        } @else if (r.oosNetPnlDelta > 0 && r.oosPnlPerTradeDelta > 0) {
                          <span class="tag" data-state="real">
                            <span aria-hidden="true">▲</span> Real ahead
                          </span>
                        } @else {
                          <span class="tag" data-state="proxy">
                            <span aria-hidden="true">▼</span> Proxy ahead
                          </span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!-- ── Simulator (pre-purchase pipeline validation) ──────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Simulator — synthetic tape &amp; depth</h3>
            <span class="muted small">
              Exercises the pipeline before a real slice exists. <strong>NoEdge</strong> is the null
              control (the experiment must find nothing); <strong>DeltaLeadsPrice</strong> plants a
              lead-lag it must detect. Synthetic data validates the pipeline and the harness — it
              can never prove a real edge. Rows are stamped <code>Source=Synthetic</code>; real data
              is never touched.
            </span>
          </header>

          <div class="toolbar">
            <select class="input sm" [(ngModel)]="synthRegime">
              <option value="NoEdge">NoEdge (null control)</option>
              <option value="DeltaLeadsPrice">DeltaLeadsPrice (planted edge)</option>
            </select>
            <input
              class="input xs"
              type="number"
              min="1"
              [(ngModel)]="synthMinutes"
              title="Minutes"
            />
            <input class="input xs" type="number" [(ngModel)]="synthSeed" title="Seed" />
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="busy() || !expContract"
              (click)="generateSynthetic()"
            >
              Generate synthetic data
            </button>
            <span class="muted small">into {{ expContract || 'set a contract above' }}</span>
          </div>
        </section>

        <!-- ── Shadow monitor ────────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Shadow monitor — would-have signals</h3>
            <span class="muted small">
              Recorded, never traded. Prove precision here before enabling a live
              CmeDeepBookOrderflow strategy.
            </span>
          </header>

          @if (s.recentShadowSignals.length === 0) {
            <app-empty-state
              title="No shadow signals yet"
              description="The shadow monitor ships disabled (Microstructure:SignalEnabled=false) and needs live CME flow."
            />
          } @else {
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Symbol</th>
                    <th>Would-have</th>
                    <th class="num">Confidence</th>
                    <th class="num">Delta</th>
                    <th class="num">Imbalance</th>
                    <th class="num">Basis</th>
                  </tr>
                </thead>
                <tbody>
                  @for (sig of s.recentShadowSignals; track sig.id) {
                    <tr>
                      <td>{{ sig.evaluatedAt | relativeTime }}</td>
                      <td>{{ sig.symbol }}</td>
                      <td>
                        <span class="dot" [style.background]="dirColor(sig.direction)"></span>
                        {{ sig.direction }}
                      </td>
                      <td class="num">{{ sig.confidence | number: '1.2-2' }}</td>
                      <td class="num">{{ sig.cumulativeDelta | number: '1.0-0' }}</td>
                      <td class="num">{{ sig.bookImbalanceTop5 | number: '1.2-2' }}</td>
                      <td class="num">
                        {{ sig.basis === null ? '—' : (sig.basis | number: '1.0-5') }}
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .feed-pill {
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid transparent;
      }
      .feed-pill[data-status='Live'] {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
        border-color: rgba(52, 199, 89, 0.35);
      }
      .feed-pill[data-status='Stale'] {
        background: rgba(255, 149, 0, 0.14);
        color: #ff9500;
        border-color: rgba(255, 149, 0, 0.35);
      }
      .feed-pill[data-status='NoData'] {
        background: rgba(142, 142, 147, 0.14);
        color: #8e8e93;
        border-color: rgba(142, 142, 147, 0.3);
      }
      .health-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
        margin-top: 12px;
      }
      .health-cell {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 10px 12px;
        border: 1px solid var(--border, rgba(120, 120, 128, 0.24));
        border-radius: 10px;
      }
      .hc-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        opacity: 0.65;
      }
      .hc-value {
        font-size: 18px;
        font-weight: 600;
      }
      .hc-sub {
        font-size: 11px;
        opacity: 0.55;
      }
      .flow-pill {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
      }
      .flow-pill[data-on='true'] {
        background: rgba(255, 149, 0, 0.14);
        color: #ff9500;
      }
      .flow-pill[data-on='false'] {
        background: rgba(142, 142, 147, 0.14);
        color: #8e8e93;
      }

      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      .banner {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left: 3px solid #ff9500;
        border-radius: var(--radius-lg);
        padding: 12px 16px;
        margin-bottom: 16px;
        font-size: 13px;
        color: var(--text-secondary);
      }
      .banner strong {
        color: var(--text-primary);
        margin-right: 6px;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 16px;
        margin-bottom: 16px;
      }
      .card-head {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-bottom: 12px;
      }
      .card-head h3 {
        margin: 0;
        font-size: 15px;
        font-weight: var(--font-bold);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 12px;
      }
      .input {
        height: 30px;
        padding: 0 8px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: inherit;
        font-size: 12px;
      }
      .input.sm {
        width: 140px;
      }
      .input.xs {
        width: 70px;
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th,
      td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      th {
        font-weight: var(--font-bold);
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      tr.front code {
        font-weight: var(--font-bold);
      }
      .pill {
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .verdict {
        border: 1px solid var(--border);
        border-left: 3px solid #ff3b30;
        border-radius: var(--radius-sm);
        padding: 10px 14px;
        margin-bottom: 12px;
      }
      .verdict[data-good='true'] {
        border-left-color: #34c759;
      }
      .verdict-headline {
        font-weight: var(--font-bold);
        font-size: 14px;
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 4px;
        vertical-align: middle;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: 12px;
      }
      .btn {
        height: 30px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-weight: var(--font-semibold);
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
        border: 1px solid var(--border);
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      /* ── Verdict caveats ──────────────────────────────────────────────
         The delta alone is the most misleading number on this page, so the
         qualifier is styled to be read, not skimmed past. */
      .verdict-caveat {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin: 10px 0 0;
        padding: 8px 10px;
        border-radius: 6px;
        font-size: 12.5px;
        line-height: 1.45;
        background: rgba(250, 178, 25, 0.12);
        border: 1px solid rgba(250, 178, 25, 0.4);
        color: var(--text-primary);
      }

      /* ── Charts ───────────────────────────────────────────────────────
         Series hues are the validated categorical slots 1 and 2 (blue,
         orange): adjacent CVD ΔE 24.7 light / 26.8 dark, normal-vision
         33.6 / 31.8, both clear of the floors and ≥3:1 on their surface.
         Dark steps are re-stepped for the dark surface, not a flip. */
      .chart-grid {
        --series-real: #2a78d6;
        --series-proxy: #eb6834;
        --chart-axis: rgba(0, 0, 0, 0.22);
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 18px;
        margin-bottom: 4px;
      }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme='light']) .chart-grid {
          --series-real: #3987e5;
          --series-proxy: #d95926;
          --chart-axis: rgba(255, 255, 255, 0.26);
        }
      }
      :root[data-theme='dark'] .chart-grid {
        --series-real: #3987e5;
        --series-proxy: #d95926;
        --chart-axis: rgba(255, 255, 255, 0.26);
      }

      .chart {
        margin: 0;
        min-width: 0;
      }
      .chart figcaption {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-bottom: 6px;
      }
      .chart-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text-primary);
      }
      .chart-svg {
        width: 100%;
        height: auto;
        display: block;
        overflow: visible;
      }
      /* Recessive: the zero reference should orient, not compete with the data. */
      .axis-zero {
        stroke: var(--chart-axis);
        stroke-width: 1;
      }
      .chart-xaxis {
        display: flex;
        justify-content: space-around;
        margin-top: 2px;
        font-variant-numeric: tabular-nums;
      }

      .legend {
        display: flex;
        gap: 16px;
        margin: 4px 0 14px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .swatch {
        width: 10px;
        height: 10px;
        border-radius: 2px;
        display: inline-block;
      }

      /* Verdict tags: icon + label, so state never rests on colour alone. */
      .tag {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: 600;
        white-space: nowrap;
      }
      .tag[data-state='real'] {
        background: rgba(12, 163, 12, 0.14);
        color: #0ca30c;
      }
      .tag[data-state='proxy'] {
        background: rgba(208, 59, 59, 0.14);
        color: #d03b3b;
      }
      .tag[data-state='ambiguous'] {
        background: rgba(250, 178, 25, 0.16);
        color: #b07c00;
      }
      .tag[data-state='skipped'] {
        background: var(--bg-primary);
        color: var(--text-secondary);
      }
      :root[data-theme='dark'] .tag[data-state='ambiguous'] {
        color: #fab219;
      }
    `,
  ],
})
export class CmeMicrostructurePageComponent {
  private readonly cme = inject(CmeMicrostructureService);
  private readonly notify = inject(NotificationService);

  protected readonly status = signal<CmeStatusDto | null>(null);
  protected readonly experiment = signal<CmeOrderflowExperimentResultDto | null>(null);
  protected readonly runs = signal<readonly CmeExperimentRunDto[]>([]);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly loadError = signal<string | null>(null);

  /** Chart geometry. Fixed viewBox; the SVG scales to its container. */
  protected readonly chartWidth = 320;
  protected readonly chartHeight = 120;

  // Seed form
  protected seedRoot = '6E';
  protected seedSpot = 'EURUSD';
  protected seedFrom = isoDate(-365);
  protected seedTo = isoDate(365);

  // Experiment form
  protected expContract = '';
  protected expFrom = isoDate(-90);
  protected expTo = isoDate(0);
  protected expFolds = 5;

  // Simulator form
  protected synthRegime: SyntheticFlowRegime = 'NoEdge';
  protected synthMinutes = 600;
  protected synthSeed = 20260808;

  protected readonly hasData = computed(() => (this.status()?.tradeCount ?? 0) > 0);

  // ── Verdict interpretation ───────────────────────────────────────────────
  // These guard the single most misleading reading of this experiment: that a positive headline
  // delta means real flow carries edge. It can equally mean the real arm simply traded less.

  protected perTrade(arm: ExperimentArmDto): number {
    return arm.tradeCount > 0 ? arm.netPnl / arm.tradeCount : 0;
  }

  /** True when total-PnL and per-trade PnL favour DIFFERENT arms. */
  protected perTradeDisagrees(x: CmeOrderflowExperimentResultDto): boolean {
    const perTradeDelta = this.perTrade(x.real) - this.perTrade(x.proxy);
    return (
      x.oosNetPnlDelta !== 0 &&
      perTradeDelta !== 0 &&
      Math.sign(x.oosNetPnlDelta) !== Math.sign(perTradeDelta)
    );
  }

  protected bothArmsLose(x: CmeOrderflowExperimentResultDto): boolean {
    return x.real.netPnl < 0 && x.proxy.netPnl < 0;
  }

  /** Only a run whose two comparisons agree, on a profitable arm, reads as a clean win. */
  protected verdictIsClean(x: CmeOrderflowExperimentResultDto): boolean {
    return x.oosNetPnlDelta > 0 && !this.perTradeDisagrees(x) && !this.bothArmsLose(x);
  }

  protected verdictHeadline(x: CmeOrderflowExperimentResultDto): string {
    if (this.perTradeDisagrees(x)) return 'Inconclusive — the two comparisons disagree';
    if (x.oosNetPnlDelta > 0) {
      return this.bothArmsLose(x) ? 'Real lost less than the proxy' : 'Real flow beat the proxy';
    }
    return 'Real flow did NOT beat the proxy';
  }

  // ── History charts ───────────────────────────────────────────────────────

  /**
   * Two separate panels — total PnL and per-trade PnL — each on its OWN axis.
   *
   * Never one chart with two y-scales: the measures are dollars and dollars-per-trade, so a shared
   * axis makes their relative heights arbitrary. Side by side, the panels answer the question that
   * matters: do the aggregate and per-trade views point the same way?
   */
  protected readonly chartPanels = computed<ChartPanel[]>(() => {
    const scored = this.runs()
      .filter((r) => r.ran)
      .slice(0, 8)
      .reverse();
    if (scored.length === 0) return [];

    return [
      this.buildPanel(
        'net',
        'Net PnL by run',
        'Total across all scored sessions.',
        scored,
        (r) => r.realNetPnl,
        (r) => r.proxyNetPnl,
      ),
      this.buildPanel(
        'perTrade',
        'PnL per trade by run',
        'Trade-count neutral — the comparison selectivity cannot flatter.',
        scored,
        (r) => r.realPnlPerTrade,
        (r) => r.proxyPnlPerTrade,
      ),
    ];
  });

  private buildPanel(
    key: string,
    title: string,
    caption: string,
    runs: readonly CmeExperimentRunDto[],
    real: (r: CmeExperimentRunDto) => number,
    proxy: (r: CmeExperimentRunDto) => number,
  ): ChartPanel {
    const values = runs.flatMap((r) => [real(r), proxy(r)]);

    // The domain always includes zero: these are signed PnL values, and a bar chart whose baseline
    // floats makes a loss look like a small gain.
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const span = max - min || 1;

    const pad = 6;
    const plotHeight = this.chartHeight - pad * 2;
    const yOf = (v: number) => pad + ((max - v) / span) * plotHeight;
    const zeroY = yOf(0);

    // Two bars per run, with a 2px surface gap between the pair and a wider gap between groups.
    const groupWidth = this.chartWidth / runs.length;
    const barWidth = Math.max(3, Math.min(14, groupWidth / 2 - 4));

    const bars: ChartBar[] = [];
    runs.forEach((r, i) => {
      const centre = groupWidth * i + groupWidth / 2;
      [
        { series: 'real' as const, value: real(r), offset: -barWidth - 1 },
        { series: 'proxy' as const, value: proxy(r), offset: 1 },
      ].forEach(({ series, value, offset }) => {
        const y = yOf(value);
        bars.push({
          key: `${key}-${r.id}-${series}`,
          series,
          x: centre + offset,
          width: barWidth,
          y: Math.min(y, zeroY),
          // Always at least 1px so a near-zero value is visibly present rather than absent.
          height: Math.max(1, Math.abs(zeroY - y)),
          tooltip: `${series === 'real' ? 'Real' : 'Proxy'} · ${title}: ${value.toFixed(2)} (${r.contract}, ${runs.length > 1 ? new Date(r.createdAtUtc).toLocaleDateString() : ''})`,
        });
      });
    });

    return {
      key,
      title,
      caption,
      zeroY,
      bars,
      xLabels: runs.map((r) => ({ key: `${key}-x-${r.id}`, text: `#${r.id}` })),
    };
  }

  protected feedStatusLabel(status: CmeFeedHealthDto['status']): string {
    switch (status) {
      case 'Live':
        return 'Live';
      case 'Stale':
        return 'Stale';
      default:
        return 'No data';
    }
  }

  /**
   * Says what the status *means for trading*, not just what it is. "Stale" on its own reads like a
   * fault; it is actually the freshness gate doing its job, and the operator needs to know the
   * strategy path is refusing the flow rather than silently trading on an old book.
   */
  protected feedStatusExplanation(health: CmeFeedHealthDto): string {
    switch (health.status) {
      case 'Live':
        return `Newest bar is inside the ${health.maxFlowStalenessSeconds}s freshness gate, so the strategy path will accept this flow.`;
      case 'Stale':
        return `Newest bar is older than the ${health.maxFlowStalenessSeconds}s freshness gate, so the strategy path is refusing this flow. Data exists — it is just too old to trade on.`;
      default:
        return 'Nothing ingested yet. Expected until a Databento slice is loaded or a sidecar starts streaming — not a fault.';
    }
  }

  protected formatAge(seconds: number | null): string {
    if (seconds === null) return '—';
    if (seconds < 90) return `${Math.round(seconds)}s`;
    if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
    return `${Math.round(seconds / 86400)}d`;
  }

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.cme
      .getStatus()
      .pipe(
        finalize(() => this.loading.set(false)),
        catchError((err) => {
          this.loadError.set(
            err?.error?.message ?? 'The engine returned an error. Verify it is reachable.',
          );
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res?.status && res.data) {
          this.status.set(res.data);
          this.loadError.set(null);
          // Default the experiment contract to the resolved front month.
          if (!this.expContract && res.data.frontMonthContract) {
            this.expContract = res.data.frontMonthContract;
          }
        }
      });

    this.loadRuns();
  }

  /**
   * Verdict history. Failures degrade to an empty list rather than an error banner — the history is
   * context for the panel, and losing it should not make the page look broken.
   */
  protected loadRuns(): void {
    this.cme
      .getExperimentRuns(undefined, 50)
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        if (res?.status && res.data) this.runs.set(res.data);
      });
  }

  protected seed(): void {
    this.run(
      this.cme.seedContracts({
        rootSymbol: this.seedRoot,
        spotSymbol: this.seedSpot,
        fromUtc: `${this.seedFrom}T00:00:00Z`,
        toUtc: `${this.seedTo}T00:00:00Z`,
      }),
      (n) => `Seeded ${n} contract(s).`,
    );
  }

  protected backAdjust(): void {
    this.run(this.cme.backAdjust(this.seedRoot), (n) => `Back-adjusted ${n} contract(s).`);
  }

  /** Populate the CME tables with synthetic tape/depth so the rest of this page can be exercised. */
  protected generateSynthetic(): void {
    this.busy.set(true);
    this.cme
      .generateSynthetic({
        contract: this.expContract,
        rootSymbol: this.seedRoot,
        minutes: this.synthMinutes,
        regime: this.synthRegime,
        seed: this.synthSeed,
        purgeExistingSynthetic: true,
      })
      .pipe(
        finalize(() => this.busy.set(false)),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Synthetic generation failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (res.status && res.data) {
          const d = res.data;
          this.notify.success(
            `Generated ${d.tradesWritten} trades / ${d.booksWritten} books → ${d.barsBuilt} bars (${d.regime}).`,
          );
          this.load();
        } else {
          this.notify.error(res.message ?? 'Synthetic generation failed.');
        }
      });
  }

  protected runExperiment(): void {
    this.busy.set(true);
    this.cme
      .runExperiment({
        contract: this.expContract,
        fromUtc: `${this.expFrom}T00:00:00Z`,
        toUtc: `${this.expTo}T00:00:00Z`,
        oosFolds: this.expFolds,
      })
      .pipe(
        finalize(() => this.busy.set(false)),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Experiment failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (res.status && res.data) {
          this.experiment.set(res.data);
          // The run was recorded engine-side; refresh so it appears in the history immediately.
          this.loadRuns();
          this.notify.success(
            res.data.ran ? 'Experiment complete.' : `Not scored: ${res.data.reason}`,
          );
        } else {
          this.notify.error(res.message ?? 'Experiment failed.');
        }
      });
  }

  /** Shared command runner: toast the outcome (including a meaningful "0 written") and refresh. */
  private run(
    call: import('rxjs').Observable<{
      status: boolean;
      data: number | null;
      message: string | null;
    }>,
    success: (n: number) => string,
  ): void {
    this.busy.set(true);
    call
      .pipe(
        finalize(() => this.busy.set(false)),
        catchError((err) => {
          this.notify.error(err?.error?.message ?? 'Request failed.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        if (res === null) return;
        if (res.status) {
          this.notify.success(success(res.data ?? 0));
          this.load();
        } else {
          this.notify.error(res.message ?? 'Request failed.');
        }
      });
  }

  protected dirColor(direction: string): string {
    return direction === 'Buy' ? '#34C759' : '#FF3B30';
  }
}

/** yyyy-MM-dd offset from today — for the date inputs. */
function isoDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
