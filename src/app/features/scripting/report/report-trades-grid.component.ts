import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GetRowIdParams,
  type RowClassRules,
  type RowClickedEvent,
} from 'ag-grid-community';

import type { ReportTrade } from './strategy-report.model';
import { inferPriceDecimals } from './report-format';
import {
  TRADE_FILTERS,
  buildTradeColumns,
  filterTrades,
  tradeFilterCounts,
  type TradeFilter,
} from './report-trades-columns';

ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * The List of trades: every closed trade (oldest first) then the open ones, with entry / exit
 * signals, times and prices, quantity, profit, cumulative profit, run-up (MFE), drawdown (MAE),
 * bars held and commission. Client-side sort, per-column filters, a quick search and side /
 * outcome pills; open trades are flagged and tinted.
 */
@Component({
  selector: 'app-report-trades-grid',
  standalone: true,
  imports: [AgGridAngular],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toolbar">
      <div class="pills" role="group" aria-label="Show trades">
        @for (f of filters; track f.id) {
          <button
            type="button"
            class="pill"
            [class.active]="filter() === f.id"
            [attr.aria-pressed]="filter() === f.id"
            [disabled]="counts()[f.id] === 0 && f.id !== 'all'"
            (click)="filter.set(f.id)"
          >
            {{ f.label }} <span class="count">{{ counts()[f.id] }}</span>
          </button>
        }
      </div>
      <label class="search">
        <span class="sr-only">Search trades</span>
        <input
          type="search"
          placeholder="Search signals, ids…"
          autocomplete="off"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
      </label>
    </div>

    @if (trades().length === 0) {
      <p class="empty" role="status">The strategy placed no trades in this range.</p>
    } @else {
      <ag-grid-angular
        class="ag-theme-alpine"
        [theme]="'legacy'"
        [rowData]="rows()"
        [columnDefs]="columnDefs()"
        [defaultColDef]="defaultColDef"
        [domLayout]="'autoHeight'"
        [rowHeight]="52"
        [pagination]="true"
        [paginationPageSize]="50"
        [paginationPageSizeSelector]="[25, 50, 100, 200]"
        [quickFilterText]="search()"
        [rowClassRules]="rowClassRules"
        [getRowId]="getRowId"
        [suppressMovableColumns]="true"
        [enableCellTextSelection]="true"
        [ensureDomOrder]="true"
        [tooltipShowDelay]="300"
        [class.clickable]="clickable()"
        (rowClicked)="onRowClicked($event)"
        style="width: 100%"
      />
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .pills {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
      }
      .pill {
        height: 30px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font: inherit;
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .pill:hover:not(:disabled) {
        color: var(--text-primary);
        background: var(--bg-tertiary);
      }
      .pill.active {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .pill:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .pill:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .count {
        font-variant-numeric: tabular-nums;
        opacity: 0.8;
      }
      .search input {
        height: 32px;
        width: min(260px, 100%);
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .empty {
        margin: 0;
        padding: var(--space-5);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      /* enableCellTextSelection wraps each value in a .ag-cell-wrapper that shrinks to its
         content, so the cell's text-align cannot move it: stretch the wrapper across the cell
         and push the value to its end for right-aligned (numeric) columns. */
      :host ::ng-deep .ag-right-aligned-cell .ag-cell-wrapper {
        flex: 1 1 auto;
        width: 100%;
        justify-content: flex-end;
      }
      .clickable ::ng-deep .ag-row {
        cursor: pointer;
      }
      :host ::ng-deep .rpt-gain {
        color: var(--profit);
      }
      :host ::ng-deep .rpt-loss {
        color: var(--loss);
      }
      :host ::ng-deep .ag-row.rpt-open-trade {
        background: rgba(0, 113, 227, 0.06);
      }
      :host ::ng-deep .rpt-two-line {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-end;
        line-height: 1.3;
      }
      :host ::ng-deep .rpt-two-line .sub {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      :host ::ng-deep .rpt-dir {
        display: inline-block;
        padding: 1px 8px;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
      }
      :host ::ng-deep .rpt-dir-long {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      :host ::ng-deep .rpt-dir-short {
        background: rgba(255, 149, 0, 0.16);
        color: #b25000;
      }
      :host ::ng-deep .rpt-open-badge {
        display: inline-block;
        margin-left: 4px;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-semibold);
        border: 1px solid currentColor;
        color: var(--text-secondary);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class ReportTradesGridComponent {
  readonly trades = input.required<readonly ReportTrade[]>();
  readonly currency = input('');
  /** True when a parent handles {@link tradeClick} — rows then show as clickable. */
  readonly clickable = input(false);
  /** A row was clicked (not a text selection) — the parent opens that trade on a chart. */
  readonly tradeClick = output<ReportTrade>();

  onRowClicked(event: RowClickedEvent<ReportTrade>): void {
    if (!this.clickable() || !event.data) return;
    // Cells are text-selectable; a drag to copy a price must not open the chart.
    if ((globalThis.getSelection?.()?.toString() ?? '').length > 0) return;
    this.tradeClick.emit(event.data);
  }

  readonly filters = TRADE_FILTERS;
  readonly filter = signal<TradeFilter>('all');
  readonly search = signal('');

  readonly counts = computed(() => tradeFilterCounts(this.trades()));
  readonly rows = computed(() => filterTrades(this.trades(), this.filter()));

  readonly priceDecimals = computed(() =>
    inferPriceDecimals(this.trades().flatMap((t) => [t.entryPrice, t.exitPrice])),
  );

  readonly columnDefs = computed<ColDef<ReportTrade>[]>(() =>
    buildTradeColumns(this.currency(), this.priceDecimals()),
  );

  readonly defaultColDef: ColDef<ReportTrade> = {
    sortable: true,
    resizable: true,
    filter: true,
    suppressHeaderMenuButton: false,
    wrapHeaderText: true,
    autoHeaderHeight: true,
    minWidth: 72,
  };

  readonly rowClassRules: RowClassRules<ReportTrade> = {
    'rpt-open-trade': (p) => p.data?.isOpen === true,
  };

  readonly getRowId = (p: GetRowIdParams<ReportTrade>): string => {
    const t = p.data;
    return t.number !== null
      ? `${t.isOpen ? 'o' : 'c'}${t.number}`
      : `${t.entryId}|${t.entryTime ?? ''}|${t.isOpen ? 'o' : 'c'}`;
  };
}
