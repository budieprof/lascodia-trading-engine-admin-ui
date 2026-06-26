import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { SlAuditService, type PagedEnvelope } from '@core/services/sl-audit.service';
import { ApiError } from '@core/api/api.types';
import {
  ALL_SL_CHANGE_SOURCES,
  PositionSlChangeLog,
  SlAuditQuery,
  SlChangeSource,
} from '@features/sl-audit/sl-audit.types';

/**
 * Fleet-wide SL audit page.  Reads <c>POST /position/sl-history/list</c>
 * with operator-tunable filters and renders the resulting paged feed.
 * The same endpoint backs the per-position drill-in modal — this page
 * just shows the firehose with no <c>positionId</c> filter set by default.
 */
@Component({
  selector: 'app-sl-audit-page',
  standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>SL Audit</h1>
          <p class="muted">
            Every stop-loss change across the fleet — manual edits, trailing-stop ratchets,
            spread-bumps + reverts, breakeven moves, LLM exits. Retention is configurable via
            <code>SlAudit:RetentionDays</code> (default 90 days).
          </p>
        </div>
      </header>

      <!-- Filter card -->
      <section class="card filters">
        <div class="filter-row">
          <label class="field">
            <span>Position id</span>
            <input
              type="number"
              [(ngModel)]="filterPositionId"
              placeholder="any"
              (keydown.enter)="search()"
            />
          </label>
          <label class="field">
            <span>Account id</span>
            <input
              type="number"
              [(ngModel)]="filterAccountId"
              placeholder="any"
              (keydown.enter)="search()"
            />
          </label>
          <label class="field">
            <span>Symbol</span>
            <input
              type="text"
              [(ngModel)]="filterSymbol"
              placeholder="any"
              maxlength="10"
              (keydown.enter)="search()"
            />
          </label>
          <label class="field">
            <span>Source</span>
            <select [(ngModel)]="filterSource">
              <option value="">any</option>
              @for (s of allSources; track s) {
                <option [value]="s">{{ s }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span>From (UTC)</span>
            <input type="datetime-local" [(ngModel)]="filterFrom" (keydown.enter)="search()" />
          </label>
          <label class="field">
            <span>To (UTC)</span>
            <input type="datetime-local" [(ngModel)]="filterTo" (keydown.enter)="search()" />
          </label>
        </div>
        <div class="filter-actions">
          <button type="button" class="btn primary" [disabled]="loading()" (click)="search()">
            {{ loading() ? 'Loading…' : 'Search' }}
          </button>
          <button type="button" class="btn ghost" [disabled]="loading()" (click)="reset()">
            Reset
          </button>
          @if (totalCount() > 0) {
            <span class="muted small"
              >{{ totalCount() }} row{{ totalCount() === 1 ? '' : 's' }}, page
              {{ currentPage() }} of {{ totalPages() }}</span
            >
          }
        </div>
      </section>

      @if (error(); as e) {
        <div class="banner error">{{ e }}</div>
      }

      <!-- Results -->
      <section class="card">
        @if (rows().length === 0 && !loading()) {
          <p class="muted small">No SL changes match these filters.</p>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Position</th>
                  <th class="num" title="Position's weighted-average entry price at change time">
                    Entry
                  </th>
                  <th class="num" title="SL the position opened with (constant per position)">
                    Initial SL
                  </th>
                  <th>Source</th>
                  <th class="num">Old SL</th>
                  <th class="num">New SL</th>
                  <th class="num" title="New SL − Old SL">Δ</th>
                  <th class="num" title="New SL − Initial SL (signed)">Δ vs init</th>
                  <th class="num">Spread</th>
                  <th>Actor</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.id) {
                  <tr [class]="'row-' + sourceClass(r.source)">
                    <td class="mono small">
                      {{ r.createdAt | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC' }}
                    </td>
                    <td class="mono small">{{ r.tradingAccountId }}</td>
                    <td class="mono">{{ r.symbol }}</td>
                    <td>
                      <span class="side-pill" [attr.data-side]="r.direction">{{
                        r.direction
                      }}</span>
                    </td>
                    <td
                      class="mono small"
                      [title]="
                        r.openedAt
                          ? 'opened ' + (r.openedAt | date: 'yyyy-MM-dd HH:mm' : 'UTC') + ' UTC'
                          : 'open time unknown'
                      "
                    >
                      {{ r.positionId }}
                    </td>
                    <td class="num mono" [class.muted]="r.entryPrice === null">
                      @if (r.entryPrice !== null) {
                        {{ r.entryPrice | number: '1.5-5' }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="num mono" [class.muted]="r.initialSl === null">
                      @if (r.initialSl !== null) {
                        {{ r.initialSl | number: '1.5-5' }}
                      } @else {
                        —
                      }
                    </td>
                    <td>
                      <span [class]="'source-pill ' + sourceClass(r.source)">{{ r.source }}</span>
                    </td>
                    <td class="num mono">
                      @if (r.oldSl !== null) {
                        {{ r.oldSl | number: '1.5-5' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (r.newSl !== null) {
                        {{ r.newSl | number: '1.5-5' }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td
                      class="num mono"
                      [class.delta-pos]="delta(r) > 0"
                      [class.delta-neg]="delta(r) < 0"
                    >
                      {{ deltaStr(r) }}
                    </td>
                    <td
                      class="num mono"
                      [class.delta-pos]="deltaVsInit(r) > 0"
                      [class.delta-neg]="deltaVsInit(r) < 0"
                      [class.muted]="r.initialSl === null || r.newSl === null"
                    >
                      {{ deltaVsInitStr(r) }}
                    </td>
                    <td class="num mono" [class.muted]="r.spread === null">
                      @if (r.spread !== null) {
                        {{ r.spread | number: '1.5-5' }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="mono small">{{ actorOf(r) }}</td>
                    <td class="small muted">{{ r.reason ?? '—' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (totalPages() > 1) {
          <div class="pagination">
            <button
              type="button"
              class="btn ghost"
              [disabled]="currentPage() <= 1 || loading()"
              (click)="goToPage(currentPage() - 1)"
            >
              ‹ Prev
            </button>
            <span class="muted small">Page {{ currentPage() }} of {{ totalPages() }}</span>
            <button
              type="button"
              class="btn ghost"
              [disabled]="currentPage() >= totalPages() || loading()"
              (click)="goToPage(currentPage() + 1)"
            >
              Next ›
            </button>
          </div>
        }
      </section>
    </div>
  `,
  styles: [
    `
      .page {
        max-width: 1480px;
        margin: 0 auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .page-head h1 {
        margin: 0 0 4px;
      }
      .muted {
        color: var(--text-secondary, #888);
      }
      .small {
        font-size: 0.85em;
      }
      .card {
        background: var(--bg-secondary, #fff);
        border: 1px solid var(--border, #e3e3e3);
        border-radius: 8px;
        padding: 14px 16px;
      }
      .filter-row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 10px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field > span {
        font-size: 0.85em;
        font-weight: 600;
        color: var(--text-secondary, #555);
      }
      .field input,
      .field select {
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid var(--border, #ccc);
        background: var(--bg-primary, #fff);
      }
      .filter-actions {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 10px;
      }
      .btn {
        padding: 7px 14px;
        border-radius: 6px;
        border: 1px solid var(--border, #ccc);
        background: var(--bg-primary, #fff);
        cursor: pointer;
      }
      .btn.primary {
        background: var(--primary, #2070d6);
        color: #fff;
        border-color: var(--primary, #2070d6);
      }
      .btn.ghost {
        background: transparent;
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .banner.error {
        padding: 10px 14px;
        border-radius: 6px;
        background: var(--error-bg, #fde2e1);
        color: var(--error, #a32928);
      }
      .table-wrap {
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 6px 10px;
        border-bottom: 1px solid var(--border, #eee);
        text-align: left;
      }
      th {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #555);
      }
      .num {
        text-align: right;
      }
      .mono {
        font-family: var(--font-mono, ui-monospace, monospace);
      }
      .delta-pos {
        color: #1d8a3e;
      }
      .delta-neg {
        color: #c93631;
      }
      .source-pill {
        padding: 2px 8px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }
      .source-pill.manual {
        background: color-mix(in srgb, #2070d6 18%, transparent);
        color: #1457a8;
      }
      .source-pill.trail {
        background: color-mix(in srgb, #1d8a3e 18%, transparent);
        color: #1d8a3e;
      }
      .source-pill.spread {
        background: color-mix(in srgb, #ff9f0a 22%, transparent);
        color: #c97700;
      }
      .source-pill.drift {
        background: color-mix(in srgb, #ff453a 18%, transparent);
        color: #c93631;
      }
      .source-pill.system {
        background: color-mix(in srgb, #9aa0a6 22%, transparent);
        color: #555e66;
      }
      .side-pill {
        padding: 2px 8px;
        border-radius: 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.4px;
      }
      .side-pill[data-side='Long'] {
        background: color-mix(in srgb, #1d8a3e 18%, transparent);
        color: #1d8a3e;
      }
      .side-pill[data-side='Short'] {
        background: color-mix(in srgb, #ff453a 18%, transparent);
        color: #c93631;
      }
      .row-spread {
        background: color-mix(in srgb, #ff9f0a 6%, transparent);
      }
      .row-drift {
        background: color-mix(in srgb, #ff453a 6%, transparent);
      }
      .pagination {
        display: flex;
        gap: 10px;
        align-items: center;
        justify-content: center;
        margin-top: 12px;
      }
    `,
  ],
})
export class SlAuditPageComponent {
  private readonly service = inject(SlAuditService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly allSources = ALL_SL_CHANGE_SOURCES;

  // Filter inputs — ngModel-bound directly.
  protected filterPositionId: number | null = null;
  protected filterAccountId: number | null = null;
  protected filterSymbol = '';
  protected filterSource: SlChangeSource | '' = '';
  protected filterFrom = '';
  protected filterTo = '';

  protected readonly rows = signal<PositionSlChangeLog[]>([]);
  protected readonly totalCount = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly pageSize = signal(50);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalCount() / this.pageSize())),
  );

  constructor() {
    // Pre-fill filters from query params so drill-in links from the EA
    // Positions panel land on a pre-filtered view.  Subsequent URL
    // changes re-run the search — useful when the operator hops from
    // one position's drill-in to another.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const positionId = params.get('positionId');
      const accountId = params.get('accountId');
      const symbol = params.get('symbol');
      const source = params.get('source');
      this.filterPositionId = positionId ? Number(positionId) : null;
      this.filterAccountId = accountId ? Number(accountId) : null;
      this.filterSymbol = symbol ?? '';
      this.filterSource = (source as SlChangeSource) ?? '';
      this.search(1);
    });
  }

  protected search(page: number = 1): void {
    this.loading.set(true);
    this.error.set(null);

    const query: SlAuditQuery = {
      positionId: this.filterPositionId ?? undefined,
      tradingAccountId: this.filterAccountId ?? undefined,
      symbol: this.filterSymbol.trim() ? this.filterSymbol.trim() : undefined,
      source: this.filterSource || undefined,
      from: this.filterFrom ? new Date(this.filterFrom).toISOString() : undefined,
      to: this.filterTo ? new Date(this.filterTo).toISOString() : undefined,
      pageNumber: page,
      pageSize: this.pageSize(),
    };

    this.service
      .list(query)
      .pipe(
        catchError((e) => {
          this.error.set(this.toMessage(e));
          this.loading.set(false);
          return of<PagedEnvelope<PositionSlChangeLog> | null>(null);
        }),
      )
      .subscribe((res) => {
        if (res) {
          this.rows.set(res.data ?? []);
          this.totalCount.set(res.pager?.TotalItemCount ?? 0);
          this.currentPage.set(res.pager?.CurrentPage ?? page);
          this.pageSize.set(res.pager?.ItemCountPerPage ?? this.pageSize());
        }
        this.loading.set(false);
      });
  }

  protected goToPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.search(page);
  }

  protected reset(): void {
    this.filterPositionId = null;
    this.filterAccountId = null;
    this.filterSymbol = '';
    this.filterSource = '';
    this.filterFrom = '';
    this.filterTo = '';
    this.search(1);
  }

  protected delta(r: PositionSlChangeLog): number {
    if (r.oldSl === null || r.newSl === null) return 0;
    return r.newSl - r.oldSl;
  }

  protected deltaStr(r: PositionSlChangeLog): string {
    if (r.oldSl === null || r.newSl === null) return '—';
    const d = r.newSl - r.oldSl;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(5)}`;
  }

  protected deltaVsInit(r: PositionSlChangeLog): number {
    if (r.initialSl === null || r.newSl === null) return 0;
    return r.newSl - r.initialSl;
  }

  protected deltaVsInitStr(r: PositionSlChangeLog): string {
    if (r.initialSl === null || r.newSl === null) return '—';
    const d = r.newSl - r.initialSl;
    const sign = d > 0 ? '+' : '';
    return `${sign}${d.toFixed(5)}`;
  }

  protected actorOf(r: PositionSlChangeLog): string {
    if (r.changedByUserId !== null && r.changedByUserId !== undefined) {
      return `user ${r.changedByUserId}`;
    }
    return r.changedByWorker ?? 'system';
  }

  protected sourceClass(s: SlChangeSource): string {
    switch (s) {
      case 'Manual':
        return 'manual';
      case 'TrailingStop':
      case 'BreakevenMove':
        return 'trail';
      case 'SpreadBump':
      case 'SpreadRevert':
        return 'spread';
      case 'SpreadRevertDrift':
        return 'drift';
      default:
        return 'system';
    }
  }

  private toMessage(e: unknown): string {
    if (e instanceof ApiError) return `${e.message} (code ${e.code})`;
    if (e instanceof HttpErrorResponse) {
      const url = e.url ? new URL(e.url).pathname : '(unknown URL)';
      return `HTTP ${e.status} ${e.statusText || ''} on ${url}`.trim();
    }
    if (e instanceof Error) return e.message;
    return 'Request failed (unknown error type)';
  }
}
