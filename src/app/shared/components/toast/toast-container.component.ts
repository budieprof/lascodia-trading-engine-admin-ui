import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { NotificationService } from '@core/notifications/notification.service';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-container">
      @for (toast of notifications.toasts(); track toast.id) {
        <div
          class="toast"
          role="alert"
          tabindex="0"
          [class]="'toast-' + toast.type"
          (click)="notifications.dismiss(toast.id)"
          (keydown.enter)="notifications.dismiss(toast.id)"
          (keydown.space)="notifications.dismiss(toast.id); $event.preventDefault()"
        >
          <div class="toast-accent"></div>
          <div class="toast-content">
            <div class="toast-icon">{{ getIcon(toast.type) }}</div>
            <p class="toast-message">{{ toast.message }}</p>
            <button
              class="toast-close"
              (click)="notifications.dismiss(toast.id); $event.stopPropagation()"
            >
              ×
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toast-container {
        position: fixed;
        top: var(--space-4);
        right: var(--space-4);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        width: 380px;
        pointer-events: none;
      }

      .toast {
        pointer-events: auto;
        display: flex;
        background: var(--bg-glass);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-md);
        overflow: hidden;
        cursor: pointer;
        animation: slideInRight 0.3s ease-out;
      }

      .toast-accent {
        width: 3px;
        flex-shrink: 0;
      }

      .toast-success .toast-accent {
        background: var(--profit);
      }
      .toast-error .toast-accent {
        background: var(--loss);
      }
      .toast-warning .toast-accent {
        background: var(--warning);
      }
      .toast-info .toast-accent {
        background: var(--accent);
      }

      .toast-content {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        flex: 1;
        min-width: 0;
      }

      .toast-icon {
        font-size: 16px;
        flex-shrink: 0;
      }

      .toast-message {
        font-size: var(--text-sm);
        color: var(--text-primary);
        margin: 0;
        flex: 1;
        line-height: 1.4;
      }

      .toast-close {
        width: 24px;
        height: 24px;
        border: none;
        background: transparent;
        color: var(--text-tertiary);
        font-size: 18px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        flex-shrink: 0;
        transition: all 0.15s ease;
      }

      .toast-close:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      @keyframes slideInRight {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `,
  ],
})
export class ToastContainerComponent {
  notifications = inject(NotificationService);

  getIcon(type: string): string {
    switch (type) {
      case 'success':
        return '✓';
      case 'error':
        return '✕';
      case 'warning':
        return '⚠';
      case 'info':
        return 'ℹ';
      default:
        return 'ℹ';
    }
  }
}
