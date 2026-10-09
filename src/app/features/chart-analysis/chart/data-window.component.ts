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
    /* The host pane has no side padding (it is shared with edge-to-edge lists), so the data window carries its own
       12px gutter — labels and values never touch the pane's border. */
    :host {
      display: block;
      font-size: 12px;
    }
    .dw-head {
      padding: 4px 12px 8px;
      font-weight: 600;
    }
    .dw-section {
      padding: 8px 12px;
      border-top: 1px solid var(--border, #e6e9ef);
    }
    .dw-title {
      margin-bottom: 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted, #787b86);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dw-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      line-height: 20px;
    }
    .dw-row span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text, inherit);
    }
    .dw-row b {
      flex-shrink: 0;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      text-align: right;
    }
    .dw-empty {
      padding: 4px 12px 8px;
      color: var(--text-muted, #787b86);
    }
  `,
})
export class DataWindowComponent {
  readonly sections = input<readonly DataWindowSection[]>([]);
}
