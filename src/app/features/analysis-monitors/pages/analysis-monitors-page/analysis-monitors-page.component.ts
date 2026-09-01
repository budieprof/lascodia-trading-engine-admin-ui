import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';

import { AnalysisMonitorsService } from '@core/services/analysis-monitors.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import { createPolledResource } from '@core/polling/polled-resource';
import type { AnalysisMonitorDto } from '@core/api/api.types';
import type {
  AnalysisMonitorBoardCounters,
  AnalysisMonitorDetail,
} from '@features/analysis-monitors/analysis-monitors.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/** Status filter chips, in the order an operator scans them. */
const STATUS_FILTERS = [
  { key: 'Live', label: 'Live' },
  { key: 'Active', label: 'Active' },
  { key: 'Paused', label: 'Paused' },
  { key: 'Triggered', label: 'Fired' },
  { key: 'Invalidated', label: 'Invalidated' },
  { key: 'Expired', label: 'Expired' },
  { key: 'Cancelled', label: 'Cancelled' },
  { key: 'Error', label: 'Error' },
  { key: '', label: 'All' },
] as const;

/**
 * Operator cockpit for analysis monitors.
 *
 * <p>Monitors are created from the LLM chat and, until this page existed, could
 * only be seen from inside the conversation that created them: an anchor-scoped,
 * active-only strip that vanished with the chat window. A watch could fire,
 * break its thesis, fail evaluation repeatedly, or quietly run out its clock with
 * no operator-visible trace anywhere.</p>
 *
 * <p>Three things this page treats as load-bearing rather than decorative:</p>
 * <ul>
 *   <li><b>Worker liveness.</b> "Active" describes the row, not the system. If
 *   the LLM role process is down, every monitor still reads Active while being
 *   functionally dead. The stalled banner is the first thing rendered.</li>
 *   <li><b>History.</b> The engine keeps an append-only event log per monitor, so
 *   the timeline can answer "why did this never fire", not just "what is its
 *   current note" — the single field the old strip had.</li>
 *   <li><b>Reversible verbs.</b> Pause / resume / extend / edit exist so the
 *   answer to "nearly right" stops being "cancel it and ask the LLM again",
 *   which threw away the fire history and the anchor thread.</li>
 * </ul>
 */
