import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { DataWindowSection } from '../render/legend';

/** TradingView's Data Window: the bar under the crosshair and every output value shown there. */
@Component({
  selector: 'app-pine-data-window',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header>
      <span>Data window</span>
      <button type="button" class="close" (click)="closed.emit()" aria-label="Close data window">
        ×
      </button>
    </header>
    <div class="body">
      @for (s of sections(); track s.title) {
        <section>
          <h4>{{ s.title }}</h4>
          @for (r of s.rows; track $index) {
            <div class="row">
              <span class="label" [title]="r.label">{{ r.label }}</span>
              <span class="value" [style.color]="r.color">{{ r.value }}</span>
            </div>
          }
        </section>
      } @empty {
        <p class="empty">Nothing to show.</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        width: 232px;
        max-height: 100%;
        background: var(--bg-glass, rgba(255, 255, 255, 0.92));
        backdrop-filter: var(--blur-md, blur(14px));
        -webkit-backdrop-filter: var(--blur-md, blur(14px));
        border: 1px solid var(--border, rgba(0, 0, 0, 0.08));
        border-radius: var(--radius-sm, 8px);
        box-shadow: var(--shadow-md, 0 4px 12px rgba(0, 0, 0, 0.08));
        color: var(--text-primary, #1d1d1f);
        font-size: 12px;
        overflow: hidden;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 6px 10px;
        font-weight: 600;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
      }
      .close {
        border: 0;
        background: transparent;
        color: var(--text-secondary, #6e6e73);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
      }
      .body {
        overflow: auto;
        padding: 4px 10px 8px;
      }
      h4 {
        margin: 8px 0 4px;
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary, #6e6e73);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 1px 0;
      }
      .label {
        color: var(--text-secondary, #6e6e73);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .value {
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .empty {
        color: var(--text-tertiary, #86868b);
      }
    `,
  ],
})
export class PineDataWindowComponent {
  readonly sections = input<readonly DataWindowSection[]>([]);
  readonly closed = output<void>();
}
