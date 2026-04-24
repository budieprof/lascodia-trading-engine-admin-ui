import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SkeletonComponent } from '../ui/skeleton/skeleton.component';

@Component({
  selector: 'app-card-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SkeletonComponent],
  template: `
    <div class="card" role="status" aria-live="polite" [attr.aria-label]="ariaLabel()">
      @if (showHeader()) {
        <div class="header">
          <ui-skeleton height="16px" width="40%" borderRadius="6px" />
          <ui-skeleton height="12px" width="20%" borderRadius="6px" />
        </div>
      }
      <div class="body">
        @for (line of lineRange(); track line) {
          <ui-skeleton height="12px" [width]="lineWidth(line)" borderRadius="6px" />
        }
      </div>
    </div>
  `,
  styles: [
    `
      .card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--space-4);
      }
      .body {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
    `,
  ],
})
export class CardSkeletonComponent {
  readonly lines = input(4);
  readonly showHeader = input(true);
  readonly ariaLabel = input('Loading');

  readonly lineRange = computed(() => Array.from({ length: this.lines() }, (_, i) => i));

  lineWidth(i: number): string {
    const widths = ['100%', '88%', '72%', '94%', '60%', '80%'];
    return widths[i % widths.length];
  }
}
