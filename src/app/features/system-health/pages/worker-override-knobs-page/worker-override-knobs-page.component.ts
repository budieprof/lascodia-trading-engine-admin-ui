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
import { catchError, map, of } from 'rxjs';

import { HealthService } from '@core/services/health.service';
import type { WorkerOverrideKnobsDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

@Component({
  selector: 'app-worker-override-knobs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="System — Worker Override Knobs"
        subtitle="The override-key allow-list per BackgroundService. Replaces the 'grep CLAUDE.md to find the right config key' workflow."
      >
        <a routerLink="/system-health" class="btn btn-secondary">← System Health</a>
        <a routerLink="/engine-config" class="btn btn-secondary">Engine Config →</a>
      </app-page-header>

      <section class="controls">
        <label class="field">
          <span>Filter</span>
          <input
            type="search"
            placeholder="Worker name or knob key…"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
        </label>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load worker knobs"
          message="Engine returned an error. The system-health controller may be offline."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Workers"
            [value]="workers().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Total knobs"
            [value]="totalKnobs()"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Matching"
            [value]="filteredCount()"
            format="number"
            dotColor="#34C759"
          />
        </section>

        @if (filtered().length === 0) {
          <app-empty-state
            title="No workers match"
            description="No worker name or knob key matches the current filter."
          />
        } @else {
          <section class="card">
            <ul class="worker-list">
              @for (w of filtered(); track w.workerName) {
                <li class="worker">
                  <header class="worker-head">
                    <h3 class="worker-name mono">{{ w.workerName }}</h3>
                    <span class="muted small"
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
          </section>
        }
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .controls {
        display: flex;
        gap: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        max-width: 480px;
      }
      .field span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .field input {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .worker-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .worker {
        padding: var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .worker-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        margin-bottom: var(--space-2);
      }
      .worker-name {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .knob-chips {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .knob-chip {
        display: inline-block;
        padding: 4px 10px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-medium);
      }
      .knob-chip:hover {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
    `,
  ],
})
export class WorkerOverrideKnobsPageComponent {
  private readonly health = inject(HealthService);

  protected readonly search = signal<string>('');

  // Worker knob list is essentially immutable for the engine's process lifetime
  // (reflection-driven discovery happens once at startup). 10-minute poll is
  // generous; in practice the page just runs the initial fetch.
  protected readonly resource = createPolledResource(
    () =>
      this.health.getWorkerOverrideKnobs().pipe(
        map((res) => res.data ?? []),
        catchError(() => of<WorkerOverrideKnobsDto[]>([])),
      ),
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
