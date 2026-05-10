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
import type { LlmProposalDto } from '@core/api/api.types';
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
      </app-page-header>

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
        <section class="kpis">
          <app-metric-card
            label="Loaded"
            [value]="proposals().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Pending review"
            [value]="countOf('Pending')"
            format="number"
            [dotColor]="countOf('Pending') > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="DSL invalid"
            [value]="countOf('DslInvalid')"
            format="number"
            [dotColor]="countOf('DslInvalid') > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Promoted (this batch)"
            [value]="countOf('Approved')"
            format="number"
            dotColor="#34C759"
          />
        </section>

        @if (proposals().length === 0) {
          <app-empty-state
            title="No LLM proposals match"
            description="No proposals match the current status filter. The LLM proposal worker emits new candidates on its own schedule."
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

  constructor() {
    effect(() => {
      this.statusFilter();
      this.resource.refresh();
    });
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

  protected toggleExpand(id: number): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
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
