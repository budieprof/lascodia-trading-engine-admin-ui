import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, map, of } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import type { EALogLevel, EALogTimelineItem } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type LevelFilter = 'all' | EALogLevel;

const LEVEL_OPTIONS: ReadonlyArray<{ value: LevelFilter; label: string }> = [
  { value: 'all', label: 'All levels' },
  { value: 'ERROR', label: 'ERROR' },
  { value: 'WARN', label: 'WARN' },
];

/**
 * Phase-9 admin pipeline.  Polls `/admin/ea/{instanceId}/logs` every 15s
 * for the most recent ~200 WARN/ERROR lines and renders a tail-style
 * panel.  Operators can filter client-side by level (in-memory) and
 * server-side by free-text search across the message body and component
 * prefix.  Empty list is the healthy default — the EA only forwards
 * WARN+ so this panel is silent on a healthy instance.
 *
 * Modelled after EAAuditTimelineComponent but stripped of the
 * severity/value/symbol columns that don't apply to general logs.
 */
@Component({
  selector: 'app-ea-logs-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
  ],
  template: `
    <section class="panel" aria-label="EA log tail">
      <header class="panel-head">
        <h3>Logs</h3>
        <div class="filters">
          <input
            type="text"
            class="input"
            placeholder="Search message body…"
            [ngModel]="searchFilter()"
            (ngModelChange)="onSearchChange($event)"
            aria-label="Filter by message body"
          />
          <input
            type="text"
            class="input"
            placeholder="Component prefix (e.g. OrderExecutor)"
            [ngModel]="componentFilter()"
            (ngModelChange)="onComponentChange($event)"
            aria-label="Filter by component prefix"
          />
          <select
            class="input"
            [ngModel]="levelFilter()"
            (ngModelChange)="levelFilter.set($event)"
            aria-label="Filter by level"
          >
            @for (opt of levelOptions; track opt.value) {
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

      <ui-progress-bar [active]="resource.loading()" />

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load logs"
          message="Engine returned an error fetching log entries."
          (retry)="resource.refresh()"
        />
      } @else if (filtered().length === 0) {
        <app-empty-state
          title="No log entries"
          description="No WARN or ERROR lines forwarded matching the current filter. The EA only ships WARN+ to limit volume — INFO/DEBUG stay local to the on-disk file. Try widening the level selector or clearing the search."
        />
      } @else {
        <ol class="rows">
          @for (row of filtered(); track row.id) {
            <li class="row" [attr.data-level]="row.level">
              <span class="lvl" [attr.data-level]="row.level">{{ row.level }}</span>
              <div class="row-main">
                <div class="row-line">
                  @if (row.component) {
                    <span class="component mono">{{ row.component }}</span>
                  }
                  <span class="msg">{{ row.message }}</span>
                </div>
                <div class="row-meta">
                  <span [title]="row.occurredAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                    {{ row.occurredAt | relativeTime }}
                  </span>
                  @if (row.correlationId) {
                    <span class="cid mono">cid: {{ row.correlationId }}</span>
                  }
                </div>
              </div>
            </li>
          }
        </ol>
        @if (filtered().length < (resource.value() ?? []).length) {
          <p class="paginated muted small">
            Showing {{ filtered().length }} of {{ (resource.value() ?? []).length }} lines — level
            filter narrows to {{ levelFilter() }}.
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
        flex-wrap: wrap;
      }
      .input {
        height: 32px;
        padding: 0 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        min-width: 180px;
      }
      .btn {
        height: 32px;
        padding: 0 14px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn-secondary {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--text-primary);
      }
      .btn-secondary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
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
        grid-template-columns: 64px 1fr;
        align-items: start;
        gap: var(--space-3);
        padding: 8px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }
      .row[data-level='WARN'] {
        border-left-color: #ff9500;
      }
      .row[data-level='ERROR'] {
        border-left-color: #ff3b30;
        background: rgba(255, 59, 48, 0.04);
      }
      .lvl {
        font-weight: var(--font-semibold);
        text-align: center;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        background: rgba(0, 0, 0, 0.05);
      }
      .lvl[data-level='WARN'] {
        background: #fff4e0;
        color: #b56b00;
      }
      .lvl[data-level='ERROR'] {
        background: #fde0de;
        color: #c4290a;
      }
      .row-main {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .row-line {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        min-width: 0;
      }
      .component {
        flex-shrink: 0;
        color: var(--text-secondary);
        font-size: 11px;
      }
      .msg {
        color: var(--text-primary);
        word-break: break-word;
        white-space: pre-wrap;
      }
      .row-meta {
        display: flex;
        gap: var(--space-3);
        color: var(--text-secondary);
        font-size: 10px;
      }
      .cid {
        font-size: 10px;
        opacity: 0.7;
      }
      .muted {
        color: var(--text-secondary);
      }
      .small {
        font-size: 10px;
      }
      .paginated {
        margin: 0;
      }
    `,
  ],
})
export class EALogsPanelComponent {
  readonly instanceId = input<string>('');

  protected readonly levelOptions = LEVEL_OPTIONS;
  protected readonly levelFilter = signal<LevelFilter>('all');
  protected readonly searchFilter = signal<string>('');
  protected readonly componentFilter = signal<string>('');

  private readonly admin = inject(EAAdminService);

  /**
   * Logs poll.  Server-side search + component-prefix filter so the
   * default 200-row cap doesn't truncate by line distance from the
   * needle.  Level filter stays client-side so flipping between WARN/
   * ERROR is instant — no extra HTTP round-trip per click.
   */
  protected readonly resource = createPolledResource(
    () => {
      const id = this.instanceId();
      if (!id) return of<EALogTimelineItem[]>([]);
      const search = this.searchFilter().trim();
      const component = this.componentFilter().trim();
      return this.admin
        .getLogTimeline(id, {
          take: 200,
          search: search || undefined,
          component: component || undefined,
        })
        .pipe(
          map((res) => res.data ?? []),
          catchError(() => of<EALogTimelineItem[]>([])),
        );
    },
    { intervalMs: 15_000 },
  );

  protected readonly filtered = computed(() => {
    const rows = this.resource.value() ?? [];
    const lvl = this.levelFilter();
    return lvl === 'all' ? rows : rows.filter((r) => r.level === lvl);
  });

  protected readonly loading = computed(
    () => this.resource.loading() && (this.resource.value() ?? null) === null,
  );

  // Debounce the search input so every keystroke doesn't refire the
  // resource.  150ms feels instant for short tokens, gives a window for
  // continuing to type before each refetch.
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  protected onSearchChange(v: string): void {
    if (this.searchDebounce !== null) clearTimeout(this.searchDebounce);
    this.searchDebounce = setTimeout(() => {
      this.searchFilter.set(v);
      this.resource.refresh();
    }, 150);
  }

  private componentDebounce: ReturnType<typeof setTimeout> | null = null;
  protected onComponentChange(v: string): void {
    if (this.componentDebounce !== null) clearTimeout(this.componentDebounce);
    this.componentDebounce = setTimeout(() => {
      this.componentFilter.set(v);
      this.resource.refresh();
    }, 150);
  }
}
