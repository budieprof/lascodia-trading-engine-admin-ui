import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { SignalRejectionsService } from '@core/services/signal-rejections.service';
import type { SignalRejectionEventDto, SignalRejectionStage } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type StageFilter = 'all' | SignalRejectionStage;

const STAGE_OPTIONS: ReadonlyArray<{ value: StageFilter; label: string }> = [
  { value: 'all', label: 'All stages' },
  { value: 'Local', label: 'Local (EA gate)' },
  { value: 'Engine', label: 'Engine' },
  { value: 'Broker', label: 'Broker' },
];

/**
 * v8.47.172 — per-instance rejection log.  Answers "why didn't this EA
 * take signal X?" in one click without VNC-ing into MT5.  Polls
 * `/signal-rejection` filtered by `eaInstanceId` every 15 s; admin can
 * narrow by stage, sub-stage substring, or symbol.
 *
 * Empty state is the healthy default — most EAs reject 0 signals in
 * any given 24h window once the safety stack is tuned.  Click a row to
 * expand the metadata blob (gate-specific context like drift fraction,
 * notional projection, broker retcode params).
 */
@Component({
  selector: 'app-ea-rejections-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="EA signal-rejection log">
      <header class="panel-head">
        <h3>Rejection log</h3>
        <div class="filters">
          <select
            class="input"
            [ngModel]="stageFilter()"
            (ngModelChange)="stageFilter.set($event)"
            aria-label="Filter by stage"
          >
            @for (opt of stageOptions; track opt.value) {
              <option [value]="opt.value">{{ opt.label }}</option>
            }
          </select>
          <input
            type="text"
            class="input"
            placeholder="SubStage substring (e.g. SafetyGate.)"
            [ngModel]="subStageFilter()"
            (ngModelChange)="onSubStageChange($event)"
            aria-label="Filter by SubStage substring"
          />
          <input
            type="text"
            class="input"
            placeholder="Symbol (e.g. EURGBP)"
            [ngModel]="symbolFilter()"
            (ngModelChange)="onSymbolChange($event)"
            aria-label="Filter by symbol"
          />
          <button
            type="button"
            class="btn btn-secondary"
            (click)="resource.refresh()"
            [disabled]="resource.loading()"
          >
            @if (resource.loading()) {
              Refreshing…
            } @else {
              Refresh
            }
          </button>
        </div>
      </header>

      <ui-progress-bar [active]="resource.loading()" />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load rejection log"
          message="Engine returned an error fetching rejection events."
          (retry)="resource.refresh()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No rejections in the last 24h"
          message="EA is processing every eligible signal — no local gate, engine check, or broker retcode has fired against this account."
        />
      } @else {
        <ul class="rejection-list" role="list">
          @for (row of rows(); track row.id) {
            <li class="rejection-row">
              <div
                class="row-head"
                (click)="toggle(row.id)"
                role="button"
                [attr.aria-expanded]="expanded() === row.id"
              >
                <span class="time" [title]="row.createdAt | date: 'medium'">
                  {{ row.createdAt | relativeTime }}
                </span>
                <a
                  class="signal"
                  [routerLink]="['/trade-signals', row.tradeSignalId]"
                  (click)="$event.stopPropagation()"
                  title="Open signal detail — cross-account attempts"
                  >#{{ row.tradeSignalId }}</a
                >
                <span class="symbol">{{ row.symbol ?? '—' }}</span>
                <span class="stage" [attr.data-stage]="row.stage">{{ row.stage }}</span>
                <span class="substage">{{ row.subStage }}</span>
                <span class="reason">{{ row.reason }}</span>
              </div>
              @if (expanded() === row.id) {
                <pre class="metadata">{{ formatMetadata(row.metadataJson) }}</pre>
              }
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--surface-base);
        border-radius: 8px;
        padding: 16px;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .panel-head h3 {
        margin: 0;
      }
      .filters {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .filters .input {
        min-width: 140px;
      }
      .rejection-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .rejection-row {
        border-bottom: 1px solid var(--border-subtle);
        padding: 8px 0;
      }
      .rejection-row:last-child {
        border-bottom: 0;
      }
      .row-head {
        display: grid;
        grid-template-columns: 90px 70px 80px 80px 150px 1fr;
        gap: 8px;
        cursor: pointer;
        align-items: center;
        font-size: 13px;
      }
      .row-head:hover {
        background: var(--surface-hover);
      }
      .time {
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }
      .signal {
        font-family: var(--font-mono);
        color: var(--text-secondary);
      }
      .symbol {
        font-family: var(--font-mono);
        font-weight: 600;
      }
      .stage {
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: uppercase;
        font-weight: 600;
      }
      .stage[data-stage='Local'] {
        background: var(--badge-amber-bg);
        color: var(--badge-amber-fg);
      }
      .stage[data-stage='Engine'] {
        background: var(--badge-blue-bg);
        color: var(--badge-blue-fg);
      }
      .stage[data-stage='Broker'] {
        background: var(--badge-red-bg);
        color: var(--badge-red-fg);
      }
      .substage {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--text-secondary);
      }
      .reason {
        color: var(--text-base);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .metadata {
        background: var(--surface-sunken);
        padding: 8px;
        border-radius: 4px;
        font-size: 12px;
        margin: 8px 0 0 0;
        overflow-x: auto;
      }
    `,
  ],
})
export class EARejectionsPanelComponent {
  // Intentionally non-required: createPolledResource invokes the fetcher
  // synchronously inside its field-initializer, which would otherwise
  // hit Angular's NG0950 ("required input not yet available") because
  // parent template bindings don't flush until after construction.
  // The fetcher's `if (!id)` guard handles the empty first tick and
  // picks up the real instance id on the next polling cycle.
  readonly instanceId = input<string>('');
  readonly stageOptions = STAGE_OPTIONS;

  readonly stageFilter = signal<StageFilter>('all');
  readonly subStageFilter = signal<string>('');
  readonly symbolFilter = signal<string>('');
  readonly expanded = signal<number | null>(null);

  private readonly rejectionsService = inject(SignalRejectionsService);

  // Debounce text inputs so each keystroke doesn't burst the engine —
  // same pattern as ea-audit-timeline.  committedSubStage/Symbol are the
  // values the fetcher actually reads; the two raw signals are bound to
  // the inputs directly so typing remains responsive.
  private readonly committedSubStage = signal<string>('');
  private readonly committedSymbol = signal<string>('');
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  onSubStageChange(value: string): void {
    this.subStageFilter.set(value);
    this.scheduleDebouncedCommit();
  }

  onSymbolChange(value: string): void {
    this.symbolFilter.set(value);
    this.scheduleDebouncedCommit();
  }

  private scheduleDebouncedCommit(): void {
    if (this.debounceHandle != null) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.committedSubStage.set(this.subStageFilter().trim());
      this.committedSymbol.set(this.symbolFilter().trim());
    }, 350);
  }

  protected readonly resource = createPolledResource(
    () => {
      const id = this.instanceId();
      if (!id) return of<SignalRejectionEventDto[]>([]);
      const stage = this.stageFilter();
      const subStage = this.committedSubStage();
      const symbol = this.committedSymbol();
      return this.rejectionsService
        .list({
          eaInstanceId: id,
          stage: stage === 'all' ? undefined : stage,
          subStage: subStage || undefined,
          symbol: symbol || undefined,
          currentPage: 1,
          itemCountPerPage: 100,
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<SignalRejectionEventDto[]>([])),
        );
    },
    { intervalMs: 15_000 },
  );

  readonly rows = computed(() => this.resource.value() ?? []);
  readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  toggle(id: number): void {
    this.expanded.set(this.expanded() === id ? null : id);
  }

  formatMetadata(json: string | null): string {
    if (!json) return '(no metadata)';
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }
}
