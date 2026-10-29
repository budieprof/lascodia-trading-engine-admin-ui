import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { catchError, forkJoin, of } from 'rxjs';

import { DealingApiService } from '../dealing-api.service';
import { DealingFiltersStore } from '../dealing-filters.store';
import { deskSummary, isModuleNotInPlan } from '../dealing.logic';
import type { DealingAlert, DealingClients, DealingCurves, DealingFeed } from '../dealing.types';

/**
 * The desk at a glance for the current window and filters: clients, fills, volume, the all-fills 60 s markout,
 * alerts and trade feeds — from the same read endpoints the tabs use (nothing is computed in the console but sums).
 */
@Component({
  selector: 'app-dealing-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
        gap: var(--space-3);
      }
      .tile {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        min-width: 0;
      }
      .label,
      .sub {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        margin: 2px 0;
      }
      .pos {
        color: var(--profit, #1f9d55);
      }
      .neg {
        color: var(--loss);
      }
    `,
  ],
  template: `
    <section class="tiles" aria-label="Dealing desk summary" [attr.aria-busy]="loading()">
      @for (t of tiles(); track t.label) {
        <div class="tile" [title]="t.title ?? ''">
          <div class="label">{{ t.label }}</div>
          <div class="value" [class.pos]="t.tone === 'pos'" [class.neg]="t.tone === 'neg'">
            {{ t.value }}
          </div>
          <div class="sub">{{ t.hint }}</div>
        </div>
      }
    </section>
  `,
})
export class DealingSummaryComponent {
  private readonly api = inject(DealingApiService);
  private readonly store = inject(DealingFiltersStore);

  readonly loading = signal(false);
  private readonly parts = signal<{
    clients: DealingClients | null;
    curves: DealingCurves | null;
    alerts: DealingAlert[] | null;
    feeds: DealingFeed[] | null;
  }>({ clients: null, curves: null, alerts: null, feeds: null });
  readonly tiles = computed(() => deskSummary(this.parts(), this.store.preset()));
  private generation = 0;

  constructor() {
    effect(() => {
      this.store.key();
      untracked(() => this.load());
    });
  }

  load(): void {
    const mine = ++this.generation;
    const w = this.store.window();
    const soft = <T>(o: import('rxjs').Observable<T>) =>
      o.pipe(
        catchError((e) => {
          if (isModuleNotInPlan(e)) this.store.moduleMissing.set(true);
          return of(null);
        }),
      );
    this.loading.set(true);
    forkJoin({
      clients: soft(this.api.clients(w, { limit: 1 })),
      curves: soft(this.api.curves(w, 'symbol', 1)),
      alerts: soft(this.api.alerts(w)),
      feeds: soft(this.api.feeds()),
    }).subscribe((p) => {
      if (mine !== this.generation) return;
      this.parts.set(p);
      this.loading.set(false);
    });
  }
}
