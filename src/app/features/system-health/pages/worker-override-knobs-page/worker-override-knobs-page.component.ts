import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { HealthService } from '@core/services/health.service';
import type { WorkerOverrideKnobsDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';

@Component({
  selector: 'app-worker-override-knobs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Worker Override Knobs"
        subtitle="Which Engine Config keys each background worker reads at runtime. Click a key to open it in Engine Config."
      >
        <a routerLink="/system-health" class="btn btn-secondary">← System Health</a>
        <a routerLink="/engine-config" class="btn btn-secondary">Engine Config →</a>
      </app-page-header>

      <p class="callout">
        <strong>Read-only reference.</strong> Nothing changes from this page. A key opens in Engine
        Config, where a saved value takes effect on the live engine — review it there before saving.
      </p>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load worker knobs"
          message="Engine returned an error. The system-health controller may be offline."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="card">
          <div class="toolbar">
            <label class="search">
              <span class="sr-only">Filter</span>
              <span class="search-icon" aria-hidden="true">⌕</span>
              <input
                type="search"
                placeholder="Filter by worker name or knob key…"
                aria-label="Filter by worker name or knob key"
                [ngModel]="search()"
                (ngModelChange)="search.set($event)"
              />
            </label>
            <div class="stats" aria-live="polite">
              <span class="stat"
                ><span class="stat-n">{{ workers().length }}</span> workers</span
              >
              <span class="stat"
                ><span class="stat-n">{{ totalKnobs() }}</span> knobs</span
              >
              @if (search().trim()) {
                <span class="stat match"
                  ><span class="stat-n">{{ filteredCount() }}</span> matching in
                  {{ filtered().length }} worker{{ filtered().length === 1 ? '' : 's' }}</span
                >
              }
            </div>
          </div>

          @if (filtered().length === 0) {
            <div class="empty">
              <strong>No workers match “{{ search().trim() }}”.</strong>
              No worker name or knob key matches the current filter.
              <button type="button" class="btn btn-secondary btn-sm" (click)="search.set('')">
                Clear filter
              </button>
            </div>
          } @else {
            <ul class="worker-list">
              @for (w of filtered(); track w.workerName) {
                <li class="worker">
                  <header class="worker-head">
                    <h3 class="worker-name mono">{{ w.workerName }}</h3>
                    <span class="count"
                      >{{ w.overrideKnobs.length }} knob{{
                        w.overrideKnobs.length === 1 ? '' : 's'
                      }}</span
                    >
                  </header>
                  @if (w.overrideKnobs.length === 0) {
                    <p class="muted small">No override-keys exposed.</p>
                  } @else {
                    <ul class="knob-chips">
                      @for (knob of w.overrideKnobs; track knob) {
                        <li>
                          <a
                            [routerLink]="['/engine-config']"
                            [queryParams]="{ search: knob }"
                            class="knob-chip mono"
                            [title]="'Open in Engine Config'"
                          >
                            {{ knob }}
                          </a>
                        </li>
                      }
                    </ul>
                  }
                </li>
              }
            </ul>
          }
        </section>
      }
    </div>
  `,
  styleUrl: './worker-override-knobs-page.component.scss',
})
export class WorkerOverrideKnobsPageComponent {
  private readonly health = inject(HealthService);

  protected readonly search = signal<string>('');

  // Worker knob list is essentially immutable for the engine's process lifetime
  // (reflection-driven discovery happens once at startup). 10-minute poll is
  // generous; in practice the page just runs the initial fetch.
  // No catchError here: the polled resource records failures in `.error()`
  // and keeps polling. Swallowing them produced an empty list that rendered
  // as "No workers match" instead of the error state with a retry.
  protected readonly resource = createPolledResource(
    () => this.health.getWorkerOverrideKnobs().pipe(map((res) => res.data ?? [])),
    { intervalMs: 600_000 },
  );

  constructor() {
    effect(() => {
      this.search();
    });
  }

  protected readonly workers = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.workers().length === 0,
  );
  protected readonly totalKnobs = computed(() =>
    this.workers().reduce((s, w) => s + w.overrideKnobs.length, 0),
  );

  protected readonly filtered = computed(() => {
    const needle = this.search().trim().toLowerCase();
    if (!needle) return this.workers();
    return this.workers()
      .map((w) => {
        const matchesName = w.workerName.toLowerCase().includes(needle);
        const matchingKnobs = w.overrideKnobs.filter((k) => k.toLowerCase().includes(needle));
        if (matchesName) return w; // show all knobs when the worker itself matches
        if (matchingKnobs.length > 0) return { ...w, overrideKnobs: matchingKnobs };
        return null;
      })
      .filter((w): w is WorkerOverrideKnobsDto => w !== null);
  });

  protected readonly filteredCount = computed(() =>
    this.filtered().reduce((s, w) => s + w.overrideKnobs.length, 0),
  );
}
