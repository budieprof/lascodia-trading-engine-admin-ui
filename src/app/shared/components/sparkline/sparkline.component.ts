import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

@Component({
  selector: 'app-sparkline',
  standalone: true,
  imports: [NgxEchartsDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      echarts
      [options]="chartOptions()"
      [autoResize]="true"
      [style.width]="width()"
      [style.height]="height()"
    ></div>
  `,
})
export class SparklineComponent {
  data = input<number[]>([]);
  color = input('#0071E3');
  width = input('80px');
  height = input('24px');

  chartOptions = computed<EChartsOption>(() => ({
    grid: { top: 0, right: 0, bottom: 0, left: 0 },
    xAxis: { type: 'category', show: false, data: this.data().map((_, i) => i) },
    yAxis: { type: 'value', show: false },
    series: [
      {
        type: 'line',
        data: this.data(),
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 1.5, color: this.color() },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: this.color() + '30' },
              { offset: 1, color: this.color() + '00' },
            ],
          },
        },
      },
    ],
    animation: false,
  }));
}
