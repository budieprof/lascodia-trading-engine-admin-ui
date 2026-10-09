import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { DataWindowSection } from './value-providers';

/**
 * TradingView's Data Window (CC-I6): every value at the crosshair — the bar, each study, each
 * script — section by section, as the chart's value providers report them
 * (`ChartHostComponent.registerValueProvider`). It shows what it is given and holds no state.
 */
@Component({
  selector: 'app-data-window',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dw-head">Data window</div>
    @for (sec of sections(); track sec.id) {
      <section class="dw-section" [attr.aria-label]="sec.title">
        <div class="dw-title">{{ sec.title }}</div>
        @for (r of sec.rows; track $index) {
          <div class="dw-row">
            <span>{{ r.label }}</span
            ><b [style.color]="r.color ?? null">{{ r.value }}</b>
          </div>
        }
      </section>
    } @empty {
      <div class="dw-empty">Move the pointer over the chart.</div>
    }
  `,
  styles: `
    :host {
      display: block;
      font-size: 12px;
    }
    .dw-head {
      padding: 4px 0 8px;
      font-weight: 600;
    }
    .dw-section {
      padding: 6px 0;
      border-top: 1px solid var(--border, #e6e9ef);
    }
    .dw-title {
      margin-bottom: 2px;
      color: var(--text-muted, #787b86);
    }
    .dw-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      line-height: 20px;
    }
    .dw-row b {
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .dw-empty {
      color: var(--text-muted, #787b86);
    }
  `,
})
export class DataWindowComponent {
  readonly sections = input<readonly DataWindowSection[]>([]);
}
