import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { AccountStripComponent } from './account-strip.component';
import { ChartPanelsState } from './chart-panels-state.service';
import { DepthPanelComponent } from './depth-panel.component';
import { NotesPanelComponent } from './notes-panel.component';
import { SentimentPanelComponent } from './sentiment-panel.component';
import type { SidePanel } from './chart-panels.types';

const TITLES: Record<SidePanel, string> = {
  notes: 'Notes & ideas',
  depth: 'Broker depth',
  sentiment: 'Sentiment',
  account: 'Account',
};

/**
 * The chart's SP-I9 side panels in one place: the page renders this once, inside its side-pane slot, and the open
 * panel ({@link ChartPanelsState}) decides what shows — notes and ideas, broker depth, sentiment or the account strip.
 */
@Component({
  selector: 'app-chart-panels-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NotesPanelComponent, DepthPanelComponent, SentimentPanelComponent, AccountStripComponent],
  template: `
    <div class="cpd-title">
      <span>{{ title() }} · {{ symbol() }}</span>
      <button type="button" class="cpd-close" (click)="state.close()" [attr.aria-label]="'Close ' + title()">
        ×
      </button>
    </div>
    @switch (panel()) {
      @case ('notes') {
        <app-notes-panel
          [symbol]="symbol()"
          [timeframe]="timeframe()"
          [timeZone]="timeZone()"
          (symbolSelected)="symbolSelected.emit($event)"
        />
      }
      @case ('depth') {
        <app-depth-panel [symbol]="symbol()" [digits]="digits()" />
      }
      @case ('sentiment') {
        <app-sentiment-panel [symbol]="symbol()" [timeZone]="timeZone()" />
      }
      @case ('account') {
        <app-account-strip [symbol]="symbol()" [digits]="digits()" [timeZone]="timeZone()" />
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cpd-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 10px 6px;
        font-weight: 600;
        color: var(--text-muted, #787b86);
      }
      .cpd-close {
        font: inherit;
        font-size: 16px;
        line-height: 1;
        color: inherit;
        background: transparent;
        border: 0;
        cursor: pointer;
      }
    `,
  ],
})
export class ChartPanelsDockComponent {
  readonly state = inject(ChartPanelsState);

  readonly panel = input.required<SidePanel>();
  readonly symbol = input.required<string>();
  /** The chart resolution's label ("1h", "1D") — stored with a new note. */
  readonly timeframe = input<string>('');
  readonly digits = input<number>(5);
  /** The chart's time zone. */
  readonly timeZone = input<string | null>(null);
  /** A note about another symbol asked for that symbol's chart. */
  readonly symbolSelected = output<string>();

  readonly title = computed(() => TITLES[this.panel()]);
}
