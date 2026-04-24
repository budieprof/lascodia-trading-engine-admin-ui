import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SkeletonComponent } from '../ui/skeleton/skeleton.component';

@Component({
  selector: 'app-table-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SkeletonComponent],
  template: `
    <div class="wrap" role="status" aria-live="polite" [attr.aria-label]="ariaLabel()">
      <div class="head">
        @for (col of columnRange(); track col) {
          <ui-skeleton height="14px" width="60%" borderRadius="6px" />
        }
      </div>
      @for (row of rowRange(); track row) {
        <div class="row">
          @for (col of columnRange(); track col) {
            <ui-skeleton height="14px" [width]="cellWidth(col)" borderRadius="6px" />
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .wrap {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        background: var(--bg-primary);
      }
      .head,
      .row {
        display: grid;
        grid-template-columns: repeat(var(--cols, 5), 1fr);
        gap: var(--space-4);
        padding: var(--space-4) var(--space-5);
        align-items: center;
      }
      .head {
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border);
      }
      .row {
        border-bottom: 1px solid var(--border);
        height: 44px;
      }
      .row:last-child {
        border-bottom: none;
      }
    `,
  ],
  host: { '[style.--cols]': 'columns()' },
})
export class TableSkeletonComponent {
  readonly rows = input(8);
  readonly columns = input(5);
  readonly ariaLabel = input('Loading table');

  readonly rowRange = computed(() => Array.from({ length: this.rows() }, (_, i) => i));
  readonly columnRange = computed(() => Array.from({ length: this.columns() }, (_, i) => i));

  cellWidth(colIndex: number): string {
    const widths = ['72%', '58%', '84%', '50%', '66%', '40%', '78%'];
    return widths[colIndex % widths.length];
  }
}
