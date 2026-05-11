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
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { AutoTuneService } from '@core/services/auto-tune.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import type { AutoTuneProposalDto, AutoTuneProposalStatus } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type ActionKind = 'apply' | 'reject';
interface PendingAction {
  kind: ActionKind;
  proposal: AutoTuneProposalDto;
}

const STATUS_TABS: readonly (AutoTuneProposalStatus | 'All')[] = [
  'Pending',
  'Applied',
  'Rejected',
  'Stale',
  'All',
] as const;

@Component({
  selector: 'app-auto-tune-proposals-page',
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
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Auto-Tune Proposals"
        subtitle="Worker-generated knob-change proposals. Review before applying to live config."
      >
        <a routerLink="/auto-tune/auto-apply" class="btn btn-secondary">Auto-Apply Config →</a>
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
        <div class="control-group">
          <span class="control-label">Knob</span>
          <input
            type="search"
            placeholder="e.g. RiskAdjustmentLambda"
            [ngModel]="keyFilter()"
            (ngModelChange)="keyFilter.set($event)"
          />
        </div>
        <span class="result-count">{{ proposals().length }} loaded</span>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load auto-tune proposals"
          message="Engine returned an error. The CompositeMLAutoTuningWorker may not be running — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Pending review"
            [value]="countOf('Pending')"
            format="number"
            [dotColor]="countOf('Pending') > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Applied (this batch)"
            [value]="countOf('Applied')"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Rejected"
            [value]="countOf('Rejected')"
            format="number"
            dotColor="#FF3B30"
          />
          <app-metric-card
            label="Stale"
            [value]="countOf('Stale')"
            format="number"
            dotColor="#8E8E93"
          />
        </section>

        @if (proposals().length === 0) {
          <app-empty-state
            title="No proposals match"
            description="No auto-tune proposals match the current filters. The worker emits new proposals on its own schedule."
          />
        } @else {
          <section class="card">
            <table class="proposals-table">
              <thead>
                <tr>
                  <th>Knob</th>
                  <th class="num">Current</th>
                  <th class="num">Proposed</th>
                  <th class="num">Delta</th>
                  <th>Confidence</th>
                  <th class="num">Evidence</th>
                  <th>Status</th>
                  <th>Proposed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (p of proposals(); track p.id) {
                  <tr [class.expanded]="expandedId() === p.id">
                    <td class="mono knob">{{ p.proposalKey }}</td>
                    <td class="num mono">{{ p.currentValue | number: '1.0-4' }}</td>
                    <td class="num mono">{{ p.proposedValue | number: '1.0-4' }}</td>
                    <td
                      class="num mono"
                      [class.positive]="p.proposedValue > p.currentValue"
                      [class.negative]="p.proposedValue < p.currentValue"
                    >
                      {{ deltaPct(p) > 0 ? '+' : '' }}{{ deltaPct(p) | number: '1.0-1' }}%
                    </td>
                    <td class="mono small">
                      [{{ p.confidenceLow | number: '1.0-3' }},
                      {{ p.confidenceHigh | number: '1.0-3' }}]
                    </td>
                    <td class="num mono">{{ p.evidenceCount }}</td>
                    <td>
                      <span class="status-pill" [attr.data-status]="p.status">
                        {{ p.status }}
                      </span>
                    </td>
                    <td class="time" [title]="p.proposedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ p.proposedAtUtc | relativeTime }}
                    </td>
                    <td class="actions">
                      <button type="button" class="link" (click)="toggleExpand(p.id)">
                        {{ expandedId() === p.id ? 'Hide' : 'Inspect' }}
                      </button>
                      @if (p.status === 'Pending') {
                        <button
                          type="button"
                          class="action ok"
                          (click)="ask('apply', p)"
                          [disabled]="submitting()"
                        >
                          Apply
                        </button>
                        <button
                          type="button"
                          class="action warn"
                          (click)="ask('reject', p)"
                          [disabled]="submitting()"
                        >
                          Reject
                        </button>
                      }
                    </td>
                  </tr>
                  @if (expandedId() === p.id) {
                    <tr class="detail-row">
                      <td colspan="9">
                        <h4>Rationale</h4>
                        <pre class="json">{{ formatJson(p.rationaleJson) }}</pre>
                        @if (p.reviewedAtUtc) {
                          <p class="muted small">
                            Reviewed by <strong>{{ p.reviewedBy ?? '—' }}</strong> at
                            {{ p.reviewedAtUtc | date: 'yyyy-MM-dd HH:mm UTC' }}
                            @if (p.appliedAtUtc) {
                              · applied at {{ p.appliedAtUtc | date: 'yyyy-MM-dd HH:mm UTC' }}
                            }
                          </p>
                        }
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
              <h2>{{ p.kind === 'apply' ? 'Apply proposal' : 'Reject proposal' }}</h2>
              <button type="button" class="close-btn" (click)="cancel()" aria-label="Close">
                ×
              </button>
            </header>
            <p class="modal-target">
              <span class="mono">{{ p.proposal.proposalKey }}</span>
              <span class="muted small">
                · {{ p.proposal.currentValue | number: '1.0-4' }} →
                {{ p.proposal.proposedValue | number: '1.0-4' }}
              </span>
            </p>
            <p class="modal-desc">
              @if (p.kind === 'apply') {
                The engine will transactionally update the EngineConfig row for this knob and flip
                the proposal to Applied. Hot-reloads on the next worker cycle.
              } @else {
                Mark this proposal Rejected so the worker doesn't re-surface it. No EngineConfig
                change. Rationale below is optional (≤200 chars).
              }
            </p>
            @if (p.kind === 'reject') {
              <label class="reason-field">
                <span>Rationale (optional)</span>
                <textarea
                  rows="2"
                  maxlength="200"
                  [(ngModel)]="reasonText"
                  placeholder="Why is this proposal being rejected?"
                ></textarea>
              </label>
            }
            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancel()">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="confirm()"
                [disabled]="submitting()"
              >
                {{ submitting() ? 'Working…' : p.kind === 'apply' ? 'Apply' : 'Reject' }}
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
      .control-group input {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 220px;
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
      .proposals-table td.num,
      .proposals-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .proposals-table tr.expanded {
        background: var(--bg-primary);
      }
      .proposals-table tr.detail-row td {
        background: var(--bg-primary);
        padding: var(--space-3) var(--space-4);
      }
      .knob {
        font-weight: var(--font-medium);
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
      .positive {
        color: #248a3d;
      }
      .negative {
        color: #d70015;
      }
      .status-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .status-pill[data-status='Pending'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .status-pill[data-status='Applied'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .status-pill[data-status='Rejected'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .status-pill[data-status='Stale'] {
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
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
      .action.warn {
        color: #c93400;
      }
      .action.warn:hover:not(:disabled) {
        background: #c93400;
        color: #fff;
      }
      .action:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      h4 {
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
        max-height: 280px;
        overflow: auto;
        color: var(--text-secondary);
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
      }
      .modal-target,
      .modal-desc {
        margin: 0;
        font-size: var(--text-sm);
      }
      .modal-target {
        color: var(--text-secondary);
      }
      .modal-desc {
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
export class AutoTuneProposalsPageComponent {
  private readonly autoTune = inject(AutoTuneService);
  private readonly auditTrail = inject(AuditTrailService);

  protected readonly STATUS_TABS = STATUS_TABS;
  protected readonly statusFilter = signal<AutoTuneProposalStatus | 'All'>('Pending');
  protected readonly keyFilter = signal<string>('');

  protected readonly resource = createPolledResource(
    () => {
      const s = this.statusFilter();
      const status = s === 'All' ? null : (s as AutoTuneProposalStatus);
      return this.autoTune
        .listProposals({
          status,
          proposalKey: this.keyFilter().trim() || null,
          limit: 200,
        })
        .pipe(
          map((res) => res.data ?? []),
          catchError(() => of<AutoTuneProposalDto[]>([])),
        );
    },
    { intervalMs: 60_000 },
  );

  constructor() {
    effect(() => {
      this.statusFilter();
      this.keyFilter();
      this.resource.refresh();
    });
  }

  protected readonly proposals = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.proposals().length === 0,
  );

  protected countOf(status: AutoTuneProposalStatus): number {
    return this.proposals().filter((p) => p.status === status).length;
  }

  protected deltaPct(p: AutoTuneProposalDto): number {
    if (p.currentValue === 0) return 0;
    return ((p.proposedValue - p.currentValue) / Math.abs(p.currentValue)) * 100;
  }

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

  protected readonly pending = signal<PendingAction | null>(null);
  protected reasonText = '';
  protected readonly submitting = signal(false);

  protected ask(kind: ActionKind, proposal: AutoTuneProposalDto): void {
    this.reasonText = '';
    this.pending.set({ kind, proposal });
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
    const obs =
      p.kind === 'apply'
        ? this.autoTune.applyProposal(p.proposal.id)
        : this.autoTune.rejectProposal(p.proposal.id, reason || null);
    obs
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.pending.set(null);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.auditTrail
              .create({
                entityType: 'AutoTuneProposal',
                entityId: p.proposal.id,
                decisionType:
                  p.kind === 'apply' ? 'AutoTuneProposalApplied' : 'AutoTuneProposalRejected',
                outcome: p.kind === 'apply' ? 'Applied' : 'Rejected',
                reason: reason || null,
                contextJson: JSON.stringify({
                  proposalKey: p.proposal.proposalKey,
                  currentValue: p.proposal.currentValue,
                  proposedValue: p.proposal.proposedValue,
                  evidenceCount: p.proposal.evidenceCount,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          }
        },
        error: () => undefined,
      });
  }
}
