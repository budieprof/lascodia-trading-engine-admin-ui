import type { Meta, StoryObj } from '@storybook/angular';
import { CardSkeletonComponent } from './card-skeleton.component';

const meta: Meta<CardSkeletonComponent> = {
  title: 'Shared / Feedback / Card skeleton',
  component: CardSkeletonComponent,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<CardSkeletonComponent>;

export const Default: Story = {
  args: {
    lines: 4,
    showHeader: true,
  },
};

export const NoHeader: Story = {
  args: {
    lines: 4,
    showHeader: false,
  },
};

export const SingleLine: Story = {
  args: {
    lines: 1,
    showHeader: false,
  },
};

export const ManyLines: Story = {
  args: {
    lines: 8,
    showHeader: true,
  },
};

export const CustomAriaLabel: Story = {
  args: {
    lines: 4,
    showHeader: true,
    ariaLabel: 'Loading strategy metrics',
  },
};
