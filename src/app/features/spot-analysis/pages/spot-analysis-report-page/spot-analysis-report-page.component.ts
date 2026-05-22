import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { SpotAnalysisService } from '@core/services/spot-analysis.service';
import { SpotAnalysisListItemDto, SpotAnalysisSummaryDto } from '@core/api/api.types';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';

/** Rolling-window options for the report. */
const WINDOWS: { label: string; hours: number }[] = [
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
  { label: 'All', hours: 0 },
];

/** Page-size options for the table. */
const PAGE_SIZES = [25, 50, 100];

const EMPTY_SUMMARY: SpotAnalysisSummaryDto = {
  analyses: 0,
  totalCostUsd: 0,
  avgLatencyMs: 0,
  signalsCreated: 0,
  positionsOpened: 0,
  realizedPnl: 0,
  unrealizedPnl: 0,
  totalPnl: 0,
};

/**
 * Spot Analysis Report — server-paginated ledger of every `market_analysis.spot`
 * run with the trade outcomes attributed to it. KPIs come from the server-side
 * window-wide summary so they stay stable across pages; the table renders one
 * page at a time and the operator pages through with the controls below it.
 */
@Component({
  selector: 'app-spot-analysis-report-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    MetricCardComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Spot Analysis Report"
        subtitle="Every LLM spot analysis with its recommendations, generated signals, and attributed trade P&L"
      >
        <div class="header-controls">
          <div class="chip-group" role="tablist" aria-label="Time window">
            @for (w of windows; track w.hours) {
              <button
                type="button"
                class="chip"
                [class.active]="windowHours() === w.hours"
                (click)="setWindow(w.hours)"
              >
                {{ w.label }}
              </button>
            }
          </div>
          <input
            type="search"
            class="input"
            placeholder="Symbol filter…"
            [ngModel]="symbolFilter()"
            (ngModelChange)="onSymbolFilter($event)"
          />
          <button class="btn" type="button" (click)="load()" [disabled]="loading()">
            {{ loading() ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </app-page-header>

      <!-- KPI strip — driven by the server's window-wide summary -->
      <div class="kpi-grid">
        <app-metric-card
          label="Analyses"
          [value]="summary().analyses"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="LLM spend"
          [value]="summary().totalCostUsd"
          format="currency"
          dotColor="#FF9500"
        />
        <app-metric-card
          label="Avg latency (s)"
          [value]="summary().avgLatencyMs / 1000"
          format="number"
          dotColor="#8E8E93"
        />
        <app-metric-card
          label="Signals created"
          [value]="summary().signalsCreated"
          format="number"
          dotColor="#34C759"
        />
        <app-metric-card
          label="Positions opened"
          [value]="summary().positionsOpened"
          format="number"
          dotColor="#5856D6"
        />
        <app-metric-card
          label="Realized P&L"
          [value]="summary().realizedPnl"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Unrealized P&L"
          [value]="summary().unrealizedPnl"
          format="currency"
          [colorByValue]="true"
        />
        <app-metric-card
          label="Total P&L"
          [value]="summary().totalPnl"
          format="currency"
          [colorByValue]="true"
        />
      </div>

      @if (error(); as e) {
        <div class="error-banner">{{ e }}</div>
      }

      <!-- Dense ledger — current page only; the controls below page through -->
      <div class="table-wrap">
        <table class="dense">
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>TF</th>
              <th>Bar</th>
              <th>Model</th>
              <th class="num">Latency</th>
              <th class="num">Cost</th>
              <th class="num">Tokens</th>
              <th>Outcome</th>
              <th class="num">Recs</th>
              <th class="num">Signals</th>
              <th class="num">Positions</th>
              <th class="num">Realized</th>
              <th class="num">Unrealized</th>
              <th class="num">Total P&L</th>
              <th class="num">Exits</th>
            </tr>
          </thead>
          <tbody>
            @for (r of items(); track r.id) {
              <tr (click)="selectedDetail.set(r)" class="row">
                <td class="mono">{{ r.invokedAt | date: 'MMM d, HH:mm' }}</td>
                <td class="strong">{{ r.symbol }}</td>
                <td>{{ r.timeframe }}</td>
                <td class="muted">{{ r.barPosition }}</td>
                <td class="muted ellipsis">{{ r.model }}</td>
                <td class="num mono">{{ r.latencyMs / 1000 | number: '1.0-1' }}s</td>
                <td class="num mono">{{ r.costUsd | currency: 'USD' : 'symbol' : '1.4-4' }}</td>
                <td class="num mono muted">{{ r.tokensInput }}/{{ r.tokensOutput }}</td>
                <td>
                  <span class="chip-outcome" [class.bad]="r.outcome !== 'Ok'">{{ r.outcome }}</span>
                </td>
                <td class="num mono">{{ r.recommendationCount }}</td>
                <td class="num mono">
                  {{ r.signalsCreated }}
                  @if (r.signalsRejected > 0) {
                    <span class="sub loss">({{ r.signalsRejected }} rej)</span>
                  }
                </td>
                <td class="num mono">
                  {{ r.positionsOpened }}
                  @if (r.positionsClosed > 0) {
                    <span class="sub muted">({{ r.positionsClosed }} closed)</span>
                  }
                </td>
                <td
                  class="num mono"
                  [class.profit]="r.realizedPnl > 0"
                  [class.loss]="r.realizedPnl < 0"
                >
                  {{ r.realizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td
                  class="num mono"
                  [class.profit]="r.unrealizedPnl > 0"
                  [class.loss]="r.unrealizedPnl < 0"
                >
                  {{ r.unrealizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td
                  class="num mono strong"
                  [class.profit]="r.totalPnl > 0"
                  [class.loss]="r.totalPnl < 0"
                >
                  {{ r.totalPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </td>
                <td class="num mono muted">
                  {{ r.exitInstructionsExecuted }}/{{ r.exitInstructionCount }}
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="16" class="empty">
                  {{ loading() ? 'Loading…' : 'No spot analyses in this window.' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Server-side pagination controls -->
      <div class="pager">
        <div class="pager-info muted">{{ rangeLabel() }} of {{ totalItems() }} analyses</div>
        <div class="pager-controls">
          <label class="size-label muted">Page size</label>
          <select
            class="size-select"
            [ngModel]="pageSize()"
            (ngModelChange)="setPageSize($any($event))"
          >
            @for (s of pageSizes; track s) {
              <option [ngValue]="s">{{ s }}</option>
            }
          </select>

          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(1)"
            [disabled]="currentPage() === 1 || loading()"
          >
            «
          </button>
          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(currentPage() - 1)"
            [disabled]="currentPage() === 1 || loading()"
          >
            ‹ Prev
          </button>
          <span class="pager-page">Page {{ currentPage() }} of {{ totalPages() }}</span>
          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(currentPage() + 1)"
            [disabled]="currentPage() >= totalPages() || loading()"
          >
            Next ›
          </button>
          <button
            class="btn page-btn"
            type="button"
            (click)="goTo(totalPages())"
            [disabled]="currentPage() >= totalPages() || loading()"
          >
            »
          </button>
        </div>
      </div>
    </div>

    <!-- Detail drawer -->
    @if (selectedDetail(); as d) {
      <div class="drawer-backdrop" (click)="selectedDetail.set(null)">
        <aside class="drawer" (click)="$event.stopPropagation()" aria-label="Analysis detail">
          <header class="drawer-head">
            <div>
              <h3>{{ d.symbol }} · {{ d.timeframe }}</h3>
              <span class="muted">
                {{ d.invokedAt | date: 'MMM d, y HH:mm:ss' }} · audit #{{ d.id }}
              </span>
            </div>
            <button class="btn-close" (click)="selectedDetail.set(null)" aria-label="Close">
              ×
            </button>
          </header>

          <section class="drawer-section">
            <h4>Analysis</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Bar position</dt>
                <dd>{{ d.barPosition }}</dd>
              </div>
              <div>
                <dt>Provider / model</dt>
                <dd class="mono">{{ d.provider }} / {{ d.model }}</dd>
              </div>
              <div>
                <dt>Latency</dt>
                <dd class="mono">{{ d.latencyMs | number }} ms</dd>
              </div>
              <div>
                <dt>Outcome</dt>
                <dd>{{ d.outcome }}</dd>
              </div>
              <div>
                <dt>Tokens in / out</dt>
                <dd class="mono">{{ d.tokensInput }} / {{ d.tokensOutput }}</dd>
              </div>
              <div>
                <dt>LLM cost</dt>
                <dd class="mono">{{ d.costUsd | currency: 'USD' : 'symbol' : '1.4-4' }}</dd>
              </div>
            </dl>
          </section>

          <section class="drawer-section">
            <h4>Recommendations & signals</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Recommendations emitted</dt>
                <dd class="mono">{{ d.recommendationCount }}</dd>
              </div>
              <div>
                <dt>Signals created</dt>
                <dd class="mono">{{ d.signalsCreated }}</dd>
              </div>
              <div>
                <dt>Approved</dt>
                <dd class="mono">{{ d.signalsApproved }}</dd>
              </div>
              <div>
                <dt>Rejected</dt>
                <dd class="mono">{{ d.signalsRejected }}</dd>
              </div>
            </dl>
          </section>

          <section class="drawer-section">
            <h4>Trade outcomes</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Positions opened</dt>
                <dd class="mono">{{ d.positionsOpened }}</dd>
              </div>
              <div>
                <dt>Positions closed</dt>
                <dd class="mono">{{ d.positionsClosed }}</dd>
              </div>
              <div>
                <dt>Realized P&L</dt>
                <dd
                  class="mono"
                  [class.profit]="d.realizedPnl > 0"
                  [class.loss]="d.realizedPnl < 0"
                >
                  {{ d.realizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </dd>
              </div>
              <div>
                <dt>Unrealized P&L</dt>
                <dd
                  class="mono"
                  [class.profit]="d.unrealizedPnl > 0"
                  [class.loss]="d.unrealizedPnl < 0"
                >
                  {{ d.unrealizedPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </dd>
              </div>
              <div>
                <dt>Total P&L</dt>
                <dd
                  class="mono strong"
                  [class.profit]="d.totalPnl > 0"
                  [class.loss]="d.totalPnl < 0"
                >
                  {{ d.totalPnl | currency: 'USD' : 'symbol' : '1.2-2' }}
                </dd>
              </div>
            </dl>
          </section>

          <section class="drawer-section">
            <h4>LLM position management</h4>
            <dl class="drawer-grid">
              <div>
                <dt>Exit instructions emitted</dt>
                <dd class="mono">{{ d.exitInstructionCount }}</dd>
              </div>
              <div>
                <dt>Executed</dt>
                <dd class="mono">{{ d.exitInstructionsExecuted }}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    }
  `,
  styles: [
    `
      .page {
        padding: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .header-controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .chip-group {
        display: inline-flex;
        gap: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        padding: 2px;
      }
      .chip {
        border: 0;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .chip.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .input,
      .size-select {
        padding: 5px 10px;
        font-size: var(--text-xs);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .btn {
        padding: 5px 12px;
        font-size: var(--text-xs);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        cursor: pointer;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: var(--space-3);
      }
      .error-banner {
        padding: var(--space-3);
        border: 1px solid #ff3b30;
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: #ff3b30;
        font-size: var(--text-sm);
      }
      .table-wrap {
        overflow-x: auto;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      table.dense {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      table.dense thead th {
        position: sticky;
        top: 0;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        text-align: left;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
        padding: 6px 10px;
        white-space: nowrap;
        border-bottom: 1px solid var(--border);
      }
      table.dense th.num,
      table.dense td.num {
        text-align: right;
      }
      table.dense td {
        padding: 5px 10px;
        border-bottom: 1px solid var(--border);
        color: var(--text-primary);
        white-space: nowrap;
      }
      tr.row {
        cursor: pointer;
      }
      tr.row:hover td {
        background: var(--bg-tertiary);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-variant-numeric: tabular-nums;
      }
      .strong {
        font-weight: var(--font-semibold);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .ellipsis {
        max-width: 130px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .profit {
        color: var(--profit, #16a34a);
      }
      .loss {
        color: var(--loss, #dc2626);
      }
      .sub {
        font-size: 10px;
        margin-left: 3px;
      }
      .chip-outcome {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: var(--radius-sm);
        background: rgba(52, 199, 89, 0.14);
        color: #16a34a;
      }
      .chip-outcome.bad {
        background: rgba(255, 59, 48, 0.14);
        color: #dc2626;
      }
      .empty {
        text-align: center;
        padding: var(--space-5);
        color: var(--text-tertiary);
      }
      .pager {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-3);
      }
      .pager-info {
        font-size: var(--text-xs);
      }
      .pager-controls {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .size-label {
        font-size: var(--text-xs);
      }
      .pager-page {
        font-size: var(--text-xs);
        font-variant-numeric: tabular-nums;
        min-width: 100px;
        text-align: center;
      }
      /* Drawer */
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        justify-content: flex-end;
        z-index: 1000;
      }
      .drawer {
        width: 420px;
        max-width: 90vw;
        height: 100%;
        background: var(--bg-primary);
        border-left: 1px solid var(--border);
        overflow-y: auto;
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .drawer-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      .drawer-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .drawer-head .muted {
        font-size: var(--text-xs);
      }
      .btn-close {
        border: 0;
        background: transparent;
        font-size: 22px;
        line-height: 1;
        color: var(--text-tertiary);
        cursor: pointer;
      }
      .drawer-section h4 {
        margin: 0 0 var(--space-2);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
      }
      .drawer-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-2) var(--space-3);
        margin: 0;
      }
      .drawer-grid dt {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .drawer-grid dd {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
    `,
  ],
})
export class SpotAnalysisReportPageComponent implements OnInit {
  private readonly service = inject(SpotAnalysisService);

  readonly windows = WINDOWS;
  readonly pageSizes = PAGE_SIZES;

  // ── Filter state ─────────────────────────────────────────────────────
  readonly windowHours = signal(168); // 7d default
  readonly symbolFilter = signal('');

  // ── Server-side paging state ─────────────────────────────────────────
  readonly currentPage = signal(1);
  readonly pageSize = signal(25);
  readonly totalItems = signal(0);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.totalItems() / Math.max(1, this.pageSize()))),
  );

  // ── Server response ──────────────────────────────────────────────────
  readonly items = signal<SpotAnalysisListItemDto[]>([]);
  readonly summary = signal<SpotAnalysisSummaryDto>(EMPTY_SUMMARY);

  // ── UI state ─────────────────────────────────────────────────────────
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly selectedDetail = signal<SpotAnalysisListItemDto | null>(null);

  /** "Showing N–M" label for the pager. */
  readonly rangeLabel = computed(() => {
    const n = this.items().length;
    if (n === 0) return 'Showing 0';
    const start = (this.currentPage() - 1) * this.pageSize() + 1;
    const end = start + n - 1;
    return `Showing ${start}–${end}`;
  });

  // Debounce timer for symbol-filter typing so we don't refetch on every keystroke.
  private symbolDebounce: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.load();
  }

  setWindow(hours: number): void {
    if (this.windowHours() === hours) return;
    this.windowHours.set(hours);
    this.currentPage.set(1);
    this.load();
  }

  onSymbolFilter(value: string): void {
    this.symbolFilter.set(value);
    if (this.symbolDebounce !== null) clearTimeout(this.symbolDebounce);
    // Re-fetch on settle. Reset to page 1 — the filter narrows the result set.
    this.symbolDebounce = setTimeout(() => {
      this.currentPage.set(1);
      this.load();
    }, 350);
  }

  setPageSize(size: number): void {
    if (this.pageSize() === size) return;
    this.pageSize.set(size);
    this.currentPage.set(1);
    this.load();
  }

  goTo(page: number): void {
    const target = Math.max(1, Math.min(page, this.totalPages()));
    if (target === this.currentPage()) return;
    this.currentPage.set(target);
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);

    const hours = this.windowHours();
    const filter: Record<string, unknown> = {};
    if (hours > 0) {
      filter['from'] = new Date(Date.now() - hours * 3_600_000).toISOString();
    }
    const sym = this.symbolFilter().trim();
    if (sym.length > 0) filter['symbol'] = sym.toUpperCase();

    this.service
      .list({
        currentPage: this.currentPage(),
        itemCountPerPage: this.pageSize(),
        filter,
      })
      .pipe(
        catchError((err) => {
          this.error.set(err?.error?.message ?? err?.message ?? 'Failed to load spot analyses.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.loading.set(false);
        if (res?.status && res.data) {
          this.items.set(res.data.items ?? []);
          this.summary.set(res.data.summary ?? EMPTY_SUMMARY);
          this.totalItems.set(res.data.totalItems ?? 0);
        } else if (res && !res.status) {
          this.error.set(res.message ?? 'Failed to load spot analyses.');
          this.items.set([]);
          this.summary.set(EMPTY_SUMMARY);
          this.totalItems.set(0);
        }
      });
  }
}
