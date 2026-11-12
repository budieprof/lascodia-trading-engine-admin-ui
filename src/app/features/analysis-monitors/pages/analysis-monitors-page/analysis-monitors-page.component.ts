import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, map, of } from 'rxjs';

import { AnalysisMonitorsService } from '@core/services/analysis-monitors.service';
import { PageContextService } from '@core/assistant/page-context.service';
import { UiCommandService } from '@core/assistant/ui-command.service';
import { monitorsPageCommands, monitorsPageFacts } from './monitors-page-assistant';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { appStorage } from '@core/storage/app-storage';
import type { AnalysisMonitorDto } from '@core/api/api.types';
import type {
  AnalysisMonitorBoardCounters,
  AnalysisMonitorDetail,
} from '@features/analysis-monitors/analysis-monitors.types';
import { PinePreviewComponent } from '@features/scripting/pine-preview/pine-preview.component';
import type { PineRunRequest } from '@shared/pine-chart/model/pine-outputs.types';
import { MonitorBuilderComponent } from '@features/analysis-monitors/components/monitor-builder/monitor-builder.component';
import { MonitorTemplatesComponent } from '@features/analysis-monitors/components/monitor-templates/monitor-templates.component';
import { MonitorActivityFeedComponent } from '@features/analysis-monitors/components/monitor-activity-feed/monitor-activity-feed.component';
import { MonitorInsightsComponent } from '@features/analysis-monitors/components/monitor-insights/monitor-insights.component';
import {
  MonitorDetailDrawerComponent,
  type MonitorDrawerAction,
} from '@features/analysis-monitors/components/monitor-detail-drawer/monitor-detail-drawer.component';
import {
  attentionReasons,
  expectedCadence,
  formatAge,
  formatCountdown,
  humanizeNote,
  isOverdue,
  lifeProgress,
  nearestLevel,
} from '@features/analysis-monitors/monitor-format';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { SparklineComponent } from '@shared/components/sparkline/sparkline.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

/** Status filter chips, in the order an operator scans them. */
const STATUS_FILTERS = [
  { key: 'Live', label: 'Live' },
  { key: 'Active', label: 'Active' },
  { key: 'Paused', label: 'Paused' },
  { key: 'Triggered', label: 'Fired' },
  { key: 'Invalidated', label: 'Thesis broke' },
  { key: 'Expired', label: 'Expired' },
  { key: 'Cancelled', label: 'Cancelled' },
  { key: 'Error', label: 'Error' },
  { key: '', label: 'All' },
] as const;

const RANGES = [7, 14, 30, 90] as const;

type View = 'table' | 'cards';
type Density = 'comfortable' | 'compact';
type SortKey = 'default' | 'symbol' | 'distance' | 'life' | 'fires' | 'check' | 'expires';

interface Prefs {
  view: View;
  density: Density;
  analyticsOpen: boolean;
  days: number;
}
const PREFS_KEY = 'lascodia.monitors.prefs.v2';

type PendingAction =
  | { kind: 'fire' | 'cancel'; monitor: AnalysisMonitorDto }
  | { kind: 'bulk-cancel'; ids: number[] };

/**
 * Operator cockpit for analysis monitors.
 *
 * <p>Three questions, top to bottom: <b>is the system alive</b> (worker ribbon), <b>is any of it
 * working</b> (KPI band + analytics: fire rate, time to fire, which pairs and kinds of watch work,
 * when fires happen, what the trades returned), and <b>what is armed right now and how close is
 * it</b> (the board: distance from the last price to the level each watch waits at, how much of
 * its life it has used, whether the worker is keeping up with it).</p>
 *
 * <p>Carried over from the first version: "Active" describes the row, not the system, so worker
 * liveness renders first; every verb that cannot be undone asks; and a monitor's full history is
 * one click away (now a drawer, so the board stays in view and j/k walk it).</p>
 */
