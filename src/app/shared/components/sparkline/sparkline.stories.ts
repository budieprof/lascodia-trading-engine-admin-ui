import type { Meta, StoryObj } from '@storybook/angular';
import { provideEchartsCore } from 'ngx-echarts';
import * as echarts from 'echarts';
import { applicationConfig } from '@storybook/angular';
import { SparklineComponent } from './sparkline.component';

const meta: Meta<SparklineComponent> = {
  title: 'Shared / Sparkline',
  component: SparklineComponent,
  tags: ['autodocs'],
  decorators: [
    applicationConfig({
      providers: [provideEchartsCore({ echarts })],
    }),
  ],
};

export default meta;
type Story = StoryObj<SparklineComponent>;

export const Ascending: Story = {
  args: {
    data: [10, 12, 15, 14, 18, 22, 25, 30, 28, 35],
    color: '#34C759',
    width: '120px',
    height: '32px',
  },
};

export const Descending: Story = {
  args: {
    data: [40, 38, 35, 32, 30, 28, 24, 20, 18, 15],
    color: '#FF3B30',
    width: '120px',
    height: '32px',
  },
};

export const Choppy: Story = {
  args: {
    data: [20, 25, 18, 22, 28, 16, 30, 14, 24, 19],
    color: '#0071E3',
    width: '120px',
    height: '32px',
  },
};

export const Flat: Story = {
  args: {
    data: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
    color: '#8E8E93',
    width: '120px',
    height: '32px',
  },
};

export const InlineSmall: Story = {
  args: {
    data: [3, 5, 4, 7, 6, 9, 8, 11, 10, 13],
    color: '#0071E3',
    width: '80px',
    height: '24px',
  },
};
