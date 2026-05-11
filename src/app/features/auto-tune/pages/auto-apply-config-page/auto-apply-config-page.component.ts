import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, finalize, map, of } from 'rxjs';

import { AutoTuneService } from '@core/services/auto-tune.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import type { AutoApplyConfigDto, UpsertAutoApplyConfigRequest } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

interface EditForm {
  proposalKey: string;
  autoApplyEnabled: boolean;
  convergenceTolerance: number;
  requiredConvergenceCount: number;
  quietPeriodHours: number;
  minValue: string;
  maxValue: string;
}

@Component({
  selector: 'app-auto-apply-config-page',
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
        title="Auto-Tune — Auto-Apply Config"
        subtitle="Per-knob safety gates for autonomous proposal application. Operator-only."
      >
        <a routerLink="/auto-tune" class="btn btn-secondary">← Proposals</a>
        <button type="button" class="btn btn-primary" (click)="openEditor(null)">
          + New config
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load auto-apply configs"
          message="Engine returned an error fetching the per-knob safety-gate configs."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Configs"
            [value]="configs().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Auto-apply enabled"
            [value]="enabledCount()"
            format="number"
            [dotColor]="enabledCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Review-only"
            [value]="disabledCount()"
            format="number"
            dotColor="#34C759"
          />
        </section>

        @if (configs().length === 0) {
          <app-empty-state
            title="No per-knob configs"
            description="Without configs, all auto-tune proposals require operator review. Add a config to enable autonomous application for a specific knob."
            actionLabel="Add config"
            (actionClick)="openEditor(null)"
          />
        } @else {
          <section class="card">
            <table class="configs-table">
              <thead>
                <tr>
                  <th>Knob key</th>
                  <th>State</th>
                  <th class="num">Tolerance</th>
                  <th class="num">Req convergence</th>
                  <th class="num">Quiet (hrs)</th>
                  <th class="num">Min</th>
                  <th class="num">Max</th>
                  <th>Last updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (c of configs(); track c.id) {
                  <tr [class.enabled]="c.autoApplyEnabled">
                    <td class="mono knob">{{ c.proposalKey }}</td>
                    <td>
                      @if (c.autoApplyEnabled) {
                        <span class="state-pill on">auto-apply on</span>
                      } @else {
                        <span class="state-pill off">review only</span>
                      }
                    </td>
                    <td class="num mono">{{ c.convergenceTolerance | number: '1.0-4' }}</td>
                    <td class="num mono">{{ c.requiredConvergenceCount }}</td>
                    <td class="num mono">{{ c.quietPeriodHours }}</td>
                    <td class="num mono">
                      @if (c.minValue !== null) {
                        {{ c.minValue | number: '1.0-4' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (c.maxValue !== null) {
                        {{ c.maxValue | number: '1.0-4' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="time" [title]="c.lastUpdatedAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ c.lastUpdatedAt | relativeTime }}
                    </td>
                    <td class="actions">
                      <button type="button" class="link" (click)="openEditor(c)">Edit</button>
                      <button
                        type="button"
                        class="link warn"
                        (click)="askDelete(c)"
                        [disabled]="submitting()"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }

      @if (editing()) {
        <div class="modal-overlay" (click)="cancelEdit()">
          <div class="modal" (click)="$event.stopPropagation()" role="dialog" aria-modal="true">
            <header class="modal-head">
              <h2>{{ editingExisting() ? 'Edit auto-apply config' : 'New auto-apply config' }}</h2>
              <button type="button" class="close-btn" (click)="cancelEdit()" aria-label="Close">
                ×
              </button>
            </header>

            <label class="field">
              <span>Proposal key</span>
              <input
                type="text"
                [(ngModel)]="form.proposalKey"
                [readOnly]="editingExisting()"
                placeholder="e.g. RiskAdjustmentLambda"
              />
            </label>

            <label class="toggle-row">
              <input type="checkbox" [(ngModel)]="form.autoApplyEnabled" />
              <span>
                <strong>Auto-apply enabled</strong>
                <span class="muted small">
                  When on, qualifying proposals for this knob apply without operator review.
                </span>
              </span>
            </label>

            <div class="row">
              <label class="field grow">
                <span>Convergence tolerance</span>
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  [(ngModel)]="form.convergenceTolerance"
                />
              </label>
              <label class="field grow">
                <span>Required convergence count</span>
                <input type="number" step="1" min="1" [(ngModel)]="form.requiredConvergenceCount" />
              </label>
            </div>

            <div class="row">
              <label class="field grow">
                <span>Quiet period (hours)</span>
                <input type="number" step="1" min="0" [(ngModel)]="form.quietPeriodHours" />
              </label>
            </div>

            <div class="row">
              <label class="field grow">
                <span>Min value (optional)</span>
                <input type="number" step="0.0001" [(ngModel)]="form.minValue" placeholder="—" />
              </label>
              <label class="field grow">
                <span>Max value (optional)</span>
                <input type="number" step="0.0001" [(ngModel)]="form.maxValue" placeholder="—" />
              </label>
            </div>

            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancelEdit()">Cancel</button>
              <button
                type="button"
                class="btn btn-primary"
                (click)="saveEdit()"
                [disabled]="!canSave()"
              >
                {{ submitting() ? 'Saving…' : 'Save' }}
              </button>
            </footer>
          </div>
        </div>
      }

      @if (deleting(); as d) {
        <div class="modal-overlay" (click)="cancelDelete()">
          <div
            class="modal small"
            (click)="$event.stopPropagation()"
            role="dialog"
            aria-modal="true"
          >
            <header class="modal-head">
              <h2>Delete auto-apply config</h2>
              <button type="button" class="close-btn" (click)="cancelDelete()" aria-label="Close">
                ×
              </button>
            </header>
            <p>
              Delete the config for <span class="mono">{{ d.proposalKey }}</span
              >? The worker will treat the knob as "operator review only" going forward (auto-apply
              disabled).
            </p>
            <footer class="modal-foot">
              <button type="button" class="btn btn-secondary" (click)="cancelDelete()">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-danger"
                (click)="confirmDelete()"
                [disabled]="submitting()"
              >
                {{ submitting() ? 'Deleting…' : 'Delete' }}
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
      .configs-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .configs-table th,
      .configs-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .configs-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .configs-table td.num,
      .configs-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .configs-table tr.enabled {
        background: rgba(255, 149, 0, 0.04);
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
      .state-pill {
        font-size: var(--text-xs);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
      }
      .state-pill.on {
        background: rgba(255, 149, 0, 0.16);
        color: #c93400;
      }
      .state-pill.off {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .actions {
        display: flex;
        gap: 8px;
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
      .link.warn {
        color: #c93400;
      }
      .link:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .link:hover:not(:disabled) {
        text-decoration: underline;
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
      .btn-danger {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: #d70015;
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-danger:disabled {
        opacity: 0.55;
        cursor: not-allowed;
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
        max-width: 560px;
        width: 90%;
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .modal.small {
        max-width: 440px;
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
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
      }
      .field input[readonly] {
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }
      .row {
        display: flex;
        gap: var(--space-3);
      }
      .grow {
        flex: 1;
      }
      .toggle-row {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
        padding: var(--space-3);
        background: var(--bg-secondary);
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .toggle-row input {
        margin-top: 2px;
      }
      .toggle-row > span {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: var(--text-sm);
      }
      .toggle-row strong {
        color: var(--text-primary);
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }
    `,
  ],
})
export class AutoApplyConfigPageComponent {
  private readonly autoTune = inject(AutoTuneService);
  private readonly auditTrail = inject(AuditTrailService);

  protected readonly resource = createPolledResource(
    () =>
      this.autoTune.listAutoApplyConfigs().pipe(
        map((res) => res.data ?? []),
        catchError(() => of<AutoApplyConfigDto[]>([])),
      ),
    { intervalMs: 120_000 },
  );

  protected readonly configs = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.configs().length === 0,
  );
  protected readonly enabledCount = computed(
    () => this.configs().filter((c) => c.autoApplyEnabled).length,
  );
  protected readonly disabledCount = computed(
    () => this.configs().filter((c) => !c.autoApplyEnabled).length,
  );

  // Edit modal -------------------------------------------------------------
  protected readonly editing = signal<boolean>(false);
  protected readonly editingExisting = signal<boolean>(false);
  protected form: EditForm = blankForm();
  protected readonly submitting = signal(false);

  protected openEditor(c: AutoApplyConfigDto | null): void {
    this.editingExisting.set(c !== null);
    this.form = c
      ? {
          proposalKey: c.proposalKey,
          autoApplyEnabled: c.autoApplyEnabled,
          convergenceTolerance: c.convergenceTolerance,
          requiredConvergenceCount: c.requiredConvergenceCount,
          quietPeriodHours: c.quietPeriodHours,
          minValue: c.minValue === null ? '' : String(c.minValue),
          maxValue: c.maxValue === null ? '' : String(c.maxValue),
        }
      : blankForm();
    this.editing.set(true);
  }

  protected cancelEdit(): void {
    if (this.submitting()) return;
    this.editing.set(false);
  }

  protected canSave = (): boolean => {
    if (this.submitting()) return false;
    if (!this.form.proposalKey.trim()) return false;
    if (this.form.convergenceTolerance < 0) return false;
    if (this.form.requiredConvergenceCount < 1) return false;
    if (this.form.quietPeriodHours < 0) return false;
    return true;
  };

  protected saveEdit(): void {
    if (!this.canSave()) return;
    this.submitting.set(true);
    const key = this.form.proposalKey.trim();
    const payload: UpsertAutoApplyConfigRequest = {
      autoApplyEnabled: this.form.autoApplyEnabled,
      convergenceTolerance: Number(this.form.convergenceTolerance),
      requiredConvergenceCount: Number(this.form.requiredConvergenceCount),
      quietPeriodHours: Number(this.form.quietPeriodHours),
      minValue: this.form.minValue.trim() === '' ? null : Number(this.form.minValue),
      maxValue: this.form.maxValue.trim() === '' ? null : Number(this.form.maxValue),
    };
    this.autoTune
      .upsertAutoApplyConfig(key, payload)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.editing.set(false);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status && res.data) {
            this.auditTrail
              .create({
                entityType: 'AutoApplyConfig',
                entityId: res.data.id,
                decisionType: 'AutoApplyConfigUpserted',
                outcome: this.editingExisting() ? 'Updated' : 'Created',
                reason: null,
                contextJson: JSON.stringify({ proposalKey: key, ...payload }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          }
        },
        error: () => undefined,
      });
  }

  // Delete modal -----------------------------------------------------------
  protected readonly deleting = signal<AutoApplyConfigDto | null>(null);

  protected askDelete(c: AutoApplyConfigDto): void {
    this.deleting.set(c);
  }

  protected cancelDelete(): void {
    if (this.submitting()) return;
    this.deleting.set(null);
  }

  protected confirmDelete(): void {
    const c = this.deleting();
    if (!c) return;
    this.submitting.set(true);
    this.autoTune
      .deleteAutoApplyConfig(c.proposalKey)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.deleting.set(null);
          this.resource.refresh();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.auditTrail
              .create({
                entityType: 'AutoApplyConfig',
                entityId: c.id,
                decisionType: 'AutoApplyConfigDeleted',
                outcome: 'Deleted',
                reason: null,
                contextJson: JSON.stringify({ proposalKey: c.proposalKey }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
          }
        },
        error: () => undefined,
      });
  }
}

function blankForm(): EditForm {
  return {
    proposalKey: '',
    autoApplyEnabled: false,
    convergenceTolerance: 0.01,
    requiredConvergenceCount: 3,
    quietPeriodHours: 24,
    minValue: '',
    maxValue: '',
  };
}
