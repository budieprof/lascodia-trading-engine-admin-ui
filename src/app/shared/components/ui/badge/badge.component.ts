import { Component, ChangeDetectionStrategy, input } from '@angular/core';

@Component({
  selector: 'ui-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="badge" [class]="'badge badge--' + variant()">
      <ng-content />
    </span>
  `,
  styles: [
    `
      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: var(--radius-full);
        padding: 2px 10px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: -0.01em;
        white-space: nowrap;
        line-height: 1.5;
      }

      .badge--success {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }

      .badge--warning {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }

      .badge--error {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }

      .badge--info {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }

      .badge--neutral {
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
    `,
  ],
})
export class BadgeComponent {
  readonly variant = input<'success' | 'warning' | 'error' | 'info' | 'neutral'>('neutral');
}
