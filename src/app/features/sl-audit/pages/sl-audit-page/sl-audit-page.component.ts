import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

import { SlAuditService, type PagedEnvelope } from '@core/services/sl-audit.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { priceDecimals } from '@shared/components/analysis-recommendations/rec-preview-chart';
import { ApiError } from '@core/api/api.types';
import {
  ALL_SL_CHANGE_SOURCES,
  PositionSlChangeLog,
  SlAuditQuery,
  SlChangeSource,
} from '@features/sl-audit/sl-audit.types';

/**
 * Embeddable SL audit section.  Renders the paged audit feed plus
 * filter card; designed to drop into any page wrapper (currently lives
 * inside `/spread-reactive`).  Reads `POST /position/sl-history/list`
 * with operator-tunable filters and renders the resulting paged feed.
 *
 * Drill-in via `?positionId=N` query param: the component reads
 * `ActivatedRoute.queryParamMap`, so a link with the param pre-fills
 * the filter regardless of which parent page mounts it.  Multiple
 * filters can be combined (`?positionId=…&source=…` etc.).
 *
 * <p>No outer `.page` chrome or `<h1>` — the parent owns the page
 * frame so this fragment sits cleanly inside any other layout.</p>
 */
@Component({
  selector: 'app-sl-audit-page',
  standalone: true,
  imports: [DatePipe, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sl-audit">
      <header class="section-head">
        <div>
          <h2>SL Audit</h2>
          <p class="muted small">
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
                  <!-- Points (the symbol's last quoted digit), not raw price: "-0.00040" was too wide
                       for the card and clipped to "-0.00"; 10 points = 1 pip on 5/3-digit FX. -->
                  <th class="num" title="New SL − Old SL, in points">Δ pts</th>
                  <th class="num" title="New SL − Initial SL (signed), in points">Δ vs init</th>
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
                        {{ price(r.symbol, r.entryPrice) }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="num mono" [class.muted]="r.initialSl === null">
                      @if (r.initialSl !== null) {
                        {{ price(r.symbol, r.initialSl) }}
                      } @else {
                        —
                      }
                    </td>
                    <td>
                      <span [class]="'source-pill ' + sourceClass(r.source)">{{ r.source }}</span>
                    </td>
                    <td class="num mono">
                      @if (r.oldSl !== null) {
                        {{ price(r.symbol, r.oldSl) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="num mono">
                      @if (r.newSl !== null) {
                        {{ price(r.symbol, r.newSl) }}
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <!-- Δ is coloured by what the move MEANS for the position
                         (protection loosened = amber, tightened/restored =
                         green), not by its arithmetic sign — a bump that widens
                         a SHORT's SL is a negative number but still loosens it. -->
                    <td [class]="'num mono ' + deltaClass(r)" [title]="deltaTitle(r, r.oldSl)">
                      {{ deltaStr(r) }}
                    </td>
                    <td
                      [class]="'num mono ' + deltaVsInitClass(r)"
                      [class.muted]="r.initialSl === null || r.newSl === null"
                      [title]="deltaTitle(r, r.initialSl)"
                    >
                      {{ deltaVsInitStr(r) }}
                    </td>
                    <td class="num mono" [class.muted]="r.spread === null">
                      @if (r.spread !== null) {
                        {{ price(r.symbol, r.spread) }}
                      } @else {
                        —
                      }
                    </td>
                    <td class="mono small nowrap">{{ actorOf(r) }}</td>
                    <td class="small muted reason" [title]="r.reason ?? ''">
                      {{ r.reason ?? '—' }}
                    </td>
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
      .sl-audit {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .section-head h2 {
        margin: 0 0 4px;
        font-size: 1.15em;
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
        color: var(--text-primary);
        font: inherit;
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
      /* Every cell single-line: the timestamp was wrapping to three lines and
         long reasons inflated some rows to 185px while others stayed at 36px. */
      th,
      td {
        padding: 6px 10px;
        border-bottom: 1px solid var(--border, #eee);
        text-align: left;
        white-space: nowrap;
        vertical-align: middle;
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
      .nowrap {
        white-space: nowrap;
      }
      td.reason {
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .delta-tighten {
        color: var(--profit, #1d8a3e);
      }
      .delta-loosen {
        color: var(--warning, #c97700);
      }
      .delta-none {
        color: var(--text-tertiary, #888);
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

    // Per-symbol price precision. Best-effort: until (or unless) it lands, the JPY/5-digit rule.
    this.pairs
      .list({ currentPage: 1, itemCountPerPage: 500, filter: null })
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        const rows = res?.data?.data ?? [];
        const map = new Map<string, number>();
        for (const p of rows) {
          if (p.symbol && p.decimalPlaces > 0) map.set(p.symbol.toUpperCase(), p.decimalPlaces);
        }
        if (map.size > 0) this.decimalsBySymbol.set(map);
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
          // The engine serialises the pager in camelCase; PagedEnvelope (core)
          // declares PascalCase, so TotalItemCount was always undefined → 0
          // rows total, "page 1 of 1", and the pager buttons dead over a
          // 300k-row feed. Read either casing.
          const pager = (res.pager ?? {}) as unknown as Record<string, number | undefined>;
          this.rows.set(res.data ?? []);
          this.totalCount.set(pager['totalItemCount'] ?? pager['TotalItemCount'] ?? 0);
          this.currentPage.set(pager['currentPage'] ?? pager['CurrentPage'] ?? page);
          this.pageSize.set(
            pager['itemCountPerPage'] ?? pager['ItemCountPerPage'] ?? this.pageSize(),
          );
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
    return this.points(r.symbol, r.newSl - r.oldSl);
  }

  /** Quoted decimals per symbol, from the currency-pair catalogue (the JPY/5-digit rule until
   *  it loads, or for a symbol it does not list). Prices were all printed to 5 places. */
  private readonly decimalsBySymbol = signal<ReadonlyMap<string, number>>(new Map());
  private readonly pairs = inject(CurrencyPairsService);

  private decimals(symbol: string | null | undefined): number {
    const sym = (symbol ?? '').toUpperCase();
    return this.decimalsBySymbol().get(sym) ?? priceDecimals(sym);
  }

  protected price(symbol: string | null | undefined, v: number | null): string {
    return v === null ? '—' : v.toFixed(this.decimals(symbol));
  }

  /** A price difference as signed points of the symbol's last quoted digit ("−4 pt"). */
  private points(symbol: string | null | undefined, d: number): string {
    const pts = Math.round(d * 10 ** this.decimals(symbol));
    if (pts === 0) return '0';
    return `${pts > 0 ? '+' : '−'}${Math.abs(pts).toLocaleString()}`;
  }

  /** Hover text with the raw price move behind a points cell. */
  protected deltaTitle(r: PositionSlChangeLog, from: number | null): string {
    if (from === null || r.newSl === null) return '';
    const d = r.newSl - from;
    return `${d > 0 ? '+' : ''}${d.toFixed(this.decimals(r.symbol))} in price`;
  }

  protected deltaVsInit(r: PositionSlChangeLog): number {
    if (r.initialSl === null || r.newSl === null) return 0;
    return r.newSl - r.initialSl;
  }

  /**
   * Meaning-based colour for an SL move. For a Long, a higher SL is tighter
   * (more protection); for a Short the opposite. Tighter = green, looser =
   * amber, no-op (Δ 0.00000 — the SPREADREVERTDRIFT audit noise) = muted.
   */
  private moveClass(r: PositionSlChangeLog, d: number): string {
    if (d === 0) return 'delta-none';
    const tighter = r.direction === 'Short' ? d < 0 : d > 0;
    return tighter ? 'delta-tighten' : 'delta-loosen';
  }

  protected deltaClass(r: PositionSlChangeLog): string {
    if (r.oldSl === null || r.newSl === null) return 'delta-none';
    return this.moveClass(r, this.delta(r));
  }

  protected deltaVsInitClass(r: PositionSlChangeLog): string {
    if (r.initialSl === null || r.newSl === null) return 'delta-none';
    return this.moveClass(r, this.deltaVsInit(r));
  }

  protected deltaVsInitStr(r: PositionSlChangeLog): string {
    if (r.initialSl === null || r.newSl === null) return '—';
    return this.points(r.symbol, r.newSl - r.initialSl);
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
