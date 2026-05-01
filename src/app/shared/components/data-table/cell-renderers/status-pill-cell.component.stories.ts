import { AfterViewInit, Component, Input, ViewChild } from '@angular/core';
import type { Meta, StoryObj } from '@storybook/angular';
import type { ICellRendererParams } from 'ag-grid-community';

import {
  StatusPillCellComponent,
  type StatusPillRendererParams,
} from './status-pill-cell.component';

/** ag-grid cell renderers don't take @Input — wrap so Storybook args land via agInit. */
@Component({
  selector: 'app-status-pill-story-host',
  standalone: true,
  imports: [StatusPillCellComponent],
  template: `<app-status-pill-cell #cell />`,
})
class StatusPillStoryHostComponent implements AfterViewInit {
  @ViewChild('cell') cell!: StatusPillCellComponent;
  @Input() value = 'Active';
  @Input() label = 'Status';

  ngAfterViewInit(): void {
    this.cell.agInit({ value: this.value, label: this.label } as ICellRendererParams &
      StatusPillRendererParams);
  }
}

const meta: Meta<StatusPillStoryHostComponent> = {
  title: 'Shared / Data Table / Status pill',
  component: StatusPillStoryHostComponent,
  argTypes: {
    value: { control: { type: 'text' } },
    label: { control: { type: 'text' } },
  },
};
export default meta;

type Story = StoryObj<StatusPillStoryHostComponent>;

export const Active: Story = { args: { value: 'Active' } };
export const Paused: Story = { args: { value: 'Paused' } };
export const Failed: Story = { args: { value: 'Failed' } };
export const Completed: Story = { args: { value: 'Completed' } };
export const Promoted: Story = { args: { value: 'Promoted' } };
export const UnknownValue: Story = {
  args: { value: 'NotInTheDefaultPalette' },
};