@Component({
  selector: 'app-analysis-monitors-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PinePreviewComponent,
    DatePipe,
    DecimalPipe,
    PercentPipe,
    NgTemplateOutlet,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    MonitorBuilderComponent,
    MonitorTemplatesComponent,
    MonitorInsightsComponent,
    MonitorActivityFeedComponent,
    MonitorDetailDrawerComponent,
    ConfirmDialogComponent,
    RefreshButtonComponent,
    SparklineComponent,
    ModalA11yDirective,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Analysis monitors"
        subtitle="Every market watch — what is armed, how close it is, what fired, and whether any of it works"
      >
        <a routerLink="/conversations" class="btn btn-secondary">Conversations</a>
        <button type="button" class="btn btn-secondary" (click)="templatesOpen.set(true)">Templates</button>
        <button type="button" class="btn btn-primary" (click)="openBuilder(null)">New monitor</button>
        <app-refresh-button [refreshing]="board.refreshing() || insightsRes.refreshing()" (refresh)="refreshAll()" />
      </app-page-header>

      <!-- ── Worker health ribbon ─────────────────────────────────────────── -->
      @if (counters(); as c) {
        <div class="ribbon" [attr.data-health]="health()">
          <span class="pulse" [attr.data-health]="health()"></span>
          @switch (health()) {
            @case ('stalled') {
              <span
                ><b>The monitor worker is not evaluating.</b> {{ c.active }} monitor{{ c.active === 1 ? '' : 's' }}
                read as Active, but {{ describeFreshestCheck(c) }}. Nothing will fire until the
                <code>llm</code> role process is running with <code>Llm:SpotMonitorEnabled</code> on.</span
              >
            }
            @case ('behind') {
              <span
                ><b>Worker behind.</b> {{ c.workerOverdueCount }} of {{ c.active }} armed monitor{{
                  c.active === 1 ? '' : 's'
                }}
                {{ c.workerOverdueCount === 1 ? 'is' : 'are' }} overdue for a check — starved or stuck on a subset.</span
              >
            }
            @case ('idle') {
              <span><b>Worker idle</b> — nothing is armed.</span>
            }
            @default {
              <span><b>Worker healthy</b></span>
            }
          }
          @if (has(c.workerLastCheckSeconds)) {
            <span class="rib-fact">freshest check <b>{{ age(c.workerLastCheckSeconds) }}</b> ago</span>
          }
          @if (has(c.workerStalestCheckSeconds)) {
            <span class="rib-fact">stalest <b>{{ age(c.workerStalestCheckSeconds) }}</b></span>
          }
          @if (c.activeHunter > 0) {
            <span class="rib-fact"><b>{{ c.activeHunter }}</b> hunter-armed</span>
          }
          @for (k of c.watchKindsByOrigin ?? []; track k.origin) {
            <span
              class="rib-fact"
              [title]="k.scriptAi + ' AI-written, ' + k.scriptSynthesized + ' engine-synthesised, ' + k.plain + ' plain — last 30 days'"
              >{{ k.origin }}: <b>{{ k.scriptShare | percent: '1.0-0' }}</b> Pine of {{ k.total }}</span
            >
          }
          <span class="rib-stamp">live · {{ data()?.asOfUtc | date: 'HH:mm:ss' : 'UTC' }} UTC</span>
        </div>
      }

      @if (board.loading() && !data()) {
        <app-card-skeleton />
      } @else if (board.error() && !data()) {
        <app-error-state
          title="Could not load monitors"
          message="The engine did not answer. Watches may be armed that are not shown here."
          (retry)="board.refresh()"
        />
      } @else if (data(); as d) {
        <!-- ── KPI band ───────────────────────────────────────────────────── -->
        <div class="kpis">
          <button type="button" class="kpi" (click)="setStatus('Active')" [class.on]="statusFilter() === 'Active'">
            <span class="k-label"><span class="dot" [class.green]="d.counters.active > 0"></span>Armed</span>
            <span class="k-value">{{ d.counters.active }}</span>
            <span class="k-cap">{{ armedMix() }}</span>
          </button>
          <button type="button" class="kpi" (click)="setStatus('Paused')" [class.on]="statusFilter() === 'Paused'">
            <span class="k-label">Paused</span>
            <span class="k-value">{{ d.counters.paused }}</span>
            <span class="k-cap">{{ d.counters.expiringWithin1h }} expiring &lt; 1h</span>
          </button>
          <button type="button" class="kpi" (click)="setStatus('Triggered')" [class.on]="statusFilter() === 'Triggered'">
            <span class="k-label">Fired · 24h</span>
            <span class="k-row">
              <span class="k-value">{{ d.counters.firedLast24h }}</span>
              @if (spark('fired').length > 1) {
                <app-sparkline [data]="spark('fired')" color="#2a78d6" width="72px" height="26px" />
              }
            </span>
            <span class="k-cap">{{ ins()?.totals?.fires ?? '—' }} in {{ days() }}d</span>
          </button>
          <div
            class="kpi static"
            [title]="'Of the watches armed in the last ' + days() + ' days that have finished, the share that fired at least once'"
          >
            <span class="k-label">Fire rate · {{ days() }}d</span>
            <span class="k-value">{{ fireRateText() }}</span>
            <span class="k-cap">
              @if (ins(); as i) {
                {{ i.totals.firedAtLeastOnce }} fired of {{ i.totals.ended }} finished
              }
            </span>
          </div>
          <div class="kpi static" title="Median time from arming to first fire, for watches armed in the window">
            <span class="k-label">Time to fire</span>
            <span class="k-value">{{ hours(ins()?.totals?.medianHoursToFire) }}</span>
            <span class="k-cap"
              >p75 {{ hours(ins()?.totals?.p75HoursToFire) }} · life {{ hours(ins()?.totals?.medianLifeHours) }}</span
            >
          </div>
          <button type="button" class="kpi" (click)="setStatus('Invalidated')" [class.on]="statusFilter() === 'Invalidated'">
            <span class="k-label">Thesis broke · {{ days() }}d</span>
            <span class="k-row">
              <span class="k-value">{{ ins()?.totals?.invalidated ?? '—' }}</span>
              @if (spark('invalidated').length > 1) {
                <app-sparkline [data]="spark('invalidated')" color="#eb6834" width="72px" height="26px" />
              }
            </span>
            <span class="k-cap">{{ ins()?.totals?.expired ?? 0 }} expired · {{ ins()?.totals?.cancelled ?? 0 }} cancelled</span>
          </button>
          <button
            type="button"
            class="kpi"
            [class.alert]="attentionCount() > 0"
            [class.on]="attentionOnly()"
            (click)="toggleAttention()"
            title="Live watches needing a look: awaiting ack, failing checks, overdue, expiring within the hour, acting on live trading, near their spend cap (a)"
          >
            <span class="k-label"><span class="dot" [class.amber]="attentionCount() > 0"></span>Needs attention</span>
            <span class="k-value">{{ attentionCount() }}</span>
            <span class="k-cap">{{ d.counters.error }} errored · {{ d.counters.workerOverdueCount }} overdue</span>
          </button>
          <div class="kpi static" [title]="'Signals filed by fires in the last ' + days() + ' days, followed to their closed positions'">
            <span class="k-label">Fire trades · {{ days() }}d</span>
            @if (ins(); as i) {
              <span class="k-value" [class.pos]="i.trades.netPnl > 0" [class.neg]="i.trades.netPnl < 0">{{ pnlText() }}</span>
              <span class="k-cap">{{ i.trades.signalsFiled }} filed · {{ i.trades.wins }}W / {{ i.trades.losses }}L</span>
            } @else {
              <span class="k-value">—</span>
              <span class="k-cap"></span>
            }
          </div>
        </div>

        <!-- ── Analytics ──────────────────────────────────────────────────── -->
        <section class="panel">
          <header class="panel-head" [class.open]="prefs().analyticsOpen">
            <button type="button" class="disclose" (click)="toggleAnalytics()" [attr.aria-expanded]="prefs().analyticsOpen">
              <span class="chev" [class.open]="prefs().analyticsOpen">▸</span>
              <h2>Fleet analytics</h2>
            </button>
            <span class="muted small">
              Watches armed in the last {{ days() }} days{{ symbol() ? ' on ' + symbol() : '' }}{{ origin() ? ' · ' + origin() : '' }}
            </span>
            <span class="grow"></span>
            <div class="seg" role="group" aria-label="Analytics window">
              @for (r of ranges; track r) {
                <button type="button" [class.on]="days() === r" (click)="setDays(r)">{{ r }}d</button>
              }
            </div>
          </header>
          @if (prefs().analyticsOpen) {
            @if (insightsRes.loading() && !ins()) {
              <div class="panel-loading">Loading analytics…</div>
            } @else if (!ins()) {
              <div class="panel-loading">Analytics are unavailable — the engine did not answer.</div>
            } @else {
              <app-monitor-insights [insights]="ins()" [activeSymbol]="symbol()" (symbolPicked)="setSymbol($event)" />
            }
          }
        </section>

        <!-- ── Toolbar ────────────────────────────────────────────────────── -->
        <div class="toolbar">
          <div class="chips" aria-label="Status">
            @for (s of statusFilters; track s.key) {
              <button type="button" class="chip" [class.on]="statusFilter() === s.key" (click)="setStatus(s.key)">
                {{ s.label }} <span class="c">{{ statusCount(s.key) }}</span>
              </button>
            }
          </div>
          <div class="tools">
            <input
              #searchBox
              class="search"
              type="search"
              placeholder="Search intent, symbol or note…   /"
              [ngModel]="searchDraft()"
              (ngModelChange)="onSearch($event)"
            />
            <select [ngModel]="symbol()" (ngModelChange)="setSymbol($event)" aria-label="Instrument">
              <option value="">All instruments</option>
              @for (s of symbolOptions(); track s) {
                <option [value]="s">{{ s }}</option>
              }
            </select>
            <select [ngModel]="origin()" (ngModelChange)="origin.set($event); resetPage()" aria-label="Origin">
              <option value="">Any origin</option>
              <option value="operator">Operator</option>
              <option value="hunter">Hunter</option>
            </select>
            <select [ngModel]="mode()" (ngModelChange)="mode.set($event); resetPage()" aria-label="Evaluation mode">
              <option value="">Any mode</option>
              <option value="Deterministic">Live check</option>
              <option value="LlmAssisted">LLM-judged</option>
            </select>
            <select [ngModel]="sortKey()" (ngModelChange)="sortKey.set($event)" aria-label="Sort">
              <option value="default">Sort: priority</option>
              <option value="distance">Closest to its level</option>
              <option value="expires">Expires soonest</option>
              <option value="life">Most life used</option>
              <option value="fires">Most fires</option>
              <option value="check">Stalest check</option>
              <option value="symbol">Instrument</option>
            </select>
            <div class="seg" role="group" aria-label="View">
              <button type="button" [class.on]="prefs().view === 'table'" (click)="setPref('view', 'table')" title="Table (v)">▤ Table</button>
              <button type="button" [class.on]="prefs().view === 'cards'" (click)="setPref('view', 'cards')" title="Cards by instrument (v)">▦ Cards</button>
            </div>
            <div class="seg" role="group" aria-label="Density">
              <button type="button" [class.on]="prefs().density === 'comfortable'" (click)="setPref('density', 'comfortable')" title="Comfortable">Roomy</button>
              <button type="button" [class.on]="prefs().density === 'compact'" (click)="setPref('density', 'compact')" title="Compact">Dense</button>
            </div>
          </div>
        </div>

        @if (activeFilterChips().length > 0) {
          <div class="active-filters">
            @for (f of activeFilterChips(); track f.key) {
              <button type="button" class="af" (click)="clearFilter(f.key)">{{ f.label }} ✕</button>
            }
            <button type="button" class="link" (click)="clearAllFilters()">Clear all</button>
            <span class="muted small">{{ rows().length }} shown of {{ d.totalCount }} match{{ d.totalCount === 1 ? '' : 'es' }}</span>
          </div>
        }

        <!-- ── Bulk bar ───────────────────────────────────────────────────── -->
        @if (selected().size > 0) {
          <div class="bulk">
            <b>{{ selected().size }} selected</b>
            <button type="button" class="btn btn-secondary sm" (click)="bulk('pause')" [disabled]="bulkBusy()">⏸ Pause</button>
            <button type="button" class="btn btn-secondary sm" (click)="bulk('resume')" [disabled]="bulkBusy()">▶ Resume</button>
            <button type="button" class="btn btn-secondary sm" (click)="bulk('extend')" [disabled]="bulkBusy()">⏱ +6h</button>
            <button type="button" class="btn btn-secondary sm danger" (click)="bulkCancel()" [disabled]="bulkBusy()">✕ Cancel</button>
            <span class="grow"></span>
            <button type="button" class="link" (click)="clearSelection()">Clear selection</button>
          </div>
        }

        <!-- ── Board ──────────────────────────────────────────────────────── -->
        @if (rows().length === 0) {
          <div class="empty-card">
            <p class="empty-title">{{ attentionOnly() ? 'Nothing needs attention' : 'No monitors match' }}</p>
            <p class="muted small">
              {{
                attentionOnly()
                  ? 'Every live watch on this page is checked on time, with nothing waiting on you.'
                  : 'Adjust the filters, create one here, or ask the chat to watch something.'
              }}
            </p>
          </div>
        } @else if (prefs().view === 'table') {
          <div class="table-card" [class.compact]="prefs().density === 'compact'">
            <table class="board">
              <thead>
                <tr>
                  <th class="sel">
                    <input type="checkbox" [checked]="allSelected()" [indeterminate]="someSelected()" (change)="toggleAll()" aria-label="Select all" />
                  </th>
                  <th>Monitor</th>
                  <th>Intent</th>
                  <th class="clickable" (click)="sortKey.set('distance')" [class.sorted]="sortKey() === 'distance'">Distance to level</th>
                  <th class="clickable" (click)="sortKey.set('life')" [class.sorted]="sortKey() === 'life'">Life</th>
                  <th class="num clickable" (click)="sortKey.set('fires')" [class.sorted]="sortKey() === 'fires'">Fires</th>
                  <th class="num clickable" (click)="sortKey.set('check')" [class.sorted]="sortKey() === 'check'">Check</th>
                  <th>Status</th>
                  <th class="actions-col"></th>
                </tr>
              </thead>
              <tbody>
                @for (m of rows(); track m.id; let i = $index) {
                  @let prox = proximity(m);
                  @let reasons = attention(m);
                  <tr
                    class="row"
                    [class.selected]="selectedId() === m.id"
                    [class.cursor]="cursor() === i"
                    [class.checked]="selected().has(m.id)"
                    [class.ended]="!isOpen(m)"
                    tabindex="0"
                    (click)="openDetail(m.id, i)"
                    (keydown.enter)="openDetail(m.id, i)"
                  >
                    <td class="sel" (click)="$event.stopPropagation()">
                      <input type="checkbox" [checked]="selected().has(m.id)" (change)="toggleSelect(m.id)" [attr.aria-label]="'Select monitor #' + m.id" />
                    </td>
                    <td class="mon">
                      <div class="mon-line">
                        @if (reasons.length) {
                          <span class="att" [title]="reasons.join(' · ')">!</span>
                        }
                        <span class="sym mono">{{ m.subjectLabel || m.symbol }}</span>
                        @if (m.subjectKind && m.subjectKind !== 'Symbol') {
                          <span class="tag subject">{{ m.subjectKind }}</span>
                        } @else {
                          <span class="tf">{{ m.timeframe }}</span>
                        }
                        @if (m.plannedDirection) {
                          <span class="tag dir" [class.buy]="m.plannedDirection === 'Buy'">{{ m.plannedDirection }}</span>
                        }
                      </div>
                      <div class="mon-sub">
                        <span class="mono muted">#{{ m.id }}</span>
                        <span class="tag mode" [class.llm]="m.evaluationMode !== 'Deterministic'">{{ m.evaluationMode === 'Deterministic' ? 'live' : 'LLM' }}</span>
                        @if (m.origin === 'hunter') {
                          <span class="tag hunter">hunter</span>
                        }
                        @if ((m.rearmDepth ?? 0) > 0) {
                          <span class="tag" title="Re-arm depth">↻{{ m.rearmDepth }}</span>
                        }
                        @if (m.ocoGroupId) {
                          <span class="tag" title="One-cancels-other group">OCO</span>
                        }
                        @if (m.monitorGroupId) {
                          <span class="tag" [title]="'Fan-out group ' + m.monitorGroupId">group</span>
                        }
                        @if ((m.maxActionTier ?? 0) >= 2) {
                          <span
                            class="tag tier2"
                            [class.dry]="m.dryRunActions"
                            [title]="m.dryRunActions ? 'Authorised to change live state, currently dry-run' : 'AUTHORISED TO CHANGE LIVE TRADING STATE'"
                            >{{ m.dryRunActions ? 'T2 dry' : 'T2 LIVE' }}</span
                          >
                        }
                        @if (m.awaitingAckSinceUtc) {
                          <span class="tag ack">needs ack</span>
                        }
                      </div>
                    </td>
                    <td class="intent">
                      <span class="intent-text" [title]="m.intentText">{{ m.intentText }}</span>
                      @if (prefs().density === 'comfortable') {
                        @if (m.scriptSource) {
                          <span class="explain" [title]="m.scriptLastReading || ''">
                            <span class="tag script">step {{ m.scriptStep ?? 0 }}</span>
                            @if (m.scriptReadyAtUtc) {
                              <span class="tag ready">ready {{ m.scriptReadyAtUtc | date: 'HH:mm' : 'UTC' }}Z</span>
                            }
                            {{ m.scriptLastReading || 'waiting for the first candle close' }}
                          </span>
                        } @else if (m.triggerExplanation || m.lastEvalNote) {
                          <span class="explain" [title]="humanize(m.triggerExplanation || m.lastEvalNote)">{{
                            humanize(m.triggerExplanation || m.lastEvalNote)
                          }}</span>
                        }
                      }
                    </td>
                    <td class="dist">
                      @if (prox) {
                        <div class="prox" [title]="prox.level.label + ' at ' + prox.level.price + ' · last mid ' + m.lastObservedPrice">
                          <div class="prox-top">
                            <span class="mono strong">{{ prox.text }}</span>
                            <span class="mono muted">{{ prox.level.price | number: '1.2-5' }}</span>
                          </div>
                          <div class="prox-track">
                            <div class="prox-fill" [style.width.%]="prox.closeness * 100" [class.hot]="prox.closeness > 0.85"></div>
                          </div>
                          @if (prefs().density === 'comfortable') {
                            <span class="prox-label">{{ prox.level.label }}</span>
                          }
                        </div>
                      } @else if (has(m.lastObservedPrice)) {
                        <span class="mono muted small">mid {{ m.lastObservedPrice | number: '1.2-5' }}</span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="lifecell">
                      @if (isOpen(m)) {
                        <div class="life" [title]="'Expires ' + (m.expiresAtUtc | date: 'MMM d HH:mm' : 'UTC') + ' UTC'">
                          <div class="life-track">
                            <div class="life-fill" [style.width.%]="life(m) * 100" [class.late]="(m.secondsToExpiry ?? 0) < 3600"></div>
                          </div>
                          <span class="mono small" [class.imminent]="(m.secondsToExpiry ?? 0) < 3600">{{ countdown(m.secondsToExpiry ?? 0) }} left</span>
                        </div>
                      } @else {
                        <span class="muted small">{{
                          m.lastTriggeredAtUtc ? 'fired ' + (m.lastTriggeredAtUtc | date: 'MMM d HH:mm' : 'UTC') : 'ended'
                        }}</span>
                      }
                    </td>
                    <td class="num">
                      <span class="mono" [class.strong]="m.triggerCount > 0">{{ m.triggerCount }}/{{ m.maxTriggers }}</span>
                      @if (prefs().density === 'comfortable') {
                        <span class="sub-num"
                          >{{ m.recurring ? 'recurring' : 'one-shot' }}{{ (m.filedSignalCount ?? 0) > 0 ? ' · ' + m.filedSignalCount + ' sig' : '' }}</span
                        >
                      }
                    </td>
                    <td class="num">
                      @if (isOpen(m)) {
                        <span
                          class="check"
                          [class.stale]="overdue(m)"
                          [title]="overdue(m) ? 'Overdue — expects a check every ' + age(cadence(m)) : 'Checked ' + lastCheckLabel(m) + ' ago'"
                          ><span class="cdot" [class.stale]="overdue(m)"></span>{{ lastCheckLabel(m) }}</span
                        >
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      <span class="status" [attr.data-status]="m.status">{{ statusLabel(m.status) }}</span>
                      @if ((m.consecutiveEvalErrors ?? 0) > 0) {
                        <span class="tag err" title="Consecutive failed evaluations">⚠{{ m.consecutiveEvalErrors }}</span>
                      }
                    </td>
                    <td class="actions-col" (click)="$event.stopPropagation()">
                      <ng-container *ngTemplateOutlet="rowActions; context: { $implicit: m }" />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <!-- Cards, grouped by instrument. -->
          <div class="groups">
            @for (g of groups(); track g.symbol) {
              <section class="group">
                <header class="group-head">
                  <span class="sym mono">{{ g.symbol }}</span>
                  <span class="muted small">{{ g.rows.length }} watch{{ g.rows.length === 1 ? '' : 'es' }}</span>
                  @if (has(g.price)) {
                    <span class="mono small muted">mid {{ g.price | number: '1.2-5' }}</span>
                  }
                </header>
                <div class="cards" [class.compact]="prefs().density === 'compact'">
                  @for (m of g.rows; track m.id) {
                    @let prox = proximity(m);
                    @let reasons = attention(m);
                    <article
                      class="mcard"
                      [class.selected]="selectedId() === m.id"
                      [class.checked]="selected().has(m.id)"
                      [class.ended]="!isOpen(m)"
                      tabindex="0"
                      (click)="openDetail(m.id)"
                      (keydown.enter)="openDetail(m.id)"
                    >
                      <header class="mc-head">
                        <input
                          type="checkbox"
                          [checked]="selected().has(m.id)"
                          (click)="$event.stopPropagation()"
                          (change)="toggleSelect(m.id)"
                          [attr.aria-label]="'Select monitor #' + m.id"
                        />
                        <span class="mono muted">#{{ m.id }}</span>
                        <span class="tf">{{ m.timeframe }}</span>
                        @if (m.plannedDirection) {
                          <span class="tag dir" [class.buy]="m.plannedDirection === 'Buy'">{{ m.plannedDirection }}</span>
                        }
                        <span class="tag mode" [class.llm]="m.evaluationMode !== 'Deterministic'">{{ m.evaluationMode === 'Deterministic' ? 'live' : 'LLM' }}</span>
                        @if (m.scriptSource) {
                          <span class="tag script">step {{ m.scriptStep ?? 0 }}</span>
                        }
                        <span class="grow"></span>
                        @if (reasons.length) {
                          <span class="att" [title]="reasons.join(' · ')">!</span>
                        }
                        <span class="status" [attr.data-status]="m.status">{{ statusLabel(m.status) }}</span>
                      </header>
                      <p class="mc-intent">{{ m.intentText }}</p>
                      @if (prefs().density === 'comfortable' && (m.scriptLastReading || m.triggerExplanation || m.lastEvalNote)) {
                        <p class="mc-explain">{{ humanize(m.scriptLastReading || m.triggerExplanation || m.lastEvalNote) }}</p>
                      }
                      @if (prox) {
                        <div class="prox wide">
                          <div class="prox-top">
                            <span class="prox-label">{{ prox.level.label }} · <span class="mono">{{ prox.level.price | number: '1.2-5' }}</span></span>
                            <span class="mono strong">{{ prox.text }}</span>
                          </div>
                          <div class="prox-track">
                            <div class="prox-fill" [style.width.%]="prox.closeness * 100" [class.hot]="prox.closeness > 0.85"></div>
                          </div>
                        </div>
                      }
                      @if (isOpen(m)) {
                        <div class="life row-life">
                          <div class="life-track">
                            <div class="life-fill" [style.width.%]="life(m) * 100" [class.late]="(m.secondsToExpiry ?? 0) < 3600"></div>
                          </div>
                          <span class="mono small" [class.imminent]="(m.secondsToExpiry ?? 0) < 3600">{{ countdown(m.secondsToExpiry ?? 0) }}</span>
                        </div>
                      }
                      <footer class="mc-foot" (click)="$event.stopPropagation()">
                        <span class="small muted">
                          fires <b class="mono">{{ m.triggerCount }}/{{ m.maxTriggers }}</b>
                          @if (isOpen(m)) {
                            · checked <span [class.stale]="overdue(m)">{{ lastCheckLabel(m) }}</span>
                          }
                        </span>
                        <span class="grow"></span>
                        <ng-container *ngTemplateOutlet="rowActions; context: { $implicit: m }" />
                      </footer>
                    </article>
                  }
                </div>
              </section>
            }
          </div>
        }

        @if (d.totalCount > d.pageSize) {
          <div class="pager">
            <button class="btn btn-secondary" [disabled]="page() <= 1" (click)="prevPage()">← Previous</button>
            <span class="muted small">Page {{ d.page }} of {{ Math.ceil(d.totalCount / d.pageSize) }}</span>
            <button class="btn btn-secondary" [disabled]="d.page * d.pageSize >= d.totalCount" (click)="nextPage()">Next →</button>
          </div>
        }

        <!-- ── Activity ───────────────────────────────────────────────────── -->
        @if (d.activity.length > 0) {
          <app-monitor-activity-feed [activity]="d.activity" (openMonitor)="focusMonitor($event)" />
        }

        <p class="keys muted small">
          <kbd>/</kbd> search · <kbd>j</kbd> <kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>x</kbd> select ·
          <kbd>a</kbd> needs attention · <kbd>v</kbd> view · <kbd>r</kbd> refresh · <kbd>Esc</kbd> close
        </p>
      }
    </div>

    <ng-template #rowActions let-m>
      <span class="acts">
        @if (m.awaitingAckSinceUtc) {
          <button type="button" class="act warn" title="Acknowledge the fire" [disabled]="busyId() === m.id" (click)="acknowledge(m.id)">✓</button>
        }
        @if (m.status === 'Active') {
          <button type="button" class="act" title="Pause — stops evaluation, keeps the watch" [attr.aria-label]="'Pause monitor #' + m.id" [disabled]="busyId() === m.id" (click)="pause(m)">⏸</button>
          <button type="button" class="act" title="Fire now — runs the action regardless of trigger" [attr.aria-label]="'Fire monitor #' + m.id + ' now'" [disabled]="busyId() === m.id" (click)="fire(m)">⚡</button>
        } @else if (m.status === 'Paused') {
          <button type="button" class="act" title="Resume" [attr.aria-label]="'Resume monitor #' + m.id" [disabled]="busyId() === m.id" (click)="resume(m)">▶</button>
        }
        @if (m.status === 'Active' || m.status === 'Paused') {
          <button type="button" class="act" title="Extend expiry by 6 hours" [attr.aria-label]="'Extend monitor #' + m.id + ' by 6 hours'" [disabled]="busyId() === m.id" (click)="extend(m, 6)">⏱</button>
          <button type="button" class="act danger" title="Cancel this monitor" [attr.aria-label]="'Cancel monitor #' + m.id" [disabled]="busyId() === m.id" (click)="cancel(m)">✕</button>
        }
        @if (m.scriptSource) {
          <button type="button" class="act" title="Show the Structure Watch on its chart" (click)="openScriptChart(m)">📈</button>
        }
        @if (m.anchorLlmInvocationId) {
          <a
            class="act"
            title="Open the conversation that created this monitor"
            aria-label="Open the conversation that created this monitor"
            [routerLink]="['/conversations']"
            [queryParams]="{ conversation: m.anchorLlmInvocationId }"
            >💬</a
          >
        }
      </span>
    </ng-template>

    @if (selectedId(); as sid) {
      <app-monitor-detail-drawer
        [monitorId]="sid"
        [refreshKey]="drawerRefresh()"
        [busy]="busyId() === sid"
        (closed)="closeDetail()"
        (loaded)="detail.set($event)"
        (openMonitor)="focusMonitor($event)"
        (step)="stepDetail($event)"
        (action)="drawerAction($event)"
      />
    }

    @if (builderOpen()) {
      <app-monitor-builder [seed]="builderSeed()" (closed)="builderOpen.set(false)" (created)="onMonitorCreated()" />
    }

    @if (templatesOpen()) {
      <app-monitor-templates (closed)="templatesOpen.set(false)" (instantiated)="onMonitorCreated()" />
    }

    @if (scriptChart(); as sc) {
      <div class="script-chart-backdrop" (click)="scriptChart.set(null)">
        <div
          class="script-chart-panel"
          (click)="$event.stopPropagation()"
          role="dialog"
          aria-modal="true"
          aria-label="Structure Watch chart"
          appModalA11y
          (dismiss)="scriptChart.set(null)"
        >
          <div class="script-chart-head">
            <strong>{{ sc.title }}</strong>
            <span class="muted">steps count from {{ sc.start }}Z</span>
            <button type="button" class="link" (click)="scriptChart.set(null)">Close</button>
          </div>
          <app-pine-preview [request]="sc.request" />
        </div>
      </div>
    }

    <app-confirm-dialog
      [open]="pendingAction() !== null"
      [title]="actionDialog().title"
      [message]="actionDialog().message"
      [confirmLabel]="actionDialog().confirmLabel"
      [confirmVariant]="pendingAction()?.kind === 'fire' ? 'primary' : 'destructive'"
      (confirm)="confirmAction()"
      (cancelled)="pendingAction.set(null)"
    >
      @if (pendingAction()?.kind === 'cancel' || pendingAction()?.kind === 'bulk-cancel') {
        <label class="reason-field">
          <span>Reason (optional)</span>
          <input
            type="text"
            maxlength="500"
            placeholder="Kept in the monitor's history"
            [ngModel]="cancelReason()"
            (ngModelChange)="cancelReason.set($event)"
          />
        </label>
      }
    </app-confirm-dialog>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0 var(--space-8);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .btn {
        height: 34px;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-family: inherit;
        text-decoration: none;
      }
      .btn.sm {
        height: 28px;
        padding: 0 12px;
        font-size: var(--text-xs);
      }
      .btn-secondary {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .btn.danger:hover:not(:disabled) {
        color: var(--tone-red);
        border-color: var(--tone-red);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .strong {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .grow {
        flex: 1;
      }
      .pos {
        color: var(--tone-green) !important;
      }
      .neg {
        color: var(--tone-red) !important;
      }
      .link {
        background: none;
        border: none;
        padding: 0;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
        font-size: var(--text-xs);
      }

      /* Worker ribbon */
      .ribbon {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px var(--space-4);
        padding: 8px var(--space-4);
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .ribbon b {
        color: var(--text-primary);
      }
      .ribbon[data-health='stalled'] {
        background: color-mix(in srgb, var(--tone-red) 10%, var(--bg-secondary));
        border-color: color-mix(in srgb, var(--tone-red) 35%, transparent);
        color: var(--tone-red);
      }
      .ribbon[data-health='stalled'] b {
        color: var(--tone-red);
      }
      .ribbon[data-health='behind'] {
        background: color-mix(in srgb, var(--tone-amber) 10%, var(--bg-secondary));
        border-color: color-mix(in srgb, var(--tone-amber) 35%, transparent);
      }
      .ribbon code {
        font-family: var(--font-mono, monospace);
      }
      .pulse {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--profit);
        box-shadow: 0 0 0 0 color-mix(in srgb, var(--profit) 60%, transparent);
        animation: pulse 2s infinite;
        flex: none;
      }
      .pulse[data-health='behind'] {
        background: var(--warning);
        animation: none;
      }
      .pulse[data-health='stalled'] {
        background: var(--loss);
        animation: none;
      }
      .pulse[data-health='idle'] {
        background: var(--text-tertiary);
        animation: none;
      }
      @keyframes pulse {
        70% {
          box-shadow: 0 0 0 7px transparent;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .pulse {
          animation: none;
        }
      }
      .rib-fact {
        white-space: nowrap;
      }
      .rib-stamp {
        margin-left: auto;
        color: var(--text-tertiary);
        white-space: nowrap;
      }

      /* KPI band */
      .kpis {
        display: grid;
        grid-template-columns: repeat(8, minmax(0, 1fr));
        gap: var(--space-2);
      }
      @media (max-width: 1500px) {
        .kpis {
          grid-template-columns: repeat(4, minmax(0, 1fr));
        }
      }
      @media (max-width: 720px) {
        .kpis {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      .kpi {
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: left;
        padding: 10px 12px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        font: inherit;
        color: inherit;
        cursor: pointer;
        min-width: 0;
        transition:
          border-color var(--dur-fast, 120ms),
          background var(--dur-fast, 120ms);
      }
      .kpi.static {
        cursor: default;
      }
      .kpi:not(.static):hover {
        border-color: color-mix(in srgb, var(--accent) 40%, transparent);
      }
      .kpi.on {
        border-color: var(--accent);
        box-shadow: inset 0 0 0 1px var(--accent);
      }
      .kpi.alert {
        background: color-mix(in srgb, var(--tone-amber) 8%, var(--bg-secondary));
      }
      .k-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .k-row {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 6px;
      }
      .k-value {
        font-size: 22px;
        line-height: 1.2;
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .k-cap {
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-height: 14px;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--bg-tertiary);
        flex: none;
      }
      .dot.green {
        background: var(--profit);
      }
      .dot.amber {
        background: var(--warning);
      }

      /* Panels */
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: var(--space-3) var(--space-4);
      }
      .panel-head {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .panel-head.open {
        margin-bottom: var(--space-3);
      }
      .panel-head h2 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .disclose {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        color: var(--text-primary);
        font: inherit;
      }
      .chev {
        display: inline-block;
        transition: transform var(--dur-fast, 120ms);
        color: var(--text-tertiary);
      }
      .chev.open {
        transform: rotate(90deg);
      }
      .panel-loading {
        padding: var(--space-5);
        text-align: center;
        font-size: var(--text-sm);
        color: var(--text-tertiary);
      }
      .seg {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        overflow: hidden;
        background: var(--bg-primary);
      }
      .seg button {
        border: none;
        background: none;
        padding: 4px 10px;
        font: inherit;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
        white-space: nowrap;
      }
      .seg button + button {
        border-left: 1px solid var(--border);
      }
      .seg button.on {
        background: var(--text-primary);
        color: var(--bg-primary);
        font-weight: var(--font-semibold);
      }

      /* Toolbar */
      .toolbar {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .tools {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
        align-items: center;
      }
      .tools select,
      .search {
        height: 30px;
        padding: 0 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-xs);
      }
      .search {
        flex: 1 1 260px;
        min-width: 200px;
      }
      .chips {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .chip {
        padding: 3px 10px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
        white-space: nowrap;
      }
      .chip .c {
        margin-left: 3px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .chip.on {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
        font-weight: var(--font-semibold);
      }
      .chip.on .c {
        color: rgba(255, 255, 255, 0.8);
      }
      .active-filters {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
      }
      .af {
        padding: 2px 9px;
        border-radius: var(--radius-full);
        border: 1px dashed color-mix(in srgb, var(--accent) 50%, transparent);
        background: color-mix(in srgb, var(--accent) 8%, transparent);
        color: var(--accent);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .bulk {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 6px var(--space-3);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--accent) 10%, var(--bg-secondary));
        border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
        font-size: var(--text-sm);
        position: sticky;
        top: 0;
        z-index: 5;
      }

      /* Board table */
      .table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        overflow-x: auto;
      }
      .board {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .board th {
        text-align: left;
        padding: 8px 10px;
        color: var(--text-tertiary);
        font-size: 11px;
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .board th.clickable {
        cursor: pointer;
      }
      .board th.sorted {
        color: var(--text-primary);
      }
      .board th.sorted::after {
        content: ' ↓';
      }
      .board td {
        padding: 9px 10px;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .compact .board td {
        padding: 4px 10px;
      }
      .board tbody tr:last-child td {
        border-bottom: none;
      }
      .board .num {
        text-align: right;
        white-space: nowrap;
      }
      .sel {
        width: 28px;
        padding-right: 0 !important;
      }
      .row {
        cursor: pointer;
        transition: background var(--dur-fast, 120ms);
      }
      .row:hover {
        background: var(--bg-tertiary);
      }
      .row.selected {
        background: color-mix(in srgb, var(--accent) 10%, transparent);
      }
      .row.cursor td:first-child {
        box-shadow: inset 3px 0 0 var(--accent);
      }
      .row.checked {
        background: color-mix(in srgb, var(--accent) 6%, transparent);
      }
      .mon {
        min-width: 200px;
        white-space: nowrap;
      }
      .mon-line {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .mon-sub {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-top: 3px;
        font-size: 11px;
      }
      .compact .mon-sub {
        display: none;
      }
      .sym {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .tf {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .att {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--warning);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        flex: none;
      }
      .intent {
        max-width: 440px;
        min-width: 220px;
        color: var(--text-secondary);
      }
      .intent-text {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        color: var(--text-primary);
        line-height: 1.4;
      }
      .compact .intent-text {
        -webkit-line-clamp: 1;
      }
      .row.ended .intent-text {
        color: var(--text-secondary);
      }
      .explain {
        display: block;
        margin-top: 3px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 440px;
      }
      .dist {
        min-width: 170px;
      }
      .prox {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 150px;
      }
      .prox-top {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: var(--text-xs);
      }
      .prox-track,
      .life-track {
        height: 5px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        overflow: hidden;
      }
      .prox-fill {
        height: 100%;
        border-radius: 3px;
        background: var(--accent);
      }
      .prox-fill.hot {
        background: var(--tone-amber);
      }
      .prox-label {
        font-size: 11px;
        color: var(--text-tertiary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lifecell {
        min-width: 120px;
      }
      .life {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .life-fill {
        height: 100%;
        background: var(--text-tertiary);
        border-radius: 3px;
      }
      .life-fill.late {
        background: var(--tone-amber);
      }
      .imminent {
        color: var(--tone-amber);
        font-weight: var(--font-semibold);
      }
      .sub-num {
        display: block;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-variant-numeric: tabular-nums;
      }
      .stale {
        color: var(--tone-red);
        font-weight: var(--font-semibold);
      }
      .cdot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--profit);
      }
      .cdot.stale {
        background: var(--loss);
      }
      .tag {
        display: inline-block;
        padding: 0 6px;
        border-radius: var(--radius-sm);
        font-size: 11px;
        line-height: 17px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .tag.hunter,
      .tag.mode.llm {
        color: var(--tone-purple);
        background: color-mix(in srgb, var(--tone-purple) 14%, transparent);
      }
      .tag.subject,
      .tag.script {
        color: var(--tone-blue);
        background: color-mix(in srgb, var(--tone-blue) 14%, transparent);
      }
      .tag.tier2 {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 16%, transparent);
        font-weight: 600;
      }
      .tag.tier2.dry {
        color: var(--tone-amber);
        background: color-mix(in srgb, var(--tone-amber) 14%, transparent);
        font-weight: 500;
      }
      .tag.ack {
        color: var(--tone-amber);
        background: color-mix(in srgb, var(--tone-amber) 16%, transparent);
        font-weight: 600;
      }
      .tag.ready,
      .tag.ok {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      .tag.dir {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 14%, transparent);
      }
      .tag.dir.buy {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      .tag.err {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 14%, transparent);
        margin-left: 4px;
      }
      .status {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .status[data-status='Active'] {
        color: var(--tone-green);
        background: color-mix(in srgb, var(--tone-green) 14%, transparent);
      }
      .status[data-status='Paused'] {
        color: var(--tone-amber);
        background: color-mix(in srgb, var(--tone-amber) 14%, transparent);
      }
      .status[data-status='Triggered'] {
        color: var(--tone-blue);
        background: color-mix(in srgb, var(--tone-blue) 14%, transparent);
      }
      .status[data-status='Invalidated'],
      .status[data-status='Error'] {
        color: var(--tone-red);
        background: color-mix(in srgb, var(--tone-red) 14%, transparent);
      }
      .actions-col {
        white-space: nowrap;
        text-align: right;
        width: 1%;
      }
      .acts {
        display: inline-flex;
        gap: 3px;
      }
      .act {
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        cursor: pointer;
        font-size: 12px;
        text-decoration: none;
        opacity: 0.75;
      }
      .row:hover .act,
      .mcard:hover .act {
        opacity: 1;
      }
      .act:hover:not(:disabled) {
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .act:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .act.danger:hover:not(:disabled) {
        border-color: var(--tone-red);
        color: var(--tone-red);
      }
      .act.warn {
        color: var(--tone-amber);
        border-color: color-mix(in srgb, var(--tone-amber) 50%, transparent);
        opacity: 1;
      }

      /* Cards */
      .groups {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .group-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        margin-bottom: var(--space-2);
        padding-bottom: 4px;
        border-bottom: 1px solid var(--border);
      }
      .group-head .sym {
        font-size: var(--text-base);
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: var(--space-3);
      }
      .cards.compact {
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: var(--space-2);
      }
      .mcard {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px 14px;
        border-radius: var(--radius-lg);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        cursor: pointer;
        transition: border-color var(--dur-fast, 120ms);
      }
      .cards.compact .mcard {
        padding: 8px 10px;
        gap: 5px;
      }
      .mcard:hover {
        border-color: color-mix(in srgb, var(--accent) 40%, transparent);
      }
      .mcard.selected {
        border-color: var(--accent);
        box-shadow: inset 0 0 0 1px var(--accent);
      }
      .mcard.checked {
        background: color-mix(in srgb, var(--accent) 6%, var(--bg-secondary));
      }
      .mcard.ended {
        opacity: 0.8;
      }
      .mc-head {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs);
      }
      .mc-intent {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        line-height: 1.4;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .cards.compact .mc-intent {
        -webkit-line-clamp: 2;
        font-size: var(--text-xs);
      }
      .mc-explain {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .prox.wide {
        min-width: 0;
      }
      .row-life {
        flex-direction: row;
        align-items: center;
        gap: 8px;
      }
      .row-life .life-track {
        flex: 1;
      }
      .mc-foot {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: auto;
        padding-top: 6px;
        border-top: 1px solid var(--border);
      }

      .empty-card {
        padding: var(--space-6) var(--space-4);
        text-align: center;
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-lg);
      }
      .empty-card p {
        margin: 0;
      }
      .empty-title {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin-bottom: 4px !important;
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-4);
      }

      .keys {
        text-align: center;
        margin: 0;
      }
      kbd {
        display: inline-block;
        padding: 0 5px;
        border: 1px solid var(--border);
        border-bottom-width: 2px;
        border-radius: 4px;
        font-family: var(--font-mono, monospace);
        font-size: 10px;
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }

      .script-chart-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1300;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .script-chart-panel {
        width: min(1200px, 96vw);
        height: min(760px, 90vh);
        display: flex;
        flex-direction: column;
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        padding: 12px;
        gap: 8px;
      }
      .script-chart-panel app-pine-preview {
        flex: 1;
        min-height: 0;
      }
      .script-chart-head {
        display: flex;
        gap: 12px;
        align-items: baseline;
      }
      .script-chart-head .link {
        margin-left: auto;
      }
      .reason-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: var(--space-3);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .reason-field input {
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
      }
    `,
  ],
})
export class AnalysisMonitorsPageComponent {
  /** Template null-check: the lint rule forbids `!= null` in templates, and `!== null` alone misses undefined. */
  protected has<T>(v: T): v is NonNullable<T> {
    return v !== null && v !== undefined;
  }

  private readonly svc = inject(AnalysisMonitorsService);
  private readonly pageContext = inject(PageContextService);
  private readonly uiCommands = inject(UiCommandService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notify = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');

  protected readonly Math = Math;
  protected readonly statusFilters = STATUS_FILTERS;
  protected readonly ranges = RANGES;

  // ── Filters (the assistant drives these signals too) ──────────────────────
  protected readonly statusFilter = signal<string>('Live');
  protected readonly search = signal<string>('');
  protected readonly searchDraft = signal<string>('');
  protected readonly origin = signal<string>('');
  protected readonly mode = signal<string>('');
  protected readonly symbol = signal<string>('');
  protected readonly page = signal(1);
  protected readonly sortKey = signal<SortKey>('default');
  protected readonly attentionOnly = signal(false);

  // ── Selection / drawer ────────────────────────────────────────────────────
  protected readonly selectedId = signal<number | null>(null);
  protected readonly detail = signal<AnalysisMonitorDetail | null>(null);
  protected readonly drawerRefresh = signal(0);
  protected readonly cursor = signal(-1);
  protected readonly selected = signal<ReadonlySet<number>>(new Set());
  protected readonly busyId = signal<number | null>(null);
  protected readonly bulkBusy = signal(false);

  protected readonly builderOpen = signal(false);
  protected readonly builderSeed = signal<AnalysisMonitorDto | null>(null);
  protected readonly templatesOpen = signal(false);

  readonly scriptChart = signal<{ title: string; start: string; request: PineRunRequest } | null>(null);

  // ── Preferences ───────────────────────────────────────────────────────────
  protected readonly prefs = signal<Prefs>(this.loadPrefs());
  protected readonly days = computed(() => this.prefs().days);

  private searchDebounce?: ReturnType<typeof setTimeout>;

  protected readonly board = createPolledResource(
    () =>
      this.svc
        .getBoard({
          statuses: this.statusFilter() ? [this.statusFilter()] : null,
          search: this.search() || null,
          symbol: this.symbol() || null,
          origin: this.origin() || null,
          evaluationMode: this.mode() || null,
          page: this.page(),
          pageSize: 100,
          activityLimit: 80,
        })
        .pipe(
          map((r) => (r?.status && r.data ? r.data : null)),
          catchError(() => of(null)),
        ),
    {
      // Push-driven; the interval only covers a missed push. 30 s keeps "last check" ages honest.
      intervalMs: 30_000,
      refreshOn: ['analysisMonitorFired', 'analysisMonitorInvalidated', 'analysisMonitorChanged', 'analysisMonitorEscalated'],
    },
  );

  protected readonly insightsRes = createPolledResource(
    () =>
      this.svc.getInsights(this.days(), this.symbol() || null, this.origin() || null).pipe(
        map((r) => (r?.status && r.data ? r.data : null)),
        catchError(() => of(null)),
      ),
    { intervalMs: 300_000, refreshOn: ['analysisMonitorFired', 'analysisMonitorInvalidated'] },
  );

  protected readonly data = this.board.value;
  protected readonly ins = this.insightsRes.value;
  protected readonly counters = computed(() => this.data()?.counters ?? null);

  protected readonly health = computed<'ok' | 'behind' | 'stalled' | 'idle'>(() => {
    const c = this.counters();
    if (!c) return 'ok';
    if (c.workerLooksStalled) return 'stalled';
    if (c.workerOverdueCount > 0) return 'behind';
    if (c.active === 0) return 'idle';
    return 'ok';
  });

  /** The page's rows after the client-side attention filter and sort. */
  protected readonly rows = computed(() => {
    let r = [...(this.data()?.monitors ?? [])];
    if (this.attentionOnly()) r = r.filter((m) => this.attention(m).length > 0);
    const key = this.sortKey();
    if (key === 'default') return r;
    const v = (m: AnalysisMonitorDto): number | string => {
      switch (key) {
        case 'symbol':
          return m.symbol;
        case 'distance':
          return -(nearestLevel(m)?.closeness ?? -1);
        case 'life':
          return -lifeProgress(m);
        case 'fires':
          return -m.triggerCount;
        case 'check':
          return -(m.secondsSinceLastCheck ?? 1e12);
        case 'expires':
          return m.isLive ? (m.secondsToExpiry ?? 1e12) : 1e13;
        default:
          return 0;
      }
    };
    return r.sort((a, b) => {
      const x = v(a);
      const y = v(b);
      return typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    });
  });

  protected readonly groups = computed(() => {
    const byKey = new Map<string, AnalysisMonitorDto[]>();
    for (const m of this.rows()) {
      const k = m.subjectLabel || m.symbol;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(m);
    }
    return [...byKey.entries()].map(([symbol, rows]) => ({
      symbol,
      rows,
      price: rows.find((x) => x.lastObservedPrice != null)?.lastObservedPrice ?? null,
    }));
  });

  protected readonly attentionCount = computed(
    () => (this.data()?.monitors ?? []).filter((m) => this.attention(m).length > 0).length,
  );

  protected readonly armedMix = computed(() => {
    const c = this.counters();
    if (!c) return '';
    return `${c.active - c.activeLlmAssisted} live check · ${c.activeLlmAssisted} LLM`;
  });

  protected readonly fireRateText = computed(() => {
    const r = this.ins()?.totals.fireRate;
    return r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`;
  });

  protected readonly pnlText = computed(() => {
    const t = this.ins()?.trades;
    if (!t || t.closedTrades === 0) return '—';
    const v = Math.round(t.netPnl);
    return `${v > 0 ? '+' : ''}${v.toLocaleString()}`;
  });

  protected readonly symbolOptions = computed(() => {
    const set = new Set<string>();
    for (const s of this.ins()?.bySymbol ?? []) set.add(s.symbol);
    for (const m of this.data()?.monitors ?? []) if (m.symbol) set.add(m.symbol);
    if (this.symbol()) set.add(this.symbol());
    return [...set].sort();
  });

  protected readonly activeFilterChips = computed(() => {
    const f: { key: string; label: string }[] = [];
    if (this.symbol()) f.push({ key: 'symbol', label: this.symbol() });
    if (this.search()) f.push({ key: 'search', label: `“${this.search()}”` });
    if (this.origin()) f.push({ key: 'origin', label: `origin: ${this.origin()}` });
    if (this.mode()) f.push({ key: 'mode', label: this.mode() === 'Deterministic' ? 'live check' : 'LLM-judged' });
    if (this.attentionOnly()) f.push({ key: 'attention', label: 'needs attention' });
    if (this.sortKey() !== 'default') f.push({ key: 'sort', label: `sorted: ${this.sortKey()}` });
    return f;
  });

  protected readonly allSelected = computed(() => {
    const r = this.rows();
    return r.length > 0 && r.every((m) => this.selected().has(m.id));
  });
  protected readonly someSelected = computed(() => this.selected().size > 0 && !this.allSelected());

  constructor() {
    this.pageContext.publish(() =>
      monitorsPageFacts({
        statusFilter: this.statusFilter(),
        search: this.search(),
        origin: this.origin(),
        mode: this.mode(),
        page: this.page(),
        monitors: this.data()?.monitors ?? [],
        counters: (this.counters() as unknown as Record<string, number> | null) ?? null,
        detail: this.detail(),
      }),
    );
    this.uiCommands.register(
      monitorsPageCommands({
        statusFilter: this.statusFilter,
        search: this.search,
        origin: this.origin,
        mode: this.mode,
        page: this.page,
        statusKeys: STATUS_FILTERS.map((f) => f.key),
        openMonitor: (id) => this.focusMonitor(id),
        closeMonitor: () => this.closeDetail(),
        openBuilder: (seedId) => {
          if (seedId == null) {
            this.openBuilder(null);
            return true;
          }
          const seed =
            (this.data()?.monitors ?? []).find((m) => m.id === seedId) ??
            (this.detail()?.monitor.id === seedId ? this.detail()!.monitor : null);
          if (!seed) return false;
          this.openBuilder(seed);
          return true;
        },
        openTemplates: () => this.templatesOpen.set(true),
      }),
      this.destroyRef,
    );

    // Re-fetch the board whenever a filter changes; analytics when its scope changes.
    effect(() => {
      this.statusFilter();
      this.search();
      this.symbol();
      this.origin();
      this.mode();
      this.page();
      this.board.refresh();
    });
    effect(() => {
      this.days();
      this.symbol();
      this.origin();
      this.insightsRes.refresh();
    });
    // The assistant sets `search` directly; keep the box in step.
    effect(() => this.searchDraft.set(this.search()));

    // Deep-link: /analysis-monitors?focus=123 (the notification bell links here).
    const focus = Number(this.route.snapshot.queryParamMap.get('focus'));
    if (Number.isFinite(focus) && focus > 0) {
      // A focused monitor is usually terminal (the bell links to fires and expiries).
      this.statusFilter.set('');
      this.selectedId.set(focus);
    }

    // `notificationsChanged` is the load-bearing push: the monitor worker runs in the `llm` role
    // process, which shares no SignalR backplane with `api`, so its direct events reach no browser;
    // the api's notification dispatcher tickles this one instead. The direct subscriptions cost
    // nothing and start working the moment a backplane exists.
    this.realtime.connect();
    this.realtime.on('notificationsChanged').pipe(takeUntilDestroyed()).subscribe(() => this.onPush());
    this.realtime
      .on<{ monitorId: number }>('analysisMonitorChanged')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => this.onPush(p?.monitorId));
    this.realtime
      .on<{ monitorId: number }>('analysisMonitorFired')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => this.onPush(p?.monitorId));
  }

  private onPush(changedId?: number): void {
    this.board.refresh();
    const open = this.selectedId();
    if (open != null && (changedId == null || changedId === open)) this.drawerRefresh.update((n) => n + 1);
  }

  protected refreshAll(): void {
    this.board.refresh();
    this.insightsRes.refresh();
    if (this.selectedId() != null) this.drawerRefresh.update((n) => n + 1);
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  private loadPrefs(): Prefs {
    const def: Prefs = { view: 'table', density: 'comfortable', analyticsOpen: true, days: 14 };
    try {
      const raw = appStorage.getItem(PREFS_KEY);
      if (!raw) return def;
      const p = { ...def, ...(JSON.parse(raw) as Partial<Prefs>) };
      if (!(RANGES as readonly number[]).includes(p.days)) p.days = 14;
      return p;
    } catch {
      return def;
    }
  }

  protected setPref<K extends keyof Prefs>(k: K, v: Prefs[K]): void {
    this.prefs.update((p) => ({ ...p, [k]: v }));
    try {
      appStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs()));
    } catch {
      /* storage unavailable: preferences last for this visit only */
    }
  }

  protected toggleAnalytics(): void {
    this.setPref('analyticsOpen', !this.prefs().analyticsOpen);
  }

  protected setDays(d: number): void {
    this.setPref('days', d);
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  protected statusCount(key: string): number | string {
    const c = this.counters();
    if (!c) return '';
    switch (key) {
      case 'Live':
        return c.active + c.paused;
      case 'Active':
        return c.active;
      case 'Paused':
        return c.paused;
      case 'Triggered':
        return c.triggered;
      case 'Invalidated':
        return c.invalidated;
      case 'Expired':
        return c.expired;
      case 'Cancelled':
        return c.cancelled;
      case 'Error':
        return c.error;
      default:
        return c.active + c.paused + c.triggered + c.invalidated + c.expired + c.cancelled + c.error;
    }
  }

  /** Clicking the chip (or KPI) that is already on goes back to Live, so a KPI works as a toggle. */
  protected setStatus(key: string): void {
    this.statusFilter.set(this.statusFilter() === key && key !== 'Live' ? 'Live' : key);
    this.resetPage();
  }

  protected setSymbol(s: string): void {
    this.symbol.set(s || '');
    this.resetPage();
  }

  protected toggleAttention(): void {
    const on = !this.attentionOnly();
    this.attentionOnly.set(on);
    if (on && this.statusFilter() !== 'Live' && this.statusFilter() !== 'Active') {
      this.statusFilter.set('Live');
      this.resetPage();
    }
  }

  protected onSearch(value: string): void {
    this.searchDraft.set(value);
    clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.search.set(value);
      this.resetPage();
    }, 300);
  }

  protected clearFilter(key: string): void {
    switch (key) {
      case 'symbol':
        this.symbol.set('');
        break;
      case 'search':
        this.search.set('');
        break;
      case 'origin':
        this.origin.set('');
        break;
      case 'mode':
        this.mode.set('');
        break;
      case 'attention':
        this.attentionOnly.set(false);
        break;
      case 'sort':
        this.sortKey.set('default');
        break;
    }
    this.resetPage();
  }

  protected clearAllFilters(): void {
    for (const k of ['symbol', 'search', 'origin', 'mode', 'attention', 'sort']) this.clearFilter(k);
  }

  protected resetPage(): void {
    this.page.set(1);
    this.clearSelection();
  }
  protected nextPage(): void {
    this.page.update((p) => p + 1);
  }
  protected prevPage(): void {
    this.page.update((p) => Math.max(1, p - 1));
  }

  // ── Selection + drawer ────────────────────────────────────────────────────

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected toggleSelect(id: number): void {
    this.selected.update((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  protected toggleAll(): void {
    this.selected.set(this.allSelected() ? new Set() : new Set(this.rows().map((m) => m.id)));
  }

  protected openDetail(id: number, index?: number): void {
    this.cursor.set(index ?? this.rows().findIndex((m) => m.id === id));
    this.selectedId.set(id);
  }

  protected closeDetail(): void {
    this.selectedId.set(null);
    this.detail.set(null);
    if (this.route.snapshot.queryParamMap.has('focus')) {
      this.router.navigate([], { relativeTo: this.route, queryParams: { focus: null }, queryParamsHandling: 'merge' });
    }
  }

  protected stepDetail(delta: number): void {
    const r = this.rows();
    if (r.length === 0) return;
    const open = this.selectedId();
    const cur = open != null ? r.findIndex((m) => m.id === open) : this.cursor();
    const next = Math.min(r.length - 1, Math.max(0, (cur < 0 ? -1 : cur) + delta));
    this.openDetail(r[next].id, next);
  }

  /** Jump to a monitor from the activity feed or lineage, widening filters so it is visible. */
  protected focusMonitor(id: number): void {
    if (!(this.data()?.monitors ?? []).some((m) => m.id === id)) this.statusFilter.set('');
    this.selectedId.set(id);
    this.router.navigate([], { relativeTo: this.route, queryParams: { focus: id }, queryParamsHandling: 'merge' });
  }

  protected drawerAction(a: MonitorDrawerAction): void {
    const m = this.detail()?.monitor;
    if (!m) return;
    switch (a) {
      case 'pause':
        return this.pause(m);
      case 'resume':
        return this.resume(m);
      case 'fire':
        return this.fire(m);
      case 'extend':
        return this.extend(m, 6);
      case 'cancel':
        return this.cancel(m);
      case 'duplicate':
        return this.openBuilder(m);
      case 'ack':
        return this.acknowledge(m.id);
      case 'disarm':
        return this.disarmActions(m.id);
      case 'chart':
        return this.openScriptChart(m);
    }
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  @HostListener('document:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) {
      if (e.key === 'Escape' && t) t.blur();
      return;
    }
    // Overlays own the keyboard while they are open (the drawer handles its own Esc).
    if (this.builderOpen() || this.templatesOpen() || this.scriptChart() || this.pendingAction()) return;
    const r = this.rows();
    switch (e.key) {
      case '/':
        e.preventDefault();
        this.searchBox()?.nativeElement.focus();
        break;
      case 'j':
        if (this.selectedId() != null) this.stepDetail(1);
        else this.cursor.set(Math.min(r.length - 1, this.cursor() + 1));
        break;
      case 'k':
        if (this.selectedId() != null) this.stepDetail(-1);
        else this.cursor.set(Math.max(0, this.cursor() - 1));
        break;
      case 'Enter':
      case 'o':
        if (this.cursor() >= 0 && r[this.cursor()]) this.openDetail(r[this.cursor()].id, this.cursor());
        break;
      case 'x':
        if (this.cursor() >= 0 && r[this.cursor()]) this.toggleSelect(r[this.cursor()].id);
        break;
      case 'a':
        this.toggleAttention();
        break;
      case 'v':
        this.setPref('view', this.prefs().view === 'table' ? 'cards' : 'table');
        break;
      case 'r':
        this.refreshAll();
        break;
      case 'Escape':
        if (this.selectedId() == null && this.selected().size) this.clearSelection();
        break;
    }
  }

  // ── Authoring ─────────────────────────────────────────────────────────────

  /**
   * Opens the guided builder, optionally seeded from an existing monitor — the answer to "nearly
   * right" for a watch that has already finished and cannot be revived.
   */
  protected openBuilder(seed: AnalysisMonitorDto | null): void {
    this.builderSeed.set(seed);
    this.builderOpen.set(true);
  }

  protected onMonitorCreated(): void {
    this.board.refresh();
    this.insightsRes.refresh();
  }

  openScriptChart(m: AnalysisMonitorDto): void {
    if (!m.scriptSource) return;
    const startIso = m.scriptStartUtc ?? m.createdAtUtc;
    const startMs = Date.parse(startIso.endsWith('Z') ? startIso : startIso + 'Z');
    // The engine sets the script's armedAt input when it runs the watch; the chart does the same,
    // so it shows exactly the steps the watch saw.
    const source = m.scriptSource.replace(/input\.time\(\s*[^,()]+,\s*"armedAt"/, `input.time(${startMs}, "armedAt"`);
    this.scriptChart.set({
      title: `#${m.id} ${m.symbol} ${m.timeframe} · structure watch`,
      start: new Date(startMs).toISOString().slice(0, 16).replace('T', ' '),
      request: { source, symbol: m.symbol, timeframe: m.timeframe, lastBars: 500, mode: 'preview' },
    });
  }

  /**
   * Revokes a monitor's tier-2 authorisation: notify-only AND dry-run in one call, so a later edit
   * cannot put it back into live action without anyone re-approving it. A body that changes nothing
   * comes back as a failure, not a reassurance.
   */
  protected disarmActions(monitorId: number): void {
    this.run(
      monitorId,
      this.svc.update(monitorId, {
        revokeActionAuthorization: true,
        dryRunActions: true,
        reason: 'tier-2 actions disarmed from the cockpit',
      }),
      'Actions disarmed — this monitor can only notify now.',
    );
  }

  /** Acknowledges a fire so it stops escalating. */
  protected acknowledge(monitorId: number): void {
    this.run(monitorId, this.svc.acknowledge(monitorId), 'Acknowledged.');
  }

  // ── Operator verbs ────────────────────────────────────────────────────────

  protected pause(m: AnalysisMonitorDto): void {
    this.run(m.id, this.svc.pause(m.id), 'Monitor paused.');
  }
  protected resume(m: AnalysisMonitorDto): void {
    this.run(m.id, this.svc.resume(m.id), 'Monitor resumed.');
  }
  protected extend(m: AnalysisMonitorDto, hours: number): void {
    this.run(m.id, this.svc.extend(m.id, hours), `Expiry extended by ${hours}h.`);
  }

  /** Force-fire and cancel ask first (the confirm dialog); pause / resume / extend are reversible. */
  protected readonly pendingAction = signal<PendingAction | null>(null);
  protected readonly cancelReason = signal('');

  protected readonly actionDialog = computed(() => {
    const a = this.pendingAction();
    if (!a) return { title: '', message: '', confirmLabel: '' };
    if (a.kind === 'bulk-cancel') {
      return {
        title: `Cancel ${a.ids.length} monitor${a.ids.length === 1 ? '' : 's'}?`,
        message: `${a.ids.map((i) => '#' + i).join(', ')} stop watching for good; their history stays. Pause them instead to keep them.`,
        confirmLabel: `Cancel ${a.ids.length}`,
      };
    }
    const m = a.monitor;
    if (a.kind === 'fire') {
      // Force-fire runs the action for real — a re-analysis, and for a proposeTrade monitor a
      // signal through the risk gates.
      const proposes = /"proposeTrade"\s*:\s*true/.test(m.actionSpecJson ?? '');
      return {
        title: `Fire monitor #${m.id} now?`,
        message:
          `${m.symbol} ${m.timeframe}: its action runs now, whatever the trigger says.` +
          (proposes ? ' Auto-propose is ON: any viable setup from the re-run is filed through the risk gates.' : ''),
        confirmLabel: 'Fire now',
      };
    }
    return {
      title: `Cancel monitor #${m.id}?`,
      message: `${m.symbol} ${m.timeframe} stops watching for good; its history stays. Pause it instead to keep it for later.`,
      confirmLabel: 'Cancel monitor',
    };
  });

  protected fire(m: AnalysisMonitorDto): void {
    this.pendingAction.set({ kind: 'fire', monitor: m });
  }
  protected cancel(m: AnalysisMonitorDto): void {
    this.cancelReason.set('');
    this.pendingAction.set({ kind: 'cancel', monitor: m });
  }

  protected confirmAction(): void {
    const a = this.pendingAction();
    if (!a) return;
    this.pendingAction.set(null);
    const reason = this.cancelReason().trim() || undefined;
    if (a.kind === 'bulk-cancel') {
      this.runBulk(a.ids, (id) => this.svc.cancel(id, reason), 'cancelled');
      return;
    }
    const id = a.monitor.id;
    if (a.kind === 'fire') this.run(id, this.svc.forceFire(id), 'Fire queued — the worker will run it shortly.');
    else this.run(id, this.svc.cancel(id, reason), 'Monitor cancelled.');
  }

  // ── Bulk ──────────────────────────────────────────────────────────────────

  private selectedRows(): AnalysisMonitorDto[] {
    const ids = this.selected();
    return (this.data()?.monitors ?? []).filter((m) => ids.has(m.id));
  }

  protected bulk(kind: 'pause' | 'resume' | 'extend'): void {
    const eligible = this.selectedRows().filter((m) =>
      kind === 'pause' ? m.status === 'Active' : kind === 'resume' ? m.status === 'Paused' : this.isOpen(m),
    );
    if (eligible.length === 0) {
      this.notify.error(`None of the selected monitors can be ${kind === 'extend' ? 'extended' : kind + 'd'}.`);
      return;
    }
    const call =
      kind === 'pause'
        ? (id: number) => this.svc.pause(id)
        : kind === 'resume'
          ? (id: number) => this.svc.resume(id)
          : (id: number) => this.svc.extend(id, 6);
    const verb = kind === 'pause' ? 'paused' : kind === 'resume' ? 'resumed' : 'extended by 6h';
    this.runBulk(eligible.map((m) => m.id), call, verb);
  }

  protected bulkCancel(): void {
    const ids = this.selectedRows()
      .filter((m) => this.isOpen(m))
      .map((m) => m.id);
    if (ids.length === 0) {
      this.notify.error('None of the selected monitors is live.');
      return;
    }
    this.cancelReason.set('');
    this.pendingAction.set({ kind: 'bulk-cancel', ids });
  }

  private runBulk(ids: number[], call: (id: number) => ReturnType<AnalysisMonitorsService['pause']>, verb: string): void {
    this.bulkBusy.set(true);
    forkJoin(
      ids.map((id) =>
        call(id).pipe(
          map((r) => !!r?.status),
          catchError(() => of(false)),
        ),
      ),
    ).subscribe((results) => {
      this.bulkBusy.set(false);
      const ok = results.filter(Boolean).length;
      const failed = ids.length - ok;
      if (failed === 0) this.notify.success(`${ok} monitor${ok === 1 ? '' : 's'} ${verb}.`);
      else this.notify.error(`${ok} ${verb}, ${failed} refused by the engine.`);
      this.clearSelection();
      this.board.refresh();
      if (this.selectedId() != null) this.drawerRefresh.update((n) => n + 1);
    });
  }

  private run(id: number, call: ReturnType<AnalysisMonitorsService['pause']>, successMessage: string): void {
    this.busyId.set(id);
    call.subscribe({
      next: (res) => {
        this.busyId.set(null);
        if (res?.status) {
          this.notify.success(successMessage);
          this.board.refresh();
          if (this.selectedId() === id) this.drawerRefresh.update((n) => n + 1);
        } else {
          this.notify.error(res?.message ?? 'The engine rejected that action.');
        }
      },
      error: (err) => {
        this.busyId.set(null);
        this.notify.error(err?.error?.message ?? err?.message ?? 'The action failed — the engine did not answer.');
      },
    });
  }

  // ── Template helpers ──────────────────────────────────────────────────────

  protected spark(series: 'fired' | 'invalidated'): number[] {
    return (this.ins()?.daily ?? []).map((d) => d[series]);
  }

  // These compare with `=== null || === undefined` because the template lint rule forbids loose
  // equality, and `=== null` alone would render a never-checked monitor as "0s ago".
  protected describeFreshestCheck(c: AnalysisMonitorBoardCounters): string {
    const f = c.workerLastCheckSeconds;
    return f === null || f === undefined ? 'none of them has ever been checked' : `the freshest check is ${formatAge(f)} old`;
  }
  protected lastCheckLabel(m: AnalysisMonitorDto): string {
    return m.secondsSinceLastCheck === null || m.secondsSinceLastCheck === undefined ? 'never' : formatAge(m.secondsSinceLastCheck);
  }

  protected isOpen(m: AnalysisMonitorDto): boolean {
    return m.status === 'Active' || m.status === 'Paused';
  }
  protected statusLabel(s: string): string {
    return s === 'Triggered' ? 'Fired' : s === 'Invalidated' ? 'Thesis broke' : s;
  }
  protected proximity(m: AnalysisMonitorDto) {
    return this.isOpen(m) ? nearestLevel(m) : null;
  }
  protected attention(m: AnalysisMonitorDto): string[] {
    return this.isOpen(m) || m.status === 'Error' ? attentionReasons(m) : [];
  }
  protected life(m: AnalysisMonitorDto): number {
    return lifeProgress(m);
  }
  protected overdue(m: AnalysisMonitorDto): boolean {
    return isOverdue(m);
  }
  protected cadence(m: AnalysisMonitorDto): number {
    return expectedCadence(m);
  }
  protected age(s: number): string {
    return formatAge(s);
  }
  protected countdown(s: number): string {
    return formatCountdown(s);
  }
  protected humanize(n: string | null | undefined): string {
    return humanizeNote(n);
  }
  protected hours(h: number | null | undefined): string {
    if (h === null || h === undefined) return '—';
    if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
    if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
    return `${(h / 24).toFixed(1)}d`;
  }
}
