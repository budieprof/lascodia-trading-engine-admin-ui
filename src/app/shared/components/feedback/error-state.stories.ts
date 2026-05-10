import type { Meta, StoryObj } from '@storybook/angular';
import { ErrorStateComponent } from './error-state.component';

const meta: Meta<ErrorStateComponent> = {
  title: 'Shared / Feedback / Error state',
  component: ErrorStateComponent,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<ErrorStateComponent>;

export const Default: Story = {
  args: {},
};

export const WithMessage: Story = {
  args: {
    title: 'Could not load strategies',
    message:
      'Engine returned 503. The strategy generation worker may be paused — check System Health.',
  },
};

export const NetworkError: Story = {
  args: {
    title: 'Network error',
    message:
      'Unable to reach the engine at https://engine.lascodia.local. Verify your connection and retry.',
  },
};

export const NoRetry: Story = {
  args: {
    title: 'Insufficient role',
    message: 'This action requires the Admin role. Contact an administrator to request access.',
    showRetry: false,
  },
};

export const CustomRetryLabel: Story = {
  args: {
    title: 'Stale data',
    message: 'The displayed data is more than 5 minutes old.',
    retryLabel: 'Refresh now',
  },
};
