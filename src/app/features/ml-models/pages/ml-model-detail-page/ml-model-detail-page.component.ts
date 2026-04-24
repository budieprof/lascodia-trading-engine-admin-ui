import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DatePipe, DecimalPipe } from '@angular/common';

import { MLModelsService } from '@core/services/ml-models.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { MLModelDto, RollbackMLModelRequest } from '@core/api/api.types';

import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

@Component({
  selector: 'app-ml-model-detail-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    StatusBadgeComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    ConfirmDialogComponent,
  ],
  template: `
    <div class="page">
      @if (loading()) {
        <app-card-skeleton [lines]="10" />
      } @else if (model()) {
        @if (model(); as m) {
          <div class="title-row">
            <div class="title-left">
              <button type="button" class="btn-back" (click)="goBack()" aria-label="Back">
                &larr;
              </button>
              <h1 class="title">ML Model #{{ m.id }}</h1>
              <app-status-badge [status]="m.status" type="default" />
              @if (m.isActive) {
                <span class="active-pill">Active</span>
              }
            </div>
            <div class="title-actions">
              @if (!m.isActive) {
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="onActivate()"
                  [disabled]="busy()"
                >
                  Activate
                </button>
              }
              <button
                type="button"
                class="btn btn-warning"
                (click)="showRollback.set(true)"
                [disabled]="busy()"
              >
                Rollback to Prior
              </button>
            </div>
          </div>

          <section class="card">
            <header class="card-head"><h3>Model Information</h3></header>
            <dl class="grid">
              <div class="item">
                <dt>Symbol</dt>
                <dd>{{ m.symbol ?? '-' }}</dd>
              </div>
              <div class="item">
                <dt>Timeframe</dt>
                <dd>{{ m.timeframe }}</dd>
              </div>
              <div class="item">
                <dt>Version</dt>
                <dd class="mono">{{ m.modelVersion ?? '-' }}</dd>
              </div>
              <div class="item">
                <dt>Status</dt>
                <dd>{{ m.status }}</dd>
              </div>
              <div class="item">
                <dt>Active</dt>
                <dd>{{ m.isActive ? 'Yes' : 'No' }}</dd>
              </div>
              <div class="item">
                <dt>File Path</dt>
                <dd class="mono">{{ m.filePath ?? '—' }}</dd>
              </div>
              <div class="item">
                <dt>Direction Accuracy</dt>
                <dd class="mono">
                  {{
                    m.directionAccuracy !== null
                      ? (m.directionAccuracy * 100 | number: '1.2-2') + '%'
                      : '—'
                  }}
                </dd>
              </div>
              <div class="item">
                <dt>Magnitude RMSE</dt>
                <dd class="mono">
                  {{ m.magnitudeRMSE !== null ? (m.magnitudeRMSE | number: '1.4-4') : '—' }}
                </dd>
              </div>
              <div class="item">
                <dt>Training Samples</dt>
                <dd class="mono">{{ m.trainingSamples | number }}</dd>
              </div>
              <div class="item">
                <dt>Trained At</dt>
                <dd>{{ m.trainedAt | date: 'MMM d, yyyy HH:mm' }}</dd>
              </div>
              <div class="item">
                <dt>Activated At</dt>
                <dd>{{ m.activatedAt ? (m.activatedAt | date: 'MMM d, yyyy HH:mm') : '—' }}</dd>
              </div>
            </dl>
          </section>

          <section class="card">
            <header class="card-head"><h3>Related</h3></header>
            <div class="related">
              <button type="button" class="related-link" (click)="goBack()">
                Back to model registry <span aria-hidden="true">&rarr;</span>
              </button>
              <div class="note">
                <strong>Explainability (SHAP, feature importance)</strong> is not yet exposed by the
                engine API. Training curves and confidence calibration are available via the
                ML-model shadow evaluation endpoints (wired in Phase 3 — ML Lifecycle Depth).
              </div>
            </div>
          </section>
        }
      } @else {
        <app-error-state
          title="Model not found"
          [message]="errorMessage()"
          retryLabel="Back"
          (retry)="goBack()"
        />
      }

      <app-confirm-dialog
        [open]="showRollback()"
        title="Rollback to Prior Model"
        [message]="
          'Rollback to the most recent superseded model for ' +
          (model()?.symbol ?? '—') +
          ' / ' +
          (model()?.timeframe ?? '—') +
          '? The current active model will be deactivated.'
        "
        confirmLabel="Rollback"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="onRollback()"
        (cancelled)="showRollback.set(false)"
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
      .active-pill {
        display: inline-flex;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      .title-actions {
        display: flex;
        gap: var(--space-2);
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
      .btn-warning {
        background: rgba(255, 149, 0, 0.15);
        color: #c93400;
      }
      .btn-warning:hover:not(:disabled) {
        background: rgba(255, 149, 0, 0.25);
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
      .related {
        padding: var(--space-4) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .related-link {
        color: var(--accent);
        cursor: pointer;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .related-link:hover {
        text-decoration: underline;
      }
      .note {
        padding: var(--space-4);
        background: var(--bg-primary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-secondary);
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
export class MLModelDetailPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(MLModelsService);
  private readonly notifications = inject(NotificationService);

  readonly model = signal<MLModelDto | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly showRollback = signal(false);

  ngOnInit(): void {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    if (!id || Number.isNaN(id)) {
      this.loading.set(false);
      this.errorMessage.set('Invalid model id');
      return;
    }
    this.load(id);
  }

  goBack(): void {
    this.router.navigate(['/ml-models']);
  }

  onActivate(): void {
    const m = this.model();
    if (!m) return;
    this.busy.set(true);
    this.service.activate(m.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(`Model ${m.symbol} ${m.timeframe} activated`);
          this.load(m.id);
        } else {
          this.notifications.error(res.message ?? 'Activation failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  onRollback(): void {
    const m = this.model();
    if (!m) return;
    const request: RollbackMLModelRequest = {
      symbol: m.symbol ?? undefined,
      timeframe: m.timeframe,
    };
    this.busy.set(true);
    this.service.rollback(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showRollback.set(false);
        if (res.status) {
          this.notifications.success('Rolled back to prior model');
          if (res.data) {
            this.router.navigate(['/ml-models', res.data.id]);
          } else {
            this.goBack();
          }
        } else {
          this.notifications.error(res.message ?? 'Rollback failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.showRollback.set(false);
      },
    });
  }

  private load(id: number): void {
    this.loading.set(true);
    this.service.getById(id).subscribe({
      next: (res) => {
        this.loading.set(false);
        if (res.data) {
          this.model.set(res.data);
          this.errorMessage.set(null);
        } else {
          this.model.set(null);
          this.errorMessage.set(res.message ?? 'Model not found');
        }
      },
      error: () => {
        this.loading.set(false);
        this.model.set(null);
        this.errorMessage.set('Failed to load model');
      },
    });
  }
}
