import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, map, of, switchMap } from 'rxjs';
import type { EChartsOption, LineSeriesOption, SeriesOption } from 'echarts';
import type { ColDef } from 'ag-grid-community';

import {
  DrawdownRecoveryService,
  type AccountRecoveryStateDto,
} from '@core/services/drawdown-recovery.service';
import { ConfigService } from '@core/services/config.service';
import type { DrawdownSnapshotDto, RecoveryMode } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import {
  ChartAnnotationsService,
  type ChartAnnotationDto,
} from '@core/annotations/chart-annotations.service';
import { FeatureFlagsService } from '@core/feature-flags/feature-flags.service';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';

import {
  formatDuration,
  formatElapsed,
  gaugeMax,
  groupByMode,
  plural,
  type Elapsed,
} from './drawdown-format';

const MODES: RecoveryMode[] = ['Normal', 'Reduced', 'Halted'];

const MODE_LABEL: Record<RecoveryMode, string> = {
  Normal: 'Normal',
  Reduced: 'Reduced',
  Halted: 'Halted',
};

const MODE_COLOR: Record<RecoveryMode, string> = {
  Normal: '#34C759',
  Reduced: '#FF9500',
  Halted: '#FF3B30',
};

/** One colour per account line; mode colours are reserved for mode semantics. */
const ACCOUNT_PALETTE = [
  '#0A84FF',
  '#AF52DE',
  '#5AC8FA',
  '#FFCC00',
  '#30D158',
  '#FF6482',
  '#8E8E93',
];

/** Single date/time format for the whole page (hero, tables, tooltips, axis). */
const DATE_FMT = 'd MMM yyyy, HH:mm';

/** Page cap on the Live analytics window — the engine has no downsampling. */
const ANALYTICS_ROW_CAP = 5000;

/** Engine defaults from RiskCheckerOptions; overridden by EngineConfig rows when present. */
const DEFAULT_REDUCED_PCT = 10;
const DEFAULT_HALTED_PCT = 20;

/**
 * The engine's snapshot row carries the owning account (0 on synthesized aggregates);
 * the shared DTO type predates that field, so it is widened locally rather than read
 * through `any`.
 */
type SnapshotRow = DrawdownSnapshotDto & { tradingAccountId?: number };

interface ModeTransition {
  accountId: number;
  at: string;
  from: RecoveryMode;
  to: RecoveryMode;
  drawdownPct: number;
}

type ModeSeconds = Record<RecoveryMode, number>;

const DAY_MS = 24 * 60 * 60 * 1000;

function accountOf(row: SnapshotRow): number {
  return row.tradingAccountId ?? 0;
}

/**
 * Snapshots for several accounts arrive interleaved on one timeline. Every
 * walk that compares neighbouring rows (transitions, dwell time, time-in-mode)
 * has to run inside one account's series, or it reads a Normal row from
 * account A followed by a Reduced row from account B as a mode flip.
 */
function groupByAccount(rows: SnapshotRow[]): Map<number, SnapshotRow[]> {
  const out = new Map<number, SnapshotRow[]>();
  for (const r of rows) {
    const id = accountOf(r);
    const list = out.get(id);
    if (list) list.push(r);
    else out.set(id, [r]);
  }
  for (const list of out.values()) {
    list.sort((a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime());
  }
  return out;
}

function transitionsOf(accountId: number, rows: SnapshotRow[]): ModeTransition[] {
  const out: ModeTransition[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].recoveryMode !== rows[i - 1].recoveryMode) {
      out.push({
        accountId,
        at: rows[i].recordedAt,
        from: rows[i - 1].recoveryMode,
        to: rows[i].recoveryMode,
        drawdownPct: rows[i].drawdownPct,
      });
    }
  }
  return out;
}

/** Seconds per mode; each gap is attributed to the mode of the earlier row. */
function dwellOf(rows: SnapshotRow[]): ModeSeconds {
  const out: ModeSeconds = { Normal: 0, Reduced: 0, Halted: 0 };
  for (let i = 1; i < rows.length; i++) {
    const dt =
      (new Date(rows[i].recordedAt).getTime() - new Date(rows[i - 1].recordedAt).getTime()) / 1000;
    // A gap longer than a week is a recording outage, not time spent in a mode.
    if (dt > 0 && dt < 7 * 24 * 3600) out[rows[i - 1].recoveryMode] += dt;
  }
  return out;
}

function totalSeconds(b: ModeSeconds): number {
  return b.Normal + b.Reduced + b.Halted;
}

function formatSeconds(secs: number): string {
  return formatDuration(secs * 1000);
}

function formatStamp(iso: string | number | Date): string {
  return formatDate(iso, DATE_FMT, 'en-US');
}

function emptyChart(text: string): EChartsOption {
  return {
    title: {
      text,
      left: 'center',
      top: 'middle',
      textStyle: { fontSize: 12, color: '#8E8E93', fontWeight: 'normal' },
    },
  };
}

