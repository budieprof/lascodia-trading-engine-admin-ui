import { Component, ChangeDetectionStrategy, input, computed } from '@angular/core';

@Component({
  selector: 'ui-skeleton',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="skeleton"
      [style.width]="computedWidth()"
      [style.height]="computedHeight()"
      [style.border-radius]="computedBorderRadius()"
    ></div>
  `,
  styles: [`
    .skeleton {
      background: linear-gradient(
        90deg,
        var(--bg-tertiary) 25%,
        rgba(255, 255, 255, 0.08) 50%,
        var(--bg-tertiary) 75%
      );
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite ease-in-out;
    }

    @keyframes shimmer {
      0% {
        background-position: -200% 0;
      }
      100% {
        background-position: 200% 0;
      }
    }
  `],
})
export class SkeletonComponent {
  readonly width = input('100%');
  readonly height = input('16px');
  readonly borderRadius = input('8px');
  readonly circle = input(false);

  readonly computedWidth = computed(() => this.circle() ? this.height() : this.width());
  readonly computedHeight = computed(() => this.height());
  readonly computedBorderRadius = computed(() => this.circle() ? '50%' : this.borderRadius());
}
