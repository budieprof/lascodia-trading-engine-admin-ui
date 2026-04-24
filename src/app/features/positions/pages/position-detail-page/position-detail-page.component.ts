import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';

import { PositionsService } from '@core/services/positions.service';
import { TrailingStopService } from '@core/services/trailing-stop.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  PositionDto,
  ScalePositionRequest,
  TrailingStopType,
  UpdateTrailingStopRequest,
} from '@core/api/api.types';

import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';

@Component({
  selector: 'app-position-detail-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    DatePipe,
    DecimalPipe,
    StatusBadgeComponent,
    ErrorStateComponent,
    FormFieldComponent,
    FormFieldControlDirective,
    CardSkeletonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      @if (loading()) {
        <app-card-skeleton [lines]="10" />
      } @else if (position()) {
        @if (position(); as p) {
          <div class="title-row">
            <div class="title-left">
              <button type="button" class="btn-back" (click)="goBack()" aria-label="Back">
                &larr;
              </button>
              <h1 class="title">Position #{{ p.id }}</h1>
              <app-status-badge [status]="p.status" type="position" />
              <span class="paper" [class.live]="!p.isPaper">{{
                p.isPaper ? 'Paper' : 'Live'
              }}</span>
            </div>
            @if (p.status === 'Open') {
              <div class="title-actions">
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="openTrailingPanel()"
                  [disabled]="busy()"
                >
                  Update Trailing Stop
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="openScalePanel()"
                  [disabled]="busy()"
                >
                  Scale In / Out
                </button>
              </div>
            }
          </div>

          @if (showTrailingPanel()) {
            <form class="panel" [formGroup]="trailingForm" (ngSubmit)="submitTrailing()">
              <div class="panel-head">
                <h3>Update Trailing Stop</h3>
                <button
                  type="button"
                  class="close"
                  (click)="showTrailingPanel.set(false)"
                  aria-label="Close"
                >
                  &times;
                </button>
              </div>
              <div class="panel-body">
                <app-form-field
                  label="Type"
                  [required]="true"
                  [control]="trailingForm.controls.trailingStopType"
                >
                  <select appFormFieldControl formControlName="trailingStopType">
                    <option value="FixedPips">Fixed Pips</option>
                    <option value="ATR">ATR</option>
                    <option value="Percentage">Percentage</option>
                  </select>
                </app-form-field>
                <app-form-field
                  label="Value"
                  [required]="true"
                  [control]="trailingForm.controls.trailingStopValue"
                >
                  <input
                    appFormFieldControl
                    formControlName="trailingStopValue"
                    type="number"
                    step="0.00001"
                    placeholder="e.g. 20"
                  />
                </app-form-field>
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="showTrailingPanel.set(false)"
                    [disabled]="busy()"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    class="btn btn-primary"
                    [disabled]="busy() || trailingForm.invalid"
                  >
                    @if (busy()) {
                      <span class="spin"></span>
                    } @else {
                      Save
                    }
                  </button>
                </div>
              </div>
            </form>
          }

          @if (showScalePanel()) {
            <form class="panel" [formGroup]="scaleForm" (ngSubmit)="submitScale()">
              <div class="panel-head">
                <h3>Scale Position</h3>
                <button
                  type="button"
                  class="close"
                  (click)="showScalePanel.set(false)"
                  aria-label="Close"
                >
                  &times;
                </button>
              </div>
              <div class="panel-body">
                <app-form-field
                  label="Action"
                  [required]="true"
                  [control]="scaleForm.controls.scaleType"
                >
                  <select appFormFieldControl formControlName="scaleType">
                    <option value="ScaleIn">Scale In</option>
                    <option value="ScaleOut">Scale Out</option>
                  </select>
                </app-form-field>
                <app-form-field label="Lots" [required]="true" [control]="scaleForm.controls.lots">
                  <input
                    appFormFieldControl
                    formControlName="lots"
                    type="number"
                    step="0.01"
                    min="0.01"
                  />
                </app-form-field>
                <app-form-field
                  label="Price"
                  [required]="true"
                  [control]="scaleForm.controls.price"
                >
                  <input appFormFieldControl formControlName="price" type="number" step="0.00001" />
                </app-form-field>
                <div class="actions">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="showScalePanel.set(false)"
                    [disabled]="busy()"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    class="btn btn-primary"
                    [disabled]="busy() || scaleForm.invalid"
                  >
                    @if (busy()) {
                      <span class="spin"></span>
                    } @else {
                      Submit
                    }
                  </button>
                </div>
              </div>
            </form>
          }

          <section class="card">
            <header class="card-head"><h3>Position Information</h3></header>
            <dl class="grid">
              <div class="item">
                <dt>Symbol</dt>
                <dd>{{ p.symbol ?? '-' }}</dd>
              </div>
              <div class="item">
                <dt>Direction</dt>
                <dd>
                  <span
                    class="side"
                    [class.long]="p.direction === 'Long'"
                    [class.short]="p.direction === 'Short'"
                  >
                    {{ p.direction }}
                  </span>
                </dd>
              </div>
              <div class="item">
                <dt>Lots</dt>
                <dd class="mono">{{ p.openLots | number: '1.2-2' }}</dd>
              </div>
              <div class="item">
                <dt>Avg Entry</dt>
                <dd class="mono">{{ p.averageEntryPrice | number: '1.5-5' }}</dd>
              </div>
              <div class="item">
                <dt>Current Price</dt>
                <dd class="mono">
                  {{ p.currentPrice !== null ? (p.currentPrice | number: '1.5-5') : '-' }}
                </dd>
              </div>
              <div class="item">
                <dt>Unrealized P&amp;L</dt>
                <dd
                  class="mono"
                  [class.profit]="p.unrealizedPnL > 0"
                  [class.loss]="p.unrealizedPnL < 0"
                >
                  {{ p.unrealizedPnL | number: '1.2-2' }}
                </dd>
              </div>
              <div class="item">
                <dt>Realized P&amp;L</dt>
                <dd
                  class="mono"
                  [class.profit]="p.realizedPnL > 0"
                  [class.loss]="p.realizedPnL < 0"
                >
                  {{ p.realizedPnL | number: '1.2-2' }}
                </dd>
              </div>
              <div class="item">
                <dt>Stop Loss</dt>
                <dd class="mono">
                  {{ p.stopLoss !== null ? (p.stopLoss | number: '1.5-5') : '-' }}
                </dd>
              </div>
              <div class="item">
                <dt>Take Profit</dt>
                <dd class="mono">
                  {{ p.takeProfit !== null ? (p.takeProfit | number: '1.5-5') : '-' }}
                </dd>
              </div>
              <div class="item">
                <dt>Trailing Stop</dt>
                <dd class="mono">
                  {{ p.trailingStopLevel !== null ? (p.trailingStopLevel | number: '1.5-5') : '-' }}
                </dd>
              </div>
              <div class="item">
                <dt>Broker ID</dt>
                <dd class="mono">{{ p.brokerPositionId ?? '-' }}</dd>
              </div>
              <div class="item">
                <dt>Opened</dt>
                <dd>{{ p.openedAt | date: 'MMM d, yyyy HH:mm:ss' }}</dd>
              </div>
              <div class="item">
                <dt>Closed</dt>
                <dd>{{ p.closedAt ? (p.closedAt | date: 'MMM d, yyyy HH:mm:ss') : '-' }}</dd>
              </div>
            </dl>
          </section>

          <section class="card">
            <header class="card-head"><h3>Related</h3></header>
            <div class="related">
              <a
                class="related-link"
                [routerLink]="['/orders']"
                [queryParams]="{ symbol: p.symbol }"
              >
                Orders for {{ p.symbol }} <span aria-hidden="true">&rarr;</span>
              </a>
              <a
                class="related-link"
                [routerLink]="['/execution-quality']"
                [queryParams]="{ symbol: p.symbol }"
              >
                Execution quality for {{ p.symbol }} <span aria-hidden="true">&rarr;</span>
              </a>
            </div>
          </section>
        }
      } @else {
        <app-error-state
          title="Position not found"
          [message]="errorMessage()"
          retryLabel="Back to Positions"
          (retry)="goBack()"
        />
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
      .title-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .title-left {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .btn-back {
        width: 36px;
        height: 36px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
      }
      .btn-back:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .title {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        margin: 0;
      }
      .title-actions {
        display: flex;
        gap: var(--space-2);
      }
      .paper {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .paper.live {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .side {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .side.long {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .side.short {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
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
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .close {
        background: transparent;
        border: none;
        font-size: 20px;
        color: var(--text-secondary);
        cursor: pointer;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-full);
      }
      .close:hover {
        background: var(--bg-tertiary);
      }
      .panel-body {
        display: flex;
        gap: var(--space-4);
        flex-wrap: wrap;
        padding: var(--space-5);
        align-items: flex-end;
      }
      .field {
        display: flex;
        flex-direction: column;
        min-width: 180px;
        flex: 1 1 180px;
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
      .actions {
        display: flex;
        gap: var(--space-2);
        margin-left: auto;
      }
      .card {
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
      .grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 0;
        margin: 0;
      }
      .item {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .item:nth-child(3n) {
        border-right: none;
      }
      .item dt {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
        margin: 0;
      }
      .item dd {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-primary);
        margin: 0;
      }
      .item dd.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
      .related {
        display: flex;
        flex-direction: column;
      }
      .related-link {
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
        color: var(--accent);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .related-link:last-child {
        border-bottom: none;
      }
      .related-link:hover {
        background: var(--bg-tertiary);
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
      @media (max-width: 768px) {
        .grid {
          grid-template-columns: 1fr;
        }
        .item {
          border-right: none;
        }
      }
    `,
  ],
})
export class PositionDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly positionsService = inject(PositionsService);
  private readonly trailingStopService = inject(TrailingStopService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  readonly position = signal<PositionDto | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly showTrailingPanel = signal(false);
  readonly showScalePanel = signal(false);

  readonly trailingForm = this.fb.nonNullable.group({
    trailingStopType: ['FixedPips' as TrailingStopType, Validators.required],
    trailingStopValue: [0, [Validators.required, Validators.min(0.00001)]],
  });

  readonly scaleForm = this.fb.nonNullable.group({
    scaleType: ['ScaleIn' as 'ScaleIn' | 'ScaleOut', Validators.required],
    lots: [0.01, [Validators.required, Validators.min(0.01)]],
    price: [0, [Validators.required, Validators.min(0.00001)]],
  });

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id || Number.isNaN(id)) {
      this.loading.set(false);
      this.errorMessage.set('Invalid position id');
      return;
    }
    this.load(id);
  }

  goBack(): void {
    this.router.navigate(['/positions']);
  }

  openTrailingPanel(): void {
    const p = this.position();
    if (!p) return;
    this.trailingForm.patchValue({
      trailingStopType: 'FixedPips',
      trailingStopValue: p.trailingStopLevel ?? 20,
    });
    this.showTrailingPanel.set(true);
    this.showScalePanel.set(false);
  }

  openScalePanel(): void {
    const p = this.position();
    if (!p) return;
    this.scaleForm.patchValue({
      scaleType: 'ScaleIn',
      lots: Math.max(0.01, p.openLots * 0.25),
      price: p.currentPrice ?? p.averageEntryPrice,
    });
    this.showScalePanel.set(true);
    this.showTrailingPanel.set(false);
  }

  submitTrailing(): void {
    const p = this.position();
    if (!p) return;
    const v = this.trailingForm.getRawValue();
    const request: UpdateTrailingStopRequest = {
      positionId: p.id,
      trailingStopType: v.trailingStopType,
      trailingStopValue: v.trailingStopValue,
    };
    this.busy.set(true);
    this.trailingStopService.update(p.id, request).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showTrailingPanel.set(false);
        if (res.status) {
          this.notifications.success('Trailing stop updated');
          this.load(p.id);
        } else {
          this.notifications.error(res.message ?? 'Failed to update trailing stop');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  submitScale(): void {
    const p = this.position();
    if (!p) return;
    const v = this.scaleForm.getRawValue();
    const request: ScalePositionRequest = {
      positionId: p.id,
      scaleType: v.scaleType,
      lots: v.lots,
      price: v.price,
    };
    this.busy.set(true);
    this.trailingStopService.scale(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showScalePanel.set(false);
        if (res.status) {
          this.notifications.success(
            `Position ${v.scaleType === 'ScaleIn' ? 'scaled in' : 'scaled out'}`,
          );
          this.load(p.id);
        } else {
          this.notifications.error(res.message ?? 'Failed to scale position');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  private load(id: number): void {
    this.loading.set(true);
    this.positionsService.getById(id).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.data) {
          this.position.set(res.data);
          this.errorMessage.set(null);
        } else {
          this.position.set(null);
          this.errorMessage.set(res.message ?? 'Position not found');
        }
      },
      error: () => {
        this.loading.set(false);
        this.position.set(null);
        this.errorMessage.set('Failed to load position');
      },
    });
  }
}
