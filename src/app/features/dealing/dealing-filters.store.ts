import { Injectable, computed, signal } from '@angular/core';

import { windowFor, type WindowPreset } from './dealing.logic';
import type { DealingWindow } from './dealing.types';

/**
 * The dealing desk's shared window and filters (provided by the feature's routes, so the desk's tabs and a client's page
 * read the same question). `moduleMissing` is set by any read the plan refuses (`-403-quota`, feature `brokerModule`):
 * the desk then shows the upgrade notice instead of empty tables.
 */
@Injectable()
export class DealingFiltersStore {
  readonly preset = signal<WindowPreset>('7d');
  readonly feedId = signal<string>('');
  readonly symbol = signal<string>('');
  readonly group = signal<string>('');
  readonly minFills = signal<number | null>(null);
  readonly aBookThreshold = signal<number | null>(null);
  readonly shortHoldSeconds = signal<number | null>(null);
  /** Bumped by "Refresh" so the same window is read again. */
  readonly revision = signal(0);
  readonly moduleMissing = signal(false);

  readonly window = computed<DealingWindow>(() => {
    this.revision();
    const w = windowFor(this.preset());
    const text = (v: string) => (v.trim() ? v.trim() : null);
    return {
      ...w,
      feedId: text(this.feedId()),
      symbol: text(this.symbol())?.toUpperCase() ?? null,
      group: text(this.group()),
      minFills: this.minFills(),
      aBookThreshold: this.aBookThreshold(),
      shortHoldSeconds: this.shortHoldSeconds(),
    };
  });

  /** A stable key of the question (the window's bounds move with "now"; the key follows the inputs + refreshes). */
  readonly key = computed(
    () =>
      `${this.preset()}|${this.feedId()}|${this.symbol()}|${this.group()}|${this.minFills()}|${this.aBookThreshold()}|${this.shortHoldSeconds()}|${this.revision()}`,
  );

  refresh(): void {
    this.revision.update((r) => r + 1);
  }
}
