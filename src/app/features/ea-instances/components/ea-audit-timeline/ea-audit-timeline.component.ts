import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, map, of } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import type { EAAuditSeverity, EAAuditTimelineItem } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type SeverityFilter = 'all' | EAAuditSeverity;

const SEVERITY_OPTIONS: ReadonlyArray<{ value: SeverityFilter; label: string }> = [
  { value: 'all', label: 'All severities' },
  { value: 'CRIT', label: 'CRIT' },
  { value: 'ERROR', label: 'ERROR' },
  { value: 'WARN', label: 'WARN' },
  { value: 'INFO', label: 'INFO' },
];

/**
 * Renders the EA's safety-audit timeline (Phase-2A admin pipeline).  Polls
 * /admin/ea/{instanceId}/audit every 20s with a 200-row cap; admin can
 * filter by severity (in-memory) or event-type prefix (server-side) and
 * tap an entry to expand the details column.  Empty list is the healthy
 * default — most EA instances log only INFO state-transitions during
 * normal operation.
 */
@Component({
  selector: 'app-ea-audit-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    SlicePipe,
    FormsModule,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="EA safety-audit timeline">
      <header class="panel-head">
        <h3>Audit timeline</h3>
        <div class="filters">
          <input
            type="text"
            class="input"
            placeholder="Event type prefix (e.g. CIRCUIT_)"
            [ngModel]="eventTypeFilter()"
            (ngModelChange)="onEventTypeChange($event)"
            aria-label="Filter by event-type prefix"
          />
          <select
            class="input"
            [ngModel]="severityFilter()"
            (ngModelChange)="severityFilter.set($event)"
            aria-label="Filter by severity"
          >
            @for (opt of severityOptions; track opt.value) {
              <option [value]="opt.value">{{ opt.label }}</option>
            }
          </select>
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

      <!--
        Same loading affordance as the page-level bar — visible during every
        in-flight fetch so users get a consistent cue when local fetches
        complete too fast for the row skeleton to register.
      -->
      <ui-progress-bar [active]="resource.loading()" />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load audit timeline"
          message="Engine returned an error fetching audit entries."
          (retry)="resource.refresh()"
        />
      } @else if (filtered().length === 0) {
        <app-empty-state
          title="No audit entries"
          description="The EA hasn't pushed any safety-audit rows matching the current filter. Try widening the severity selector or clearing the event-type prefix."
        />
      } @else {
        <ol class="rows">
          @for (row of filtered(); track row.id) {
            <li class="row" [attr.data-severity]="row.severity">
              <span class="sev" [attr.data-severity]="row.severity">{{ row.severity }}</span>
              <div class="row-main">
                <div class="row-line">
                  <span class="event mono">{{ row.eventType }}</span>
                  @if (row.symbol) {
                    <span class="symbol mono">{{ row.symbol }}</span>
                  }
                  @if (row.correlationId) {
                    <span class="cid mono" [title]="row.correlationId"
                      >cid {{ row.correlationId | slice: 0 : 8 }}</span
                    >
                  }
                </div>
                <div class="row-details">{{ row.details }}</div>
              </div>
              <div class="row-meta">
                <span class="when" [title]="row.occurredAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                  {{ row.occurredAt | relativeTime }}
                </span>
                @if (row.value !== 0) {
                  <span class="value mono">{{ row.value }}</span>
                }
              </div>
            </li>
          }
        </ol>
        @if (filtered().length < (resource.value() ?? []).length) {
          <p class="paginated muted small">
            Showing {{ filtered().length }} of {{ (resource.value() ?? []).length }} entries —
            filter narrows to {{ severityFilter() }}.
          </p>
        }
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .filters {
        display: flex;
        gap: var(--space-2);
        align-items: center;
      }
      .input {
        height: 32px;
        padding: 0 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .rows {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
        max-height: 480px;
        overflow-y: auto;
      }
      .row {
        display: grid;
        grid-template-columns: 64px 1fr 110px;
        align-items: center;
        gap: var(--space-3);
        padding: 8px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }
      .row[data-severity='INFO'] {
        border-left-color: #0071e3;
      }
      .row[data-severity='WARN'] {
        border-left-color: #ff9500;
      }
      .row[data-severity='ERROR'] {
        border-left-color: #ff3b30;
      }
      .row[data-severity='CRIT'] {
        border-left-color: #d70015;
        background: rgba(215, 0, 21, 0.05);
      }
      .sev {
        font-weight: var(--font-semibold);
        text-align: center;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: rgba(0, 0, 0, 0.05);
        color: var(--text-secondary);
      }
      .sev[data-severity='INFO'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .sev[data-severity='WARN'] {
        background: rgba(255, 149, 0, 0.15);
        color: #c93400;
      }
      .sev[data-severity='ERROR'] {
        background: rgba(255, 59, 48, 0.15);
        color: #d70015;
      }
      .sev[data-severity='CRIT'] {
        background: #d70015;
        color: #fff;
      }
      .row-main {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .row-line {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        flex-wrap: wrap;
      }
      .event {
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }
      .symbol {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .cid {
        color: var(--text-tertiary);
        font-size: 10px;
      }
      .row-details {
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row-meta {
        text-align: right;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .when {
        color: var(--text-tertiary);
      }
      .value {
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
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
      .paginated {
        margin: 0;
      }
      .btn-secondary {
        height: 32px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn-secondary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `,
  ],
})
export class EAAuditTimelineComponent {
  /**
   * Optional (not `required`) so the polled resource's field initializer can
   * read it safely.  Angular's required signal inputs throw NG0950 when read
   * before the parent's binding flushes, but createPolledResource() invokes
   * the fetcher synchronously to seed the first value — well before the
   * component goes through its first change-detection pass.  We treat empty
   * string as "no instance yet" and bail out of the fetch.
   */
  readonly instanceId = input<string>('');

  protected readonly severityOptions = SEVERITY_OPTIONS;
  protected readonly severityFilter = signal<SeverityFilter>('all');
  protected readonly eventTypeFilter = signal<string>('');

  private readonly admin = inject(EAAdminService);

  // Debounce event-type prefix changes via a separate signal so the
  // polled resource only re-fetches once the operator stops typing.
  private readonly committedEventType = signal<string>('');
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;

  protected onEventTypeChange(value: string): void {
    this.eventTypeFilter.set(value);
    if (this.debounceHandle != null) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => this.committedEventType.set(value), 350);
  }

  protected readonly resource = createPolledResource(
    () => {
      const id = this.instanceId();
      if (!id) {
        // Parent binding hasn't flushed yet — first poll falls through
        // and the resource picks up the live instanceId on the next tick.
        return of<EAAuditTimelineItem[]>([]);
      }
      return this.admin
        .getAuditTimeline(id, {
          eventType: this.committedEventType() || undefined,
          take: 200,
        })
        .pipe(
          map((res) => res.data ?? []),
          catchError(() => of<EAAuditTimelineItem[]>([])),
        );
    },
    { intervalMs: 20_000 },
  );

  protected readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  protected readonly filtered = computed(() => {
    const rows = this.resource.value() ?? [];
    const sev = this.severityFilter();
    if (sev === 'all') return rows;
    return rows.filter((r) => r.severity === sev);
  });
}
