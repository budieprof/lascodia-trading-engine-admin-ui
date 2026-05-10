import type { Meta, StoryObj } from '@storybook/angular';
import { MetricCardComponent } from './metric-card.component';

const meta: Meta<MetricCardComponent> = {
  title: 'Shared / Metric card',
  component: MetricCardComponent,
  tags: ['autodocs'],
  argTypes: {
    format: {
      control: 'select',
      options: ['currency', 'percent', 'number'],
    },
  },
};

export default meta;
type Story = StoryObj<MetricCardComponent>;

export const Currency: Story = {
  args: {
    label: 'Daily P&L',
    value: 12450.32,
    format: 'currency',
    delta: 480.5,
    colorByValue: true,
  },
};

export const CurrencyLoss: Story = {
  args: {
    label: 'Daily P&L',
    value: -1234.56,
    format: 'currency',
    delta: -210.4,
    colorByValue: true,
  },
};

export const Percent: Story = {
  args: {
    label: 'Win rate',
    value: 62.4,
    format: 'percent',
    delta: 1.2,
  },
};

export const Number: Story = {
  args: {
    label: 'Open positions',
    value: 8,
    format: 'number',
  },
};

export const NullValue: Story = {
  args: {
    label: 'Sharpe (live)',
    value: null,
    format: 'number',
  },
};

export const WithDot: Story = {
  args: {
    label: 'Engine status',
    value: 190,
    format: 'number',
    dotColor: '#34C759',
  },
};
