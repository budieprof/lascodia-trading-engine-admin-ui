import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
import { Subject, timer, takeUntil, catchError, of } from 'rxjs';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { SystemLogsService } from '@core/services/system-logs.service';
import { EngineLogEntryDto, EngineLogPageDto } from '@core/api/api.types';
import {
  categoryTail,
  firstLine,
  isMultiline,
  isSameLocalDay,
  levelLabel,
  utcStamp,
} from './log-format';

@Component({
  selector: 'app-system-logs-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, FormsModule, PageHeaderComponent, ErrorStateComponent],
  styleUrl: './system-logs-page.component.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Engine Logs"
        subtitle="In-memory tail of the engine's recent log stream — info, warnings, errors, and exceptions"
      />

      <!--
        Filter bar — every input updates a field that drives the next fetch (debounced 300 ms).
        Auto-refresh fires on a 5s timer when Live is on (default on).
      -->
      <section class="toolbar" aria-label="Log filters">
        <label class="fld">
          <span class="fld-l">Min level</span>
          <select class="fld-c" [(ngModel)]="minLevel" (ngModelChange)="onFilterChange()">
            <option value="">All</option>
            @for (l of levels; track l) {
              <option [value]="l">{{ levelLabel(l) }} and above</option>
            }
          </select>
        </label>
        <label class="fld cat">
          <span class="fld-l">Category</span>
          <input
            type="text"
            class="fld-c"
            placeholder="e.g. Worker, MLPrediction"
            [(ngModel)]="category"
            (ngModelChange)="onFilterChange()"
          />
        </label>
        <label class="fld grow">
          <span class="fld-l">Search</span>
          <input
            type="text"
            class="fld-c"
            placeholder="Match on message or exception text"
            [(ngModel)]="search"
            (ngModelChange)="onFilterChange()"
          />
        </label>
        <label class="fld">
          <span class="fld-l">Limit</span>
          <input
            type="number"
            class="fld-c narrow"
            min="10"
            max="5000"
            [(ngModel)]="limit"
            (ngModelChange)="onFilterChange()"
          />
        </label>
        <div class="actions">
          <button
            type="button"
            class="btn live"
            [class.on]="autoRefresh()"
            (click)="toggleAutoRefresh()"
            [attr.aria-pressed]="autoRefresh()"
            title="Auto-refresh every 5s"
          >
            <span class="auto-dot" [class.on]="autoRefresh()"></span>
            Live
          </button>
          <button type="button" class="btn primary" (click)="fetchNow()" [disabled]="loading()">
            {{ loading() ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </section>

      <section class="meta-row">
        <span class="meta-item">
          @if (autoRefresh()) {
            <span class="state on">Live · every 5 s</span>
          } @else {
            <span class="state">Paused</span>
          }
        </span>
        @if (lastFetchedAt()) {
          <span class="meta-item" title="Your browser's local time">
            Last fetched
            <strong>{{ lastFetchedAt() | date: 'HH:mm:ss' }}</strong>
          </span>
        }
        <span class="meta-item">
          <strong>{{ pageData()?.entries?.length ?? 0 }}</strong> entries loaded
          <span class="muted">(limit {{ limit }} · scroll the table)</span>
        </span>
        @if (errorMessage()) {
          <span class="meta-item error">
            <strong>{{ errorMessage() }}</strong>
          </span>
        }
        <span class="meta-item right">
          Buffer
          <strong>{{ pageData()?.bufferSize ?? 0 | number }}</strong>
          /
          <span class="muted">{{ pageData()?.bufferCapacity ?? 0 | number }}</span>
          @if ((pageData()?.droppedCount ?? 0) > 0) {
            <span
              class="muted"
              title="The buffer is a fixed-size ring: once full, the oldest entry is dropped for each new one"
            >
              · {{ pageData()!.droppedCount | number }} entries evicted since startup (FIFO)
            </span>
          }
        </span>
      </section>

      <section class="logs-table-wrap">
        @if ((pageData()?.entries?.length ?? 0) === 0) {
          <div class="empty-state">
            @if (loading()) {
              <span class="muted">Loading…</span>
            } @else if (errorMessage()) {
              <app-error-state
                title="Could not load engine logs"
                [message]="errorMessage()"
                (retry)="fetchNow()"
              />
            } @else {
              <strong>No log entries match the current filters.</strong>
              <span class="empty-hint">
                Either the buffer is genuinely empty (engine just started) or the filters are too
                restrictive — try clearing the search field.
              </span>
            }
          </div>
        } @else {
          <table class="logs-table">
            <colgroup>
              <col class="w-time" />
              <col class="w-level" />
              <col class="w-cat" />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th
                  class="col-time"
                  title="Your browser's local time; hover a time for the UTC stamp"
                >
                  Time <span class="th-hint">local</span>
                </th>
                <th class="col-level">Level</th>
                <th class="col-cat" title="Logger class; hover a cell for the full namespace">
                  Category
                </th>
                <th>Message <span class="th-hint">click a row for the full entry</span></th>
              </tr>
            </thead>
            <tbody>
              <!-- Rows are keyed by the entry, not its index: with Live on, new entries arrive at
                   the top every 5 s, and an index-keyed expansion jumped to a different entry. -->
              @for (r of rows(); track r.key) {
                @let e = r.entry;
                <tr
                  class="log-row"
                  [attr.data-lvl]="e.level.toLowerCase()"
                  [class.has-exception]="!!e.exception"
                  [class.expanded]="expandedKey() === r.key"
                  [attr.aria-expanded]="expandedKey() === r.key"
                  (click)="toggleRow(r.key)"
                >
                  <td class="col-time mono" [title]="utcStamp(e.timestamp)">
                    @if (!isToday(e.timestamp)) {
                      <span class="day">{{ e.timestamp | date: 'd MMM' }}</span>
                    }
                    {{ e.timestamp | date: 'HH:mm:ss.SSS' }}
                  </td>
                  <td class="col-level">
                    <span class="lvl" [attr.data-lvl]="e.level.toLowerCase()" [title]="e.level">
                      {{ levelLabel(e.level) }}
                    </span>
                  </td>
                  <td class="col-cat mono" [title]="e.category">{{ categoryTail(e.category) }}</td>
                  <td class="col-msg">
                    <div class="msg-line">
                      <span class="msg-text" [title]="e.message">{{ firstLine(e.message) }}</span>
                      @if (isMultiline(e.message)) {
                        <span class="more" title="The message continues — click to expand">…</span>
                      }
                      @if (e.exception) {
                        <span
                          class="exc-pill"
                          title="This entry carries an exception — click to read it"
                        >
                          exception
                        </span>
                      }
                    </div>
                  </td>
                </tr>
                @if (expandedKey() === r.key) {
                  <tr class="exp-row">
                    <td colspan="4">
                      <pre class="exp-msg">{{ e.message }}</pre>
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
                          <dd class="mono">
                            {{ utcStamp(e.timestamp) }}
                            <span class="muted"
                              >· {{ e.timestamp | date: 'yyyy-MM-dd HH:mm:ss.SSS' }} local</span
                            >
                          </dd>
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
  /** Identity of the expanded entry — see entryKey(). */
  expandedKey = signal<string | null>(null);
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
        // Not while the tab is hidden: a backgrounded console kept pulling 200 entries every 5 s.
        if (document.visibilityState === 'hidden') return;
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

  toggleRow(key: string) {
    this.expandedKey.set(this.expandedKey() === key ? null : key);
  }

  /**
   * Entries with an identity that survives refreshes. The buffer has no id, so timestamp + event
   * id + category + message head stand in, and a repeat counter separates identical lines
   * logged in the same tick. (The position in the list is NOT part of it — that shifts by
   * however many entries arrived since the last fetch.)
   */
  readonly rows = computed<{ key: string; entry: EngineLogEntryDto }[]>(() => {
    const seen = new Map<string, number>();
    return (this.pageData()?.entries ?? []).map((entry) => {
      const base = `${entry.timestamp}|${entry.eventId}|${entry.category}|${entry.message.slice(0, 80)}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: n === 0 ? base : `${base}#${n}`, entry };
    });
  });

  // Pure formatters (log-format.ts), exposed to the template.
  protected readonly levelLabel = levelLabel;
  protected readonly categoryTail = categoryTail;
  protected readonly firstLine = firstLine;
  protected readonly isMultiline = isMultiline;
  protected readonly utcStamp = utcStamp;
  protected isToday(iso: string): boolean {
    return isSameLocalDay(iso);
  }
}