@Component({
  selector: 'app-analysis-monitors-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Analysis monitors"
        subtitle="Live market watches created from the LLM chat — what is armed, what fired, and why"
      >
        <a routerLink="/conversations" class="btn btn-secondary">💬 Conversations</a>
        <button class="btn btn-secondary" (click)="board.refresh()">↻ Refresh</button>
      </app-page-header>

      @if (counters(); as c) {
        @if (c.workerLooksStalled) {
          <div class="banner error">
            <strong>The monitor worker is not evaluating.</strong>
            {{ c.active }} monitor{{ c.active === 1 ? '' : 's' }} read as Active, but
            {{ describeFreshestCheck(c) }}. Nothing below will fire until the <code>llm</code> role
            process is running with <code>Llm:SpotMonitorEnabled</code> on.
          </div>
        } @else if (c.workerOverdueCount > 0) {
          <div class="banner warn">
            The worker is running, but {{ c.workerOverdueCount }} of {{ c.active }} armed monitor{{
              c.active === 1 ? '' : 's'
            }}
            {{ c.workerOverdueCount === 1 ? 'is' : 'are' }} overdue for a check — it may be starved
            or stuck on a subset.
          </div>
        }
      }

      @if (board.loading() && !data()) {
        <app-card-skeleton />
      } @else if (board.error()) {
        <app-error-state
          title="Could not load monitors"
          message="The engine did not answer. Watches may be armed that are not shown here."
          (retry)="board.refresh()"
        />
      } @else if (data(); as d) {
        <div class="kpi-strip">
          <app-metric-card
            label="Armed"
            [value]="d.counters.active"
            [dotColor]="d.counters.active > 0 ? 'var(--profit)' : undefined"
          />
          <app-metric-card label="Paused" [value]="d.counters.paused" />
          <app-metric-card label="Fired (24h)" [value]="d.counters.firedLast24h" />
          <app-metric-card
            label="Expiring < 1h"
            [value]="d.counters.expiringWithin1h"
            [dotColor]="d.counters.expiringWithin1h > 0 ? 'var(--warning)' : undefined"
          />
          <app-metric-card
            label="LLM-judged"
            [value]="d.counters.activeLlmAssisted"
            [dotColor]="d.counters.activeLlmAssisted > 0 ? 'var(--accent)' : undefined"
          />
          <app-metric-card
            label="Errored"
            [value]="d.counters.error"
            [dotColor]="d.counters.error > 0 ? 'var(--loss)' : undefined"
          />
        </div>

        <div class="filter-row">
          <div class="chips">
            @for (s of statusFilters; track s.key) {
              <button class="chip" [class.on]="statusFilter() === s.key" (click)="setStatus(s.key)">
                {{ s.label }}
              </button>
            }
          </div>
          <input
            class="search"
            type="search"
            placeholder="Search intent, symbol or note…"
            [ngModel]="search()"
            (ngModelChange)="onSearch($event)"
          />
          <select [ngModel]="origin()" (ngModelChange)="origin.set($event); resetPage()">
            <option value="">Any origin</option>
            <option value="operator">Operator</option>
            <option value="hunter">Hunter</option>
          </select>
          <select [ngModel]="mode()" (ngModelChange)="mode.set($event); resetPage()">
            <option value="">Any mode</option>
            <option value="Deterministic">Deterministic</option>
            <option value="LlmAssisted">LLM-judged</option>
          </select>
          <span class="stamp">
            {{ d.totalCount }} match{{ d.totalCount === 1 ? '' : 'es' }} · as of
            {{ d.asOfUtc | date: 'HH:mm:ss' : 'UTC' }} UTC
          </span>
        </div>

        @if (d.monitors.length === 0) {
          <app-empty-state
            title="No monitors match"
            description="Adjust the filters, or ask the chat to watch something — monitors are created from a conversation."
          />
        } @else {
          <div class="data-table-card">
            <table class="board-table">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Intent</th>
                  <th>Mode</th>
                  <th class="num">Fires</th>
                  <th class="num">Last check</th>
                  <th class="num">Expires</th>
                  <th>Status</th>
                  <th class="actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (m of d.monitors; track m.id) {
                  <tr
                    class="mon-row"
                    [class.selected]="selectedId() === m.id"
                    (click)="toggleDetail(m.id)"
                  >
                    <td>
                      <span class="mono sym">{{ m.symbol }}</span>
                      <span class="tf">{{ m.timeframe }}</span>
                      @if (m.origin === 'hunter') {
                        <span class="tag hunter">hunter</span>
                      }
                      @if (m.plannedDirection) {
                        <span class="tag dir" [class.buy]="m.plannedDirection === 'Buy'">{{
                          m.plannedDirection
                        }}</span>
                      }
                      @if ((m.rearmDepth ?? 0) > 0) {
                        <span class="tag depth" title="Re-arm depth">↻{{ m.rearmDepth }}</span>
                      }
                    </td>
                    <td class="intent" [title]="m.intentText">{{ m.intentText }}</td>
                    <td>
                      <span class="tag mode" [class.llm]="m.evaluationMode !== 'Deterministic'">{{
                        m.evaluationMode === 'Deterministic' ? 'live check' : 'LLM'
                      }}</span>
                      <span class="tag">{{ m.recurring ? 'recurring' : 'one-shot' }}</span>
                    </td>
                    <td class="num">{{ m.triggerCount }}/{{ m.maxTriggers }}</td>
                    <td class="num">
                      @if (neverChecked(m)) {
                        <span class="muted">never</span>
                      } @else {
                        <span
                          [class.stale]="isOverdue(m)"
                          [title]="
                            isOverdue(m)
                              ? 'Overdue — this monitor expects a check every ' +
                                formatAge(expectedCadence(m))
                              : ''
                          "
                          >{{ lastCheckLabel(m) }}</span
                        >
                      }
                    </td>
                    <td class="num">
                      @if (m.isLive) {
                        <span
                          class="mono"
                          [class.imminent]="(m.secondsToExpiry ?? 0) < 3600"
                          [title]="m.expiresAtUtc | date: 'MMM d, HH:mm' : 'UTC'"
                          >{{ formatCountdown(m.secondsToExpiry ?? 0) }}</span
                        >
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td>
                      <span class="status" [attr.data-status]="m.status">{{ m.status }}</span>
                      @if ((m.consecutiveEvalErrors ?? 0) > 0) {
                        <span class="tag err" title="Consecutive failed evaluations"
                          >⚠{{ m.consecutiveEvalErrors }}</span
                        >
                      }
                    </td>
                    <td class="actions-col" (click)="$event.stopPropagation()">
                      @if (m.status === 'Active') {
                        <button
                          class="act"
                          title="Pause — stops evaluation, keeps the watch"
                          [disabled]="busyId() === m.id"
                          (click)="pause(m)"
                        >
                          ⏸
                        </button>
                        <button
                          class="act"
                          title="Fire now — runs the action regardless of trigger"
                          [disabled]="busyId() === m.id"
                          (click)="fire(m)"
                        >
                          ⚡
                        </button>
                      } @else if (m.status === 'Paused') {
                        <button
                          class="act"
                          title="Resume"
                          [disabled]="busyId() === m.id"
                          (click)="resume(m)"
                        >
                          ▶
                        </button>
                      }
                      @if (m.status === 'Active' || m.status === 'Paused') {
                        <button
                          class="act"
                          title="Extend expiry by 6 hours"
                          [disabled]="busyId() === m.id"
                          (click)="extend(m, 6)"
                        >
                          ⏱
                        </button>
                        <button
                          class="act danger"
                          title="Cancel this monitor"
                          [disabled]="busyId() === m.id"
                          (click)="cancel(m)"
                        >
                          ✕
                        </button>
                      }
                      <a
                        class="act"
                        title="Open the conversation that created this monitor"
                        [routerLink]="['/conversations']"
                        [queryParams]="{ conversation: m.anchorLlmInvocationId }"
                        >💬</a
                      >
                    </td>
                  </tr>

                  @if (selectedId() === m.id) {
                    <tr class="detail-row">
                      <td colspan="8">
                        @if (detailLoading()) {
                          <p class="muted small">Loading history…</p>
                        } @else if (detail(); as det) {
                          <div class="detail">
                            <div class="detail-cols">
                              <section class="det-block">
                                <h4>Trigger</h4>
                                <pre class="spec">{{ pretty(det.monitor.triggerSpecJson) }}</pre>
                                <h4>Action</h4>
                                <pre class="spec">{{ pretty(det.monitor.actionSpecJson) }}</pre>
                                @if (det.monitor.invalidationSpecJson) {
                                  <h4>Invalidation (thesis break)</h4>
                                  <pre class="spec">{{
                                    pretty(det.monitor.invalidationSpecJson)
                                  }}</pre>
                                }
                                <dl class="facts">
                                  <dt>Created</dt>
                                  <dd>
                                    {{ det.monitor.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC' }}
                                    UTC{{
                                      det.monitor.createdBy ? ' by ' + det.monitor.createdBy : ''
                                    }}
                                  </dd>
                                  <dt>Expires</dt>
                                  <dd>
                                    {{ det.monitor.expiresAtUtc | date: 'MMM d, HH:mm' : 'UTC' }}
                                    UTC
                                  </dd>
                                  <dt>Cooldown</dt>
                                  <dd>{{ det.monitor.cooldownSeconds }}s</dd>
                                  @if (det.monitor.evaluationMode !== 'Deterministic') {
                                    <dt>LLM throttle</dt>
                                    <dd>{{ det.monitor.minEvalIntervalSeconds }}s</dd>
                                  }
                                  @if (hasObservedPrice(det.monitor)) {
                                    <dt>Last price seen</dt>
                                    <dd class="mono">
                                      {{ det.monitor.lastObservedPrice | number: '1.0-5' }}
                                    </dd>
                                  }
                                  <dt>Anchor</dt>
                                  <dd>
                                    <a
                                      [routerLink]="['/conversations']"
                                      [queryParams]="{
                                        conversation: det.monitor.anchorLlmInvocationId,
                                      }"
                                      >#{{ det.monitor.anchorLlmInvocationId }}</a
                                    >
                                  </dd>
                                </dl>

                                @if (det.lineage.length > 0) {
                                  <h4>Re-arm lineage</h4>
                                  <ul class="lineage">
                                    @for (l of det.lineage; track l.id) {
                                      <li>
                                        <span class="tag">{{ l.relation }}</span>
                                        <button class="linkish" (click)="toggleDetail(l.id)">
                                          #{{ l.id }}
                                        </button>
                                        <span class="status" [attr.data-status]="l.status">{{
                                          l.status
                                        }}</span>
                                        <span class="muted small">depth {{ l.rearmDepth }}</span>
                                      </li>
                                    }
                                  </ul>
                                }

                                @if (det.signals.length > 0) {
                                  <h4>Signals filed by this monitor</h4>
                                  <ul class="signals">
                                    @for (s of det.signals; track s.id) {
                                      <li>
                                        <a [routerLink]="['/trade-signals', s.id]">#{{ s.id }}</a>
                                        <span class="tag dir" [class.buy]="s.direction === 'Buy'">{{
                                          s.direction
                                        }}</span>
                                        <span class="status" [attr.data-status]="s.status">{{
                                          s.status
                                        }}</span>
                                        <span class="muted small">{{
                                          s.createdAtUtc | date: 'MMM d, HH:mm' : 'UTC'
                                        }}</span>
                                      </li>
                                    }
                                  </ul>
                                }
                              </section>

                              <section class="det-block">
                                <div class="tl-head">
                                  <h4>Timeline ({{ det.timelineTotal }})</h4>
                                  <label class="check small">
                                    <input
                                      type="checkbox"
                                      [ngModel]="includeHeartbeats()"
                                      (ngModelChange)="setHeartbeats($event)"
                                    />
                                    show routine checks
                                  </label>
                                </div>
                                @if (det.timeline.length === 0) {
                                  <p class="muted small">
                                    No history recorded yet. Monitors created before the history log
                                    shipped only have events from that point on.
                                  </p>
                                } @else {
                                  <ol class="timeline">
                                    @for (e of det.timeline; track e.id) {
                                      <li [attr.data-kind]="e.kind">
                                        <span class="tl-when mono">{{
                                          e.occurredAtUtc | date: 'MMM d HH:mm:ss' : 'UTC'
                                        }}</span>
                                        <span class="tl-kind" [attr.data-kind]="e.kind">{{
                                          e.kind
                                        }}</span>
                                        <span class="tl-note">{{ e.note }}</span>
                                        @if (e.resultLlmInvocationId) {
                                          <a
                                            class="tl-link"
                                            [routerLink]="['/conversations']"
                                            [queryParams]="{
                                              conversation: e.resultLlmInvocationId,
                                            }"
                                            >analysis #{{ e.resultLlmInvocationId }}</a
                                          >
                                        }
                                        @if (e.actorUserId) {
                                          <span class="muted small">by {{ e.actorUserId }}</span>
                                        }
                                      </li>
                                    }
                                  </ol>
                                }
                              </section>
                            </div>
                          </div>
                        }
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>

          @if (d.totalCount > d.pageSize) {
            <div class="pager">
              <button class="btn btn-secondary" [disabled]="page() <= 1" (click)="prevPage()">
                ← Previous
              </button>
              <span class="muted small">
                Page {{ d.page }} of {{ Math.ceil(d.totalCount / d.pageSize) }}
              </span>
              <button
                class="btn btn-secondary"
                [disabled]="d.page * d.pageSize >= d.totalCount"
                (click)="nextPage()"
              >
                Next →
              </button>
            </div>
          }
        }

        @if (d.activity.length > 0) {
          <section class="card">
            <header class="card-head">
              <h2>Recent activity</h2>
              <span class="muted small">
                Fires, invalidations, expiries and operator actions across the whole fleet. Routine
                "checked, not met" heartbeats are excluded.
              </span>
            </header>
            <ul class="feed">
              @for (a of d.activity; track a.id) {
                <li>
                  <span class="tl-when mono">{{
                    a.occurredAtUtc | date: 'MMM d HH:mm' : 'UTC'
                  }}</span>
                  <span class="tl-kind" [attr.data-kind]="a.kind">{{ a.kind }}</span>
                  <button class="linkish mono" (click)="focusMonitor(a.monitorId)">
                    #{{ a.monitorId }}
                  </button>
                  <span class="mono sym">{{ a.symbol }}</span>
                  <span class="tf">{{ a.timeframe }}</span>
                  <span class="tl-note">{{ a.note }}</span>
                  @if (a.generatedSignalIds) {
                    <span class="tag ok">signals {{ a.generatedSignalIds }}</span>
                  }
                </li>
              }
            </ul>
          </section>
        }
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-6);
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }

      .banner {
        padding: var(--space-3) var(--space-4);
        border-radius: var(--radius-md);
        font-size: var(--text-sm);
        border: 1px solid transparent;
      }
      .banner.error {
        background: rgba(239, 68, 68, 0.12);
        border-color: rgba(239, 68, 68, 0.35);
        color: var(--loss);
      }
      .banner.warn {
        background: rgba(234, 179, 8, 0.12);
        border-color: rgba(234, 179, 8, 0.35);
        color: var(--warning);
      }
      .banner code {
        font-family: var(--font-mono, monospace);
        font-size: 0.9em;
      }

      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }

      .filter-row {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .chips {
        display: flex;
        gap: var(--space-1);
        flex-wrap: wrap;
      }
      .chip {
        padding: 4px 10px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .chip.on {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
        font-weight: var(--font-semibold);
      }
      .search {
        flex: 1 1 240px;
        min-width: 200px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        color: var(--text-primary);
      }
      .stamp {
        margin-left: auto;
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }

      .data-table-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        overflow-x: auto;
      }
      .board-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .board-table th {
        text-align: left;
        padding: var(--space-3);
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .board-table td {
        padding: var(--space-3);
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .board-table th.num,
      .board-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mon-row {
        cursor: pointer;
      }
      .mon-row:hover {
        background: var(--bg-tertiary);
      }
      .mon-row.selected {
        background: var(--bg-tertiary);
      }

      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .sym {
        font-weight: var(--font-semibold);
      }
      .tf {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
        margin-left: 4px;
      }
      .intent {
        max-width: 420px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-secondary);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .stale {
        color: var(--loss);
        font-weight: var(--font-semibold);
      }
      .imminent {
        color: var(--warning);
        font-weight: var(--font-semibold);
      }

      .tag {
        display: inline-block;
        padding: 1px 6px;
        margin-left: 4px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      .tag.hunter {
        background: rgba(192, 38, 211, 0.15);
        color: #c026d3;
        border-color: transparent;
      }
      .tag.mode.llm {
        background: rgba(124, 58, 237, 0.15);
        color: #7c3aed;
        border-color: transparent;
      }
      .tag.dir {
        background: rgba(239, 68, 68, 0.15);
        color: var(--loss);
        border-color: transparent;
      }
      .tag.dir.buy {
        background: rgba(34, 197, 94, 0.15);
        color: var(--profit);
      }
      .tag.err {
        background: rgba(239, 68, 68, 0.15);
        color: var(--loss);
        border-color: transparent;
      }
      .tag.ok {
        background: rgba(34, 197, 94, 0.15);
        color: var(--profit);
        border-color: transparent;
      }

      .status {
        display: inline-block;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status[data-status='Active'] {
        background: rgba(34, 197, 94, 0.15);
        color: var(--profit);
      }
      .status[data-status='Paused'] {
        background: rgba(234, 179, 8, 0.15);
        color: var(--warning);
      }
      .status[data-status='Triggered'] {
        background: rgba(59, 130, 246, 0.15);
        color: #2563eb;
      }
      .status[data-status='Invalidated'],
      .status[data-status='Error'] {
        background: rgba(239, 68, 68, 0.15);
        color: var(--loss);
      }

      .actions-col {
        white-space: nowrap;
        text-align: right;
      }
      .act {
        background: transparent;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        cursor: pointer;
        padding: 3px 7px;
        margin-left: 3px;
        font-size: var(--text-sm);
        text-decoration: none;
        display: inline-block;
      }
      .act:hover:not(:disabled) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .act:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .act.danger:hover:not(:disabled) {
        border-color: var(--loss);
        color: var(--loss);
      }

      .detail-row td {
        background: var(--bg-primary);
        padding: var(--space-4);
      }
      .detail-cols {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.4fr);
        gap: var(--space-5);
      }
      @media (max-width: 900px) {
        .detail-cols {
          grid-template-columns: 1fr;
        }
      }
      .det-block h4 {
        margin: var(--space-3) 0 var(--space-1);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .det-block h4:first-child {
        margin-top: 0;
      }
      .spec {
        margin: 0;
        padding: var(--space-2);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: var(--text-xs);
        overflow-x: auto;
        white-space: pre;
      }
      .facts {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 2px var(--space-3);
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
      }
      .facts dt {
        color: var(--text-tertiary);
      }
      .facts dd {
        margin: 0;
        color: var(--text-secondary);
      }
      .lineage,
      .signals {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: var(--text-xs);
      }
      .lineage li,
      .signals li {
        display: flex;
        gap: var(--space-2);
        align-items: center;
        padding: 2px 0;
      }
      .linkish {
        background: none;
        border: none;
        padding: 0;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
      }

      .tl-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--text-tertiary);
      }
      .timeline,
      .feed {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: var(--text-xs);
        max-height: 420px;
        overflow-y: auto;
      }
      .timeline li,
      .feed li {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        padding: 4px 0;
        border-bottom: 1px solid var(--border);
        flex-wrap: wrap;
      }
      .tl-when {
        color: var(--text-tertiary);
        white-space: nowrap;
      }
      .tl-kind {
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .tl-kind[data-kind='Fired'] {
        background: rgba(34, 197, 94, 0.18);
        color: var(--profit);
      }
      .tl-kind[data-kind='Suppressed'] {
        background: rgba(234, 179, 8, 0.18);
        color: var(--warning);
      }
      .tl-kind[data-kind='Invalidated'],
      .tl-kind[data-kind='EvalError'] {
        background: rgba(239, 68, 68, 0.18);
        color: var(--loss);
      }
      .tl-kind[data-kind='Expired'],
      .tl-kind[data-kind='Cancelled'] {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .tl-note {
        color: var(--text-secondary);
        flex: 1 1 200px;
        min-width: 0;
        word-break: break-word;
      }
      .tl-link {
        color: var(--accent);
        white-space: nowrap;
      }

      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: var(--space-4);
      }
      .card-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        flex-wrap: wrap;
        margin-bottom: var(--space-3);
      }
      .card-head h2 {
        margin: 0;
        font-size: var(--text-base);
      }

      .pager {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-4);
      }
    `,
  ],
})
export class AnalysisMonitorsPageComponent {
  private readonly svc = inject(AnalysisMonitorsService);
  private readonly notify = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly Math = Math;
  protected readonly statusFilters = STATUS_FILTERS;

  protected readonly statusFilter = signal<string>('Live');
  protected readonly search = signal<string>('');
  protected readonly origin = signal<string>('');
  protected readonly mode = signal<string>('');
  protected readonly page = signal(1);

  protected readonly selectedId = signal<number | null>(null);
  protected readonly detail = signal<AnalysisMonitorDetail | null>(null);
  protected readonly detailLoading = signal(false);
  protected readonly includeHeartbeats = signal(false);
  protected readonly busyId = signal<number | null>(null);

  private searchDebounce?: ReturnType<typeof setTimeout>;

  protected readonly board = createPolledResource(
    () =>
      this.svc
        .getBoard({
          statuses: this.statusFilter() ? [this.statusFilter()] : null,
          search: this.search() || null,
          origin: this.origin() || null,
          evaluationMode: this.mode() || null,
          page: this.page(),
          pageSize: 50,
          activityLimit: 40,
        })
        .pipe(
          map((r) => (r?.status && r.data ? r.data : null)),
          catchError(() => of(null)),
        ),
    // 15s: monitors change on the worker's 20s cadence, and realtime pushes
    // cover anything that happens in between.
    { intervalMs: 15_000 },
  );

  protected readonly data = this.board.value;
  protected readonly counters = computed(() => this.data()?.counters ?? null);

  constructor() {
    // Re-fetch whenever a filter changes.
    effect(() => {
      this.statusFilter();
      this.search();
      this.origin();
      this.mode();
      this.page();
      this.board.refresh();
    });

    // Deep-link: /analysis-monitors?focus=123 (the notification bell links here).
    const focus = Number(this.route.snapshot.queryParamMap.get('focus'));
    if (Number.isFinite(focus) && focus > 0) {
      // A focused monitor is usually terminal (the bell links to fires and
      // expiries), so widen the status filter or the row would not be in the page.
      this.statusFilter.set('');
      this.selectedId.set(focus);
      this.loadDetail(focus);
    }

    // Live updates.
    //
    // `notificationsChanged` is the load-bearing one. The monitor worker runs in
    // the role-scoped `llm` container, which publishes no port and shares no
    // SignalR backplane with `api` — so the events it pushes directly
    // (`analysisMonitorFired`, `analysisMonitorChanged`) reach zero browsers.
    // The `api` container's NotificationDispatcherWorker polls the monitor-event
    // table and tickles `notificationsChanged`, which DOES arrive. The direct
    // subscriptions below are kept because they cost nothing and would start
    // working the moment a backplane is introduced — but the 15s poll plus this
    // tickle are what the page actually relies on.
    this.realtime.connect();
    this.realtime
      .on('notificationsChanged')
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.refreshAll());
    this.realtime
      .on<{ monitorId: number }>('analysisMonitorChanged')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => this.refreshAll(p?.monitorId));
    this.realtime
      .on<{ monitorId: number }>('analysisMonitorFired')
      .pipe(takeUntilDestroyed())
      .subscribe((p) => this.refreshAll(p?.monitorId));
  }

  /** Refetch the board, and the open detail when it is the one that changed. */
  private refreshAll(changedId?: number): void {
    this.board.refresh();
    const open = this.selectedId();
    if (open != null && (changedId == null || changedId === open)) this.loadDetail(open);
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  protected setStatus(key: string): void {
    this.statusFilter.set(key);
    this.resetPage();
  }

  protected onSearch(value: string): void {
    clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.search.set(value);
      this.resetPage();
    }, 300);
  }

  protected resetPage(): void {
    this.page.set(1);
  }

  protected nextPage(): void {
    this.page.update((p) => p + 1);
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(1, p - 1));
  }

  // ── Detail ────────────────────────────────────────────────────────────────

  protected toggleDetail(id: number): void {
    if (this.selectedId() === id) {
      this.selectedId.set(null);
      this.detail.set(null);
      return;
    }
    this.selectedId.set(id);
    this.loadDetail(id);
  }

  /** Jump to a monitor from the activity feed, widening filters so it is visible. */
  protected focusMonitor(id: number): void {
    this.statusFilter.set('');
    this.selectedId.set(id);
    this.loadDetail(id);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { focus: id },
      queryParamsHandling: 'merge',
    });
  }

  protected setHeartbeats(on: boolean): void {
    this.includeHeartbeats.set(on);
    const id = this.selectedId();
    if (id) this.loadDetail(id);
  }

  private loadDetail(id: number): void {
    this.detailLoading.set(true);
    this.svc.getDetail(id, this.includeHeartbeats()).subscribe({
      next: (res) => {
        this.detail.set(res?.status && res.data ? res.data : null);
        this.detailLoading.set(false);
      },
      error: () => {
        this.detail.set(null);
        this.detailLoading.set(false);
      },
    });
  }

  // ── Operator actions ──────────────────────────────────────────────────────

  protected pause(m: AnalysisMonitorDto): void {
    this.run(m.id, this.svc.pause(m.id), 'Monitor paused.');
  }

  protected resume(m: AnalysisMonitorDto): void {
    this.run(m.id, this.svc.resume(m.id), 'Monitor resumed.');
  }

  protected extend(m: AnalysisMonitorDto, hours: number): void {
    this.run(m.id, this.svc.extend(m.id, hours), `Expiry extended by ${hours}h.`);
  }

  protected fire(m: AnalysisMonitorDto): void {
    // Force-fire runs the monitor's action for real — a re-analysis, and for a
    // proposeTrade monitor a signal through the risk gates. Worth a confirm.
    const proposes = /"proposeTrade"\s*:\s*true/.test(m.actionSpecJson ?? '');
    const warning = proposes
      ? '\n\nThis monitor has auto-propose ON: any viable setup from the re-run will be filed through the risk gates.'
      : '';
    if (!confirm(`Fire monitor #${m.id} (${m.symbol} ${m.timeframe}) now?${warning}`)) return;
    this.run(m.id, this.svc.forceFire(m.id), 'Fire queued — the worker will run it shortly.');
  }

  protected cancel(m: AnalysisMonitorDto): void {
    const reason = prompt(
      `Cancel monitor #${m.id} (${m.symbol} ${m.timeframe})?\n\nReason (optional):`,
    );
    // `prompt` returns null on dismiss and '' on an empty submit — only the
    // former means "don't do it".
    if (reason === null) return;
    this.run(m.id, this.svc.cancel(m.id, reason || undefined), 'Monitor cancelled.');
  }

  private run(
    id: number,
    call: ReturnType<AnalysisMonitorsService['pause']>,
    successMessage: string,
  ): void {
    this.busyId.set(id);
    call.subscribe({
      next: (res) => {
        this.busyId.set(null);
        if (res?.status) {
          this.notify.success(successMessage);
          this.board.refresh();
          if (this.selectedId() === id) this.loadDetail(id);
        } else {
          this.notify.error(res?.message ?? 'The engine rejected that action.');
        }
      },
      error: (err) => {
        this.busyId.set(null);
        this.notify.error(
          err?.error?.message ?? err?.message ?? 'The action failed — the engine did not answer.',
        );
      },
    });
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  // These three exist as methods rather than template expressions because the
  // check that matters is `== null` — "null OR undefined" — and the template
  // lint rule forbids loose equality. Writing `=== null` inline would silently
  // stop matching an absent field, which is exactly how a never-checked monitor
  // would start rendering as "0s ago" instead of "never".

  /** Phrase for the stalled banner, covering "never checked at all". */
  protected describeFreshestCheck(c: AnalysisMonitorBoardCounters): string {
    const freshest = c.workerLastCheckSeconds;
    return freshest === null || freshest === undefined
      ? 'none of them has ever been checked'
      : `the freshest check is ${this.formatAge(freshest)} old`;
  }

  protected neverChecked(m: AnalysisMonitorDto): boolean {
    return m.secondsSinceLastCheck === null || m.secondsSinceLastCheck === undefined;
  }

  /** "4m" since the worker last looked at this monitor, or "never". */
  protected lastCheckLabel(m: AnalysisMonitorDto): string {
    return this.neverChecked(m) ? 'never' : this.formatAge(m.secondsSinceLastCheck as number);
  }

  protected hasObservedPrice(m: AnalysisMonitorDto): boolean {
    return m.lastObservedPrice !== null && m.lastObservedPrice !== undefined;
  }

  /**
   * How often this monitor expects to be evaluated, in seconds.
   *
   * Deterministic monitors are checked every worker loop (~20s); LLM-judged ones
   * are deliberately throttled to `minEvalIntervalSeconds` to bound model spend.
   * Judging both against one flat number would paint a perfectly healthy
   * LLM-judged fleet as stale on every row. Mirrors the engine's
   * `OverdueToleranceSeconds`.
   */
  protected expectedCadence(m: AnalysisMonitorDto): number {
    return m.evaluationMode === 'Deterministic'
      ? 120
      : Math.max(120, (m.minEvalIntervalSeconds ?? 300) * 2);
  }

  protected isOverdue(m: AnalysisMonitorDto): boolean {
    if (!m.isLive) return false;
    if (m.secondsSinceLastCheck == null) return true;
    return m.secondsSinceLastCheck > this.expectedCadence(m);
  }

  /** "3s" / "4m" / "2h 10m" — how long ago something happened. */
  protected formatAge(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  /** "12m" / "3h 14m" / "2d 4h", or "overdue" once past. */
  protected formatCountdown(seconds: number): string {
    if (seconds <= 0) return 'overdue';
    const s = Math.round(seconds);
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86_400) {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3600);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }

  /** Pretty-print an LLM-authored spec, falling back to the raw string when it
   *  will not parse — a malformed spec is exactly what you want to SEE here. */
  protected pretty(json: string | null | undefined): string {
    if (!json) return '—';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }
}
