import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  effect,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { Subject, timer, takeUntil, catchError, of } from 'rxjs';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { SystemLogsService } from '@core/services/system-logs.service';
import { EngineLogEntryDto, EngineLogPageDto } from '@core/api/api.types';

@Component({
  selector: 'app-system-logs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, PageHeaderComponent],
  template: `
    <div class="page">
      <app-page-header
        title="Engine Logs"
        subtitle="In-memory tail of the engine's recent log stream — info, warnings, errors, and exceptions"
      />

      <!--
        Filter bar — every input updates a signal that drives the next
        fetch. Auto-refresh fires on a 5s timer when enabled (default on).
        Buffer-stats badge shows what % of capacity is in use so the
        operator knows when entries are getting evicted.
      -->
      <section class="filter-bar">
        <div class="filter-group">
          <label class="filter-label">Min level</label>
          <select class="filter-input" [(ngModel)]="minLevel" (ngModelChange)="onFilterChange()">
            <option value="">All</option>
            @for (l of levels; track l) {
              <option [value]="l">{{ l }}</option>
            }
          </select>
        </div>
        <div class="filter-group flex-grow">
          <label class="filter-label">Category</label>
          <input
            type="text"
            class="filter-input"
            placeholder="e.g. Worker, MLPrediction"
            [(ngModel)]="category"
            (ngModelChange)="onFilterChange()"
          />
        </div>
        <div class="filter-group flex-grow">
          <label class="filter-label">Search</label>
          <input
            type="text"
            class="filter-input"
            placeholder="Match on message or exception text"
            [(ngModel)]="search"
            (ngModelChange)="onFilterChange()"
          />
        </div>
        <div class="filter-group">
          <label class="filter-label">Limit</label>
          <input
            type="number"
            class="filter-input narrow"
            min="10"
            max="5000"
            [(ngModel)]="limit"
            (ngModelChange)="onFilterChange()"
          />
        </div>
        <div class="filter-actions">
          <button
            type="button"
            class="btn btn-ghost"
            [class.active]="autoRefresh()"
            (click)="toggleAutoRefresh()"
            [attr.aria-pressed]="autoRefresh()"
            title="Auto-refresh every 5s"
          >
            <span class="auto-dot" [class.on]="autoRefresh()"></span>
            Live
          </button>
          <button type="button" class="btn btn-primary" (click)="fetchNow()" [disabled]="loading()">
            {{ loading() ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </section>

      <section class="meta-row">
        <div class="meta-item">
          Buffer
          <strong>{{ pageData()?.bufferSize ?? 0 }}</strong>
          /
          <span class="muted">{{ pageData()?.bufferCapacity ?? 0 }}</span>
        </div>
        <div class="meta-item">
          Showing <strong>{{ pageData()?.entries?.length ?? 0 }}</strong> entries
        </div>
        @if ((pageData()?.droppedCount ?? 0) > 0) {
          <div class="meta-item warn">
            <span class="muted"
              >{{ pageData()!.droppedCount }} entries evicted since startup (FIFO)</span
            >
          </div>
        }
        @if (lastFetchedAt()) {
          <div class="meta-item right">
            Last fetched
            <strong>{{ lastFetchedAt() | date: 'HH:mm:ss' }}</strong>
          </div>
        }
        @if (errorMessage()) {
          <div class="meta-item error">
            <strong>{{ errorMessage() }}</strong>
          </div>
        }
      </section>

      <section class="logs-table-wrap">
        @if ((pageData()?.entries?.length ?? 0) === 0) {
          <div class="empty-state">
            @if (loading()) {
              <span class="muted">Loading…</span>
            } @else if (errorMessage()) {
              <span class="muted">No data — see the error above.</span>
            } @else {
              <span class="muted">No log entries match the current filters.</span>
              <span class="empty-hint">
                Either the buffer is genuinely empty (engine just started) or the filters are too
                restrictive — try clearing the search field.
              </span>
            }
          </div>
        } @else {
          <table class="logs-table">
            <thead>
              <tr>
                <th class="col-time">Time</th>
                <th class="col-level">Level</th>
                <th class="col-cat">Category</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              @for (e of pageData()!.entries; track $index) {
                <tr
                  class="log-row"
                  [class.has-exception]="!!e.exception"
                  [class.expanded]="expandedIndex() === $index"
                  [class]="'lvl-' + e.level.toLowerCase()"
                  (click)="toggleRow($index, e)"
                >
                  <td class="col-time mono">{{ e.timestamp | date: 'HH:mm:ss.SSS' }}</td>
                  <td class="col-level">
                    <span class="level-chip" [class]="'lvl-chip-' + e.level.toLowerCase()">
                      {{ e.level }}
                    </span>
                  </td>
                  <td class="col-cat mono">{{ shortCategory(e.category) }}</td>
                  <td class="col-msg">
                    <span class="msg-text">{{ e.message }}</span>
                    @if (e.exception) {
                      <span class="exc-pill">EXC</span>
                    }
                  </td>
                </tr>
                @if (expandedIndex() === $index) {
                  <tr class="exp-row">
                    <td colspan="4">
                      <dl class="exp-dl">
                        <div>
                          <dt>Full category</dt>
                          <dd class="mono">{{ e.category }}</dd>
                        </div>
                        <div>
                          <dt>Event ID</dt>
                          <dd class="mono">{{ e.eventId }}</dd>
                        </div>
                        <div>
                          <dt>Timestamp</dt>
                          <dd class="mono">{{ e.timestamp }}</dd>
                        </div>
                      </dl>
                      @if (e.exception) {
                        <div class="exp-section">
                          <div class="exp-section-title">Exception</div>
                          <pre class="exp-pre">{{ e.exception }}</pre>
                        </div>
                      }
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-4) var(--space-6);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .filter-bar {
        display: flex;
        align-items: flex-end;
        gap: var(--space-3);
        flex-wrap: wrap;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
      }
      .filter-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 120px;
      }
      .filter-group.flex-grow {
        flex: 1;
      }
      .filter-label {
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .filter-input {
        height: 30px;
        padding: 0 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: 12px;
        font-family: inherit;
      }
      .filter-input.narrow {
        width: 80px;
      }
      .filter-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .btn {
        height: 30px;
        padding: 0 12px;
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: var(--font-semibold);
        cursor: pointer;
        font-family: inherit;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-ghost {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .btn-ghost.active {
        color: var(--accent);
        border-color: var(--accent);
        background: rgba(0, 113, 227, 0.06);
      }
      .auto-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-tertiary);
        transition: background 0.2s ease;
      }
      .auto-dot.on {
        background: #34c759;
        box-shadow: 0 0 0 3px rgba(52, 199, 89, 0.18);
      }

      .meta-row {
        display: flex;
        gap: var(--space-4);
        align-items: center;
        font-size: 11.5px;
        color: var(--text-secondary);
      }
      .meta-item.right {
        margin-left: auto;
      }
      .meta-item.error {
        color: #b91c1c;
      }
      .meta-item.warn {
        color: #b45309;
      }
      .meta-item strong {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }

      .logs-table-wrap {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: auto;
        max-height: calc(100vh - 320px);
      }
      .logs-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11.5px;
      }
      .logs-table thead th {
        position: sticky;
        top: 0;
        background: var(--bg-secondary);
        text-align: left;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
        padding: 8px;
        border-bottom: 1px solid var(--border);
      }
      .logs-table td {
        padding: 6px 8px;
        vertical-align: top;
        border-bottom: 1px solid rgba(142, 142, 147, 0.1);
      }
      .col-time {
        width: 95px;
        white-space: nowrap;
      }
      .col-level {
        width: 90px;
      }
      .col-cat {
        width: 220px;
        word-break: break-all;
      }
      .col-msg {
        word-break: break-word;
      }

      .log-row {
        cursor: pointer;
        transition: background 0.1s ease;
      }
      .log-row:hover {
        background: rgba(0, 113, 227, 0.04);
      }
      .log-row.expanded {
        background: rgba(0, 113, 227, 0.06);
      }
      .log-row.lvl-warning {
        background: rgba(255, 149, 0, 0.04);
      }
      .log-row.lvl-error,
      .log-row.lvl-critical {
        background: rgba(255, 59, 48, 0.06);
      }

      .level-chip {
        display: inline-flex;
        align-items: center;
        height: 18px;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 9.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
      }
      .lvl-chip-debug {
        background: rgba(142, 142, 147, 0.16);
      }
      .lvl-chip-information {
        background: rgba(0, 113, 227, 0.14);
        color: #0071e3;
      }
      .lvl-chip-warning {
        background: rgba(255, 149, 0, 0.18);
        color: #b45309;
      }
      .lvl-chip-error {
        background: rgba(255, 59, 48, 0.18);
        color: #b91c1c;
      }
      .lvl-chip-critical {
        background: #b91c1c;
        color: #fff;
      }
      .lvl-chip-trace {
        background: rgba(142, 142, 147, 0.14);
        color: var(--text-tertiary);
      }

      .exc-pill {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 5px;
        font-size: 9px;
        font-weight: var(--font-semibold);
        background: rgba(255, 59, 48, 0.18);
        color: #b91c1c;
        border-radius: 3px;
        vertical-align: middle;
      }

      .exp-row td {
        background: rgba(0, 113, 227, 0.04);
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
      }
      .exp-dl {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        margin: 0 0 10px;
      }
      .exp-dl > div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .exp-dl dt {
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .exp-dl dd {
        margin: 0;
        font-size: 11px;
        color: var(--text-primary);
      }
      .exp-section-title {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
        margin-bottom: 4px;
      }
      .exp-pre {
        margin: 0;
        padding: 8px 12px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
        color: #b91c1c;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 300px;
        overflow: auto;
      }

      .empty-state {
        padding: 30px 20px;
        text-align: center;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .empty-state .muted {
        color: var(--text-tertiary);
        font-size: 13px;
      }
      .empty-state .empty-hint {
        font-size: 11px;
        color: var(--text-tertiary);
        opacity: 0.85;
      }

      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
      }
      .muted {
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class SystemLogsPageComponent implements OnInit, OnDestroy {
  private logsService = inject(SystemLogsService);
  private destroy$ = new Subject<void>();

  readonly levels = ['Debug', 'Information', 'Warning', 'Error', 'Critical'];

  // Filter inputs (template-driven via ngModel — direct fields, not signals,
  // so two-way binding stays simple).
  minLevel: string = 'Information';
  category: string = '';
  search: string = '';
  limit: number = 200;

  pageData = signal<EngineLogPageDto | null>(null);
  loading = signal<boolean>(false);
  errorMessage = signal<string | null>(null);
  lastFetchedAt = signal<Date | null>(null);
  expandedIndex = signal<number | null>(null);
  autoRefresh = signal<boolean>(true);

  private filterChangeDebounce: ReturnType<typeof setTimeout> | null = null;

  ngOnInit() {
    this.fetchNow();
    // Auto-refresh loop: 5s cadence whenever the toggle is on. The effect
    // doesn't need to be tracked through the signal because we manually
    // gate inside the timer subscription on every tick.
    timer(5000, 5000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.autoRefresh() && !this.loading()) this.fetchNow();
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.filterChangeDebounce) clearTimeout(this.filterChangeDebounce);
  }

  fetchNow() {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.logsService
      .getRecent({
        level: this.minLevel || undefined,
        category: this.category?.trim() || undefined,
        search: this.search?.trim() || undefined,
        limit: this.limit,
      })
      .pipe(
        catchError((err) => {
          const msg =
            (err?.error?.message as string) ?? (err?.message as string) ?? 'Failed to load logs.';
          this.errorMessage.set(msg);
          return of(null);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.data) {
          this.pageData.set(res.data);
          this.lastFetchedAt.set(new Date());
        }
      });
  }

  /**
   * Debounce filter changes — typing in the search box would otherwise
   * fire a fetch on every keystroke. 300ms is short enough to feel
   * responsive but coalesces typed strings.
   */
  onFilterChange() {
    if (this.filterChangeDebounce) clearTimeout(this.filterChangeDebounce);
    this.filterChangeDebounce = setTimeout(() => {
      this.filterChangeDebounce = null;
      this.fetchNow();
    }, 300);
  }

  toggleAutoRefresh() {
    this.autoRefresh.set(!this.autoRefresh());
  }

  toggleRow(index: number, _entry: EngineLogEntryDto) {
    this.expandedIndex.set(this.expandedIndex() === index ? null : index);
  }

  /** Trim category to the last segment to keep the table readable. */
  shortCategory(category: string): string {
    if (!category) return '';
    const parts = category.split('.');
    if (parts.length <= 2) return category;
    return `…${parts.slice(-2).join('.')}`;
  }
}
