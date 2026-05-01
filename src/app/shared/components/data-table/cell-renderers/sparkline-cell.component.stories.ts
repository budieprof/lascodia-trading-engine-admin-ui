import { AfterViewInit, Component, Input, ViewChild } from '@angular/core';
import type { Meta, StoryObj } from '@storybook/angular';
import type { ICellRendererParams } from 'ag-grid-community';

import {
  SparklineCellComponent,
  type SparklineCellRendererParams,
} from './sparkline-cell.component';

/**
 * Storybook can't bind args directly to a component that uses ag-grid's
 * `agInit(params)` lifecycle (the public API isn't `@Input`-based). This
 * wrapper exposes args as Inputs and forwards them on view init so each
 * story renders one isolated sparkline.
 */
@Component({
  selector: 'app-sparkline-story-host',
  standalone: true,
  imports: [SparklineCellComponent],
  template: `
    <div [style.width]="width" [style.height.px]="32">
      <app-sparkline-cell #cell />
    </div>
  `,
})
class SparklineStoryHostComponent implements AfterViewInit {
  @ViewChild('cell') cell!: SparklineCellComponent;

  @Input() points: number[] = [];
  @Input() color = '#34C759';
  @Input() showLatestDot = true;
  @Input() label = 'Trend';
  @Input() domain: [number, number] | null = null;
  @Input() width = '160px';

  ngAfterViewInit(): void {
    const params = {
      value: this.points,
      color: this.color,
      showLatestDot: this.showLatestDot,
      label: this.label,
      domain: this.domain ?? undefined,
    } as ICellRendererParams & SparklineCellRendererParams;
    this.cell.agInit(params);
  }
}

const meta: Meta<SparklineStoryHostComponent> = {
  title: 'Shared / Data Table / Sparkline cell',
  component: SparklineStoryHostComponent,
  argTypes: {
    color: { control: { type: 'color' } },
    width: { control: { type: 'text' } },
    showLatestDot: { control: { type: 'boolean' } },
  },
};
export default meta;

type Story = StoryObj<SparklineStoryHostComponent>;

export const Rising: Story = {
  args: {
    points: [0.42, 0.45, 0.48, 0.52, 0.55, 0.61, 0.67, 0.72, 0.78, 0.81, 0.84, 0.88],
    color: '#34C759',
    label: 'Health score',
  },
};

export const Falling: Story = {
  args: {
    points: [0.92, 0.88, 0.81, 0.74, 0.66, 0.55, 0.48, 0.41, 0.33, 0.27, 0.22, 0.18],
    color: '#FF3B30',
    label: 'Health score',
  },
};

/**
 * Health-score domain pinned to 0..1 — matches what the strategies list does
 * so all rows share the same Y axis even when individual ranges are tiny.
 */
export const FixedDomain: Story = {
  args: {
    points: [0.5, 0.51, 0.49, 0.5, 0.52, 0.51, 0.5, 0.49, 0.5, 0.51, 0.5, 0.51],
    color: '#0071E3',
    label: 'Health score',
    domain: [0, 1],
  },
};

/** Single point shouldn't render — not enough to draw a line. */
export const SinglePoint: Story = {
  args: { points: [0.5], color: '#34C759' },
};

/** Empty series should render the muted dash placeholder. */
export const Empty: Story = {
  args: { points: [], color: '#34C759' },
};
