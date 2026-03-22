import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

@Component({
  selector: 'app-gauge',
  standalone: true,
  imports: [NgxEchartsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      echarts
      [options]="chartOptions()"
      [autoResize]="true"
      [style.width]="size()"
      [style.height]="size()"
    ></div>
  `,
})
export class GaugeComponent {
  value = input(0);
  min = input(0);
  max = input(100);
  label = input('');
  size = input('160px');
  thresholds = input<{ value: number; color: string }[]>([
    { value: 33, color: '#34C759' },
    { value: 66, color: '#FF9500' },
    { value: 100, color: '#FF3B30' },
  ]);

  chartOptions = computed<EChartsOption>(() => ({
    series: [{
      type: 'gauge',
      min: this.min(),
      max: this.max(),
      progress: { show: true, width: 10 },
      axisLine: {
        lineStyle: {
          width: 10,
          color: this.thresholds().map(t => [t.value / this.max(), t.color] as [number, string]),
        },
      },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      anchor: { show: false },
      title: {
        show: !!this.label(),
        offsetCenter: [0, '70%'],
        fontSize: 11,
        color: '#6E6E73',
      },
      detail: {
        valueAnimation: true,
        fontSize: 20,
        fontWeight: 600,
        offsetCenter: [0, '0%'],
        formatter: `{value}%`,
        color: '#1D1D1F',
      },
      data: [{ value: this.value(), name: this.label() }],
    }],
    animation: true,
  }));
}
