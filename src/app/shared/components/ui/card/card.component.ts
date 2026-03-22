import { Component, ChangeDetectionStrategy, input } from '@angular/core';

@Component({
  selector: 'ui-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="card"
      [class.card--hoverable]="hoverable()"
      [class.card--padding-lg]="padding() === 'large'"
    >
      <ng-content />
    </div>
  `,
  styles: [`
    .card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-sm);
      padding: var(--card-padding);
      transition: box-shadow 0.15s ease, transform 0.15s ease;
    }

    .card--padding-lg {
      padding: var(--card-padding-lg);
    }

    .card--hoverable:hover {
      box-shadow: var(--shadow-md);
      transform: translateY(-1px);
    }
  `],
})
export class CardComponent {
  readonly hoverable = input(true);
  readonly padding = input<'default' | 'large'>('default');
}
