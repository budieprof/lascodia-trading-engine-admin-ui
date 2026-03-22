import { Component, input, ChangeDetectionStrategy, ElementRef, inject, AfterViewInit, OnDestroy, viewChild } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

@Component({
  selector: 'app-chart-card',
  standalone: true,
  imports: [NgxEchartsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chart-card">
      @if (title()) {
        <div class="chart-header">
          <h3 class="chart-title">{{ title() }}</h3>
          @if (subtitle()) {
            <p class="chart-subtitle">{{ subtitle() }}</p>
          }
        </div>
      }
      <div class="chart-body" [style.height]="height()">
        @if (loading()) {
          <div class="chart-skeleton">
            <div class="shimmer"></div>
          </div>
        } @else {
          <div
            echarts
            [options]="options()"
            [theme]="'lascodia'"
            [autoResize]="true"
            class="chart-instance"
          ></div>
        }
      </div>
    </div>
  `,
  styles: [`
    .chart-card {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--card-padding);
      box-shadow: var(--shadow-sm);
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
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
  `],
})
export class ChartCardComponent {
  title = input<string>();
  subtitle = input<string>();
  options = input<EChartsOption>({});
  height = input('300px');
  loading = input(false);
}
