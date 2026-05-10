import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, switchMap } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import type { PolicySnapshotDiffDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

/** Cap |deltaFraction| display at ±50% so a single outlier doesn't squash everything else. */
const DELTA_BAR_CAP = 0.5;

type DiffResult =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'loaded'; data: PolicySnapshotDiffDto };

@Component({
  selector: 'app-diff-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CompositeML — Policy Diff"
        subtitle="Per-knob change between two snapshots"
      >
        <a routerLink="/composite-ml" class="btn btn-secondary">← Active Policies</a>
      </app-page-header>

      <section class="picker">
        <div class="picker-field">
          <label for="fromId">From snapshot</label>
          <input
            id="fromId"
            type="number"
            min="1"
            [ngModel]="fromInput()"
            (ngModelChange)="fromInput.set($event)"
            placeholder="e.g. 1240"
          />
        </div>
        <span class="picker-arrow">→</span>
        <div class="picker-field">
          <label for="toId">To snapshot</label>
          <input
            id="toId"
            type="number"
            min="1"
            [ngModel]="toInput()"
            (ngModelChange)="toInput.set($event)"
            placeholder="e.g. 1241"
          />
        </div>
        <button type="button" class="btn btn-primary" (click)="apply()" [disabled]="!canApply()">
          Compare
        </button>
      </section>

      @switch (result()?.state) {
        @case ('idle') {
          <app-empty-state
            title="Pick two snapshots to compare"
            description="Enter the source and target snapshot ids above, or navigate here from the lineage timeline of any active policy."
          />
        }
        @case ('loading') {
          <app-card-skeleton [lines]="8" />
        }
        @case ('error') {
          <app-error-state
            title="Could not load diff"
            [message]="errorMessage()"
            (retry)="apply()"
          />
        }
        @case ('loaded') {
          @if (loaded()) {
            <section class="summary">
              <span class="summary-pair">
                <a
                  class="snapshot-link"
                  [routerLink]="['/composite-ml/snapshot', loaded()!.fromId]"
                >
                  #{{ loaded()!.fromId }}
                </a>
                <span class="schema-badge">schema v{{ loaded()!.fromSchemaVersion }}</span>
              </span>
              <span class="summary-arrow">→</span>
              <span class="summary-pair">
                <a class="snapshot-link" [routerLink]="['/composite-ml/snapshot', loaded()!.toId]">
                  #{{ loaded()!.toId }}
                </a>
                <span class="schema-badge">schema v{{ loaded()!.toSchemaVersion }}</span>
              </span>
              @if (loaded()!.fromSchemaVersion !== loaded()!.toSchemaVersion) {
                <span class="schema-mismatch"
                  >schemas differ — newly-added knobs show ∅ on the older side</span
                >
              }
              <span class="summary-count">
                {{ changedKnobs().length }} of {{ loaded()!.knobs.length }} knobs changed
              </span>
            </section>

            @if (loaded()!.knobs.length === 0) {
              <app-empty-state
                title="No knobs in this schema"
                description="Both snapshots use schemas that don't declare any required knobs."
              />
            } @else {
              <section class="card">
                <table class="diff-table">
                  <thead>
                    <tr>
                      <th>Knob</th>
                      <th class="num">From</th>
                      <th class="num">To</th>
                      <th>Change</th>
                      <th class="num delta-col">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (k of loaded()!.knobs; track k.name) {
                      <tr [class.unchanged]="!isChanged(k.fromValue, k.toValue)">
                        <td class="mono knob-name">{{ k.name }}</td>
                        <td class="num">
                          @if (k.fromValue !== null) {
                            <span class="mono">{{ k.fromValue | number: '1.0-4' }}</span>
                          } @else {
                            <span class="muted">∅</span>
                          }
                        </td>
                        <td class="num">
                          @if (k.toValue !== null) {
                            <span class="mono">{{ k.toValue | number: '1.0-4' }}</span>
                          } @else {
                            <span class="muted">∅</span>
                          }
                        </td>
                        <td class="bar-cell">
                          @if (k.deltaFraction !== null) {
                            <div class="bar-row">
                              <span class="bar-track">
                                @if (k.deltaFraction > 0) {
                                  <span
                                    class="bar-fill positive"
                                    [style.width.%]="barWidth(k.deltaFraction)"
                                    [style.margin-left.%]="50"
                                  ></span>
                                } @else if (k.deltaFraction < 0) {
                                  <span
                                    class="bar-fill negative"
                                    [style.width.%]="barWidth(k.deltaFraction)"
                                    [style.margin-left.%]="50 - barWidth(k.deltaFraction)"
                                  ></span>
                                }
                                <span class="bar-axis"></span>
                              </span>
                            </div>
                          } @else if (isChanged(k.fromValue, k.toValue)) {
                            <span class="muted small">∅ baseline</span>
                          } @else {
                            <span class="muted small">unchanged</span>
                          }
                        </td>
                        <td class="num delta-col">
                          @if (k.deltaFraction !== null) {
                            <span
                              class="delta-pct mono"
                              [class.positive]="k.deltaFraction > 0"
                              [class.negative]="k.deltaFraction < 0"
                            >
                              {{ k.deltaFraction > 0 ? '+' : ''
                              }}{{ k.deltaFraction * 100 | number: '1.0-2' }}%
                            </span>
                          } @else {
                            <span class="muted">—</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </section>
            }
          }
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
        gap: var(--space-5);
      }
      .picker {
        display: flex;
        align-items: end;
        gap: var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
      }
      .picker-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        flex: 1;
        max-width: 220px;
      }
      .picker-field label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .picker-field input {
        padding: 8px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .picker-arrow {
        font-size: var(--text-xl);
        color: var(--text-secondary);
        padding-bottom: 8px;
      }
      .btn-primary {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: #fff;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        border: none;
        cursor: pointer;
      }
      .btn-primary:disabled {
        background: var(--bg-tertiary, #d1d1d6);
        cursor: not-allowed;
      }
      .summary {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
        font-size: var(--text-sm);
      }
      .summary-pair {
        display: inline-flex;
        align-items: baseline;
        gap: 6px;
      }
      .snapshot-link {
        font-family: var(--font-mono);
        font-weight: var(--font-semibold);
        color: var(--accent);
        text-decoration: none;
      }
      .snapshot-link:hover {
        text-decoration: underline;
      }
      .schema-badge {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        background: var(--bg-primary);
        padding: 2px 8px;
        border-radius: var(--radius-full);
      }
      .summary-arrow {
        color: var(--text-tertiary);
      }
      .schema-mismatch {
        font-size: var(--text-xs);
        color: #c93400;
        font-style: italic;
      }
      .summary-count {
        margin-left: auto;
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .diff-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .diff-table th,
      .diff-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .diff-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .diff-table td.num,
      .diff-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .diff-table tr.unchanged {
        opacity: 0.55;
      }
      .knob-name {
        font-weight: var(--font-medium);
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
      .bar-cell {
        width: 160px;
      }
      .bar-row {
        display: flex;
        align-items: center;
      }
      .bar-track {
        position: relative;
        flex: 1;
        height: 14px;
        background: var(--bg-primary);
        border-radius: var(--radius-sm);
        overflow: hidden;
        min-width: 120px;
      }
      .bar-fill {
        position: absolute;
        top: 0;
        bottom: 0;
        display: block;
        border-radius: 2px;
      }
      .bar-fill.positive {
        background: rgba(52, 199, 89, 0.55);
      }
      .bar-fill.negative {
        background: rgba(255, 59, 48, 0.55);
      }
      .bar-axis {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 50%;
        width: 1px;
        background: var(--border);
        pointer-events: none;
      }
      .delta-col {
        width: 110px;
      }
      .delta-pct.positive {
        color: #248a3d;
      }
      .delta-pct.negative {
        color: #d70015;
      }
    `,
  ],
})
export class DiffPageComponent {
  private readonly compositeMl = inject(CompositeMLService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly fromInput = signal<number | null>(null);
  protected readonly toInput = signal<number | null>(null);

  protected readonly result = toSignal(
    this.route.queryParamMap.pipe(
      switchMap((qp): ReturnType<typeof this.fetchFor> => {
        const fromId = parseId(qp.get('fromId'));
        const toId = parseId(qp.get('toId'));
        // Keep the picker inputs in sync with the URL.
        this.fromInput.set(fromId);
        this.toInput.set(toId);
        if (fromId === null || toId === null) {
          return of<DiffResult>({ state: 'idle' });
        }
        return this.fetchFor(fromId, toId);
      }),
    ),
    { initialValue: { state: 'idle' } as DiffResult },
  );

  protected readonly loaded = computed(() => {
    const r = this.result();
    return r?.state === 'loaded' ? r.data : null;
  });

  protected readonly errorMessage = computed(() => {
    const r = this.result();
    return r?.state === 'error' ? r.message : '';
  });

  protected readonly changedKnobs = computed(() => {
    const d = this.loaded();
    if (!d) return [];
    return d.knobs.filter((k) => this.isChanged(k.fromValue, k.toValue));
  });

  protected readonly canApply = computed(() => {
    const from = this.fromInput();
    const to = this.toInput();
    return from !== null && to !== null && from > 0 && to > 0 && from !== to;
  });

  protected apply(): void {
    if (!this.canApply()) return;
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { fromId: this.fromInput(), toId: this.toInput() },
      queryParamsHandling: 'merge',
    });
  }

  protected isChanged(from: number | null, to: number | null): boolean {
    if (from === null && to === null) return false;
    if (from === null || to === null) return true;
    return from !== to;
  }

  protected barWidth(deltaFraction: number): number {
    // Map |delta| to a percent of the 50%-half-width track, capped at the
    // display cap (matches DELTA_BAR_CAP). 100% bar width = cap reached.
    const magnitude = Math.min(Math.abs(deltaFraction), DELTA_BAR_CAP);
    return (magnitude / DELTA_BAR_CAP) * 50;
  }

  private fetchFor(fromId: number, toId: number) {
    return this.compositeMl.diffPolicySnapshots(fromId, toId).pipe(
      map((res): DiffResult => {
        if (!res.status || !res.data) {
          return {
            state: 'error',
            message: res.message ?? 'Could not load diff.',
          };
        }
        return { state: 'loaded', data: res.data };
      }),
      catchError(() =>
        of<DiffResult>({
          state: 'error',
          message: 'Engine returned an error fetching the diff.',
        }),
      ),
    );
  }
}

function parseId(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
