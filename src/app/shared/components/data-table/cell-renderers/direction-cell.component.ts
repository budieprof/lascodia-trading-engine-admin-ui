import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import type { ICellRendererAngularComp } from 'ag-grid-angular';
import type { ICellRendererParams } from 'ag-grid-community';

type Direction = 'Long' | 'Short' | 'Buy' | 'Sell' | string;

/**
 * Angular cell component rendering a position / order direction with an arrow
 * glyph and a colour tied to long/short semantics. Replaces the innerHTML-built
 * span pattern scattered across the list views.
 */
@Component({
  selector: 'app-direction-cell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (value()) {
      <span
        class="dir"
        [class.long]="isLong()"
        [class.short]="!isLong()"
        [attr.aria-label]="ariaLabel()"
      >
        <span class="arrow" aria-hidden="true">{{ isLong() ? '▲' : '▼' }}</span>
        {{ value() }}
      </span>
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
      .dir {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-weight: var(--font-semibold);
        font-size: var(--text-xs);
      }
      .dir.long {
        color: var(--profit);
      }
      .dir.short {
        color: var(--loss);
      }
      .arrow {
        font-size: 10px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class DirectionCellComponent implements ICellRendererAngularComp {
  readonly value = signal<Direction>('');

  readonly isLong = computed(() => {
    const v = this.value();
    return v === 'Long' || v === 'Buy';
  });

  readonly ariaLabel = computed(() => `Direction: ${this.value()}`);

  agInit(params: ICellRendererParams): void {
    this.value.set(params.value == null ? '' : String(params.value));
  }

  refresh(params: ICellRendererParams): boolean {
    this.value.set(params.value == null ? '' : String(params.value));
    return true;
  }
}
