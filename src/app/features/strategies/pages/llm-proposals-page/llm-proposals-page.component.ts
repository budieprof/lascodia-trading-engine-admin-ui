import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  LlmProposalDto,
  LlmProposalStatusDto,
  StrategyProposalCycleResult,
} from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

const STATUS_TABS = ['Pending', 'DslInvalid', 'Approved', 'Rejected', 'Duplicate', 'All'] as const;

@Component({
  selector: 'app-llm-proposals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
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
        title="Strategies — LLM Proposals"
        subtitle="LLM-generated strategy candidates. Inspect the DSL before promoting to a Paused strategy."
      >
        <a routerLink="/strategies" class="btn btn-secondary">← Strategies</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
        <button
          type="button"
          class="btn btn-primary"
          [disabled]="triggering() || readiness() !== 'ready'"
          [title]="
            readiness() === 'ready'
              ? 'Run one cycle now — bypasses the worker poll schedule.'
              : 'Worker not ready. Fix the status banner below first.'
          "
          (click)="triggerRunNow()"
        >
          {{ triggering() ? '⏳ Running…' : '▶ Run now' }}
        </button>
      </app-page-header>

      <!-- ── Last manual-run result banner ──────────────────────────── -->
      @if (lastRunResult(); as r) {
        <section class="run-result" [class.empty]="r.totalWritten === 0">
          <header class="run-result-head">
            <strong>
              Manual run completed
              @if (r.totalWritten > 0) {
                — wrote {{ r.totalWritten }} row(s)
              } @else {
                — no rows written
              }
            </strong>
            <button
              type="button"
              class="btn-dismiss"
              (click)="lastRunResult.set(null)"
              aria-label="Dismiss"
            >
              ×
            </button>
          </header>
          <dl class="run-result-grid">
            <div>
              <dt>Pending</dt>
              <dd class="num">{{ r.pendingWritten }}</dd>
            </div>
            <div>
              <dt>DSL invalid</dt>
              <dd class="num">{{ r.dslInvalidWritten }}</dd>
            </div>
            <div>
              <dt>Duplicate</dt>
              <dd class="num">{{ r.duplicateWritten }}</dd>
            </div>
            <div>
              <dt>Auto-promoted</dt>
              <dd
                class="num"
                [class.gain]="r.autoPromotedCount > 0"
                [class.muted]="r.autoPromotedCount === 0"
              >
                {{ r.autoPromotedCount }}
              </dd>
            </div>
            <div>
              <dt>Sources attempted</dt>
              <dd class="num">{{ r.sourcesAttempted }}</dd>
            </div>
            <div>
              <dt>Completed at</dt>
              <dd class="num">{{ r.completedAt | date: 'MMM d, HH:mm:ss' }}</dd>
            </div>
          </dl>
          @if (r.totalWritten === 0) {
            <footer class="run-result-foot">
              Possible reasons: the LLM returned malformed JSON (check /llm/invocations for the
              matching <code>strategy_proposal.generate</code> row + its error), every candidate was
              a duplicate of an existing row, the budget circuit-breaker was tripped, or
              <code>ProposalsPerCycle</code> is set to 0.
            </footer>
          }
        </section>
      }

      <section class="controls">
        <div class="control-group">
          <span class="control-label">Status</span>
          <div class="status-tabs">
            @for (s of STATUS_TABS; track s) {
              <button
                type="button"
                [class.active]="statusFilter() === s"
                (click)="statusFilter.set(s)"
              >
                {{ s }}
              </button>
            }
          </div>
        </div>
        <span class="result-count">
          {{ proposals().length }} proposal{{ proposals().length === 1 ? '' : 's' }} loaded
        </span>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load LLM proposals"
          message="Engine returned an error. The LLM proposal worker may not be enabled — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <!-- ── All-time KPI strip (status-snapshot driven) ──────────── -->
        @if (status(); as st) {
          <section class="kpis">
            <app-metric-card
              label="Total proposals"
              [value]="st.totalProposalsAllTime"
              format="number"
              dotColor="#0071E3"
            />
            <app-metric-card
              label="Pending review"
              [value]="st.pendingCount"
              format="number"
              [dotColor]="st.pendingCount > 0 ? '#FF9500' : '#34C759'"
            />
            <app-metric-card
              label="Promoted"
              [value]="st.approvedCount"
              format="number"
              dotColor="#34C759"
            />
            <app-metric-card
              label="Rejected"
              [value]="st.rejectedCount"
              format="number"
              dotColor="#FF3B30"
            />
            <app-metric-card
              label="DSL invalid"
              [value]="st.dslInvalidCount"
              format="number"
              [dotColor]="st.dslInvalidCount > 0 ? '#FF3B30' : '#8E8E93'"
            />
            <app-metric-card
              label="Approval rate"
              [value]="percent(st.approvalRateAllTime)"
              format="percent"
              [colorByValue]="true"
            />
          </section>

          <!-- ── Worker status card ─────────────────────────────────── -->
          <section class="card status-card" [attr.data-readiness]="readiness()">
            <header class="card-head">
              <h3>Worker Status</h3>
              <span class="readiness-badge" [class]="readiness()">
                <span class="dot"></span>
                {{ readinessLabel(readiness()) }}
              </span>
            </header>
            <dl class="status-grid">
              <div>
                <dt>Enabled</dt>
                <dd>{{ st.workerEnabled ? 'true' : 'false' }}</dd>
              </div>
              <div>
                <dt>API key</dt>
                <dd>{{ st.apiKeyConfigured ? 'configured' : 'missing' }}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd class="mono">{{ st.model }}</dd>
              </div>
              <div>
                <dt>Poll interval</dt>
                <dd>{{ st.pollIntervalHours }} h</dd>
              </div>
              <div>
                <dt>Proposals / cycle</dt>
                <dd>{{ st.proposalsPerCycle }}</dd>
              </div>
              <div>
                <dt>Last attempt</dt>
                <dd>
                  {{ st.lastProposalAt ? (st.lastProposalAt | date: 'MMM d, HH:mm') : 'never' }}
                </dd>
              </div>
              <div>
                <dt>Next scheduled</dt>
                <dd>
                  {{
                    st.nextScheduledRunAt
                      ? (st.nextScheduledRunAt | date: 'MMM d, HH:mm') +
                        ' (' +
                        formatNextRun(st.nextScheduledRunAt) +
                        ')'
                      : '—'
                  }}
                </dd>
              </div>
              <div>
                <dt>Duplicates</dt>
                <dd>{{ st.duplicateCount }}</dd>
              </div>
            </dl>
            @if (readiness() !== 'ready') {
              <footer class="readiness-help">
                @if (readiness() === 'disabled') {
                  Master kill-switch is engaged. Set
                  <code>LlmStrategyProposal:Enabled</code> = <code>true</code> on the
                  <a routerLink="/llm/settings">LLM Settings</a> page to resume the worker.
                } @else if (readiness() === 'no-key') {
                  The proposer routes through the shared LLM client factory, so it uses the same API
                  key as the rest of the narrative layer. Set
                  <code>Llm:&lt;Provider&gt;:ApiKey</code> for whichever provider
                  <code>Llm:DeepProvider</code> currently points at on the
                  <a routerLink="/llm/settings">LLM Settings</a> page — the worker will pick it up
                  on its next poll tick.
                }
              </footer>
            }
          </section>

          <!-- ── Recent activity (all statuses) ─────────────────────── -->
          @if (st.recentActivity.length > 0) {
            <section class="card">
              <header class="card-head">
                <h3>Recent activity</h3>
                <span class="muted">last {{ st.recentActivity.length }} proposal(s)</span>
              </header>
              <table class="recent-table">
                <thead>
                  <tr>
                    <th>Proposed</th>
                    <th>Name</th>
                    <th>Pair</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of st.recentActivity; track r.id) {
                    <tr>
                      <td class="time">{{ r.proposedAt | date: 'MMM d, HH:mm' }}</td>
                      <td class="mono">{{ r.name }}</td>
                      <td class="mono">{{ r.symbol }}</td>
                      <td>
                        <span class="status-pill" [attr.data-status]="r.status">{{
                          r.status
                        }}</span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </section>
          }
        }

        @if (proposals().length === 0) {
          <app-empty-state
            title="No proposals match the current filter"
            description="The status filter above is hiding nothing — the table is genuinely empty at this status. Switch to All / Pending to confirm. New proposals land on the worker's poll schedule (see Worker Status above) and are visible immediately once written."
          />
        } @else {
          <section class="card">
            <table class="proposals-table">
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Pair</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Proposed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (p of proposals(); track p.id) {
                  <tr [class.expanded]="expandedId() === p.id">
                    <td>
                      <span class="prop-id mono small">#{{ p.id }}</span>
                      <div class="prop-name mono">{{ p.name }}</div>
                    </td>
                    <td class="mono">{{ p.symbol }}</td>
                    <td class="mono small">{{ p.source }}</td>
                    <td>
                      <span class="status-pill" [attr.data-status]="p.status">
                        {{ p.status }}
                      </span>
                      @if (p.promotedStrategyId) {
                        <a
                          [routerLink]="['/strategies', p.promotedStrategyId]"
                          class="link small mono"
                          [title]="'Promoted to strategy #' + p.promotedStrategyId"
                        >
                          → #{{ p.promotedStrategyId }}
                        </a>
                      }
                    </td>
                    <td class="time" [title]="p.proposedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ p.proposedAt | relativeTime }}
                    </td>
                    <td class="actions">
                      <button type="button" class="link" (click)="toggleExpand(p.id)">
                        {{ expandedId() === p.id ? 'Hide' : 'Inspect' }}
                      </button>
                      @if (p.status === 'Pending') {
                        <button
                          type="button"
                          class="action ok"
                          (click)="ask(p)"
                          [disabled]="submitting()"
                        >
                          Promote →
                        </button>
                      }
                    </td>
                  </tr>
                  @if (expandedId() === p.id) {
                    <tr class="detail-row">
                      <td colspan="6">
                        <div class="detail-grid">
                          <div>
                            <h4>Plain-English summary</h4>
                            @if (summaryFor(p.id) === 'loading') {
                              <p class="summary muted">Summarising DSL…</p>
                            } @else if (summaryFor(p.id) === 'error') {
                              <p class="summary muted">
                                Summary unavailable — DSL summariser refused or the proposal is
                                malformed. Inspect the raw JSON below.
                              </p>
                            } @else if (summaryFor(p.id); as text) {
                              <p class="summary">{{ text }}</p>
                            }
                            <h4>Proposal JSON</h4>
                            <pre class="json">{{ formatJson(p.proposalJson) }}</pre>
                          </div>
                          <div>
                            <h4>Disposition</h4>
                            <dl>
                              <dt>Status</dt>
                              <dd>{{ p.status }}</dd>
                              <dt>Source</dt>
                              <dd class="mono">{{ p.source }}</dd>
                              @if (p.rejectionReason) {
                                <dt>Rejection reason</dt>
                                <dd class="muted">{{ p.rejectionReason }}</dd>
                              }
                              @if (p.promotedStrategyId) {
                                <dt>Promoted strategy</dt>
                                <dd>
                                  <a
                                    [routerLink]="['/strategies', p.promotedStrategyId]"
                                    class="link mono"
                                  >
                                    #{{ p.promotedStrategyId }}
                                  </a>
                                </dd>
                              }
                            </dl>
                          </div>
                        </div>
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </section>
        }
      }

      @if (pending(); as p) {
        <div class="modal-overlay" (click)="cancel()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>Promote LLM proposal</h2>
              <button type="button" class="close-btn" (click)="cancel()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              <span class="mono">#{{ p.id }} · {{ p.name }}</span>
              <span class="muted small"> · {{ p.symbol }}</span>
            </p>
            <p class="modal-desc">
              Promotion creates a <strong>Paused</strong> Strategy in your library. You can activate
              it after reviewing the auto-generated parameters, or pause-and-edit the DSL further
              before activation. Nothing trades automatically.
            </p>
            <label class="reason-field">
              <span>Reason (optional, written to audit trail)</span>
              <textarea
                rows="2"
                [(ngModel)]="reasonText"
                placeholder="Why is this proposal worth promoting?"
              ></textarea>
            </label>
            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancel()">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="confirm()"
                [disabled]="submitting()"
              >
                {{ submitting() ? 'Promoting…' : 'Promote' }}
              </button>
            </footer>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .controls {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .control-group {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .control-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .status-tabs {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-secondary);
        padding: 4px;
        border-radius: var(--radius-md);
      }
      .status-tabs button {
        background: transparent;
        border: none;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .status-tabs button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .result-count {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin-left: auto;
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .status-card {
        padding: 0;
      }
      .status-card .card-head {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .status-card .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .readiness-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .readiness-badge .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .readiness-badge.ready {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
      }
      .readiness-badge.ready .dot {
        background: #34c759;
      }
      .readiness-badge.disabled {
        background: rgba(142, 142, 147, 0.18);
        color: #6e6e73;
      }
      .readiness-badge.disabled .dot {
        background: #6e6e73;
      }
      .readiness-badge.no-key {
        background: rgba(255, 59, 48, 0.14);
        color: #ff3b30;
      }
      .readiness-badge.no-key .dot {
        background: #ff3b30;
      }
      .status-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        margin: 0;
      }
      .status-grid div {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .status-grid div:nth-child(4n) {
        border-right: none;
      }
      .status-grid dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .status-grid dd {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .status-grid dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .readiness-help {
        padding: var(--space-3) var(--space-5);
        background: rgba(255, 149, 0, 0.06);
        border-top: 1px solid rgba(255, 149, 0, 0.2);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .readiness-help code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        padding: 1px 4px;
        background: var(--bg-tertiary);
        border-radius: 3px;
      }
      .run-result {
        background: rgba(52, 199, 89, 0.06);
        border: 1px solid rgba(52, 199, 89, 0.3);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .run-result.empty {
        background: rgba(255, 149, 0, 0.06);
        border-color: rgba(255, 149, 0, 0.3);
      }
      .run-result-head {
        padding: var(--space-3) var(--space-5);
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: var(--text-sm);
        border-bottom: 1px solid var(--border);
      }
      .btn-dismiss {
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-tertiary);
        font-size: 16px;
        cursor: pointer;
      }
      .btn-dismiss:hover {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }
      .run-result-grid {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        margin: 0;
      }
      .run-result-grid div {
        padding: var(--space-3) var(--space-5);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .run-result-grid div:nth-child(6n) {
        border-right: none;
      }
      .run-result-grid dd.gain {
        color: var(--color-success, #34c759);
      }
      .run-result-grid dd.muted {
        color: var(--text-tertiary);
      }
      .run-result-grid dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 0;
      }
      .run-result-grid dd {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        margin: 0;
      }
      .run-result-grid dd.num {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .run-result-foot {
        padding: var(--space-3) var(--space-5);
        border-top: 1px solid var(--border);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .run-result-foot code {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        padding: 1px 4px;
        background: var(--bg-tertiary);
        border-radius: 3px;
      }
      .recent-table {
        width: 100%;
        border-collapse: collapse;
      }
      .recent-table th,
      .recent-table td {
        padding: var(--space-2) var(--space-5);
        font-size: var(--text-sm);
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .recent-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .recent-table td.time {
        white-space: nowrap;
      }
      .recent-table td.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        overflow-x: auto;
      }
      .proposals-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .proposals-table th,
      .proposals-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .proposals-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .proposals-table tr.expanded {
        background: var(--bg-primary);
      }
      .proposals-table tr.detail-row td {
        background: var(--bg-primary);
        padding: var(--space-3) var(--space-4);
      }
      .prop-id {
        color: var(--text-tertiary);
      }
      .prop-name {
        font-weight: var(--font-medium);
        margin-top: 2px;
        word-break: break-word;
        max-width: 360px;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .status-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        margin-right: 6px;
      }
      .status-pill[data-status='Pending'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .status-pill[data-status='Approved'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .status-pill[data-status='Rejected'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .status-pill[data-status='DslInvalid'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .status-pill[data-status='Duplicate'] {
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
      }
      .status-pill[data-status='Screening'],
      .status-pill[data-status='Validating'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .actions {
        display: flex;
        gap: 6px;
        align-items: center;
        white-space: nowrap;
      }
      .link {
        background: none;
        border: none;
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-xs);
        padding: 4px 6px;
        font-weight: var(--font-medium);
        text-decoration: none;
      }
      .link:hover:not(:disabled) {
        text-decoration: underline;
      }
      .action {
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .action.ok {
        color: #248a3d;
      }
      .action.ok:hover:not(:disabled) {
        background: #34c759;
        color: #fff;
      }
      .action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .detail-grid {
        display: grid;
        grid-template-columns: minmax(280px, 1fr) minmax(220px, 1fr);
        gap: var(--space-4);
      }
      .detail-grid h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .summary {
        margin: 0 0 var(--space-3) 0;
        padding: var(--space-3) var(--space-4);
        background: rgba(0, 113, 227, 0.06);
        border: 1px solid rgba(0, 113, 227, 0.2);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }
      .summary.muted {
        background: var(--bg-tertiary);
        border-color: var(--border);
        color: var(--text-tertiary);
      }
      .json {
        background: var(--bg-secondary);
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        font-family: var(--font-mono);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 360px;
        overflow: auto;
        color: var(--text-secondary);
      }
      dl {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px var(--space-3);
        margin: 0;
        font-size: var(--text-xs);
      }
      dt {
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      dd {
        margin: 0;
        color: var(--text-primary);
      }
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: var(--backdrop-scrim, rgba(0, 0, 0, 0.45));
        display: grid;
        place-items: center;
        z-index: 1000;
      }
      .modal {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-width: 520px;
        width: 90%;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .modal-head h2 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .close-btn {
        background: none;
        border: none;
        font-size: 24px;
        color: var(--text-secondary);
        cursor: pointer;
        line-height: 1;
      }
      .modal-target {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .reason-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .reason-field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .reason-field textarea {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: var(--font-sans);
        resize: vertical;
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
    `,
  ],
})
export class LlmProposalsPageComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  protected readonly STATUS_TABS = STATUS_TABS;

  protected readonly statusFilter = signal<(typeof STATUS_TABS)[number]>('Pending');

  protected readonly resource = createPolledResource(
    () => {
      const s = this.statusFilter();
      return this.strategies.listLlmProposals({ status: s === 'All' ? null : s, limit: 200 }).pipe(
        map((res) => res.data ?? []),
        catchError(() => of<LlmProposalDto[]>([])),
      );
    },
    { intervalMs: 60_000 },
  );

  /** Worker-status snapshot — config, all-time aggregates, recent activity.
   *  Loaded once at construction and on every refresh-button click so the
   *  page header isn't a forever-zero ghost when the table is empty. */
  protected readonly status = signal<LlmProposalStatusDto | null>(null);

  /** True while the manual-trigger POST is in flight. */
  protected readonly triggering = signal(false);

  /** Result of the most recent manual run; rendered in a dismissible
   *  banner. `null` hides the banner. */
  protected readonly lastRunResult = signal<StrategyProposalCycleResult | null>(null);

  constructor() {
    effect(() => {
      this.statusFilter();
      this.resource.refresh();
    });
    // Initial status load + refresh whenever proposals reload.
    this.refreshStatus();
    effect(() => {
      this.resource.value();
      this.refreshStatus();
    });
  }

  private refreshStatus(): void {
    this.strategies
      .getLlmProposalStatus()
      .pipe(
        map((res) => res?.data ?? null),
        catchError(() => of(null as LlmProposalStatusDto | null)),
      )
      .subscribe((s) => this.status.set(s));
  }

  protected triggerRunNow(): void {
    if (this.triggering()) return;
    this.triggering.set(true);
    this.lastRunResult.set(null);
    this.strategies
      .triggerLlmProposalRun()
      .pipe(
        catchError((err) => {
          this.notifications.error?.(
            `Run failed: ${err?.error?.message ?? err?.message ?? String(err)}`,
          );
          return of(null);
        }),
        finalize(() => this.triggering.set(false)),
      )
      .subscribe((res) => {
        if (res?.status && res.data) {
          this.lastRunResult.set(res.data);
          if (res.data.totalWritten > 0) {
            const promoted = res.data.autoPromotedCount;
            const promoteSuffix =
              promoted > 0 ? ` · ${promoted} auto-promoted to Paused strategies` : '';
            this.notifications.success?.(
              `Wrote ${res.data.totalWritten} proposal(s): ${res.data.pendingWritten} pending, ${res.data.dslInvalidWritten} invalid, ${res.data.duplicateWritten} duplicate${promoteSuffix}.`,
            );
          } else {
            this.notifications.error?.(
              'Run completed but no rows were written. See the banner for likely causes.',
            );
          }
          // Refresh the list + status so the new rows show up immediately.
          this.resource.refresh();
          this.refreshStatus();
        } else if (res) {
          this.notifications.error?.(res.message ?? 'Run refused.');
        }
      });
  }

  // Helpers used by the dense header below ----------------------------------
  protected readonly readiness = computed<'ready' | 'disabled' | 'no-key'>(() => {
    const s = this.status();
    if (!s) return 'no-key';
    if (!s.workerEnabled) return 'disabled';
    if (!s.apiKeyConfigured) return 'no-key';
    return 'ready';
  });

  protected readinessLabel(r: 'ready' | 'disabled' | 'no-key'): string {
    return r === 'ready'
      ? 'Worker ready'
      : r === 'disabled'
        ? 'Worker disabled'
        : 'API key missing';
  }

  protected formatNextRun(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const deltaMs = d.getTime() - Date.now();
    if (deltaMs <= 0) return 'overdue';
    const mins = Math.round(deltaMs / 60_000);
    if (mins < 60) return `in ${mins} min`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `in ${hours} h`;
    return `in ${Math.round(hours / 24)} d`;
  }

  protected percent(x: number | null): number {
    return x == null ? 0 : Math.round(x * 1000) / 10;
  }

  protected readonly proposals = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.proposals().length === 0,
  );

  protected countOf(status: string): number {
    return this.proposals().filter((p) => p.status === status).length;
  }

  // Inspect / expand --------------------------------------------------------
  protected readonly expandedId = signal<number | null>(null);
  /** Plain-English DSL summary of the currently-expanded proposal. Keyed by
   *  proposal id so re-expanding a previously-seen row doesn't re-fetch. */
  protected readonly summaries = signal<Record<number, string | 'loading' | 'error'>>({});

  protected toggleExpand(id: number): void {
    const next = this.expandedId() === id ? null : id;
    this.expandedId.set(next);
    if (next != null) this.loadSummary(id);
  }

  private loadSummary(id: number): void {
    const cache = this.summaries();
    if (cache[id] !== undefined && cache[id] !== 'error') return;
    const proposal = this.proposals().find((p) => p.id === id);
    if (!proposal) return;
    this.summaries.set({ ...cache, [id]: 'loading' });
    this.strategies
      .summariseDsl(proposal.proposalJson)
      .pipe(
        map((res) => res?.data ?? null),
        catchError(() => of(null as string | null)),
      )
      .subscribe((text: string | null) => {
        this.summaries.update((s) => ({
          ...s,
          [id]: text && text.trim().length > 0 ? text : 'error',
        }));
      });
  }

  /** Resolves the cached summary for a proposal — used by the template to
   *  render "Loading…" / the prose / a fallback chip without leaking the
   *  cache shape into the .html. */
  protected summaryFor(id: number): string | 'loading' | 'error' | undefined {
    return this.summaries()[id];
  }

  protected formatJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  // Promote modal -----------------------------------------------------------
  protected readonly pending = signal<LlmProposalDto | null>(null);
  protected reasonText = '';
  protected readonly submitting = signal(false);

  protected ask(p: LlmProposalDto): void {
    this.reasonText = '';
    this.pending.set(p);
  }

  protected cancel(): void {
    if (this.submitting()) return;
    this.pending.set(null);
  }

  protected confirm(): void {
    const p = this.pending();
    if (!p) return;
    this.submitting.set(true);
    const reason = this.reasonText.trim();
    this.strategies
      .promoteLlmProposal(p.id)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status && res.data) {
            this.auditTrail
              .create({
                entityType: 'LlmStrategyProposal',
                entityId: p.id,
                decisionType: 'LlmProposalPromoted',
                outcome: 'Promoted',
                reason: reason || null,
                contextJson: JSON.stringify({
                  proposalName: p.name,
                  symbol: p.symbol,
                  promotedStrategyId: res.data,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
            this.pending.set(null);
            // Navigate straight to the newly created strategy so the operator
            // lands on the configurable surface, ready to activate or edit.
            this.router.navigate(['/strategies', res.data]);
          } else {
            this.resource.refresh();
            this.pending.set(null);
          }
        },
        error: () => {
          this.pending.set(null);
        },
      });
  }
}
