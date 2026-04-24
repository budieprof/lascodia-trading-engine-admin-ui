import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';

type Variant = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'accent';

export interface StatusPillRendererParams {
  /** Optional per-value map overriding the default palette. */
  palette?: Record<string, Variant>;
  /** Accessible-label prefix, e.g. "Order status". */
  label?: string;
}

const DEFAULT_PALETTE: Record<string, Variant> = {
  // Orders / runs
  Pending: 'warning',
  Submitted: 'info',
  PartialFill: 'info',
  Filled: 'success',
  Cancelled: 'neutral',
  Rejected: 'error',
  Expired: 'neutral',
  // Positions
  Open: 'info',
  Closing: 'warning',
  Closed: 'neutral',
  // Strategies / models
  Active: 'success',
  Paused: 'warning',
  Stopped: 'neutral',
  Training: 'info',
  Superseded: 'neutral',
  Failed: 'error',
  Completed: 'success',
  Queued: 'neutral',
  Running: 'info',
  Promoted: 'accent',
  Processing: 'warning',
  // Brokers / EA
  Connected: 'success',
  Disconnected: 'error',
  Error: 'error',
  Idle: 'warning',
  // Generic booleans
  Healthy: 'success',
  Degraded: 'warning',
  Crisis: 'error',
  // A/B results
  ChampionWon: 'success',
  ChallengerWon: 'accent',
  Inconclusive: 'warning',
};

const STYLES: Record<Variant, { bg: string; color: string }> = {
  success: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
  warning: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
  error: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
  info: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
  neutral: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
  accent: { bg: 'rgba(175, 82, 222, 0.12)', color: '#8944AB' },
};

/**
 * Angular cell component for ag-grid — renders a status pill without building
 * HTML via innerHTML. Use from ColDef like:
 *   { field: 'status', cellRenderer: StatusPillCellComponent,
 *     cellRendererParams: { label: 'Order status' } satisfies StatusPillRendererParams }
 */
@Component({
  selector: 'app-status-pill-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (value()) {
      <span
        class="pill"
        [style.background]="style().bg"
        [style.color]="style().color"
        [attr.aria-label]="ariaLabel()"
        >{{ value() }}</span
      >
    } @else {
      <span class="muted">—</span>
    }
  `,
  styles: [
    `
      :host {
        display: inline-flex;
        align-items: center;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        line-height: 1.5;
        white-space: nowrap;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class StatusPillCellComponent implements ICellRendererAngularComp {
  readonly value = signal<string>('');
  readonly params = signal<StatusPillRendererParams>({});

  readonly variant = computed<Variant>(() => {
    const override = this.params().palette?.[this.value()];
    return override ?? DEFAULT_PALETTE[this.value()] ?? 'neutral';
  });

  readonly style = computed(() => STYLES[this.variant()]);
  readonly ariaLabel = computed(() => {
    const prefix = this.params().label ?? 'Status';
    return `${prefix}: ${this.value()}`;
  });

  agInit(params: ICellRendererParams & StatusPillRendererParams): void {
    this.value.set(params.value == null ? '' : String(params.value));
    this.params.set({ palette: params.palette, label: params.label });
  }

  refresh(params: ICellRendererParams & StatusPillRendererParams): boolean {
    this.value.set(params.value == null ? '' : String(params.value));
    this.params.set({ palette: params.palette, label: params.label });
    return true;
  }
}
