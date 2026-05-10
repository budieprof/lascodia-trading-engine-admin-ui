import type { Meta, StoryObj } from '@storybook/angular';
import { FileX, Inbox, Search } from 'lucide-angular';
import { EmptyStateComponent } from './empty-state.component';

const meta: Meta<EmptyStateComponent> = {
  title: 'Shared / Feedback / Empty state',
  component: EmptyStateComponent,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<EmptyStateComponent>;

export const Default: Story = {
  args: {
    title: 'No open positions',
    description: 'When the engine opens a position it will appear here.',
  },
};

export const WithAction: Story = {
  args: {
    title: 'No strategies created yet',
    description:
      'Start by generating a strategy via the strategy-hunt loop, or create one manually.',
    actionLabel: 'Create strategy',
    icon: FileX,
  },
};

export const TitleOnly: Story = {
  args: {
    title: 'No matching results',
    icon: Search,
  },
};

export const InboxIcon: Story = {
  args: {
    title: 'No pending signals',
    description: 'Approved signals will appear here for review.',
    icon: Inbox,
  },
};
