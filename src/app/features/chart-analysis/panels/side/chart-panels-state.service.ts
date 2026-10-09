import { Injectable, signal } from '@angular/core';

import type { SidePanel } from './chart-panels.types';

const KEY = 'lascodia.chart.sidePanel';
const PANELS: readonly SidePanel[] = ['notes', 'depth', 'sentiment', 'account'];

/**
 * Which of the SP-I9 side panels is open on the chart (notes, broker depth, sentiment, account), remembered per
 * viewer. One at a time, and never together with the page's own side panes (details, news, calendar): the page closes
 * this when it opens one of those, and the rail buttons close those when they open this.
 */
@Injectable({ providedIn: 'root' })
export class ChartPanelsState {
  readonly open = signal<SidePanel | null>(this.restore());

  toggle(panel: SidePanel): void {
    this.set(this.open() === panel ? null : panel);
  }

  close(): void {
    this.set(null);
  }

  private set(panel: SidePanel | null): void {
    this.open.set(panel);
    try {
      if (panel) localStorage.setItem(KEY, panel);
      else localStorage.removeItem(KEY);
    } catch {
      // Per-viewer convenience only.
    }
  }

  private restore(): SidePanel | null {
    try {
      const v = localStorage.getItem(KEY) as SidePanel | null;
      return v && PANELS.includes(v) ? v : null;
    } catch {
      return null;
    }
  }
}