@Component({
  selector: 'app-drawdown-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    TabsComponent,
    ChartCardComponent,
    DataTableComponent,
    DatePipe,
    DecimalPipe,
    CurrencyPipe,
    ModalA11yDirective,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Drawdown Recovery"
        subtitle="Real-time drawdown and recovery-mode monitoring"
      />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab" />

      <!--
        A restricted account is invisible on the Live tab — that view aggregates,
        so one halted account among six reads as a fleet in "Reduced". Surface it
        on every tab, with the route to act on it.
      -->
      <!-- Active and inactive accounts are told apart: an inactive account does not trade at all,
           so counting its stale halt among "not trading normally" made 8 of 5 live accounts. -->
      @if (restrictedAccounts().length > 0 && activeTab() !== 'accounts') {
        <!-- Grouped by mode (Halted first) so the list reads as a status, not a run-on line. -->
        <button
          type="button"
          class="restricted-banner"
          [class.has-halt]="restrictedActiveHalted()"
          (click)="activeTab.set('accounts')"
        >
          <span class="rb-head">
            @if (restrictedActive().length > 0) {
              {{ plural(restrictedActive().length, 'active account') }}
              {{ restrictedActive().length === 1 ? 'is' : 'are' }} not trading normally
            } @else {
              No active account is restricted ·
              {{ plural(restrictedInactive().length, 'inactive account') }} still
              {{ restrictedInactive().length === 1 ? 'holds' : 'hold' }} a restriction
            }
          </span>
          <span class="rb-go">Review on Accounts →</span>
          @if (restrictedActive().length > 0) {
            <span class="rb-groups">
              @for (g of restrictedActiveGroups(); track g.mode) {
                <span class="rb-group">
                  <span class="mode-badge" [attr.data-mode]="g.mode">{{ g.mode }}</span>
                  @for (a of g.items; track a.tradingAccountId) {
                    <span class="rb-acct"
                      >{{ a.accountName }}
                      <span class="rb-id">#{{ a.tradingAccountId }}</span></span
                    >
                  }
                </span>
              }
            </span>
          }
          @if (restrictedInactive().length > 0) {
            @if (restrictedActive().length > 0) {
              <span class="rb-sub"
                >{{ plural(restrictedInactive().length, 'inactive account') }} still
                {{ restrictedInactive().length === 1 ? 'holds' : 'hold' }} a restriction · not
                trading</span
              >
            }
            <span class="rb-groups inactive">
              @for (g of restrictedInactiveGroups(); track g.mode) {
                <span class="rb-group">
                  <span class="mode-badge" [attr.data-mode]="g.mode">{{ g.mode }}</span>
                  @for (a of g.items; track a.tradingAccountId) {
                    <span class="rb-acct"
                      >{{ a.accountName }}
                      <span class="rb-id">#{{ a.tradingAccountId }}</span></span
                    >
                  }
                </span>
              }
            </span>
          }
        </button>
      }

      @if (activeTab() === 'accounts') {
        @if (accountsLoading()) {
          <app-card-skeleton [lines]="6" />
        } @else {
          @if (releaseNote(); as note) {
            <p class="release-note">{{ note }}</p>
          }
          @if (releaseError(); as err) {
            <p class="release-error">{{ err }}</p>
          }

          <section class="panel accounts-card">
            <header class="card-head accounts-head">
              <h3>Recovery mode by account</h3>
              <span class="accounts-summary">
                @for (c of accountModeCounts(); track c.mode) {
                  <span class="mode-badge" [attr.data-mode]="c.mode"
                    >{{ c.count }} {{ c.mode }}</span
                  >
                }
              </span>
              @if (hiddenAccountCount() > 0) {
                <label class="toggle-inactive">
                  <input
                    type="checkbox"
                    [ngModel]="showInactiveAccounts()"
                    (ngModelChange)="showInactiveAccounts.set($event)"
                  />
                  Show {{ hiddenAccountCount() }} inactive / never-evaluated
                </label>
              }
            </header>
            <p class="t-source">
              Mode is read from the <code>DrawdownRecovery:ActiveMode</code> rows the risk checker
              enforces — not inferred — so what is shown here is what the engine applies. Releasing
              rebases the anchor to current equity; the all-time high-water mark is kept, so
              historical drawdown stays reportable.
            </p>

            <table class="trans-table accounts-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Mode</th>
                  <th class="num">Drawdown</th>
                  <th class="num">Equity</th>
                  <th class="num">Anchor peak</th>
                  <th>Last recorded</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (a of visibleAccounts(); track a.tradingAccountId) {
                  <tr
                    [class.row-restricted]="a.isRestricted"
                    [class.row-halted]="a.recoveryMode === 'Halted'"
                  >
                    <td>
                      <span class="acct-name">{{ a.accountName }}</span>
                      <span class="acct-meta"
                        >#{{ a.tradingAccountId }} · {{ a.accountNumber }}</span
                      >
                      @if (!a.isActive) {
                        <span class="chip-inactive">inactive</span>
                      }
                    </td>
                    <td>
                      <span class="mode-badge" [attr.data-mode]="a.recoveryMode">
                        {{ a.recoveryMode }}
                      </span>
                      <!--
                        Published mode vs last-evaluated mode. They normally agree; a
                        divergence means the row the engine enforces is stale, which is
                        worth seeing rather than quietly preferring one of them.
                      -->
                      @if (a.snapshotMode && a.snapshotMode !== a.recoveryMode) {
                        <span
                          class="mode-stale"
                          [title]="'Newest snapshot recorded ' + a.snapshotMode"
                        >
                          snapshot: {{ a.snapshotMode }}
                        </span>
                      }
                    </td>
                    <td class="num" [class.bad]="a.isRestricted">
                      {{ a.drawdownPct !== null ? (a.drawdownPct | number: '1.2-2') + '%' : '—' }}
                    </td>
                    <td class="num">
                      {{ a.currentEquity !== null ? (a.currentEquity | number: '1.2-2') : '—' }}
                    </td>
                    <td class="num">
                      {{ a.peakEquity !== null ? (a.peakEquity | number: '1.2-2') : '—' }}
                    </td>
                    <td class="muted last-rec">
                      {{ a.recordedAtUtc ? (a.recordedAtUtc | date: dateFmt) : 'never' }}
                      @if (a.peakRebasedAtUtc) {
                        <span
                          class="rebased"
                          [title]="a.peakRebaseReason ?? 'Anchor previously rebased'"
                        >
                          Anchor rebased {{ a.peakRebasedAtUtc | date: dateFmt }}
                        </span>
                      }
                    </td>
                    <td class="num">
                      @if (a.isRestricted) {
                        <button
                          type="button"
                          class="release-btn"
                          (click)="askRelease(a)"
                          [disabled]="releasing() === a.tradingAccountId"
                        >
                          {{
                            releasing() === a.tradingAccountId ? 'Releasing…' : 'Release to Normal'
                          }}
                        </button>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="7" class="muted">No trading accounts.</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }

      @if (activeTab() === 'live') {
        @if (loading()) {
          <app-card-skeleton [lines]="6" />
        } @else if (liveError()) {
          <!-- A failed fetch is not "no data": the empty state below is
               reserved for an engine that answered with no snapshot. -->
          <app-error-state
            title="Could not load the latest drawdown snapshot"
            message="Engine returned an error from /drawdown-recovery/latest. The tiles will fill in once it answers."
            (retry)="retryLive()"
          />
        } @else if (snapshot()) {
          @if (snapshot(); as s) {
            <div class="scope-row">
              <label class="scope-select">
                <span class="lbl-up">Account</span>
                <select [ngModel]="liveAccountId()" (ngModelChange)="selectLiveAccount($event)">
                  <option [ngValue]="null">All accounts (aggregate)</option>
                  @for (a of accounts(); track a.tradingAccountId) {
                    <option [ngValue]="a.tradingAccountId">
                      {{ a.accountName }} · #{{ a.tradingAccountId }}
                    </option>
                  }
                </select>
              </label>
              @if (windowCoverage(); as w) {
                <span class="muted window-note">
                  Analytics window: most recent {{ w.label }} · {{ w.rows | number }} snapshots
                  across {{ w.accounts }} account{{ w.accounts === 1 ? '' : 's' }}
                  @if (w.capped) {
                    ·
                    <span class="capped"
                      >{{ rowCap | number }}-snapshot cap reached, older history not loaded</span
                    >
                  }
                </span>
              }
            </div>

            <div class="hero-section">
              <div class="hero-gauge">
                <app-chart-card [options]="gaugeOptions()" height="200px" />
                <!-- The zones in words: colour alone does not say where a mode starts. -->
                <ul class="gauge-zones" aria-label="Recovery thresholds">
                  <li [class.on]="s.recoveryMode === 'Normal'">
                    <i style="background: #34c759"></i>Normal &lt;
                    {{ reducedPct() | number: '1.0-2' }}%
                  </li>
                  <li [class.on]="s.recoveryMode === 'Reduced'">
                    <i style="background: #ff9500"></i>Reduced
                    {{ reducedPct() | number: '1.0-2' }}–{{ haltedPct() | number: '1.0-2' }}%
                  </li>
                  <li [class.on]="s.recoveryMode === 'Halted'">
                    <i style="background: #ff3b30"></i>Halted ≥ {{ haltedPct() | number: '1.0-2' }}%
                  </li>
                </ul>
              </div>
              <div class="hero-info">
                <div class="recovery-badge-row">
                  <span class="lbl-up">Recovery mode</span>
                  <span class="recovery-badge" [class]="s.recoveryMode.toLowerCase()">
                    {{ modeLabel(s.recoveryMode) }}
                  </span>
                  @if (liveAccountId() === null && accounts().length > 1) {
                    <span class="muted">worst mode across the fleet</span>
                  }
                </div>
                <div class="equity-comparison">
                  <div class="equity-item">
                    <span class="lbl-up">Peak equity</span>
                    <span class="equity-value peak">{{
                      s.peakEquity | currency: 'USD' : 'symbol' : '1.2-2'
                    }}</span>
                  </div>
                  <div class="equity-divider"><span aria-hidden="true">→</span></div>
                  <div class="equity-item">
                    <span class="lbl-up">Current equity</span>
                    <span class="equity-value">{{
                      s.currentEquity | currency: 'USD' : 'symbol' : '1.2-2'
                    }}</span>
                  </div>
                  <div class="equity-item delta">
                    <span class="lbl-up">Drawdown amount</span>
                    <span class="equity-value" [class.loss]="drawdownAmount() < 0">{{
                      drawdownAmount() | currency: 'USD' : 'symbol' : '1.2-2'
                    }}</span>
                  </div>
                </div>
                <div class="meta-row">
                  <span>{{ liveScopeNote() }}</span>
                  <span aria-hidden="true">·</span>
                  <span>Recorded {{ s.recordedAt | date: dateFmt }} (local time)</span>
                </div>
              </div>
            </div>

            <!-- 6-tile KPI strip — every figure is computed inside one account's series -->
            <div class="kpis">
              <!-- Each caption says what the figure is measured over: the aggregate's current
                   drawdown (summed equity) and the worst single-account reading are different
                   quantities and read as a contradiction when unlabelled. -->
              <app-metric-card
                label="Current drawdown"
                [value]="s.drawdownPct"
                format="percent"
                [colorByValue]="true"
                [invertColor]="true"
                [dotColor]="ddColor(s.drawdownPct)"
                [caption]="
                  liveAccountId() === null ? 'Fleet equity vs fleet peak' : 'Equity vs anchor peak'
                "
              />
              <app-metric-card
                label="Worst account drawdown in window"
                [value]="maxDdInWindow()"
                format="percent"
                [dotColor]="ddColor(maxDdInWindow())"
                [caption]="worstDdCaption()"
              />
              <app-metric-card
                label="Time since anchor peak"
                [value]="null"
                [displayValue]="sincePeakLabel()"
                [dotColor]="sincePeak() === null ? '#34C759' : '#FF9500'"
                [caption]="sincePeakCaption()"
              />
              <app-metric-card
                label="Time in {{ s.recoveryMode }}"
                [value]="null"
                [displayValue]="timeInModeLabel()"
                [dotColor]="modeColorFor(s.recoveryMode)"
                [caption]="timeInModeCaption()"
              />
              <app-metric-card
                label="Mode transitions in window"
                [value]="modeTransitions().length"
                format="number"
                [dotColor]="modeTransitions().length > 5 ? '#FF9500' : '#34C759'"
                [caption]="
                  modeTransitions().length === 0 ? 'No mode changes' : 'Per account, see below'
                "
              />
              <app-metric-card
                label="Active accounts restricted"
                [value]="restrictedActive().length"
                format="number"
                [dotColor]="restrictedActive().length > 0 ? '#FF3B30' : '#34C759'"
                [caption]="'of ' + plural(accounts().length, 'active account')"
              />
            </div>

            <div class="chart-row">
              <app-chart-card
                title="Drawdown — loaded window"
                [subtitle]="liveChartSubtitle()"
                [options]="liveSparklineOptions()"
                height="240px"
              />
              <app-chart-card
                title="Mode dwell time"
                subtitle="Share of the loaded window each account spent in each mode"
                [options]="liveDwellOptions()"
                [height]="liveDwellHeight()"
              />
            </div>

            <!-- Threshold reference + recent mode transitions -->
            <div class="info-row">
              <section class="panel threshold-card">
                <header class="card-head">
                  <h3>Recovery thresholds</h3>
                  <span class="card-sub">When the engine throttles back</span>
                </header>
                <table class="trans-table">
                  <thead>
                    <tr>
                      <th>Mode</th>
                      <th>Drawdown</th>
                      <th>What the engine does</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr [class.active]="s.recoveryMode === 'Normal'">
                      <td class="t-mode">
                        <span class="t-dot" style="background: #34c759"></span>Normal
                      </td>
                      <td class="t-range">&lt; {{ reducedPct() | number: '1.0-2' }}%</td>
                      <td>
                        Full size · all strategies trading
                        @if (s.recoveryMode === 'Normal') {
                          <span class="t-now">now</span>
                        }
                      </td>
                    </tr>
                    <tr [class.active]="s.recoveryMode === 'Reduced'">
                      <td class="t-mode">
                        <span class="t-dot" style="background: #ff9500"></span>Reduced
                      </td>
                      <td class="t-range">
                        {{ reducedPct() | number: '1.0-2' }}–{{ haltedPct() | number: '1.0-2' }}%
                      </td>
                      <td>
                        Lot sizes scaled down · risk controls tighten
                        @if (s.recoveryMode === 'Reduced') {
                          <span class="t-now">now</span>
                        }
                      </td>
                    </tr>
                    <tr [class.active]="s.recoveryMode === 'Halted'">
                      <td class="t-mode">
                        <span class="t-dot" style="background: #ff3b30"></span>Halted
                      </td>
                      <td class="t-range">≥ {{ haltedPct() | number: '1.0-2' }}%</td>
                      <td>
                        No new positions · existing positions managed
                        @if (s.recoveryMode === 'Halted') {
                          <span class="t-now">now</span>
                        }
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p class="t-source">
                  @if (thresholdsFromEngine()) {
                    Live values from <code>RiskCheckerOptions:ReducedDrawdownPct</code> /
                    <code>HaltedDrawdownPct</code>.
                  } @else {
                    Engine defaults — no <code>RiskCheckerOptions:*DrawdownPct</code> override is
                    set.
                  }
                </p>
                <details class="method">
                  <summary>Why an account can sit above a threshold in a lower mode</summary>
                  <p>
                    A mode is assigned per account when its snapshot is recorded, and an operator
                    release rebases the anchor without changing the all-time peak — so an account
                    can sit above a threshold in a lower mode until its next evaluation.
                  </p>
                </details>
              </section>

              <section class="panel trans-card">
                <header class="card-head">
                  <h3>Recent mode transitions</h3>
                  <span class="card-sub"
                    >{{ modeTransitions().length | number }} in the window, per account</span
                  >
                </header>
                @if (modeTransitions().length > 0) {
                  <div class="trans-scroll">
                    <table class="trans-table">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Account</th>
                          <th>From</th>
                          <th></th>
                          <th>To</th>
                          <th class="num">DD %</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (t of recentTransitions(); track t.accountId + t.at) {
                          <tr>
                            <td class="mono muted">{{ t.at | date: dateFmt }}</td>
                            <td class="acct-cell">{{ accountLabel(t.accountId) }}</td>
                            <td>
                              <span class="mode-pill" [attr.data-mode]="t.from">{{ t.from }}</span>
                            </td>
                            <td class="muted">→</td>
                            <td>
                              <span class="mode-pill" [attr.data-mode]="t.to">{{ t.to }}</span>
                            </td>
                            <td
                              class="num mono"
                              [class.warn]="
                                t.drawdownPct >= reducedPct() && t.drawdownPct < haltedPct()
                              "
                              [class.bad]="t.drawdownPct >= haltedPct()"
                            >
                              {{ t.drawdownPct | number: '1.2-2' }}%
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                } @else {
                  <span class="empty">
                    <strong>No mode transitions in the window</strong>
                    Every account stayed in one mode.
                  </span>
                }
              </section>
            </div>
          }
        } @else {
          <app-empty-state
            title="No drawdown data available"
            description="The engine has not yet recorded a drawdown snapshot."
          />
        }
        <!--
          Named explicitly rather than "@else". With only Live and History, "not
          live" meant history and read fine; adding a third tab silently made
          Accounts render the entire history section underneath itself — charts,
          KPIs and a 1.2M-row grid. Guards on a tab set of three or more have to
          name their tab.
        -->
      } @else if (activeTab() === 'history') {
        <!-- 6-tile KPI strip computed from the loaded page, per account -->
        @if (historySeries().length > 0) {
          <div class="kpis">
            <app-metric-card
              label="Snapshots on page"
              [value]="historySeries().length"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Accounts on page"
              [value]="historyAccountCount()"
              format="number"
              dotColor="#5AC8FA"
            />
            <app-metric-card
              label="Max drawdown on page"
              [value]="historyMaxDd()"
              format="percent"
              [dotColor]="ddColor(historyMaxDd())"
            />
            <app-metric-card
              label="Avg drawdown on page"
              [value]="historyAvgDd()"
              format="percent"
              [dotColor]="ddColor(historyAvgDd())"
            />
            <app-metric-card
              label="Mode transitions on page"
              [value]="historyModeTransitions().length"
              format="number"
              [dotColor]="historyModeTransitions().length > 0 ? '#FF9500' : '#34C759'"
            />
            <app-metric-card
              label="Time in Reduced or Halted"
              [value]="historyTimeInNonNormalPct()"
              format="percent"
              [colorByValue]="true"
              [invertColor]="true"
              [dotColor]="historyTimeInNonNormalPct() === 0 ? '#34C759' : '#FF9500'"
            />
          </div>
        }

        <div class="history-chart-wrap">
          @if (annotationsEnabled()) {
            <button
              type="button"
              class="btn btn-secondary btn-sm add-note"
              (click)="openCreateAnnotation()"
              [disabled]="creatingAnnotation()"
            >
              + Add note
            </button>
          }
          <app-chart-card
            title="Drawdown over time"
            [subtitle]="historyChartSubtitle()"
            [options]="historyChart()"
            height="320px"
            [loading]="historyLoading()"
          />
        </div>

        @if (historySeries().length > 0) {
          <div class="chart-row">
            <app-chart-card
              title="Mode dwell time on page"
              subtitle="Share of the loaded page each account spent in each mode"
              [options]="historyDwellOptions()"
              [height]="historyDwellHeight()"
            />
            <section class="panel trans-card">
              <header class="card-head">
                <h3>Mode transitions on page</h3>
                <span class="card-sub"
                  >{{ historyModeTransitions().length | number }} per account</span
                >
              </header>
              @if (historyModeTransitions().length > 0) {
                <div class="trans-scroll">
                  <table class="trans-table">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Account</th>
                        <th>From</th>
                        <th></th>
                        <th>To</th>
                        <th class="num">DD %</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (t of historyModeTransitions(); track t.accountId + t.at) {
                        <tr>
                          <td class="mono muted">{{ t.at | date: dateFmt }}</td>
                          <td class="acct-cell">{{ accountLabel(t.accountId) }}</td>
                          <td>
                            <span class="mode-pill" [attr.data-mode]="t.from">{{ t.from }}</span>
                          </td>
                          <td class="muted">→</td>
                          <td>
                            <span class="mode-pill" [attr.data-mode]="t.to">{{ t.to }}</span>
                          </td>
                          <td
                            class="num mono"
                            [class.warn]="
                              t.drawdownPct >= reducedPct() && t.drawdownPct < haltedPct()
                            "
                            [class.bad]="t.drawdownPct >= haltedPct()"
                          >
                            {{ t.drawdownPct | number: '1.2-2' }}%
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <span class="empty">
                  <strong>No mode transitions on the loaded page</strong>
                  Every account stayed in one mode.
                </span>
              }
            </section>
          </div>
        }

        <!--
          Snapshots have no free-text field, so the table's search box could
          never match anything — it only added an empty toolbar card.
        -->
        <app-data-table
          [columnDefs]="historyColumns"
          [fetchData]="fetchHistoryPage"
          [searchable]="false"
          stateKey="drawdown-history"
        />

        @if (annotationDrawerOpen()) {
          <div class="annot-overlay" role="presentation" (click)="closeAnnotationDrawer()">
            <form
              class="annot-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Add drawdown note"
              tabindex="-1"
              appModalA11y
              (dismiss)="closeAnnotationDrawer()"
              (click)="$event.stopPropagation()"
              (keydown)="$event.stopPropagation()"
              (ngSubmit)="submitAnnotation()"
            >
              <h4>Add note</h4>
              <label class="field">
                <span class="lbl">When (your local time; stored as UTC)</span>
                <input type="datetime-local" [(ngModel)]="annotWhen" name="when" required />
              </label>
              <label class="field">
                <span class="lbl">Note</span>
                <textarea
                  [(ngModel)]="annotBody"
                  name="body"
                  rows="4"
                  maxlength="500"
                  placeholder="What happened here?"
                  required
                ></textarea>
              </label>
              <div class="annot-actions">
                <button type="button" class="btn btn-ghost" (click)="closeAnnotationDrawer()">
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="creatingAnnotation() || !annotBody.trim()"
                >
                  {{ creatingAnnotation() ? 'Saving…' : 'Save' }}
                </button>
              </div>
            </form>
          </div>
        }
      }

      @if (releaseTarget(); as t) {
        <!-- Release asks in-page: it was a window.prompt, which an automated session dismisses
             unseen and which cannot show what is being discarded. -->
        <div class="annot-overlay" role="presentation" (click)="cancelRelease()">
          <div
            class="annot-dialog release-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dd-release-title"
            appModalA11y
            (dismiss)="cancelRelease()"
            (click)="$event.stopPropagation()"
          >
            <h4 id="dd-release-title">
              Release {{ t.accountName }} #{{ t.tradingAccountId }} from {{ t.recoveryMode }}?
            </h4>
            <p class="release-copy">
              Rebases the drawdown anchor to current equity ({{
                t.currentEquity !== null ? (t.currentEquity | number: '1.2-2') : 'unknown'
              }}; drawdown now
              {{ t.drawdownPct !== null ? (t.drawdownPct | number: '1.2-2') + '%' : 'unknown' }}),
              so the account trades at full size again. The all-time high-water mark is kept, so
              historical drawdown stays reportable.
            </p>
            <label class="field">
              <span class="lbl">Reason (required, stored on the audit snapshot)</span>
              <textarea [(ngModel)]="releaseReasonText" rows="3" maxlength="500"></textarea>
            </label>
            <div class="annot-actions">
              <button type="button" class="btn btn-ghost" (click)="cancelRelease()" data-autofocus>
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-primary"
                [disabled]="!releaseReasonText.trim()"
                (click)="confirmRelease()"
              >
                Release to Normal
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './drawdown-page.scss',
})
export class DrawdownPageComponent {
  private readonly service = inject(DrawdownRecoveryService);
  private readonly configService = inject(ConfigService);
  private readonly annotationsService = inject(ChartAnnotationsService);
  private readonly flags = inject(FeatureFlagsService);

  readonly dateFmt = DATE_FMT;
  readonly rowCap = ANALYTICS_ROW_CAP;

  /**
   * Chart annotations are gated behind `chart-annotations` so ops can stage
   * rollout per-role or per-percentage via `runtime-config.json`. When off,
   * existing notes still render in the chart (read path) but the authoring
   * affordance is hidden.
   */
  readonly annotationsEnabled = this.flags.watch('chart-annotations');

  readonly tabs: TabItem[] = [
    { label: 'Live', value: 'live' },
    { label: 'Accounts', value: 'accounts' },
    { label: 'History', value: 'history' },
  ];
  readonly activeTab = signal('live');

  constructor() {
    this.loadThresholds();
  }

  // ── Recovery thresholds ──────────────────────────────────────────────────
  // The card used to hard-code 5% / 10%, which is neither the engine default
  // (10% / 20%) nor whatever an operator has saved — so it contradicted the
  // Accounts tab on every screenshot. Read the enforced values instead.
  readonly reducedPct = signal(DEFAULT_REDUCED_PCT);
  readonly haltedPct = signal(DEFAULT_HALTED_PCT);
  readonly thresholdsFromEngine = signal(false);

  private loadThresholds(): void {
    const read = (key: string) =>
      this.configService.getByKey(key).pipe(
        map((r) => {
          const v = Number(r.data?.value);
          return Number.isFinite(v) && v > 0 ? v : null;
        }),
        catchError(() => of(null as number | null)),
      );
    read('RiskCheckerOptions:ReducedDrawdownPct').subscribe((v) => {
      if (v !== null) {
        this.reducedPct.set(v);
        this.thresholdsFromEngine.set(true);
      }
    });
    read('RiskCheckerOptions:HaltedDrawdownPct').subscribe((v) => {
      if (v !== null) {
        this.haltedPct.set(v);
        this.thresholdsFromEngine.set(true);
      }
    });
  }

  ddColor(pct: number): string {
    if (pct >= this.haltedPct()) return MODE_COLOR.Halted;
    if (pct >= this.reducedPct()) return MODE_COLOR.Reduced;
    return MODE_COLOR.Normal;
  }

  // ── Per-account recovery ─────────────────────────────────────────────────
  // The Live tab is a fleet AGGREGATE: it sums equity and shows the worst mode in
  // the set. That cannot answer "which account is halted", so an account can sit
  // Halted for days behind a gauge reading "Reduced" — which is how account 24
  // went unnoticed. This is the per-account view, and the only place a halt can
  // be released.
  private readonly accountsResource = createPolledResource(
    () =>
      this.service.listByAccount(true).pipe(
        map((r) => r.data ?? []),
        catchError(() => of([] as AccountRecoveryStateDto[])),
      ),
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 60_000,
      refreshOn: ['positionClosed', 'vaRBreach', 'emergencyFlatten'],
    },
  );

  readonly allAccounts = computed(() => this.accountsResource.value() ?? []);
  readonly accountsLoading = computed(
    () => this.accountsResource.loading() && this.accountsResource.value() === null,
  );

  /**
   * Accounts the engine is actually evaluating. `listByAccount(true)` also returns
   * dormant rows and seed placeholders ("Account 99999999", never evaluated) that
   * padded the table to 13 rows under a scope of six; they are hidden behind a
   * toggle rather than dropped, since an inactive account can still hold a halt.
   */
  readonly accounts = computed(() =>
    this.allAccounts().filter((a) => a.isActive && (!a.isUnknown || a.recordedAtUtc !== null)),
  );
  readonly showInactiveAccounts = signal(false);
  readonly visibleAccounts = computed(() =>
    this.showInactiveAccounts() ? this.allAccounts() : this.accounts(),
  );
  readonly hiddenAccountCount = computed(() => this.allAccounts().length - this.accounts().length);

  /** Accounts whose sizing is restricted or whose trading is stopped. */
  readonly restrictedAccounts = computed(() => this.allAccounts().filter((a) => a.isRestricted));
  readonly restrictedActive = computed(() => this.restrictedAccounts().filter((a) => a.isActive));
  readonly restrictedInactive = computed(() =>
    this.restrictedAccounts().filter((a) => !a.isActive),
  );

  readonly restrictedActiveGroups = computed(() => groupByMode(this.restrictedActive()));
  readonly restrictedInactiveGroups = computed(() => groupByMode(this.restrictedInactive()));
  readonly restrictedActiveHalted = computed(() =>
    this.restrictedActive().some((a) => a.recoveryMode === 'Halted'),
  );

  /** "2 Halted · 3 Reduced · 1 Normal" over the rows the table is showing. */
  readonly accountModeCounts = computed(() =>
    groupByMode(this.visibleAccounts()).map((g) => ({ mode: g.mode, count: g.items.length })),
  );

  readonly plural = plural;

  private readonly accountNames = computed(() => {
    const m = new Map<number, string>();
    for (const a of this.allAccounts()) m.set(a.tradingAccountId, a.accountName);
    return m;
  });

  accountLabel(id: number | null | undefined): string {
    if (id == null || id === 0) return 'Fleet aggregate';
    return this.accountNames().get(id) ?? `Account #${id}`;
  }

  /** Id currently being released, so only that row shows a pending state. */
  readonly releasing = signal<number | null>(null);
  readonly releaseError = signal<string | null>(null);
  readonly releaseNote = signal<string | null>(null);

  /**
   * Release an account back to Normal by rebasing its drawdown anchor to current
   * equity.
   *
   * The reason is prompted for rather than defaulted because the engine persists it
   * on the rebase snapshot — this discards a protective state, and months later an
   * unexplained rebase is indistinguishable from a bug. A cancelled or blank prompt
   * aborts rather than sending a placeholder.
   */
  readonly releaseTarget = signal<AccountRecoveryStateDto | null>(null);
  /** Bound to the release dialog's reason box. */
  releaseReasonText = '';

  askRelease(account: AccountRecoveryStateDto): void {
    this.releaseReasonText = '';
    this.releaseTarget.set(account);
  }

  cancelRelease(): void {
    this.releaseTarget.set(null);
  }

  confirmRelease(): void {
    const account = this.releaseTarget();
    const reason = this.releaseReasonText.trim();
    if (!account || !reason) return;
    this.releaseTarget.set(null);
    this.releaseToNormal(account, reason);
  }

  private releaseToNormal(account: AccountRecoveryStateDto, reason: string): void {
    this.releaseError.set(null);
    this.releaseNote.set(null);
    this.releasing.set(account.tradingAccountId);

    this.service.rebaseAnchor(account.tradingAccountId, reason, 0).subscribe({
      next: (res) => {
        this.releasing.set(null);
        const result = res.data;
        if (!res.status || !result?.rebased) {
          // The engine refuses some rebases deliberately; surface its reason verbatim
          // rather than a generic failure, because the reason is the actionable part.
          this.releaseError.set(
            result?.refusedReason ?? res.message ?? 'The engine refused the release.',
          );
          return;
        }
        this.releaseNote.set(
          `${account.accountName} released from ${result.previousMode} ` +
            `(was ${result.previousDrawdownPct.toFixed(2)}% drawdown). ` +
            `Anchor ${result.previousAnchor.toFixed(2)} → ${result.newAnchor.toFixed(2)}.`,
        );
        this.accountsResource.refresh();
      },
      error: (e) => {
        this.releasing.set(null);
        this.releaseError.set(e?.error?.message ?? e?.message ?? 'Release failed.');
      },
    });
  }

  // ── Live scope ───────────────────────────────────────────────────────────
  /** null = fleet aggregate (worst mode, summed equity); a number = that account only. */
  readonly liveAccountId = signal<number | null>(null);

  selectLiveAccount(id: number | null): void {
    this.liveAccountId.set(id);
    this.resource.refresh();
  }

  // Errors are left to the polled resource so they land in `.error()`; a
  // catchError here turned an engine outage into the "no snapshot" empty state.
  private readonly resource = createPolledResource(
    () => {
      const id = this.liveAccountId();
      return this.service.getLatest(id === null ? undefined : [id]).pipe(map((r) => r.data));
    },
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 60_000,
      refreshOn: ['positionClosed', 'vaRBreach', 'emergencyFlatten'],
    },
  );

  readonly snapshot = computed(() => this.resource.value());
  readonly loading = computed(() => this.resource.loading() && this.resource.value() === null);
  /** Only while there is nothing to show — a stale snapshot beats an error card. */
  readonly liveError = computed(
    () => this.resource.error() !== null && this.resource.value() === null,
  );

  retryLive(): void {
    this.resource.refresh();
    this.analyticsResource.refresh();
  }
  readonly drawdownAmount = computed(() => {
    const s = this.snapshot();
    if (!s) return 0;
    return s.currentEquity - s.peakEquity;
  });

  // ── Live-tab analytics window ────────────────────────────────────────────
  // Probe-and-fetch the most recent 7 days of snapshots (capped at 5000) so
  // the KPIs and breakdown chart reflect the current state of the engine
  // rather than a single moment in time. Polled every 60s. Six accounts at a
  // ~30 s cadence fill the cap in a few hours, so the window the page really
  // holds is measured from the rows and labelled, never assumed to be 7 days.
  private readonly analyticsResource = createPolledResource(
    () => {
      const fromDate = new Date(Date.now() - 7 * DAY_MS).toISOString();
      return this.service
        .listHistory({ currentPage: 1, itemCountPerPage: 1, filter: { fromDate } })
        .pipe(
          switchMap((probe) => {
            const total = probe.data?.pager?.totalItemCount ?? 0;
            const limit = Math.min(total, ANALYTICS_ROW_CAP);
            if (limit === 0) return of([] as SnapshotRow[]);
            return this.service
              .listHistory({
                currentPage: 1,
                itemCountPerPage: limit,
                filter: { fromDate },
              })
              .pipe(map((r) => (r.data?.data ?? []) as SnapshotRow[]));
          }),
          catchError(() => of([] as SnapshotRow[])),
        );
    },
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 60_000,
      refreshOn: ['positionClosed', 'vaRBreach', 'emergencyFlatten'],
    },
  );

  /** Every loaded row, oldest first, all accounts interleaved. */
  readonly analyticsRows = computed(() => {
    const rows = this.analyticsResource.value() ?? [];
    return [...rows].sort(
      (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
    );
  });

  private readonly analyticsByAccount = computed(() => groupByAccount(this.analyticsRows()));

  /** The account series the Live tab is currently looking at. */
  readonly liveGroups = computed(() => {
    const id = this.liveAccountId();
    const all = this.analyticsByAccount();
    if (id === null) return all;
    return new Map<number, SnapshotRow[]>([[id, all.get(id) ?? []]]);
  });

  private readonly liveRows = computed(() => {
    const id = this.liveAccountId();
    return id === null ? this.analyticsRows() : (this.analyticsByAccount().get(id) ?? []);
  });

  readonly windowCoverage = computed(() => {
    const rows = this.analyticsRows();
    if (rows.length === 0) return null;
    const from = new Date(rows[0].recordedAt).getTime();
    const to = new Date(rows[rows.length - 1].recordedAt).getTime();
    return {
      label: formatDuration(Math.max(0, to - from)),
      rows: rows.length,
      accounts: this.analyticsByAccount().size,
      capped: rows.length >= ANALYTICS_ROW_CAP,
    };
  });

  readonly liveChartSubtitle = computed(() => {
    const w = this.windowCoverage();
    if (!w) return 'No snapshots loaded';
    const scope =
      this.liveAccountId() === null
        ? `one line per account`
        : this.accountLabel(this.liveAccountId());
    // The threshold lines do not stretch the axis, so say when one is off the top.
    const offScale = this.maxDdInWindow() < this.haltedPct() * 0.8;
    const halt = offScale ? ` · Halted line (${this.haltedPct()}%) above the plotted range` : '';
    return `${scope} · most recent ${w.label}${halt}`;
  });

  /**
   * Highest drawdown any one account reached inside the loaded window (plus the
   * current snapshot). Under the aggregate this is a per-account reading, not the
   * fleet figure the gauge shows — the caption names the account so the two are
   * not read as a contradiction.
   */
  private readonly worstDd = computed(() => {
    let max = 0;
    let accountId: number | null = null;
    for (const r of this.liveRows()) {
      if (r.drawdownPct > max) {
        max = r.drawdownPct;
        accountId = accountOf(r);
      }
    }
    // Include the current snapshot — it might be fresher than the last
    // analytics row, especially right after a sudden drop.
    const s = this.snapshot();
    if (s && s.drawdownPct > max) {
      max = s.drawdownPct;
      accountId = this.liveAccountId() ?? 0;
    }
    return { pct: max, accountId };
  });

  readonly maxDdInWindow = computed(() => this.worstDd().pct);

  readonly worstDdCaption = computed(() => {
    const w = this.worstDd();
    if (w.accountId === null) return 'No samples in the window';
    if (this.liveAccountId() !== null) return 'Highest in loaded window';
    return this.accountLabel(w.accountId);
  });

  /** "Fleet aggregate · 5 accounts" or the selected account's name. */
  readonly liveScopeNote = computed(() => {
    const id = this.liveAccountId();
    if (id !== null) return this.accountLabel(id);
    return `Fleet aggregate · ${plural(this.accounts().length, 'active account')}`;
  });

  /**
   * Time since the account last stood at its anchor peak; null when every account
   * in scope is at its peak now. Under the aggregate this is the longest such gap
   * across accounts: an aggregate row sums equity, so no single snapshot can ever
   * be compared against the summed peak. When the peak predates the loaded window
   * the figure is only a minimum (`lowerBound`) — it used to floor to "0 days",
   * which read as "at peak" for accounts 44% under it.
   */
  readonly sincePeak = computed<Elapsed | null>(() => {
    let worst: Elapsed | null = null;
    const now = Date.now();
    for (const rows of this.liveGroups().values()) {
      if (rows.length === 0) continue;
      const latest = rows[rows.length - 1];
      if (latest.currentEquity >= latest.peakEquity) continue;
      let e: Elapsed | null = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].currentEquity >= latest.peakEquity * 0.9999) {
          e = { ms: now - new Date(rows[i].recordedAt).getTime(), lowerBound: false };
          break;
        }
      }
      // Peak predates the window: at least as old as the oldest row we hold.
      e ??= { ms: now - new Date(rows[0].recordedAt).getTime(), lowerBound: true };
      if (worst === null || e.ms > worst.ms) worst = e;
    }
    return worst;
  });

  readonly sincePeakLabel = computed(() => formatElapsed(this.sincePeak(), 'At peak'));

  readonly sincePeakCaption = computed(() => {
    const e = this.sincePeak();
    if (e === null) return 'Equity at anchor peak';
    if (e.lowerBound) return 'Peak predates the window';
    return this.liveAccountId() === null ? 'Longest across accounts' : 'Since equity was at peak';
  });

  /**
   * Continuous time in the displayed mode. Under the aggregate the displayed mode
   * is the worst one in the fleet, so the figure is taken from the account(s)
   * currently in that mode — the longest such run. A run that reaches back to the
   * oldest loaded row is a minimum.
   */
  readonly timeInMode = computed<Elapsed | null>(() => {
    const s = this.snapshot();
    if (!s) return null;
    let longest: Elapsed | null = null;
    const now = Date.now();
    for (const rows of this.liveGroups().values()) {
      if (rows.length === 0 || rows[rows.length - 1].recoveryMode !== s.recoveryMode) continue;
      let i = rows.length - 1;
      while (i > 0 && rows[i - 1].recoveryMode === s.recoveryMode) i--;
      const e: Elapsed = {
        ms: now - new Date(rows[i].recordedAt).getTime(),
        lowerBound: i === 0,
      };
      if (longest === null || e.ms > longest.ms) longest = e;
    }
    return longest;
  });

  readonly timeInModeLabel = computed(() => formatElapsed(this.timeInMode()));

  readonly timeInModeCaption = computed(() => {
    const e = this.timeInMode();
    if (e === null) return 'Not in this mode in window';
    if (e.lowerBound) return 'Began before the window';
    return 'Longest continuous run';
  });

  private transitionsAcross(groups: Map<number, SnapshotRow[]>): ModeTransition[] {
    const out: ModeTransition[] = [];
    for (const [id, rows] of groups) out.push(...transitionsOf(id, rows));
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  readonly modeTransitions = computed(() => this.transitionsAcross(this.liveGroups()));
  readonly recentTransitions = computed(() => [...this.modeTransitions()].reverse().slice(0, 12));

  modeColorFor(mode: RecoveryMode): string {
    return MODE_COLOR[mode];
  }

  // ── Live-tab charts ──────────────────────────────────────────────────────

  /**
   * Drawn in-page instead of the shared gauge: that component paints its value in
   * a fixed dark grey that vanishes on the dark theme and puts its caption on the
   * arc. Two concentric rings: a thin outer ring carries the threshold zones, the
   * thick inner ring fills to the current drawdown in the mode colour. The needle
   * is gone — on a 0–120% scale a 14% needle was a short stub that read as
   * nothing — and the value sits in the open centre with its caption beneath.
   * The scale stops at 100%: drawdown cannot exceed it.
   */
  readonly gaugeOptions = computed<EChartsOption>(() => {
    const s = this.snapshot();
    const value = s?.drawdownPct ?? 0;
    const reduced = this.reducedPct();
    const halted = this.haltedPct();
    const max = gaugeMax(value, halted);
    const mode: RecoveryMode = s?.recoveryMode ?? 'Normal';
    const ring = {
      type: 'gauge' as const,
      startAngle: 210,
      endAngle: -30,
      min: 0,
      max,
      center: ['50%', '56%'],
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      anchor: { show: false },
    };
    return {
      series: [
        {
          ...ring,
          radius: '98%',
          progress: { show: false },
          axisLine: {
            lineStyle: {
              width: 4,
              color: [
                [Math.min(1, reduced / max), MODE_COLOR.Normal],
                [Math.min(1, halted / max), MODE_COLOR.Reduced],
                [1, MODE_COLOR.Halted],
              ],
            },
          },
          title: { show: false },
          detail: { show: false },
          data: [{ value: 0 }],
          silent: true,
        },
        {
          ...ring,
          radius: '88%',
          progress: {
            show: true,
            width: 14,
            roundCap: true,
            itemStyle: { color: MODE_COLOR[mode] },
          },
          axisLine: {
            roundCap: true,
            lineStyle: { width: 14, color: [[1, 'rgba(142, 142, 147, 0.2)']] },
          },
          title: { show: true, offsetCenter: [0, '30%'], fontSize: 11, color: '#8E8E93' },
          detail: {
            valueAnimation: true,
            fontSize: 24,
            fontWeight: 600,
            offsetCenter: [0, '-4%'],
            formatter: (v: number) => `${v.toFixed(2)}%`,
            color: MODE_COLOR[mode],
          },
          data: [{ value: +value.toFixed(2), name: 'Current drawdown' }],
        },
      ],
      animation: true,
    };
  });

  readonly liveSparklineOptions = computed<EChartsOption>(() => {
    const groups = this.liveGroups();
    // Threshold lines ride on the first series; labels sit inside the plot so
    // they cannot be clipped to "Ha"/"Re" at the right edge.
    const markLine = {
      silent: true,
      symbol: 'none',
      data: [
        {
          yAxis: this.reducedPct(),
          lineStyle: { color: MODE_COLOR.Reduced, type: 'dashed' as const, width: 1 },
          label: {
            formatter: `Reduced ≥ ${this.reducedPct()}%`,
            position: 'insideEndTop' as const,
            fontSize: 9,
          },
        },
        {
          yAxis: this.haltedPct(),
          lineStyle: { color: MODE_COLOR.Halted, type: 'dashed' as const, width: 1 },
          label: {
            formatter: `Halted ≥ ${this.haltedPct()}%`,
            position: 'insideEndTop' as const,
            fontSize: 9,
          },
        },
      ],
    };
    // Faint mode zones behind the lines, so where a line sits reads as a mode
    // without hunting for the dashed threshold.
    const markArea = {
      silent: true,
      data: [
        [
          { yAxis: 0, itemStyle: { color: 'rgba(52, 199, 89, 0.06)' } },
          { yAxis: this.reducedPct() },
        ],
        [
          { yAxis: this.reducedPct(), itemStyle: { color: 'rgba(255, 149, 0, 0.07)' } },
          { yAxis: this.haltedPct() },
        ],
        [
          { yAxis: this.haltedPct(), itemStyle: { color: 'rgba(255, 59, 48, 0.07)' } },
          { yAxis: 100 },
        ],
      ],
    } as unknown as LineSeriesOption['markArea'];
    const series: SeriesOption[] = [];
    let i = 0;
    for (const [id, rows] of groups) {
      if (rows.length === 0) continue;
      const color = ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length];
      series.push({
        name: this.accountLabel(id),
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        data: rows.map((r) => [r.recordedAt, +r.drawdownPct.toFixed(2)]),
        lineStyle: { width: 1.5, color },
        itemStyle: { color },
        emphasis: { focus: 'series' },
        markLine: i === 0 ? markLine : undefined,
        markArea: i === 0 ? markArea : undefined,
        // Name + value at the line's end: with flat lines and six similar hues,
        // colour alone could not tell which account sits where.
        endLabel: {
          show: true,
          fontSize: 10,
          color,
          formatter: (p: { seriesName?: string; value?: unknown }) => {
            const v = Array.isArray(p.value) ? Number(p.value[1]) : Number(p.value);
            const name = p.seriesName ?? '';
            const short = name.length > 14 ? `${name.slice(0, 13)}…` : name;
            return `${short} ${v.toFixed(1)}%`;
          },
        },
        labelLayout: { moveOverlap: 'shiftY' },
      });
      i++;
    }
    if (series.length === 0) return emptyChart('No drawdown samples in the window');
    return {
      grid: { left: 44, right: 118, top: series.length > 1 ? 32 : 16, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => `${Number(v).toFixed(2)}%`,
      },
      legend:
        series.length > 1 ? { top: 0, type: 'scroll', textStyle: { fontSize: 10 } } : undefined,
      xAxis: {
        type: 'time',
        axisLabel: {
          fontSize: 10,
          formatter: (v: string | number) => formatDate(v, 'HH:mm', 'en-US'),
        },
      },
      yAxis: {
        type: 'value',
        min: 0,
        axisLabel: { fontSize: 10, formatter: '{value}%' },
      },
      series,
    };
  });

  /**
   * Dwell time as one stacked bar per account. A donut of the whole window was a
   * single 99% slice — it could not show that one account spent the window in
   * Reduced while five sat in Normal, which is the only thing worth showing.
   */
  private dwellBarOptions(groups: Map<number, SnapshotRow[]>, emptyText: string): EChartsOption {
    const rows: { name: string; secs: ModeSeconds; total: number }[] = [];
    for (const [id, list] of groups) {
      const secs = dwellOf(list);
      const total = totalSeconds(secs);
      if (total > 0) rows.push({ name: this.accountLabel(id), secs, total });
    }
    if (rows.length === 0) return emptyChart(emptyText);
    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const list = params as { seriesName: string; dataIndex: number; value: number }[];
          if (!Array.isArray(list) || list.length === 0) return '';
          const row = rows[list[0].dataIndex];
          const lines = list
            .filter((p) => p.value > 0)
            .map(
              (p) =>
                `${p.seriesName}: ${formatSeconds(row.secs[p.seriesName as RecoveryMode])} (${p.value.toFixed(1)}%)`,
            );
          return `<strong>${row.name}</strong><br/>${lines.join('<br/>')}`;
        },
      },
      legend: { top: 0, textStyle: { fontSize: 10 } },
      grid: { left: 8, right: 16, top: 28, bottom: 24, containLabel: true },
      xAxis: {
        type: 'value',
        max: 100,
        axisLabel: { fontSize: 10, formatter: '{value}%' },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: rows.map((r) => r.name),
        axisLabel: { fontSize: 10, width: 120, overflow: 'truncate' },
      },
      series: MODES.map((mode) => ({
        name: mode,
        type: 'bar',
        stack: 'dwell',
        barMaxWidth: 18,
        itemStyle: { color: MODE_COLOR[mode] },
        data: rows.map((r) => +((r.secs[mode] / r.total) * 100).toFixed(1)),
      })),
    };
  }

  private dwellHeight(groups: Map<number, SnapshotRow[]>): string {
    return `${Math.max(150, 76 + 30 * groups.size)}px`;
  }

  readonly liveDwellOptions = computed(() =>
    this.dwellBarOptions(this.liveGroups(), 'No samples in the window'),
  );
  readonly liveDwellHeight = computed(() => this.dwellHeight(this.liveGroups()));

  // ── History tab ──────────────────────────────────────────────────────────
  readonly historySeries = signal<SnapshotRow[]>([]);
  readonly historyLoading = signal(false);
  readonly annotations = signal<ChartAnnotationDto[]>([]);

  private readonly historyGroups = computed(() => groupByAccount(this.historySeries()));
  readonly historyAccountCount = computed(() => this.historyGroups().size);

  readonly historyChartSubtitle = computed(() => {
    const n = this.historySeries().length;
    if (n === 0) return 'Most recent page of snapshots, oldest first';
    const k = this.historyAccountCount();
    return `Most recent ${n} snapshots on this page · ${k} account${k === 1 ? '' : 's'} · oldest first`;
  });

  // History-tab KPI strip + breakdown — analytics computed from the loaded
  // page (no extra fetch), inside each account's own series.
  readonly historyMaxDd = computed(() => {
    let max = 0;
    for (const r of this.historySeries()) if (r.drawdownPct > max) max = r.drawdownPct;
    return max;
  });

  readonly historyAvgDd = computed(() => {
    const rows = this.historySeries();
    if (rows.length === 0) return 0;
    const sum = rows.reduce((s, r) => s + (r.drawdownPct ?? 0), 0);
    return sum / rows.length;
  });

  readonly historyModeTransitions = computed(() =>
    [...this.transitionsAcross(this.historyGroups())].reverse(),
  );

  /** Time-weighted across accounts: every account's own dwell, summed. */
  readonly historyTimeInNonNormalPct = computed(() => {
    let nonNormal = 0;
    let total = 0;
    for (const rows of this.historyGroups().values()) {
      const b = dwellOf(rows);
      nonNormal += b.Reduced + b.Halted;
      total += totalSeconds(b);
    }
    return total === 0 ? 0 : (nonNormal / total) * 100;
  });

  readonly historyDwellOptions = computed(() =>
    this.dwellBarOptions(this.historyGroups(), 'No samples on the loaded page'),
  );
  readonly historyDwellHeight = computed(() => this.dwellHeight(this.historyGroups()));

  // ── Annotation editor state ───────────────────────────────────────────
  readonly annotationDrawerOpen = signal(false);
  readonly creatingAnnotation = signal(false);
  /** ngModel-bound. `datetime-local` yields `YYYY-MM-DDTHH:mm` (no TZ). */
  annotWhen = '';
  annotBody = '';

  readonly historyChart = computed<EChartsOption>(() => {
    const groups = this.historyGroups();
    if (this.historySeries().length === 0) return emptyChart('No snapshots on this page');
    const single = groups.size === 1;
    const series: SeriesOption[] = [];
    const transitions = this.historyModeTransitions();
    let i = 0;
    for (const [id, rows] of groups) {
      const color = ACCOUNT_PALETTE[i++ % ACCOUNT_PALETTE.length];
      const name = this.accountLabel(id);
      // Markers only where the mode actually changed, and without value labels —
      // a label on every non-Normal sample printed "39.36" over its own marker.
      const marks = transitions
        .filter((t) => t.accountId === id)
        .map((t) => ({
          name: `${t.from} → ${t.to}`,
          xAxis: t.at,
          yAxis: t.drawdownPct,
          itemStyle: { color: MODE_COLOR[t.to] },
        }));
      series.push({
        name: single ? 'Drawdown %' : name,
        type: 'line',
        yAxisIndex: 0,
        smooth: false,
        showSymbol: false,
        sampling: 'lttb',
        data: rows.map((s) => [s.recordedAt, +s.drawdownPct.toFixed(2)]),
        lineStyle: { width: 1.5, color },
        itemStyle: { color },
        areaStyle: single ? { color: 'rgba(10, 132, 255, 0.10)' } : undefined,
        markPoint: {
          symbol: 'circle',
          symbolSize: 9,
          label: { show: false },
          data: marks,
        },
      });
      // Equity only reads when there is one account; six equity lines on a
      // second axis buried the drawdown lines the chart exists for.
      if (single) {
        series.push({
          name: 'Equity',
          type: 'line',
          yAxisIndex: 1,
          smooth: false,
          showSymbol: false,
          sampling: 'lttb',
          data: rows.map((s) => [s.recordedAt, +s.currentEquity.toFixed(2)]),
          lineStyle: { width: 1.5, color: '#34C759' },
          itemStyle: { color: '#34C759' },
        });
      }
    }
    // Operator-authored annotations overlaid as a scatter series, pinned
    // to a fixed y-height (0) on the drawdown axis so they read as
    // "things that happened at this timestamp." Tooltip formatter shows
    // the body; escaping keeps malicious bodies out of the DOM.
    if (this.annotations().length > 0) {
      series.push({
        name: 'Notes',
        type: 'scatter',
        yAxisIndex: 0,
        symbol: 'pin',
        symbolSize: 22,
        itemStyle: { color: '#AF52DE' },
        data: this.annotations().map((a) => ({
          name: 'Note',
          value: [a.annotatedAt, 0],
          tooltip: { formatter: `<strong>Note</strong><br/>${escapeHtml(a.body)}` },
        })),
        emphasis: { scale: true },
      });
    }
    return {
      grid: { left: 56, right: single ? 72 : 24, top: 44, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        formatter: (params: unknown) => {
          const list = params as {
            seriesName: string;
            value: [string, number];
            marker: string;
            seriesType: string;
          }[];
          if (!Array.isArray(list) || list.length === 0) return '';
          const head = formatStamp(list[0].value[0]);
          const lines = list
            .filter((p) => p.seriesType === 'line')
            .map(
              (p) =>
                `${p.marker} ${p.seriesName}: ${
                  p.seriesName === 'Equity'
                    ? Number(p.value[1]).toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })
                    : `${Number(p.value[1]).toFixed(2)}%`
                }`,
            );
          return `${head}<br/>${lines.join('<br/>')}`;
        },
      },
      legend: { top: 0, type: 'scroll', textStyle: { fontSize: 10 } },
      xAxis: {
        type: 'time',
        // One weight, one format: the default time axis mixes bold day
        // boundaries with regular hour ticks.
        axisLabel: {
          fontSize: 10,
          formatter: (v: string | number) => formatDate(v, 'd MMM HH:mm', 'en-US'),
        },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Drawdown %',
          nameGap: 10,
          nameTextStyle: { fontSize: 10, align: 'left' },
          position: 'left',
          min: 0,
          axisLabel: { fontSize: 10, formatter: '{value}%' },
        },
        {
          type: 'value',
          name: single ? 'Equity' : '',
          nameGap: 10,
          nameTextStyle: { fontSize: 10, align: 'right' },
          position: 'right',
          show: single,
          scale: true,
          axisLabel: { fontSize: 10 },
          splitLine: { show: false },
        },
      ],
      series,
    };
  });

  readonly historyColumns: ColDef<SnapshotRow>[] = [
    {
      headerName: 'Recorded',
      field: 'recordedAt',
      width: 180,
      valueFormatter: (p) => formatStamp(p.value as string),
    },
    {
      headerName: 'Account',
      colId: 'account',
      width: 180,
      sortable: false,
      valueGetter: (p) => this.accountLabel(p.data?.tradingAccountId),
    },
    {
      headerName: 'Mode',
      field: 'recoveryMode',
      width: 120,
      cellRenderer: (p: { value: RecoveryMode }) => {
        const color = MODE_COLOR[p.value];
        return `<span style="color: ${color}; font-weight: 600;">${MODE_LABEL[p.value] ?? p.value}</span>`;
      },
    },
    {
      headerName: 'Drawdown %',
      field: 'drawdownPct',
      width: 140,
      type: 'numericColumn',
      cellStyle: { justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' },
      valueFormatter: (p) => (p.value as number)?.toFixed(2) + '%',
    },
    {
      headerName: 'Current Equity',
      field: 'currentEquity',
      width: 160,
      type: 'numericColumn',
      cellStyle: { justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' },
      valueFormatter: (p) =>
        (p.value as number)?.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
    },
    {
      headerName: 'Peak Equity',
      field: 'peakEquity',
      width: 160,
      type: 'numericColumn',
      cellStyle: { justifyContent: 'flex-end', fontVariantNumeric: 'tabular-nums' },
      valueFormatter: (p) =>
        (p.value as number)?.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
    },
  ];

  readonly fetchHistoryPage = (params: {
    currentPage?: number;
    itemCountPerPage?: number;
    filter?: any;
  }) => {
    this.historyLoading.set(true);
    return this.service
      .listHistory({
        currentPage: params.currentPage,
        itemCountPerPage: params.itemCountPerPage,
        filter: params.filter,
      })
      .pipe(
        map((res) => {
          const empty = {
            pager: {
              totalItemCount: 0,
              filter: null,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 1,
              pageSize: 25,
            },
            data: [] as DrawdownSnapshotDto[],
          };
          const page = res.data ?? empty;
          // Chart wants oldest-first; engine returns newest-first.
          this.historySeries.set([...(page.data as SnapshotRow[])].reverse());
          this.historyLoading.set(false);
          // Fire-and-forget — the chart re-renders on annotation arrival,
          // and a failed annotation load shouldn't break the table page.
          this.loadAnnotationsForSeries(page.data);
          return page;
        }),
        catchError(() => {
          this.historySeries.set([]);
          this.historyLoading.set(false);
          return of({
            pager: {
              totalItemCount: 0,
              filter: null,
              currentPage: 1,
              itemCountPerPage: 25,
              pageNo: 1,
              pageSize: 25,
            },
            data: [] as DrawdownSnapshotDto[],
          });
        }),
      );
  };

  modeLabel(mode: RecoveryMode): string {
    return MODE_LABEL[mode] ?? String(mode);
  }

  // ── Annotation editor ────────────────────────────────────────────────

  openCreateAnnotation(): void {
    // Default to "now" so the common case (just happened) is a single click.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    this.annotWhen = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    this.annotBody = '';
    this.annotationDrawerOpen.set(true);
  }

  closeAnnotationDrawer(): void {
    if (this.creatingAnnotation()) return; // don't close mid-save
    this.annotationDrawerOpen.set(false);
  }

  submitAnnotation(): void {
    const body = this.annotBody.trim();
    if (!body || !this.annotWhen) return;
    // `datetime-local` value is local time; convert to UTC ISO before posting.
    const annotatedAt = new Date(this.annotWhen).toISOString();
    this.creatingAnnotation.set(true);
    this.annotationsService
      .create({ target: 'drawdown', annotatedAt, body })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.creatingAnnotation.set(false);
        if (res?.status) {
          // Refresh against the current window so the new note shows up.
          this.loadAnnotationsForSeries(this.historySeries());
          this.annotationDrawerOpen.set(false);
        }
      });
  }

  /**
   * Fetches chart annotations covering the loaded series's time range and
   * stashes them on `this.annotations`. Network + parse errors leave the
   * annotation layer empty rather than bubble up.
   */
  private loadAnnotationsForSeries(series: DrawdownSnapshotDto[]): void {
    if (series.length === 0) {
      this.annotations.set([]);
      return;
    }
    const earliest = series.reduce(
      (min, s) => (new Date(s.recordedAt) < new Date(min) ? s.recordedAt : min),
      series[0].recordedAt,
    );
    const latest = series.reduce(
      (max, s) => (new Date(s.recordedAt) > new Date(max) ? s.recordedAt : max),
      series[0].recordedAt,
    );

    this.annotationsService
      .list('drawdown', {
        currentPage: 1,
        itemCountPerPage: 100,
        filter: { from: earliest, to: latest },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.annotations.set(res?.data?.data ?? []);
      });
  }
}

/** Minimal HTML escape — ECharts renders tooltip strings as raw HTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
