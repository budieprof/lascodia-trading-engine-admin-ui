import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideAngularModule, AlertTriangle } from 'lucide-angular';

@Component({
  selector: 'app-error-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    <div class="state" role="alert">
      <div class="icon">
        <lucide-icon [img]="AlertTriangle" size="32" strokeWidth="1.5" />
      </div>
      <h3 class="title">{{ title() }}</h3>
      @if (message()) {
        <p class="msg">{{ message() }}</p>
      }
      @if (showRetry()) {
        <button type="button" class="retry" (click)="retry.emit()">{{ retryLabel() }}</button>
      }
    </div>
  `,
  styles: [
    `
      .state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: var(--space-10) var(--space-6);
      }
      .icon {
        width: 56px;
        height: 56px;
        border-radius: var(--radius-full);
        display: grid;
        place-items: center;
        background: rgba(255, 59, 48, 0.1);
        color: var(--loss);
        margin-bottom: var(--space-4);
      }
      .title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin-bottom: var(--space-2);
      }
      .msg {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        max-width: 480px;
        margin-bottom: var(--space-5);
        word-break: break-word;
      }
      .retry {
        padding: 8px 16px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        transition: background 0.15s ease;
      }
      .retry:hover {
        background: var(--accent-hover);
      }
    `,
  ],
})
export class ErrorStateComponent {
  readonly title = input('Something went wrong');
  readonly message = input<string | null>(null);
  readonly retryLabel = input('Try again');
  readonly showRetry = input(true);

  readonly retry = output<void>();

  protected readonly AlertTriangle = AlertTriangle;
}
