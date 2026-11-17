import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { StrategiesService } from '@core/services/strategies.service';
import { AuditTrailService } from '@core/services/audit-trail.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { StrategyVariantDto } from '@core/api/api.types';
import { isApprovalPendingEnvelope } from '@core/auth/approval.interceptor';

/**
 * The one confirm for promoting an A/B shadow variant (variants tab + analytics page). Promotion
 * copies the variant's overrides onto the LIVE base strategy, so it is never one click: the
 * operator sees what it does and may give a reason, which goes to the audit trail.
 *
 * Render it only while a variant is pending (`@if (pending(); as v) { <app-promote-variant-dialog [variant]="v" …/> }`).
 * `closed` fires on cancel and after the call settles; `promoted` fires only on success.
 */
@Component({
  selector: 'app-promote-variant-dialog',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" (click)="cancel()">
      <div
        class="modal"
        (click)="$event.stopPropagation()"
        role="dialog"
        aria-modal="true"
        aria-labelledby="promote-variant-title"
      >
        <header class="modal-head">
          <h2 id="promote-variant-title">Promote variant</h2>
          <button type="button" class="close-btn" (click)="cancel()" aria-label="Close">×</button>
        </header>
        <p class="modal-target">
          <span class="mono">#{{ variant().id }} · {{ variant().name }}</span>
        </p>
        <p class="modal-desc">
          Promotion copies this variant's parameter overrides onto the base strategy and retires the
          shadow run. The base strategy continues trading with the new parameters. This is
          reversible only by capturing a strategy version before promoting (use the version history
          drawer).
        </p>
        <label class="reason-field">
          <span>Reason (optional, written to audit trail)</span>
          <textarea
            rows="2"
            [(ngModel)]="reasonText"
            placeholder="Why is this variant worth promoting?"
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
  `,
  styles: [
    `
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
export class PromoteVariantDialogComponent {
  private readonly strategies = inject(StrategiesService);
  private readonly auditTrail = inject(AuditTrailService);
  private readonly notify = inject(NotificationService);

  readonly variant = input.required<StrategyVariantDto>();
  /** The engine accepted the promotion. */
  readonly promoted = output<StrategyVariantDto>();
  /** The dialog is done (cancelled, or the call settled either way). */
  readonly closed = output<void>();

  protected reasonText = '';
  protected readonly submitting = signal(false);

  protected cancel(): void {
    if (this.submitting()) return;
    this.closed.emit();
  }

  protected confirm(): void {
    if (this.submitting()) return;
    const v = this.variant();
    this.submitting.set(true);
    const reason = this.reasonText.trim();
    this.strategies
      .promoteVariant(v.id)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.closed.emit();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res?.status) {
            this.notify.success(`Variant #${v.id} promoted.`);
            this.auditTrail
              .create({
                entityType: 'StrategyVariant',
                entityId: v.id,
                decisionType: 'StrategyVariantPromoted',
                outcome: 'Promoted',
                reason: reason || null,
                contextJson: JSON.stringify({
                  baseStrategyId: v.baseStrategyId,
                  name: v.name,
                  shadowSignalCount: v.shadowSignalCount,
                  shadowSharpeRatio: v.shadowSharpeRatio,
                }),
                source: 'AdminUI',
              })
              .subscribe({ error: () => undefined });
            this.promoted.emit(v);
          } else if (isApprovalPendingEnvelope(res)) {
            // Parked for a second approver; the approval interceptor already said so.
          } else {
            this.notify.error(res?.message ?? 'Variant promotion failed.');
          }
        },
        error: () => this.notify.error('Variant promotion failed.'),
      });
  }
}
