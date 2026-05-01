import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { throttleTime } from 'rxjs';

import { StrategyGenerationService } from '@core/services/strategy-generation.service';
import { NotificationService } from '@core/notifications/notification.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { StrategyGenerationCycleRunDto } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Strategy-generation timeline. Renders the last N cycle runs as a vertical
 * timeline, colour-coded by status. Operators can also force a manual cycle
 * from this page (Operator policy required server-side).
 */
@Component({
  selector: 'app-strategy-generation-cycles-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, CardSkeletonComponent, EmptyStateComponent, RelativeTimePipe],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy Generation"
        subtitle="Recent cycle runs from StrategyGenerationWorker"
      >
        <button
          type="button"
          class="btn btn-primary"
          (click)="triggerCycle()"
          [disabled]="triggering()"
        >
          {{ triggering() ? 'Triggering…' : 'Trigger cycle' }}
        </button>
      </app-page-header>

      <section class="filter-bar">
        @for (s of statusFilters; track s) {
          <button
            type="button"
            class="chip"
            [class.active]="statusFilter() === s"
            (click)="setStatusFilter(s)"
          >
            {{ s ?? 'All' }}
          </button>
        }
      </section>

      @if (loading() && cycles().length === 0) {
        <app-card-skeleton [lines]="6" />
      } @else if (cycles().length === 0) {
        <app-empty-state
          title="No cycles yet"
          description="StrategyGenerationWorker hasn't run a cycle (or none match the current filter)."
        />
      } @else {
        <div class="totals">
          <div>
            <span class="label">Cycles shown</span>
            <span class="value">{{ cycles().length }}</span>
          </div>
          <div>
            <span class="label">Candidates created</span>
            <span class="value">{{ totalCandidates() }}</span>
          </div>
          <div>
            <span class="label">Symbols processed</span>
            <span class="value">{{ totalSymbols() }}</span>
          </div>
          <div>
            <span class="label">Strategies pruned</span>
            <span class="value">{{ totalPruned() }}</span>
          </div>
        </div>

        <ol class="timeline">
          @for (c of cycles(); track c.id) {
            <li class="timeline-item" [attr.data-status]="c.status.toLowerCase()">
              <div class="dot"></div>
              <div class="card">
                <header class="card-head">
                  <div>
                    <span class="cycle-id" title="{{ c.cycleId }}">
                      {{ shortCycleId(c.cycleId) }}
                    </span>
                    <span class="status">{{ c.status }}</span>
                  </div>
                  <span class="muted">{{ c.startedAtUtc | relativeTime }}</span>
                </header>
                <div class="metrics">
                  <span
                    ><strong>{{ c.candidatesCreated }}</strong> created</span
                  >
                  <span
                    ><strong>{{ c.reserveCandidatesCreated }}</strong> reserve</span
                  >
                  <span
                    ><strong>{{ c.candidatesScreened }}</strong> screened</span
                  >
                  <span
                    ><strong>{{ c.symbolsProcessed }}</strong> symbols</span
                  >
                  <span
                    ><strong>{{ c.symbolsSkipped }}</strong> skipped</span
                  >
                  <span
                    ><strong>{{ c.strategiesPruned }}</strong> pruned</span
                  >
                  <span
                    ><strong>{{ c.portfolioFilterRemoved }}</strong> filtered out</span
                  >
                  @if (c.durationMs !== null) {
                    <span
                      ><strong>{{ formatDuration(c.durationMs) }}</strong> elapsed</span
                    >
                  }
                </div>
                @if (c.failureMessage) {
                  <div class="failure">
                    <span class="failure-stage">{{ c.failureStage ?? 'unknown stage' }}:</span>
                    {{ c.failureMessage }}
                  </div>
                }
              </div>
            </li>
          }
        </ol>
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

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .filter-bar {
        display: flex;
        gap: var(--space-2);
      }
      .chip {
        padding: 6px 14px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .chip:hover {
        border-color: var(--accent);
        color: var(--accent);
      }
      .chip.active {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }

      .totals {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-4);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .totals div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .label {
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .value {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }

      .timeline {
        list-style: none;
        margin: 0;
        padding: 0 0 0 var(--space-4);
        position: relative;
      }
      .timeline::before {
        content: '';
        position: absolute;
        left: 4px;
        top: 8px;
        bottom: 8px;
        width: 2px;
        background: var(--border);
      }
      .timeline-item {
        position: relative;
        padding: 0 0 var(--space-4) var(--space-5);
      }
      .timeline-item:last-child {
        padding-bottom: 0;
      }
      .dot {
        position: absolute;
        left: -4px;
        top: 6px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #636366;
        border: 2px solid var(--bg-primary);
      }
      .timeline-item[data-status='running'] .dot {
        background: #0071e3;
        animation: pulse 1.6s ease-in-out infinite;
      }
      .timeline-item[data-status='completed'] .dot {
        background: #34c759;
      }
      .timeline-item[data-status='failed'] .dot {
        background: #ff3b30;
      }
      @keyframes pulse {
        0%,
        100% {
          box-shadow: 0 0 0 0 rgba(0, 113, 227, 0.4);
        }
        50% {
          box-shadow: 0 0 0 6px rgba(0, 113, 227, 0);
        }
      }

      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .cycle-id {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-right: var(--space-2);
      }
      .status {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .timeline-item[data-status='completed'] .status {
        color: #248a3d;
      }
      .timeline-item[data-status='failed'] .status {
        color: #d70015;
      }
      .timeline-item[data-status='running'] .status {
        color: #0040dd;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .metrics {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1) var(--space-4);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .metrics strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .failure {
        padding: var(--space-2) var(--space-3);
        background: rgba(255, 59, 48, 0.08);
        border-left: 3px solid #ff3b30;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .failure-stage {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: #d70015;
        margin-right: 4px;
      }
    `,
  ],
})
export class StrategyGenerationCyclesPageComponent {
  private readonly service = inject(StrategyGenerationService);
  private readonly notify = inject(NotificationService);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly cycles = signal<StrategyGenerationCycleRunDto[]>([]);
  readonly loading = signal(true);
  readonly triggering = signal(false);
  readonly statusFilter = signal<string | null>(null);

  readonly statusFilters: (string | null)[] = [null, 'Running', 'Completed', 'Failed'];

  readonly totalCandidates = computed(() =>
    this.cycles().reduce((acc, c) => acc + c.candidatesCreated, 0),
  );
  readonly totalSymbols = computed(() =>
    this.cycles().reduce((acc, c) => acc + c.symbolsProcessed, 0),
  );
  readonly totalPruned = computed(() =>
    this.cycles().reduce((acc, c) => acc + c.strategiesPruned, 0),
  );

  constructor() {
    this.load();

    // Re-pull when a strategy is activated — most likely the runner just
    // finished a cycle. Cheaper than polling and matches the actual signal
    // operators care about. Throttled so a burst doesn't pile up requests.
    this.realtime
      .on('strategyActivated')
      .pipe(
        throttleTime(3_000, undefined, { leading: false, trailing: true }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.load());
  }

  protected setStatusFilter(s: string | null): void {
    this.statusFilter.set(s);
    this.load();
  }

  protected triggerCycle(): void {
    this.triggering.set(true);
    this.service.triggerCycle().subscribe({
      next: (res) => {
        this.triggering.set(false);
        if (res?.status) {
          this.notify.success('Cycle triggered');
          this.load();
        } else {
          this.notify.error(res?.message ?? 'Trigger failed');
        }
      },
      error: () => {
        this.triggering.set(false);
        this.notify.error('Trigger failed');
      },
    });
  }

  protected shortCycleId(id: string): string {
    if (!id) return '—';
    return id.length > 24 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id;
  }

  protected formatDuration(ms: number): string {
    if (ms < 1_000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
    return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
  }

  private load(): void {
    this.loading.set(true);
    this.service
      .listCycles({
        currentPage: 1,
        itemCountPerPage: 30,
        filter: this.statusFilter() ? { status: this.statusFilter() } : null,
      })
      .subscribe({
        next: (res) => {
          this.cycles.set(res?.data?.data ?? []);
          this.loading.set(false);
        },
        error: () => {
          this.cycles.set([]);
          this.loading.set(false);
        },
      });
  }
}
