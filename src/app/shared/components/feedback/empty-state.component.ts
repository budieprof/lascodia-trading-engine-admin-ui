import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { LucideAngularModule, Inbox } from 'lucide-angular';

@Component({
  selector: 'app-empty-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  template: `
    <div class="empty" role="status">
      <div class="icon">
        <lucide-icon [img]="icon()" size="32" strokeWidth="1.5" />
      </div>
      <h3 class="title">{{ title() }}</h3>
      @if (description()) {
        <p class="desc">{{ description() }}</p>
      }
      @if (actionLabel()) {
        <button type="button" class="action" (click)="actionClick.emit()">
          {{ actionLabel() }}
        </button>
      }
    </div>
  `,
  styles: [
    `
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: var(--space-10) var(--space-6);
        color: var(--text-secondary);
      }
      .icon {
        width: 56px;
        height: 56px;
        border-radius: var(--radius-full);
        display: grid;
        place-items: center;
        background: var(--bg-secondary);
        color: var(--text-tertiary);
        margin-bottom: var(--space-4);
      }
      .title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin-bottom: var(--space-2);
      }
      .desc {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        max-width: 420px;
        margin-bottom: var(--space-5);
      }
      .action {
        padding: 8px 16px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        transition: background 0.15s ease;
      }
      .action:hover {
        background: var(--accent-hover);
      }
    `,
  ],
})
export class EmptyStateComponent {
  readonly title = input.required<string>();
  readonly description = input<string | null>(null);
  readonly actionLabel = input<string | null>(null);
  readonly icon = input(Inbox);

  readonly actionClick = output<void>();
}
