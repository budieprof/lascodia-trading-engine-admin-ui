import type { Meta, StoryObj } from '@storybook/angular';

import { StatusBadgeComponent } from './status-badge.component';

/**
 * `<app-status-badge>` is the single source of truth for status chips across
 * the app — orders, positions, strategies, signals, health, run-status. The
 * variant / glyph / aria mapping is centralised in the component so these
 * stories are the canonical visual catalogue. Break a mapping, and the
 * story test snapshot breaks.
 */
const meta: Meta<StatusBadgeComponent> = {
  title: 'Primitives / StatusBadge',
  component: StatusBadgeComponent,
  tags: ['autodocs'],
  args: {
    status: 'Filled',
    type: 'order',
  },
  argTypes: {
    type: {
      control: 'select',
      options: ['order', 'position', 'strategy', 'signal', 'broker', 'health', 'run', 'default'],
    },
    status: { control: 'text' },
  },
};
export default meta;

type Story = StoryObj<StatusBadgeComponent>;

export const OrderFilled: Story = { args: { status: 'Filled', type: 'order' } };
export const OrderPending: Story = { args: { status: 'Pending', type: 'order' } };
export const OrderRejected: Story = { args: { status: 'Rejected', type: 'order' } };

export const PositionOpen: Story = { args: { status: 'Open', type: 'position' } };
export const PositionClosed: Story = { args: { status: 'Closed', type: 'position' } };

export const StrategyActive: Story = { args: { status: 'Active', type: 'strategy' } };
export const StrategyPaused: Story = { args: { status: 'Paused', type: 'strategy' } };

export const HealthyWorker: Story = { args: { status: 'true', type: 'health' } };
export const FailingWorker: Story = { args: { status: 'false', type: 'health' } };

/**
 * Unknown status / type combos fall through to the neutral variant — this
 * story guards the default branch so a future map-key typo doesn't silently
 * render a blank pill.
 */
export const UnknownFallback: Story = { args: { status: 'Garbage', type: 'order' } };
