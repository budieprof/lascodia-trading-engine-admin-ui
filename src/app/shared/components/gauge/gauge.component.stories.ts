import type { Meta, StoryObj } from '@storybook/angular';
import { GaugeComponent } from './gauge.component';

/**
 * The Gauge is used as the live health indicator at the top of the strategy
 * detail page (see StrategyDetailPageComponent's `health-strip`) and on the
 * drawdown live tab. Its `value` is a 0–`max` number; the `thresholds` array
 * paints the arc segments.
 *
 * Default palette assumes "low is good" (green at the start). For metrics
 * where higher is better (e.g. health score) pass an inverted threshold list,
 * as the strategy detail page does.
 */
const meta: Meta<GaugeComponent> = {
  title: 'Shared / Feedback / Gauge',
  component: GaugeComponent,
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 100, step: 1 } },
    min: { control: { type: 'number' } },
    max: { control: { type: 'number' } },
    label: { control: { type: 'text' } },
    size: { control: { type: 'text' } },
  },
};
export default meta;

type Story = StoryObj<GaugeComponent>;

export const Healthy: Story = {
  args: { value: 82, min: 0, max: 100, label: 'Health' },
};

export const Warning: Story = {
  args: { value: 48, min: 0, max: 100, label: 'Drawdown %' },
};

export const Critical: Story = {
  args: { value: 91, min: 0, max: 100, label: 'Drawdown %' },
};

/**
 * Inverted palette for "higher is better" metrics — matches what the strategy
 * detail page uses for its composite health score.
 */
export const HealthInverted: Story = {
  args: {
    value: 80,
    min: 0,
    max: 100,
    label: 'Health',
    thresholds: [
      { value: 30, color: '#FF3B30' },
      { value: 60, color: '#FF9500' },
      { value: 100, color: '#34C759' },
    ],
  },
};
