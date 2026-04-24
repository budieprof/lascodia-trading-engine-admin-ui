import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="overlay"
        role="presentation"
        tabindex="-1"
        (click)="onCancel()"
        (keydown.escape)="onCancel()"
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          [attr.aria-labelledby]="dialogTitleId"
          [attr.aria-describedby]="dialogBodyId"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="dialog-header">
            <h3 class="dialog-title" [id]="dialogTitleId">{{ title() }}</h3>
          </div>
          <div class="dialog-body" [id]="dialogBodyId">
            <p>{{ message() }}</p>
            <ng-content />
          </div>
          <div class="dialog-actions">
            <button
              type="button"
              class="btn btn-secondary"
              (click)="onCancel()"
              [disabled]="loading()"
            >
              Cancel
            </button>
            <button
              type="button"
              class="btn"
              [class.btn-destructive]="confirmVariant() === 'destructive'"
              [class.btn-primary]="confirmVariant() === 'primary'"
              (click)="onConfirm()"
              [disabled]="loading()"
              autofocus
            >
              @if (loading()) {
                <span class="spinner" aria-label="Loading"></span>
              } @else {
                {{ confirmLabel() }}
              }
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.15s ease;
      }

      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 420px;
        animation: scaleIn 0.2s ease-out;
      }

      .dialog-header {
        padding: var(--space-5) var(--space-6) 0;
      }

      .dialog-title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }

      .dialog-body {
        padding: var(--space-3) var(--space-6);
      }

      .dialog-body p {
        font-size: var(--text-base);
        color: var(--text-secondary);
        margin: 0;
        line-height: 1.5;
      }

      .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-6) var(--space-5);
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 80px;
      }

      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-tertiary);
        opacity: 0.8;
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

      .spinner {
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
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes scaleIn {
        from {
          transform: scale(0.96);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }
    `,
  ],
})
export class ConfirmDialogComponent {
  private static nextId = 0;

  readonly dialogTitleId = `confirm-dialog-title-${ConfirmDialogComponent.nextId++}`;
  readonly dialogBodyId = `confirm-dialog-body-${ConfirmDialogComponent.nextId++}`;

  open = input(false);
  title = input('Confirm Action');
  message = input('Are you sure?');
  confirmLabel = input('Confirm');
  confirmVariant = input<'primary' | 'destructive'>('primary');
  loading = input(false);

  confirm = output<void>();
  cancelled = output<void>();

  onConfirm() {
    this.confirm.emit();
  }
  onCancel() {
    this.cancelled.emit();
  }
}
