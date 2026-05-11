import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { PositionsService } from '@core/services/positions.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { PositionLifecycleEventDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Fleet-wide position-delta feed (PRD-V2 FR-5.8 operator overview).
 *
 * Cross-position counterpart to the per-position timeline card on the
 * detail page: this surface answers "what's happening across positions
 * right now?". Most-leverage operator use cases:
 *
 *   - Spot a burst of StaleClose events (= EA dropping OnTradeTransaction
 *     events / restarting / losing broker connectivity)
 *   - See the open/close/modify rate across the fleet in a chosen window
 *   - Drill from a position id back to its detail-page timeline
 */
interface TypeBucket {
  eventType: string;
  count: number;
  share: number;
  recentAt: string;
}

@Component({
  selector: 'app-position-deltas-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Position deltas"
        subtitle="Fleet-wide position-lifecycle event stream"
      >
        <a routerLink="/positions" class="btn btn-secondary">← Positions</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      <section class="controls">
        <div class="control-group">
          <label for="window">Window (hours)</label>
          <input
            id="window"
            type="number"
            min="1"
            max="168"
            step="1"
            [ngModel]="windowHours()"
            (ngModelChange)="setWindow($event)"
          />
        </div>
        <div class="control-group">
          <label for="source">Source filter</label>
          <select id="source" [ngModel]="sourceFilter()" (ngModelChange)="sourceFilter.set($event)">
            <option value="">(all sources)</option>
            <option value="EA">EA (delta)</option>
            <option value="EASnapshot">EASnapshot</option>
            <option value="OrderFilled">OrderFilled</option>
            <option value="OrderFilledEventHandler">OrderFilledEventHandler</option>
            <option value="PositionWorker">PositionWorker (any reason)</option>
            <option value="Manual">Manual</option>
            <option value="ReceivePositionSnapshot">ReceivePositionSnapshot</option>
          </select>
        </div>
        <div class="control-group">
          <label for="eventType">Type filter</label>
          <select
            id="eventType"
            [ngModel]="eventTypeFilter()"
            (ngModelChange)="eventTypeFilter.set($event)"
          >
            <option value="">(all types)</option>
            <option value="Opened">Opened</option>
            <option value="Closed">Closed</option>
            <option value="Closing">Closing</option>
            <option value="PartialClose">PartialClose</option>
            <option value="Modified">Modified</option>
            <option value="Reconciled">Reconciled</option>
            <option value="StaleClose">StaleClose</option>
          </select>
        </div>
      </section>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load position deltas"
          message="Engine returned an error. The lifecycle audit table may be empty if the writer-side wiring hasn't shipped yet — check engine commits."
          (retry)="resource.refresh()"
        />
      } @else if (rows().length === 0) {
        <app-empty-state
          title="No position deltas in this window"
          message="Either no positions changed in the chosen window, or the lifecycle writer wiring hasn't propagated yet. Widen the window to look further back."
        />
      } @else {
        <div class="kpis">
          <app-metric-card label="Events" [value]="rows().length" />
          <app-metric-card label="Types" [value]="typeBuckets().length" />
          <app-metric-card label="StaleCloses" [value]="staleCloseCount()" />
          <app-metric-card label="Positions touched" [value]="distinctPositionCount()" />
        </div>

        <section class="card">
          <header class="card-head">
            <h3>By type</h3>
            <span class="muted small">aggregated over window</span>
          </header>
          <table class="deltas-table">
            <thead>
              <tr>
                <th>Type</th>
                <th class="num">Count</th>
                <th class="num">Share</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              @for (b of typeBuckets(); track b.eventType) {
                <tr>
                  <td>
                    <span class="badge" [attr.data-type]="eventBucket(b.eventType)">
                      {{ b.eventType }}
                    </span>
                  </td>
                  <td class="num">{{ b.count }}</td>
                  <td class="num">
                    <span class="bar-track">
                      <span class="bar-fill" [style.width.%]="b.share * 100"></span>
                    </span>
                    <span class="small muted">{{ b.share * 100 | number: '1.0-0' }}%</span>
                  </td>
                  <td class="time">{{ b.recentAt | relativeTime }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Recent events</h3>
            <span class="muted small">{{ rows().length }} shown</span>
          </header>
          <table class="deltas-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Type</th>
                <th>Source</th>
                <th class="num">Lots</th>
                <th>Description</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              @for (e of rows(); track e.id) {
                <tr>
                  <td>
                    <a
                      class="link mono"
                      [routerLink]="['/positions', e.positionId]"
                      [queryParams]="{}"
                    >
                      #{{ e.positionId }}
                    </a>
                  </td>
                  <td>
                    <span class="badge" [attr.data-type]="eventBucket(e.eventType)">
                      {{ e.eventType }}
                    </span>
                  </td>
                  <td class="small">{{ e.source }}</td>
                  <td class="num mono">
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
                  </td>
                  <td class="desc">{{ e.description }}</td>
                  <td class="time">{{ e.occurredAt | date: 'short' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>
  `,
  styles: [
    `
      .page {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .controls {
        display: flex;
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .control-group {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .control-group label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .control-group input,
      .control-group select {
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        min-width: 200px;
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
        overflow-x: auto;
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
      .deltas-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .deltas-table th,
      .deltas-table td {
        padding: 8px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .deltas-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .deltas-table td.num,
      .deltas-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-secondary);
      }
      .desc {
        color: var(--text-secondary);
        max-width: 420px;
        word-break: break-word;
      }
      .link {
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-semibold);
      }
      .link:hover {
        text-decoration: underline;
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .arrow {
        margin: 0 4px;
        color: var(--text-secondary);
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
      .bar-track {
        display: inline-block;
        width: 80px;
        height: 8px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        overflow: hidden;
        vertical-align: middle;
        margin-right: 8px;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: #ff9500;
        border-radius: var(--radius-full);
      }
    `,
  ],
})
export class PositionDeltasPageComponent {
  private readonly positions = inject(PositionsService);
  private readonly realtime = inject(RealtimeService);

  protected readonly windowHours = signal(24);
  protected readonly sourceFilter = signal('');
  protected readonly eventTypeFilter = signal('');

  // Push events arriving via SignalR — merged with polled rows in `rows()` and
  // deduped by id. Capped so a runaway stream can't grow this unboundedly.
  private readonly livePrepend = signal<PositionLifecycleEventDto[]>([]);
  private static readonly LIVE_PREPEND_MAX = 200;

  protected readonly resource = createPolledResource(
    () => {
      const since = new Date(Date.now() - this.windowHours() * 60 * 60 * 1000).toISOString();
      return this.positions
        .listLifecycleEvents({
          currentPage: 1,
          itemCountPerPage: 200,
          filter: {
            from: since,
            source: this.sourceFilter() || null,
            eventType: this.eventTypeFilter() || null,
          },
        })
        .pipe(
          map((res) => res.data?.data ?? []),
          catchError(() => of<PositionLifecycleEventDto[]>([])),
        );
    },
    { intervalMs: 30_000 },
  );

  constructor() {
    effect(() => {
      this.windowHours();
      this.sourceFilter();
      this.eventTypeFilter();
      // Filters changed — discard the live buffer too so the merged view
      // matches the polled refetch, otherwise stale-filtered push events
      // linger at the top until the cap rolls them off.
      this.livePrepend.set([]);
      this.resource.refresh();
    });

    // Live updates: prepend matching push events into the buffer; the rows()
    // computed merges with polled rows and dedupes by id.
    this.realtime
      .on<PositionLifecycleEventDto>('positionLifecycleEvent')
      .pipe(takeUntilDestroyed())
      .subscribe((evt) => {
        if (!this.matchesActiveFilters(evt)) return;
        this.livePrepend.update((buf) =>
          [evt, ...buf].slice(0, PositionDeltasPageComponent.LIVE_PREPEND_MAX),
        );
      });
  }

  protected readonly rows = computed(() => {
    const polled = this.resource.value() ?? [];
    const live = this.livePrepend();
    if (live.length === 0) return polled;
    const seen = new Set(polled.map((r) => r.id));
    // Live events arrive newest-first; merge unique ones at the front of
    // the polled list (which is the engine's sorted-by-OccurredAt-desc
    // result), so the table always shows newest-first.
    const merged: PositionLifecycleEventDto[] = [];
    for (const e of live) if (!seen.has(e.id)) merged.push(e);
    return [...merged, ...polled];
  });
  protected readonly loading = computed(() => this.resource.loading() && this.rows().length === 0);

  protected readonly distinctPositionCount = computed(
    () => new Set(this.rows().map((r) => r.positionId)).size,
  );
  protected readonly staleCloseCount = computed(
    () => this.rows().filter((r) => r.eventType === 'StaleClose').length,
  );

  protected readonly typeBuckets = computed<TypeBucket[]>(() => {
    const rows = this.rows();
    const total = rows.length;
    const map = new Map<string, { count: number; recentAt: string }>();
    for (const row of rows) {
      const existing = map.get(row.eventType);
      if (existing) {
        existing.count++;
        if (row.occurredAt > existing.recentAt) existing.recentAt = row.occurredAt;
      } else {
        map.set(row.eventType, { count: 1, recentAt: row.occurredAt });
      }
    }
    return Array.from(map.entries())
      .map(([eventType, v]) => ({
        eventType,
        count: v.count,
        share: total > 0 ? v.count / total : 0,
        recentAt: v.recentAt,
      }))
      .sort((a, b) => b.count - a.count);
  });

  protected setWindow(v: number | string): void {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1 && n <= 168) this.windowHours.set(n);
  }

  // Mirrors the per-position card's bucketer so colour coding is consistent
  // across both surfaces. Unknown EventType strings fall through to the
  // neutral default.
  eventBucket(type: string): 'open' | 'close' | 'modify' | 'reconcile' | 'other' {
    const t = (type ?? '').toLowerCase();
    if (t === 'opened') return 'open';
    if (t.includes('close')) return 'close';
    if (t === 'modified') return 'modify';
    if (t.includes('reconcile')) return 'reconcile';
    return 'other';
  }

  // Client-side mirror of the engine's filter logic so push events arriving
  // in the SignalR stream don't bypass the active selector state. Substring
  // match on source matches the engine's ILIKE semantics
  // (PositionWorker matches "PositionWorker:StopLoss" etc.).
  private matchesActiveFilters(evt: PositionLifecycleEventDto): boolean {
    const src = this.sourceFilter();
    if (src && !evt.source.toLowerCase().includes(src.toLowerCase())) return false;
    const type = this.eventTypeFilter();
    if (type && !evt.eventType.toLowerCase().includes(type.toLowerCase())) return false;
    // Window filter — drop events older than the active window. SignalR push
    // is real-time so this is rarely false, but stricter is safer.
    const cutoff = Date.now() - this.windowHours() * 60 * 60 * 1000;
    if (new Date(evt.occurredAt).getTime() < cutoff) return false;
    return true;
  }
}
