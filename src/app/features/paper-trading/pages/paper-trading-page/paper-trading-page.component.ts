import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';

import { PaperTradingService } from '@core/services/paper-trading.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';

@Component({
  selector: 'app-paper-trading-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    ConfirmDialogComponent,
    ReactiveFormsModule,
    DatePipe,
    FormFieldComponent,
    FormFieldControlDirective,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Paper Trading"
        subtitle="Simulated execution with no broker contact"
      />

      <div class="status-card">
        <div class="status-header">
          <div class="status-text">
            <span class="status-label">Paper Trading is</span>
            <span
              class="status-value"
              [class.on]="service.isPaperMode()"
              [class.off]="!service.isPaperMode()"
            >
              {{ service.isPaperMode() ? 'ENABLED' : 'DISABLED' }}
            </span>
          </div>
          <button
            type="button"
            class="toggle-switch"
            [class.active]="service.isPaperMode()"
            [disabled]="busy()"
            (click)="confirmToggle()"
            role="switch"
            [attr.aria-checked]="service.isPaperMode()"
          >
            <span class="toggle-knob"></span>
          </button>
        </div>
        @if (service.status()?.changedAt) {
          <div class="changed-at">
            Last changed: {{ service.status()!.changedAt | date: 'MMM d, yyyy HH:mm:ss' }}
          </div>
        }
      </div>

      <div class="backfill-card">
        <h3 class="section-title">Backfill Simulated Executions</h3>
        <p class="muted">
          Replay historical candles through an approved strategy's signal pipeline to generate
          synthetic paper executions for TCA, slippage, and fill-quality analysis.
        </p>
        <form class="backfill-form" [formGroup]="backfillForm" (ngSubmit)="submitBackfill()">
          <app-form-field
            label="Strategy"
            [required]="true"
            [control]="backfillForm.controls.strategyId"
          >
            <select appFormFieldControl formControlName="strategyId">
              <option [ngValue]="null">Select a strategy…</option>
              @for (s of strategies(); track s.id) {
                <option [ngValue]="s.id">{{ s.name }} ({{ s.symbol }} {{ s.timeframe }})</option>
              }
            </select>
          </app-form-field>
          <button type="submit" class="btn btn-primary" [disabled]="busy() || backfillForm.invalid">
            @if (busy()) {
              <span class="spin"></span>
            } @else {
              Trigger Backfill
            }
          </button>
        </form>
      </div>

      <app-confirm-dialog
        [open]="showConfirm()"
        [title]="pendingValue() ? 'Enable Paper Trading?' : 'Disable Paper Trading?'"
        [message]="
          pendingValue()
            ? 'All orders will route to a simulated broker. No real trades will be placed.'
            : 'Real-money trading will resume. Ensure your broker connection is verified before proceeding.'
        "
        [confirmLabel]="pendingValue() ? 'Enable' : 'Disable'"
        [confirmVariant]="pendingValue() ? 'primary' : 'destructive'"
        [loading]="busy()"
        (confirm)="applyToggle()"
        (cancelled)="showConfirm.set(false)"
      />
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
      .status-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-8);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .status-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .status-text {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
      }
      .status-label {
        font-size: var(--text-lg);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .status-value {
        font-size: 32px;
        font-weight: var(--font-semibold);
        letter-spacing: var(--tracking-tight);
      }
      .status-value.on {
        color: var(--profit);
      }
      .status-value.off {
        color: var(--text-tertiary);
      }
      .changed-at {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .toggle-switch {
        position: relative;
        width: 64px;
        height: 34px;
        border-radius: 17px;
        border: none;
        background: #e5e5ea;
        cursor: pointer;
        transition: background 0.25s ease;
        padding: 0;
        flex-shrink: 0;
      }
      .toggle-switch:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .toggle-switch.active {
        background: var(--profit);
      }
      .toggle-knob {
        position: absolute;
        top: 3px;
        left: 3px;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: white;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        transition: transform 0.25s ease;
      }
      .toggle-switch.active .toggle-knob {
        transform: translateX(30px);
      }
      .backfill-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        box-shadow: var(--shadow-sm);
      }
      .section-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        margin: 0 0 var(--space-2);
      }
      .muted {
        color: var(--text-secondary);
        font-size: var(--text-sm);
        margin: 0 0 var(--space-4);
      }
      .backfill-form {
        display: flex;
        gap: var(--space-3);
        align-items: flex-end;
        flex-wrap: wrap;
      }
      .field {
        display: flex;
        flex-direction: column;
        min-width: 280px;
        flex: 1 1 280px;
      }
      .field label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
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
        justify-content: center;
        gap: var(--space-1);
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .spin {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class PaperTradingPageComponent implements OnInit {
  protected readonly service = inject(PaperTradingService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  readonly busy = signal(false);
  readonly showConfirm = signal(false);
  readonly pendingValue = signal(false);
  readonly strategies = signal<StrategyDto[]>([]);

  readonly backfillForm = this.fb.nonNullable.group({
    strategyId: [null as number | null, Validators.required],
  });

  ngOnInit(): void {
    this.service.getStatus().subscribe({
      error: () => this.notifications.error('Failed to load paper-trading status'),
    });
    this.strategiesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe((res) => {
      this.strategies.set(res.data?.data ?? []);
    });
  }

  confirmToggle(): void {
    this.pendingValue.set(!this.service.isPaperMode());
    this.showConfirm.set(true);
  }

  applyToggle(): void {
    const next = this.pendingValue();
    this.busy.set(true);
    this.service.setMode({ isPaperMode: next, reason: 'Toggled via admin UI' }).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showConfirm.set(false);
        if (res.status) {
          this.notifications.success(`Paper trading ${next ? 'enabled' : 'disabled'}`);
        } else {
          this.notifications.error(res.message ?? 'Failed to toggle mode');
        }
      },
      error: () => {
        this.busy.set(false);
        this.showConfirm.set(false);
      },
    });
  }

  submitBackfill(): void {
    const strategyId = this.backfillForm.getRawValue().strategyId;
    if (strategyId == null) return;
    this.busy.set(true);
    this.service.backfill(strategyId).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(
            'Backfill queued. Paper executions will be generated in the background.',
          );
        } else {
          this.notifications.error(res.message ?? 'Failed to queue backfill');
        }
      },
      error: () => this.busy.set(false),
    });
  }
}
