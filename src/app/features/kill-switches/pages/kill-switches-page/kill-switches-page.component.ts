import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { catchError, forkJoin, map, of } from 'rxjs';

import { KillSwitchService } from '@core/services/kill-switch.service';
import { StrategiesService } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  KillSwitchStatusDto,
  StrategyDto,
  ToggleKillSwitchRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

interface StrategySwitch {
  strategy: StrategyDto;
  status: KillSwitchStatusDto | null;
}

@Component({
  selector: 'app-kill-switches-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    ConfirmDialogComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ReactiveFormsModule,
    DatePipe,
  ],
  template: `
    <div class="page">
      <app-page-header title="Kill Switches" subtitle="Global and per-strategy circuit breakers" />

      <section class="global-card" [class.engaged]="service.isGlobalEngaged()">
        <div class="global-head">
          <div class="global-title">
            <span class="indicator" [class.on]="service.isGlobalEngaged()"></span>
            <div>
              <h3>Global Kill Switch</h3>
              <p class="muted">
                When engaged, no new signals are generated and no new orders are submitted. Existing
                positions are untouched.
              </p>
            </div>
          </div>
          <button
            type="button"
            class="btn"
            [class.btn-destructive]="!service.isGlobalEngaged()"
            [class.btn-primary]="service.isGlobalEngaged()"
            [disabled]="busyGlobal()"
            (click)="requestGlobalToggle()"
          >
            {{ service.isGlobalEngaged() ? 'Disengage' : 'Engage Kill Switch' }}
          </button>
        </div>
        @if (service.global(); as g) {
          <dl class="global-meta">
            <div>
              <dt>State</dt>
              <dd>{{ g.enabled ? 'Engaged' : 'Disengaged' }}</dd>
            </div>
            @if (g.changedAt) {
              <div>
                <dt>Changed</dt>
                <dd>{{ g.changedAt | date: 'MMM d, yyyy HH:mm:ss' }}</dd>
              </div>
            }
            @if (g.changedBy) {
              <div>
                <dt>By</dt>
                <dd>{{ g.changedBy }}</dd>
              </div>
            }
            @if (g.reason) {
              <div class="reason">
                <dt>Reason</dt>
                <dd>{{ g.reason }}</dd>
              </div>
            }
          </dl>
        }
      </section>

      <section class="strategies-card">
        <header class="card-head"><h3>Per-Strategy Kill Switches</h3></header>
        @if (loading()) {
          <app-card-skeleton [lines]="6" [showHeader]="false" />
        } @else if (rows().length > 0) {
          <table class="table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Status</th>
                <th>Symbol</th>
                <th>Timeframe</th>
                <th>Kill Switch</th>
                <th>Last Change</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.strategy.id) {
                <tr>
                  <td>
                    <strong>#{{ row.strategy.id }}</strong> {{ row.strategy.name }}
                  </td>
                  <td>{{ row.strategy.status }}</td>
                  <td>{{ row.strategy.symbol }}</td>
                  <td>{{ row.strategy.timeframe }}</td>
                  <td>
                    <span class="pill" [class.on]="row.status?.enabled">
                      {{ row.status?.enabled ? 'Engaged' : 'Off' }}
                    </span>
                  </td>
                  <td class="muted">
                    {{
                      row.status?.changedAt ? (row.status!.changedAt | date: 'MMM d, HH:mm') : '—'
                    }}
                  </td>
                  <td class="actions">
                    <button
                      type="button"
                      class="link"
                      [disabled]="busyStrategyIds().has(row.strategy.id)"
                      (click)="requestStrategyToggle(row)"
                    >
                      {{ row.status?.enabled ? 'Disengage' : 'Engage' }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <app-empty-state
            title="No strategies found"
            description="Create a strategy before configuring per-strategy kill switches."
          />
        }
      </section>

      <app-confirm-dialog
        [open]="dialogOpen()"
        [title]="dialogTitle()"
        [message]="dialogMessage()"
        [confirmLabel]="dialogConfirmLabel()"
        [confirmVariant]="dialogVariant()"
        [loading]="busyGlobal() || dialogBusy()"
        (confirm)="submitToggle()"
        (cancelled)="cancelDialog()"
      >
      </app-confirm-dialog>

      @if (dialogOpen()) {
        <!-- Separate reason input overlays the dialog. ConfirmDialog content is fixed, so we render a small extra modal here. -->
        <div class="reason-overlay" role="dialog">
          <form class="reason-dialog" [formGroup]="reasonForm" (ngSubmit)="submitToggle()">
            <label>Reason (written to audit trail)</label>
            <textarea
              formControlName="reason"
              rows="3"
              placeholder="e.g. Broker feed stalled; halting to investigate"
            ></textarea>
            @if (reasonForm.controls.reason.invalid && reasonForm.controls.reason.touched) {
              <span class="err">Reason is required</span>
            }
          </form>
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
        gap: var(--space-5);
      }

      .global-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5) var(--space-6);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .global-card.engaged {
        border-color: rgba(255, 59, 48, 0.3);
        background: rgba(255, 59, 48, 0.04);
      }
      .global-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .global-title {
        display: flex;
        align-items: flex-start;
        gap: var(--space-3);
        flex: 1;
        min-width: 280px;
      }
      .global-title h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .global-title p.muted {
        margin: var(--space-1) 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .indicator {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        margin-top: 8px;
        background: var(--profit);
        flex-shrink: 0;
      }
      .indicator.on {
        background: var(--loss);
        box-shadow: 0 0 0 4px rgba(255, 59, 48, 0.12);
      }
      .global-meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: var(--space-4);
        margin: 0;
        padding-top: var(--space-4);
        border-top: 1px solid var(--border);
      }
      .global-meta dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .global-meta dd {
        margin: var(--space-1) 0 0;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .global-meta .reason {
        grid-column: 1 / -1;
      }

      .strategies-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
      }
      .table th,
      .table td {
        padding: var(--space-3) var(--space-5);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-sm);
        vertical-align: middle;
      }
      .table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill.on {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .actions {
        text-align: right;
      }
      .link {
        background: transparent;
        border: none;
        color: var(--accent);
        font-weight: var(--font-medium);
        cursor: pointer;
        font-size: var(--text-sm);
      }
      .link:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .link:hover:not(:disabled) {
        text-decoration: underline;
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .btn-destructive {
        background: var(--loss);
        color: white;
      }
      .btn-destructive:hover:not(:disabled) {
        opacity: 0.9;
      }

      .reason-overlay {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding: 140px var(--space-4) var(--space-6);
        pointer-events: none;
        z-index: 1100;
      }
      .reason-dialog {
        pointer-events: auto;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        padding: var(--space-4);
        width: min(480px, 100%);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .reason-dialog label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .reason-dialog textarea {
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-family: inherit;
        font-size: var(--text-sm);
        outline: none;
        resize: vertical;
        min-height: 72px;
      }
      .reason-dialog textarea:focus {
        border-color: var(--accent);
      }
      .err {
        color: var(--loss);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class KillSwitchesPageComponent implements OnInit {
  protected readonly service = inject(KillSwitchService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly auditService = inject(AuditTrailService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  readonly rows = signal<StrategySwitch[]>([]);
  readonly loading = signal(true);
  readonly busyGlobal = signal(false);
  readonly busyStrategyIds = signal(new Set<number>());

  readonly dialogOpen = signal(false);
  readonly dialogBusy = signal(false);
  private readonly pending = signal<{
    scope: 'global' | 'strategy';
    strategyId?: number;
    nextEnabled: boolean;
    strategyName?: string;
  } | null>(null);

  readonly dialogTitle = computed(() => {
    const p = this.pending();
    if (!p) return '';
    if (p.scope === 'global')
      return p.nextEnabled ? 'Engage Global Kill Switch?' : 'Disengage Global Kill Switch?';
    return p.nextEnabled
      ? `Engage kill switch for ${p.strategyName}?`
      : `Disengage kill switch for ${p.strategyName}?`;
  });

  readonly dialogMessage = computed(() => {
    const p = this.pending();
    if (!p) return '';
    return p.nextEnabled
      ? 'This stops new signals and orders while in effect. Open positions are untouched.'
      : 'Signal generation and order submission will resume.';
  });

  readonly dialogConfirmLabel = computed(() =>
    this.pending()?.nextEnabled ? 'Engage' : 'Disengage',
  );
  readonly dialogVariant = computed<'primary' | 'destructive'>(() =>
    this.pending()?.nextEnabled ? 'destructive' : 'primary',
  );

  readonly reasonForm = this.fb.nonNullable.group({
    reason: ['', [Validators.required, Validators.minLength(3)]],
  });

  ngOnInit(): void {
    this.loadAll();
  }

  requestGlobalToggle(): void {
    this.pending.set({ scope: 'global', nextEnabled: !this.service.isGlobalEngaged() });
    this.openReasonDialog();
  }

  requestStrategyToggle(row: StrategySwitch): void {
    const nextEnabled = !row.status?.enabled;
    this.pending.set({
      scope: 'strategy',
      strategyId: row.strategy.id,
      strategyName: row.strategy.name ?? `#${row.strategy.id}`,
      nextEnabled,
    });
    this.openReasonDialog();
  }

  submitToggle(): void {
    const p = this.pending();
    if (!p) return;
    if (this.reasonForm.invalid) {
      this.reasonForm.controls.reason.markAsTouched();
      return;
    }
    const payload: ToggleKillSwitchRequest = {
      enabled: p.nextEnabled,
      reason: this.reasonForm.getRawValue().reason,
    };

    if (p.scope === 'global') {
      this.busyGlobal.set(true);
      this.service.toggleGlobal(payload).subscribe({
        next: (res) => {
          this.busyGlobal.set(false);
          if (res.status) {
            this.notifications.success(
              p.nextEnabled ? 'Global kill switch engaged' : 'Global kill switch disengaged',
            );
            this.logAudit('KillSwitch', 0, payload);
            this.closeDialog();
          } else {
            this.notifications.error(res.message ?? 'Failed to toggle kill switch');
            this.closeDialog();
          }
        },
        error: () => {
          this.busyGlobal.set(false);
          this.closeDialog();
        },
      });
    } else if (p.strategyId != null) {
      const strategyId = p.strategyId;
      const next = new Set(this.busyStrategyIds());
      next.add(strategyId);
      this.busyStrategyIds.set(next);
      this.dialogBusy.set(true);
      this.service.toggleStrategy(strategyId, payload).subscribe({
        next: (res) => {
          this.dialogBusy.set(false);
          const after = new Set(this.busyStrategyIds());
          after.delete(strategyId);
          this.busyStrategyIds.set(after);
          if (res.status) {
            this.notifications.success(
              `${p.strategyName}: kill switch ${p.nextEnabled ? 'engaged' : 'disengaged'}`,
            );
            this.logAudit('StrategyKillSwitch', strategyId, payload);
            this.updateRowStatus(
              strategyId,
              res.data ?? {
                enabled: payload.enabled,
                reason: payload.reason ?? null,
                changedAt: new Date().toISOString(),
                changedBy: null,
              },
            );
            this.closeDialog();
          } else {
            this.notifications.error(res.message ?? 'Failed to toggle kill switch');
            this.closeDialog();
          }
        },
        error: () => {
          this.dialogBusy.set(false);
          const after = new Set(this.busyStrategyIds());
          after.delete(strategyId);
          this.busyStrategyIds.set(after);
          this.closeDialog();
        },
      });
    }
  }

  cancelDialog(): void {
    this.closeDialog();
  }

  private openReasonDialog(): void {
    this.reasonForm.reset({ reason: '' });
    this.dialogOpen.set(true);
  }

  private closeDialog(): void {
    this.dialogOpen.set(false);
    this.pending.set(null);
    this.dialogBusy.set(false);
  }

  private updateRowStatus(strategyId: number, status: KillSwitchStatusDto): void {
    this.rows.update((arr) =>
      arr.map((row) => (row.strategy.id === strategyId ? { ...row, status } : row)),
    );
  }

  private loadAll(): void {
    this.loading.set(true);
    this.service.getGlobal().subscribe({
      error: () => {
        /* allow UI to load even if global fails */
      },
    });
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
      next: (res) => {
        const strategies = res.data?.data ?? [];
        if (strategies.length === 0) {
          this.rows.set([]);
          this.loading.set(false);
          return;
        }
        forkJoin(
          strategies.map((s) =>
            this.service.getStrategy(s.id).pipe(
              map((r) => r.data ?? null),
              catchError(() => of(null as KillSwitchStatusDto | null)),
            ),
          ),
        ).subscribe((statuses) => {
          this.rows.set(
            strategies.map((strategy, i) => ({ strategy, status: statuses[i] ?? null })),
          );
          this.loading.set(false);
        });
      },
      error: () => this.loading.set(false),
    });
  }

  private logAudit(entityType: string, entityId: number, payload: ToggleKillSwitchRequest): void {
    this.auditService
      .create({
        entityType,
        entityId,
        decisionType: 'KillSwitchToggle',
        outcome: payload.enabled ? 'Engaged' : 'Disengaged',
        reason: payload.reason ?? '',
        source: 'AdminUI',
      })
      .subscribe({
        error: () => {
          /* non-fatal: audit is best-effort */
        },
      });
  }
}
