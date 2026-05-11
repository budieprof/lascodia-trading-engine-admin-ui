import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, finalize, map, of } from 'rxjs';

import { PositionsService } from '@core/services/positions.service';
import type { PositionLifecycleEventDto } from '@core/api/api.types';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Position-delta timeline card (PRD-V2 FR-5.8 read side).
 *
 * Renders PositionLifecycleEvent rows for one position. Today this list
 * is empty for live positions because the engine's writer wiring across
 * the position-management command handlers hasn't landed yet — the
 * empty-state copy says so explicitly so operators don't read it as a
 * bug. Once writers wire up, this card lights up automatically without
 * a UI change.
 *
 * Layout: vertical timeline. Each entry shows event type with a
 * colour-coded badge (open green, close red, modify amber, reconcile
 * blue), lots delta, source, description, and relative time.
 */
@Component({
  selector: 'app-position-lifecycle-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="card">
      <header class="card-head">
        <h3>Lifecycle</h3>
        <span class="muted small">
          {{ events().length }} event{{ events().length === 1 ? '' : 's' }}
        </span>
      </header>

      @if (loading()) {
        <app-card-skeleton [lines]="4" />
      } @else if (error()) {
        <app-error-state
          title="Could not load lifecycle"
          message="Engine returned an error fetching the position-delta timeline."
          (retry)="load()"
        />
      } @else if (events().length === 0) {
        <app-empty-state
          title="No lifecycle events"
          message="The position-lifecycle audit log is not yet populated for this position. Writer wiring across the position-management command handlers is a pending engine slice — once shipped, opens / closes / modifies will appear here automatically."
        />
      } @else {
        <ol class="timeline">
          @for (e of events(); track e.id) {
            <li class="entry" [attr.data-type]="eventBucket(e.eventType)">
              <span class="dot" aria-hidden="true"></span>
              <div class="body">
                <header>
                  <span class="badge" [attr.data-type]="eventBucket(e.eventType)">
                    {{ e.eventType }}
                  </span>
                  <span class="small muted">via {{ e.source }}</span>
                  <span class="small muted">·</span>
                  <span class="small muted" [title]="e.occurredAt | date: 'medium'">
                    {{ e.occurredAt | relativeTime }}
                  </span>
                </header>
                <div class="meta">
                  @if (e.previousLots !== null || e.newLots !== null) {
                    <span class="lots-delta mono">
                      @if (e.previousLots !== null) {
                        {{ e.previousLots | number: '1.2-2' }}
                      } @else {
                        —
                      }
                      <span class="arrow">→</span>
                      @if (e.newLots !== null) {
                        {{ e.newLots | number: '1.2-2' }}
                      } @else {
                        —
                      }
                      <span class="small muted">lots</span>
                    </span>
                  }
                  @if (e.swapAccumulated !== null) {
                    <span class="small muted">
                      swap {{ e.swapAccumulated | number: '1.2-2' }}
                    </span>
                  }
                  @if (e.commissionAccumulated !== null) {
                    <span class="small muted">
                      comm {{ e.commissionAccumulated | number: '1.2-2' }}
                    </span>
                  }
                </div>
                @if (e.description) {
                  <p class="desc">{{ e.description }}</p>
                }
              </div>
            </li>
          }
        </ol>
      }
    </section>
  `,
  styles: [
    `
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: var(--space-3);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: var(--text-xs);
      }
      .mono {
        font-family: var(--font-mono);
      }

      .timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        position: relative;
      }
      .timeline::before {
        content: '';
        position: absolute;
        left: 7px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--border);
      }
      .entry {
        position: relative;
        padding: 0 0 var(--space-3) var(--space-5);
      }
      .entry:last-child {
        padding-bottom: 0;
      }
      .dot {
        position: absolute;
        left: 0;
        top: 6px;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--bg-tertiary, var(--bg-primary));
        border: 2px solid var(--border);
        box-sizing: border-box;
      }
      .entry[data-type='open'] .dot {
        background: rgb(34, 197, 94);
        border-color: rgb(34, 197, 94);
      }
      .entry[data-type='close'] .dot {
        background: rgb(239, 68, 68);
        border-color: rgb(239, 68, 68);
      }
      .entry[data-type='modify'] .dot {
        background: rgb(245, 158, 11);
        border-color: rgb(245, 158, 11);
      }
      .entry[data-type='reconcile'] .dot {
        background: rgb(59, 130, 246);
        border-color: rgb(59, 130, 246);
      }

      .body header {
        display: flex;
        align-items: baseline;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
      .badge {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 2px 8px;
        border-radius: var(--radius-pill);
        background: var(--bg-tertiary, var(--bg-primary));
        color: var(--text-primary);
      }
      .badge[data-type='open'] {
        background: rgba(34, 197, 94, 0.15);
        color: rgb(22, 163, 74);
      }
      .badge[data-type='close'] {
        background: rgba(239, 68, 68, 0.15);
        color: rgb(220, 38, 38);
      }
      .badge[data-type='modify'] {
        background: rgba(245, 158, 11, 0.15);
        color: rgb(217, 119, 6);
      }
      .badge[data-type='reconcile'] {
        background: rgba(59, 130, 246, 0.15);
        color: rgb(37, 99, 235);
      }
      .meta {
        display: flex;
        gap: var(--space-3);
        margin-top: 4px;
        align-items: baseline;
        flex-wrap: wrap;
      }
      .lots-delta {
        font-size: var(--text-sm);
      }
      .arrow {
        margin: 0 4px;
        color: var(--text-secondary);
      }
      .desc {
        margin: 4px 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class PositionLifecycleCardComponent {
  readonly positionId = input.required<number>();
  /** Cap on rows fetched from the engine. Engine clamps to [1, 1000]. */
  readonly limit = input<number>(200);

  private readonly positions = inject(PositionsService);

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly events = signal<PositionLifecycleEventDto[]>([]);

  protected readonly hasAny = computed(() => this.events().length > 0);

  constructor() {
    effect(() => {
      const id = this.positionId();
      if (id) this.load();
    });
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.positions
      .getLifecycle(this.positionId(), this.limit())
      .pipe(
        map((res) => res.data ?? []),
        catchError(() => {
          this.error.set('Failed to load lifecycle.');
          return of<PositionLifecycleEventDto[]>([]);
        }),
        finalize(() => this.loading.set(false)),
      )
      .subscribe((rows) => this.events.set(rows));
  }

  // ── Engine event-type strings are free-form. Bucket them for colour-coding
  // without hard-failing on values we haven't seen — unknown types just get
  // the neutral default dot/badge styling.
  eventBucket(type: string): 'open' | 'close' | 'modify' | 'reconcile' | 'other' {
    const t = (type ?? '').toLowerCase();
    if (t === 'opened') return 'open';
    if (t.includes('close')) return 'close';
    if (t === 'modified') return 'modify';
    if (t.includes('reconcile')) return 'reconcile';
    return 'other';
  }
}
