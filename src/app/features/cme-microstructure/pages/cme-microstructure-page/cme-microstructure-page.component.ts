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
  yMaxLabel: string;
  yMinLabel: string;
  bars: ChartBar[];
  xLabels: { key: string; text: string; title: string }[];
}

/** A run in the history table, with identical consecutive re-runs folded into it. */
interface RunGroup {
  run: CmeExperimentRunDto;
  count: number;
  ids: number[];
}

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { CmeHistoricAnalyticsComponent } from '@features/cme-microstructure/components/cme-historic-analytics.component';
import { CmeExperimentTradesComponent } from '@features/cme-microstructure/components/cme-experiment-trades.component';
import { splitContracts } from '@features/cme-microstructure/cme-calendar.logic';
import { runVerdict, signedUsd } from '@features/cme-microstructure/cme-verdict.logic';

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
    ConfirmDialogComponent,
    RefreshButtonComponent,
    RelativeTimePipe,
    CmeHistoricAnalyticsComponent,
    CmeExperimentTradesComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CME Microstructure"
        subtitle="Real futures tape + depth bridged to spot — gated on the real-vs-proxy experiment (ADR-0021/0022)"
      >
        <app-refresh-button [refreshing]="loading()" (refresh)="load()" />
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
        <!-- Headline: the subsystem's state in one line, read before the zero-filled tiles. The
             hot tier, the imported (warm) tier and the newest recorded verdict answer different
             questions, and each one alone has misled an operator. -->
        <section class="headline" aria-label="CME subsystem summary">
          <span class="hl-item">
            <span class="hl-label">Live feed</span>
            <span
              class="dot"
              [class.ok]="s.feedHealth.status === 'Live'"
              [class.warn]="s.feedHealth.status === 'Stale'"
            >
              <strong>{{ feedStatusLabel(s.feedHealth.status) }}</strong>
            </span>
          </span>
          <span class="hl-item">
            <span class="hl-label">Imported history</span>
            @if (s.warmTier.sessionCount > 0) {
              <span class="dot ok">
                <strong>{{ s.warmTier.sessionCount | number }} sessions</strong>
                <span>· {{ s.warmTier.contracts.join(', ') }}</span>
              </span>
            } @else {
              <span class="dot">
                <strong>{{ s.warmTier.configured ? 'Empty' : 'Not configured' }}</strong>
              </span>
            }
          </span>
          <span class="hl-item">
            <span class="hl-label">Latest verdict</span>
            @if (latestRun(); as lr) {
              @let lv = runVerdict(lr);
              <span class="tag" [attr.data-state]="lv.state" [title]="lv.title">
                <span aria-hidden="true">{{ lv.icon }}</span> {{ lv.label }}
              </span>
              <span class="muted small">#{{ lr.id }} · {{ lr.contract }}</span>
            } @else {
              <span class="muted">none recorded</span>
            }
          </span>
          <span class="hl-item">
            <span class="hl-label">Workers</span>
            <span class="dot" [class.ok]="s.feedHealth.ingestEnabled">
              ingest {{ s.feedHealth.ingestEnabled ? 'on' : 'off' }}
            </span>
            <span class="dot" [class.ok]="s.feedHealth.shadowMonitorEnabled">
              shadow monitor {{ s.feedHealth.shadowMonitorEnabled ? 'on' : 'off' }}
            </span>
          </span>
        </section>

        <!-- Hot-tier counts. No status dots: these are inventory numbers, not health signals —
             a zero here is expected after a bulk import (see the warm-tier callout). -->
        <section class="kpis">
          <app-metric-card label="Contracts seeded" [value]="s.contractCount" format="number" />
          <app-metric-card
            label="Trades ingested (hot tier)"
            [value]="s.tradeCount"
            format="number"
          />
          <app-metric-card
            label="Book snapshots (hot tier)"
            [value]="s.bookSnapshotCount"
            format="number"
          />
          <app-metric-card label="Derived bars (hot tier)" [value]="s.barCount" format="number" />
          <app-metric-card
            label="Shadow would-haves"
            [value]="s.shadowSignalCount"
            format="number"
          />
        </section>

        <!--
          The hot tables are only a recent window; bulk-imported research slices live in the Parquet
          warm tier. Reporting "no data" off the hot counts alone told an operator the purchase had
          failed while 31M records sat on disk and the experiment was running against them.
        -->
        @if (s.warmTier.sessionCount) {
          <section class="banner" data-tone="info">
            <strong
              >Warm tier holds {{ s.warmTier.sessionCount }} imported
              {{ s.warmTier.sessionCount === 1 ? 'session' : 'sessions' }}.</strong
            >
            {{ s.warmTier.contracts.join(', ') }} · {{ s.warmTier.earliestSession }} →
            {{ s.warmTier.latestSession }}. Raw tape and book live in Parquet (the system of
            record); the hot tables above hold only the recent window the retention worker keeps, so
            a zero there is expected after a bulk import — the experiment reads both tiers.
          </section>
        } @else if (!hasData()) {
          <section class="banner">
            <strong>No CME data ingested yet.</strong>
            The subsystem ships disabled and inert: it needs a Databento slice plus
            <code>Microstructure:Enabled=true</code> and an API key. Seeding the contract calendar
            below is the prerequisite that makes the futures→spot resolver return anything.
          </section>
        }

        <!-- ── Feed health ───────────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <div class="title-row">
              <h3>Feed health</h3>
              <span class="feed-pill" [attr.data-status]="s.feedHealth.status">
                {{ feedStatusLabel(s.feedHealth.status) }}
              </span>
            </div>
            <span class="muted small">Live hot-tier stream over the last 24 hours</span>
          </header>

          <p class="muted small">{{ feedStatusExplanation(s.feedHealth) }}</p>

          <div class="health-grid">
            <div class="health-cell">
              <span class="hc-label">Newest bar age</span>
              <span class="hc-value">{{ formatAge(s.feedHealth.latestBarAgeSeconds) }}</span>
              <span class="hc-sub">freshness gate {{ s.feedHealth.maxFlowStalenessSeconds }}s</span>
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
              <span class="hc-value dot" [class.ok]="s.feedHealth.ingestEnabled">{{
                s.feedHealth.ingestEnabled ? 'On' : 'Off'
              }}</span>
            </div>
            <div class="health-cell">
              <span class="hc-label">Shadow monitor</span>
              <span class="hc-value dot" [class.ok]="s.feedHealth.shadowMonitorEnabled">{{
                s.feedHealth.shadowMonitorEnabled ? 'On' : 'Off'
              }}</span>
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
            <p class="empty-line">
              <strong>No active model uses the V11 CME feature block yet.</strong> This is the
              expected state until a training run completes with
              <code>MLTraining:UseV11CmeFlow</code> on — it is not a fault, and models on earlier
              schemas keep serving normally.
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
                      <td>{{ m.trainedAt ? (m.trainedAt | date: 'yyyy-MM-dd HH:mm') : '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

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
            <label class="field">
              <span>Root</span>
              <input class="input sm" placeholder="6E" [(ngModel)]="seedRoot" />
            </label>
            <label class="field">
              <span>Spot symbol</span>
              <input class="input sm" placeholder="EURUSD" [(ngModel)]="seedSpot" />
            </label>
            <label class="field">
              <span>From</span>
              <input class="input sm" type="date" [(ngModel)]="seedFrom" />
            </label>
            <label class="field">
              <span>To</span>
              <input class="input sm" type="date" [(ngModel)]="seedTo" />
            </label>
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
              (click)="confirmBackAdjust.set(true)"
              title="Compute roll-gap offsets so a multi-quarter series is continuous"
            >
              Back-adjust rolls
            </button>
          </div>

          @if (s.contracts.length === 0) {
            <p class="empty-line">
              No contracts seeded — seed a root → spot mapping (e.g. 6E → EURUSD) so the
              futures→spot resolver has a chain to resolve.
            </p>
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
                    <th
                      title="Newest trade in the hot tables only. Bulk-imported sessions live in the Parquet warm tier and do not advance this column."
                    >
                      Hot tier ingested through
                    </th>
                  </tr>
                </thead>
                <tbody>
                  @for (c of shownContracts(); track c.contractCode) {
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
                        @if (c.lastTradeEventTimestamp) {
                          <span
                            [title]="
                              (c.lastTradeEventTimestamp | date: 'yyyy-MM-dd HH:mm' : 'UTC') +
                              ' UTC'
                            "
                            >{{ c.lastTradeEventTimestamp | relativeTime }}</span
                          >
                        } @else if (inWarmTier(c.contractCode)) {
                          <span
                            class="muted"
                            title="Not in the hot tables; see the warm-tier callout above"
                          >
                            warm tier only
                          </span>
                        } @else {
                          <span class="muted">nothing ingested</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            @if (split().hiddenPast + split().hiddenFuture > 0) {
              <p class="muted small footnote">
                @if (!showAllContracts()) {
                  {{ split().shown.length }} of {{ s.contracts.length }} contracts shown — those
                  with data, the front month and the ones expiring within ~6 months. Hidden:
                  {{ split().hiddenPast }} expired and {{ split().hiddenFuture }} far-dated
                  contracts with nothing ingested ({{ split().withData }} contracts hold any data).
                }
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  (click)="showAllContracts.set(!showAllContracts())"
                >
                  {{
                    showAllContracts()
                      ? 'Show only the relevant contracts'
                      : 'Show all ' + s.contracts.length
                  }}
                </button>
              </p>
            }
            @if (status()?.warmTier?.sessionCount) {
              <p class="muted small footnote">
                The warm tier is not broken down per contract by the status endpoint — use
                “Downloaded historic slice” below for per-contract session spans.
              </p>
            }
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
            <label class="field">
              <span>Contract</span>
              <input class="input sm" placeholder="6EU5" [(ngModel)]="expContract" />
            </label>
            <label class="field">
              <span>From</span>
              <input class="input sm" type="date" [(ngModel)]="expFrom" />
            </label>
            <label class="field">
              <span>To</span>
              <input class="input sm" type="date" [(ngModel)]="expTo" />
            </label>
            <label class="field">
              <span>OOS folds</span>
              <input class="input xs" type="number" min="1" max="50" [(ngModel)]="expFolds" />
            </label>
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
              <p class="empty-line">
                <strong>Not scored</strong> — <code>{{ x.reason }}</code>
                @if (x.reason === 'no_data') {
                  · ingest a Databento slice for this contract/window first.
                }
              </p>
            } @else {
              <div class="verdict" [attr.data-good]="verdictIsClean(x)">
                <div class="verdict-headline">{{ verdictHeadline(x) }}</div>
                <div class="verdict-sub muted small">
                  OOS net-PnL delta {{ x.oosNetPnlDelta | number: '1.2-2' }} USD · PF delta
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
                      <th class="num">Net PnL (USD)</th>
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
                        <td class="num">{{ arm.tradeCount | number }}</td>
                        <td class="num">{{ arm.winRate * 100 | number: '1.0-1' }}%</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          } @else {
            <p class="empty-line">
              <strong>No verdict in this session yet.</strong> Run the experiment for an ingested
              contract and window to get one.
              @if (latestRun(); as lr) {
                The newest recorded run is #{{ lr.id }} ({{ lr.contract }},
                {{ lr.createdAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC) — see Verdict history
                below.
              }
            </p>
          }
        </section>

        <!-- ── Downloaded historic slice ─────────────────────────────── -->
        <!-- Placed before the verdict history deliberately: a verdict is only worth reading once
             you know what data produced it, and this is where the tape-only sessions show up. -->
        <section class="card">
          <app-cme-historic-analytics />
        </section>

        <!-- ── Verdict history ───────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Verdict history</h3>
            <span class="muted small">
              Every recorded run, newest first in the table; the charts read left-to-right in run
              order and share the run numbers. Identical consecutive re-runs are collapsed with a ×N
              badge.
            </span>
            <details class="method">
              <summary>Why runs are recorded, and how to read a verdict</summary>
              <p>
                A verdict that exists only in one HTTP response can't be revisited or compared — and
                a decision that gates real money should be auditable long after the run.
              </p>
              <p>
                <strong>Real ahead</strong> needs both the net and the per-trade delta to favour
                real flow with at least one arm making money. <strong>Real lost less</strong> means
                both arms lost: it shows which way a losing system fails, not that real flow carries
                edge. <strong>Inconclusive</strong> means the net and per-trade comparisons point
                different ways (selectivity, not signal quality).
              </p>
            </details>
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

                  <!-- A labelled axis: max, zero and min in USD, so the bars are readable
                       without hovering. Losses hang below the zero line by construction. -->
                  <div class="plot">
                    <div class="yaxis muted small" aria-hidden="true">
                      <!-- An end that IS zero is labelled by the zero tick alone: an all-loss
                           panel drew "0" twice, one over the other, at its top. -->
                      @if (panel.yMaxLabel) {
                        <span class="ytick" [style.top.%]="0">{{ panel.yMaxLabel }}</span>
                      }
                      <span class="ytick zero" [style.top.%]="(panel.zeroY / chartHeight) * 100">
                        0
                      </span>
                      @if (panel.yMinLabel) {
                        <span class="ytick" [style.top.%]="100">{{ panel.yMinLabel }}</span>
                      }
                    </div>
                    <svg
                      class="chart-svg"
                      [attr.viewBox]="'0 0 ' + chartWidth + ' ' + chartHeight"
                      role="img"
                      [attr.aria-label]="panel.title + ' — real aggressor versus tick-rule proxy'"
                      preserveAspectRatio="none"
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
                          [attr.fill]="
                            bar.series === 'real' ? 'var(--series-real)' : 'var(--series-proxy)'
                          "
                        >
                          <title>{{ bar.tooltip }}</title>
                        </rect>
                      }
                    </svg>
                  </div>

                  <div class="chart-xaxis">
                    @for (label of panel.xLabels; track label.key) {
                      <span class="muted small" [title]="label.title">{{ label.text }}</span>
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
                    <th class="num">#</th>
                    <th>Run (UTC)</th>
                    <th>Window (UTC)</th>
                    <th class="num">Sessions</th>
                    <th class="num">Real PF</th>
                    <th class="num">Proxy PF</th>
                    <th class="num">Net Δ (USD)</th>
                    <th class="num">Per-trade Δ (USD)</th>
                    <th>Entry</th>
                    <th>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  @for (g of collapsedRuns(); track g.run.id) {
                    @let r = g.run;
                    <tr>
                      <td class="num">
                        #{{ r.id }}
                        @if (g.count > 1) {
                          <span
                            class="dup-badge"
                            [title]="
                              'Identical result recorded ' +
                              g.count +
                              ' times: runs ' +
                              g.ids.join(', ')
                            "
                            >×{{ g.count }}</span
                          >
                        }
                      </td>
                      <!-- These two may wrap: with every cell on one line the table ran past
                           the card at 1440px and the Verdict column sat half outside it. -->
                      <td class="wrap">
                        {{ r.createdAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }}
                        <span class="muted small">· {{ r.contract }}</span>
                      </td>
                      <td class="muted small wrap">
                        <span class="nw">{{ r.fromUtc | date: 'yyyy-MM-dd' : 'UTC' }} –</span>
                        <span class="nw">{{ r.toUtc | date: 'yyyy-MM-dd' : 'UTC' }}</span>
                      </td>
                      <td class="num">{{ r.foldsScored }}</td>
                      <td class="num">{{ r.realProfitFactor | number: '1.2-2' }}</td>
                      <td class="num">{{ r.proxyProfitFactor | number: '1.2-2' }}</td>
                      <td
                        class="num"
                        [class.pos]="r.ran && r.oosNetPnlDelta > 0"
                        [class.neg]="r.ran && r.oosNetPnlDelta < 0"
                      >
                        {{ signedUsd(r.oosNetPnlDelta) }}
                      </td>
                      <td
                        class="num"
                        [class.pos]="r.ran && r.oosPnlPerTradeDelta > 0"
                        [class.neg]="r.ran && r.oosPnlPerTradeDelta < 0"
                      >
                        {{ signedUsd(r.oosPnlPerTradeDelta) }}
                      </td>
                      <!-- Cost model, not signal. A crossing run and a passive run are different
                           experiments: on 6EM6 the round-trip spread was ~$12.50 against a ~$20-25
                           average trade, so execution dominated the result. -->
                      <td class="muted small">{{ r.passiveEntry ? 'Passive' : 'Crossing' }}</td>
                      <td>
                        <!-- Icon + label, never colour alone. -->
                        @let v = runVerdict(r);
                        <span class="tag" [attr.data-state]="v.state" [title]="v.title">
                          <span aria-hidden="true">{{ v.icon }}</span> {{ v.label }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <!-- ── Trades behind the verdict ─────────────────────────────── -->
        @if (runs().length > 0) {
          <section class="card">
            <app-cme-experiment-trades [runId]="tradeRunId()">
              <label class="field" runPicker>
                <span>Inspect run</span>
                <select
                  id="trade-run"
                  class="input select-wide"
                  [ngModel]="tradeRunId()"
                  (ngModelChange)="tradeRunId.set(+$event)"
                >
                  @for (r of runs(); track r.id) {
                    <option [value]="r.id">
                      #{{ r.id }} · {{ r.contract }} ·
                      {{ r.createdAtUtc | date: 'yyyy-MM-dd HH:mm' : 'UTC' }}
                    </option>
                  }
                </select>
              </label>
            </app-cme-experiment-trades>
          </section>
        }

        <!-- ── Simulator (pre-purchase pipeline validation) ──────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Simulator — synthetic tape &amp; depth</h3>
            <span class="muted small">
              Exercises the pipeline before a real slice exists. <strong>NoEdge</strong> is the
              negative control (the experiment must find nothing);
              <strong>DeltaLeadsPrice</strong> plants a lead-lag it must detect. Synthetic data
              validates the pipeline and the harness — it can never prove a real edge. Rows are
              stamped <code>Source=Synthetic</code>; real data is never touched.
            </span>
          </header>

          <div class="toolbar">
            <label class="field">
              <span>Regime</span>
              <select class="input select-wide" [(ngModel)]="synthRegime">
                <option value="NoEdge">NoEdge (control)</option>
                <option value="DeltaLeadsPrice">DeltaLeadsPrice (planted edge)</option>
              </select>
            </label>
            <label class="field">
              <span>Minutes</span>
              <input class="input xs" type="number" min="1" [(ngModel)]="synthMinutes" />
            </label>
            <label class="field">
              <span>Seed</span>
              <input class="input md" type="number" [(ngModel)]="synthSeed" />
            </label>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="busy() || !expContract"
              (click)="generateSynthetic()"
            >
              Generate synthetic data
            </button>
            <span class="muted small toolbar-note"
              >into {{ expContract || 'set a contract above' }}</span
            >
          </div>
        </section>

        <!-- ── Shadow monitor ────────────────────────────────────────── -->
        <section class="card">
          <header class="card-head">
            <h3>Shadow monitor — would-have signals</h3>
            <span class="muted small">
              Recorded, never traded — research only. The CmeDeepBookOrderflow strategy type is
              retired (2026-09-30); a CME-flow strategy would be a Pine script with its own data
              access.
            </span>
          </header>

          @if (s.recentShadowSignals.length === 0) {
            <p class="empty-line">
              <strong>No shadow signals yet.</strong> The monitor ships disabled
              (<code>Microstructure:SignalEnabled=false</code>) and needs live CME flow.
            </p>
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
                        <span class="side-dot" [style.background]="dirColor(sig.direction)"></span>
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

      <!-- Back-adjust is a Command: it overwrites the stored roll offsets of the whole chain, which
           every continuous-series read (and so the experiment) goes through. One click used to run it. -->
      <app-confirm-dialog
        [open]="confirmBackAdjust()"
        title="Back-adjust the rolls?"
        [message]="
          'Recomputes the roll-gap offset of every ' +
          seedRoot +
          ' contract from the derived bars around each roll and overwrites the stored offsets. A roll with no bars on both sides (none ingested, or pruned from the hot tier) keeps the gap stored for it.'
        "
        confirmLabel="Back-adjust"
        [loading]="busy()"
        (confirm)="confirmBackAdjust.set(false); backAdjust()"
        (cancelled)="confirmBackAdjust.set(false)"
      />
    </div>
  `,
  styleUrl: './cme-microstructure-page.component.scss',
})
export class CmeMicrostructurePageComponent {
  private readonly cme = inject(CmeMicrostructureService);
  private readonly notify = inject(NotificationService);

  protected readonly status = signal<CmeStatusDto | null>(null);
  protected readonly experiment = signal<CmeOrderflowExperimentResultDto | null>(null);
  protected readonly runs = signal<readonly CmeExperimentRunDto[]>([]);

  /**
   * Run whose trades are being inspected. Set when the run list loads (newest first, so it defaults
   * to the most recent verdict) and thereafter driven by the operator's selection.
   */
  protected readonly tradeRunId = signal<number | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  /** The back-adjust confirm is open. */
  protected readonly confirmBackAdjust = signal(false);
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
  protected readonly showAllContracts = signal(false);
  protected readonly split = computed(() =>
    splitContracts(
      this.status()?.contracts ?? [],
      new Set(this.status()?.warmTier?.contracts ?? []),
      Date.now(),
    ),
  );
  protected readonly shownContracts = computed(() =>
    this.showAllContracts() ? (this.status()?.contracts ?? []) : this.split().shown,
  );

  /** Whether the warm tier lists this contract — the status endpoint has no per-contract span. */
  protected inWarmTier(contractCode: string): boolean {
    return (this.status()?.warmTier?.contracts ?? []).includes(contractCode);
  }

  /**
   * Identical consecutive runs (same contract, window, folds and every reported number) are one
   * result recorded N times, not N results. Folding them keeps the table and both charts honest
   * about how much independent evidence exists.
   */
  protected readonly collapsedRuns = computed<RunGroup[]>(() => {
    const groups: RunGroup[] = [];
    for (const r of this.runs()) {
      const last = groups[groups.length - 1];
      if (last && this.sameResult(last.run, r)) {
        last.count++;
        last.ids.push(r.id);
      } else {
        groups.push({ run: r, count: 1, ids: [r.id] });
      }
    }
    return groups;
  });

  /** Newest recorded run — the headline's "latest verdict". */
  protected readonly latestRun = computed<CmeExperimentRunDto | null>(() => this.runs()[0] ?? null);

  protected readonly runVerdict = runVerdict;
  protected readonly signedUsd = signedUsd;

  private sameResult(a: CmeExperimentRunDto, b: CmeExperimentRunDto): boolean {
    return (
      a.contract === b.contract &&
      a.fromUtc === b.fromUtc &&
      a.toUtc === b.toUtc &&
      a.ran === b.ran &&
      a.reason === b.reason &&
      a.foldsScored === b.foldsScored &&
      a.eventsLoaded === b.eventsLoaded &&
      a.passiveEntry === b.passiveEntry &&
      a.realNetPnl === b.realNetPnl &&
      a.proxyNetPnl === b.proxyNetPnl &&
      a.realTradeCount === b.realTradeCount &&
      a.proxyTradeCount === b.proxyTradeCount &&
      a.realProfitFactor === b.realProfitFactor &&
      a.proxyProfitFactor === b.proxyProfitFactor
    );
  }

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
    // Same collapsed list as the table, so a ×3 row is one group of bars, not three.
    const scored = this.collapsedRuns()
      .map((g) => g.run)
      .filter((r) => r.ran)
      .slice(0, 8)
      .reverse();
    if (scored.length === 0) return [];

    return [
      this.buildPanel(
        'net',
        'Net PnL by run (USD)',
        'Total across all scored sessions.',
        scored,
        (r) => r.realNetPnl,
        (r) => r.proxyNetPnl,
      ),
      this.buildPanel(
        'perTrade',
        'PnL per trade by run (USD)',
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
          tooltip: `${series === 'real' ? 'Real' : 'Proxy'} · ${title}: ${value.toFixed(2)} USD (#${r.id}, ${r.contract}, ${r.createdAtUtc.slice(0, 10)})`,
        });
      });
    });

    const usd = (v: number) =>
      v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

    return {
      key,
      title,
      caption,
      zeroY,
      yMaxLabel: max > 0 ? `+${usd(max)}` : '',
      yMinLabel: min < 0 ? `−${usd(Math.abs(min))}` : '',
      bars,
      xLabels: runs.map((r) => ({
        key: `${key}-x-${r.id}`,
        text: `#${r.id}`,
        title: `Run #${r.id} · ${r.contract} · ${r.createdAtUtc.slice(0, 16).replace('T', ' ')} UTC`,
      })),
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
   * Says what the status *means*, not just what it is. "Stale" on its own reads like a fault; it is
   * actually the freshness gate doing its job, and the operator needs to know the shadow monitor
   * (the gate's only consumer since the CmeDeepBookOrderflow strategy type was retired) is refusing
   * the flow rather than silently deciding on an old book.
   */
  protected feedStatusExplanation(health: CmeFeedHealthDto): string {
    switch (health.status) {
      case 'Live':
        return `Newest bar is inside the ${health.maxFlowStalenessSeconds}s freshness gate, so the shadow monitor will accept this flow.`;
      case 'Stale':
        return `Newest bar is older than the ${health.maxFlowStalenessSeconds}s freshness gate, so the shadow monitor is refusing this flow. Data exists — it is just too old to decide on.`;
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
          this.defaultExperimentWindow(res.data);
        }
      });

    this.loadRuns();
  }

  /** Set once; a background refresh must not overwrite dates the operator has typed. */
  private expWindowDefaulted = false;

  /**
   * The experiment window defaults to the ingested data, ending on the newest imported session
   * rather than today: a window that runs past the data silently scores nothing at its tail.
   */
  private defaultExperimentWindow(s: CmeStatusDto): void {
    if (this.expWindowDefaulted) return;
    const latest = toIsoDate(s.warmTier?.latestSession ?? s.latestBarUtc);
    if (!latest) return;
    const earliest = toIsoDate(s.warmTier?.earliestSession);
    const ninetyBack = shiftIsoDate(latest, -90);
    this.expTo = latest;
    this.expFrom = earliest && earliest > ninetyBack ? earliest : ninetyBack;
    this.expWindowDefaulted = true;
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
        if (res?.status && res.data) {
          this.runs.set(res.data);
          // Default to the newest run, but never override a selection the operator has already
          // made — a background refresh must not yank them to a different run mid-read.
          if (this.tradeRunId() === null && res.data.length > 0) {
            this.tradeRunId.set(res.data[0].id);
          }
        }
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
      (n) => `Seeded ${n} ${n === 1 ? 'contract' : 'contracts'}.`,
    );
  }

  protected backAdjust(): void {
    this.run(
      this.cme.backAdjust(this.seedRoot),
      (n) => `Back-adjusted ${n} ${n === 1 ? 'contract' : 'contracts'}.`,
    );
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

/** First ten characters of anything that starts like an ISO date, else null. */
function toIsoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
