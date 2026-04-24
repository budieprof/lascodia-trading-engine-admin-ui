import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';

type BadgeVariant = 'success' | 'warning' | 'error' | 'info' | 'neutral';
type EntityType =
  | 'order'
  | 'position'
  | 'strategy'
  | 'signal'
  | 'broker'
  | 'health'
  | 'run'
  | 'default';

const STATUS_MAP: Record<string, Record<string, BadgeVariant>> = {
  order: {
    Pending: 'warning',
    Submitted: 'info',
    PartialFill: 'info',
    Filled: 'success',
    Cancelled: 'neutral',
    Rejected: 'error',
    Expired: 'neutral',
  },
  position: { Open: 'info', Closed: 'neutral', Closing: 'warning' },
  strategy: { Active: 'success', Paused: 'warning', Backtesting: 'info', Stopped: 'neutral' },
  signal: {
    Pending: 'warning',
    Approved: 'success',
    Executed: 'success',
    Rejected: 'error',
    Expired: 'neutral',
  },
  broker: { Connected: 'success', Disconnected: 'error', Error: 'error' },
  health: { true: 'success', false: 'error' },
  run: { Queued: 'neutral', Running: 'info', Completed: 'success', Failed: 'error' },
};

const VARIANT_STYLES: Record<
  BadgeVariant,
  { bg: string; color: string; glyph: string; aria: string }
> = {
  success: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D', glyph: '●', aria: 'success' },
  warning: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400', glyph: '▲', aria: 'warning' },
  error: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015', glyph: '■', aria: 'error' },
  info: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD', glyph: '◆', aria: 'info' },
  neutral: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366', glyph: '○', aria: 'neutral' },
};

@Component({
  selector: 'app-status-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="badge"
      [style.background]="style().bg"
      [style.color]="style().color"
      [attr.aria-label]="style().aria + ' status: ' + status()"
    >
      <span class="glyph" aria-hidden="true">{{ style().glyph }}</span>
      {{ status() }}
    </span>
  `,
  styles: [
    `
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        white-space: nowrap;
        line-height: 1.5;
      }
      .glyph {
        font-size: 8px;
        line-height: 1;
      }
    `,
  ],
})
export class StatusBadgeComponent {
  status = input.required<string>();
  type = input<EntityType>('default');

  private variant = computed<BadgeVariant>(() => {
    const map = STATUS_MAP[this.type()];
    return map?.[this.status()] ?? 'neutral';
  });

  style = computed(() => VARIANT_STYLES[this.variant()]);
}
