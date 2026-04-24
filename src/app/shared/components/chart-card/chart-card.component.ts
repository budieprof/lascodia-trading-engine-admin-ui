import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

import { ThemeService } from '@core/theme/theme.service';

@Component({
  selector: 'app-chart-card',
  standalone: true,
  imports: [NgxEchartsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="chart-card"
      [attr.aria-labelledby]="title() ? titleId : null"
      [attr.aria-describedby]="subtitle() ? subtitleId : null"
    >
      @if (title()) {
        <header class="chart-header">
          <h3 class="chart-title" [id]="titleId">{{ title() }}</h3>
          @if (subtitle()) {
            <p class="chart-subtitle" [id]="subtitleId">{{ subtitle() }}</p>
          }
        </header>
      }
      <div class="chart-body" [style.height]="height()">
        @if (loading()) {
          <div class="chart-skeleton" role="status" aria-label="Loading chart">
            <div class="shimmer"></div>
          </div>
        } @else {
          <div
            echarts
            [options]="options()"
            [theme]="echartsTheme()"
            [autoResize]="true"
            class="chart-instance"
            role="img"
            [attr.aria-label]="accessibleLabel()"
          ></div>
        }
      </div>
    </section>
  `,
  styles: [
    `
      .chart-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        transition:
          box-shadow var(--dur-base) var(--ease-out-soft),
          transform var(--dur-base) var(--ease-out-soft);
      }

      .chart-card:hover {
        box-shadow: var(--shadow-md);
        transform: translateY(-1px);
      }

      .chart-header {
        margin-bottom: var(--space-4);
      }

      .chart-title {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }

      .chart-subtitle {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin: var(--space-1) 0 0;
      }

      .chart-body {
        position: relative;
      }

      .chart-instance {
        width: 100%;
        height: 100%;
      }

      .chart-skeleton {
        width: 100%;
        height: 100%;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        overflow: hidden;
        position: relative;
      }

      .shimmer {
        position: absolute;
        inset: 0;
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(255, 255, 255, 0.2) 50%,
          transparent 100%
        );
        animation: shimmer 1.5s infinite;
      }

      @keyframes shimmer {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(100%);
        }
      }
    `,
  ],
})
export class ChartCardComponent {
  private static nextId = 0;
  private readonly themeService = inject(ThemeService);

  readonly titleId = `chart-card-title-${ChartCardComponent.nextId++}`;
  readonly subtitleId = `chart-card-subtitle-${ChartCardComponent.nextId++}`;

  title = input<string>();
  subtitle = input<string>();
  /** Screen-reader caption for the chart itself when title/subtitle aren't enough. */
  alt = input<string>();
  options = input<EChartsOption>({});
  height = input('300px');
  loading = input(false);

  /** Registered echarts theme name, driven by the global ThemeService. */
  readonly echartsTheme = computed(() =>
    this.themeService.theme() === 'dark' ? 'lascodia-dark' : 'lascodia-light',
  );

  readonly accessibleLabel = computed(() => {
    const explicit = this.alt();
    if (explicit) return explicit;
    const parts = [this.title(), this.subtitle()].filter((p): p is string => !!p);
    return parts.length > 0 ? parts.join(' — ') : 'Chart';
  });
}
