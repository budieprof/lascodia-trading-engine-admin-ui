import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';

import { PaperTradingService } from '@core/services/paper-trading.service';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PaperTrackRecordComponent } from '../../components/paper-track-record.component';
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
    PaperTrackRecordComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Paper Trading"
        subtitle="Simulated execution with no broker contact"
      />

      <!-- The engine-wide switch. On is the unusual state (live accounts stop trading), so it reads
           amber, not green. -->
      <section
        class="status-card"
        [class.on]="service.isPaperMode()"
        aria-label="Engine paper mode"
      >
        <div class="status-header">
          <div class="status-main">
            <span class="status-kicker">Engine-wide paper mode</span>
            <div class="status-text">
              <span class="status-label">Paper Trading is</span>
              <span
                class="status-value"
                [class.on]="service.isPaperMode()"
                [class.off]="!service.isPaperMode()"
              >
                {{ service.isPaperMode() ? 'ENABLED' : 'DISABLED' }}
              </span>
              <span class="mode-pill" [class.on]="service.isPaperMode()">
                {{ service.isPaperMode() ? 'Every order simulated' : 'Live trading' }}
              </span>
            </div>
            @if (service.status()?.changedAt) {
              <div class="changed-at">
                Last changed {{ service.status()!.changedAt | date: 'd MMM yyyy, HH:mm:ss' }}
              </div>
            }
          </div>
          <div class="toggle-wrap">
            <span class="toggle-caption">{{ service.isPaperMode() ? 'On' : 'Off' }}</span>
            <button
              type="button"
              class="toggle-switch"
              [class.active]="service.isPaperMode()"
              [disabled]="busy()"
              (click)="confirmToggle()"
              role="switch"
              [attr.aria-checked]="service.isPaperMode()"
              aria-label="Engine paper mode"
            >
              <span class="toggle-knob"></span>
            </button>
          </div>
        </div>
        <p class="explain">
          <code>Engine:PaperMode</code> is the engine-wide switch: while it is on, EVERY order is
          filled by a simulated broker and none reaches an MT5 account. It is
          {{
            service.isPaperMode()
              ? 'on — live accounts are not trading'
              : 'off — orders go to the live accounts through their EA instances'
          }}. It is a trading-behaviour switch; strategies that are not yet trusted are paper-traded
          on their own (below) without it.
        </p>
      </section>

      <app-paper-track-record />

      <section class="backfill-card">
        <h3 class="section-title">Backfill simulated executions</h3>
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
              Trigger backfill
            }
          </button>
        </form>
      </section>

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
  styleUrl: './paper-trading-page.component.scss',
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
