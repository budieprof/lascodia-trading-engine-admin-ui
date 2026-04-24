import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  TemplateRef,
  computed,
  contentChild,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { AgGridAngular } from 'ag-grid-angular';
import { AllCommunityModule, ModuleRegistry } from 'ag-grid-community';
import type {
  ColDef,
  GridApi,
  GridReadyEvent,
  RowSelectedEvent,
  SelectionChangedEvent,
  SortChangedEvent,
} from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

import { Observable, Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';
import type { PagedData, PagerRequest } from '@core/api/api.types';
import { TableStateService } from './table-state.service';

type SortDir = 'asc' | 'desc';

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [AgGridAngular, FormsModule, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="data-table-wrapper">
      @if (searchable()) {
        <div class="table-toolbar">
          <label class="search-box">
            <span class="search-icon" aria-hidden="true">⌕</span>
            <span class="sr-only">Search within table</span>
            <input
              type="search"
              [ngModel]="searchTerm()"
              (ngModelChange)="onSearchChange($event)"
              placeholder="Search…"
              class="search-input"
              aria-label="Search within table"
              autocomplete="off"
            />
          </label>
          <div class="toolbar-actions">
            <ng-content select="[toolbar]" />
          </div>
        </div>
      }

      @if (selectable() && selectedRows().length > 0) {
        <div class="selection-toolbar" role="toolbar" aria-label="Bulk actions">
          <span class="selection-count">
            <strong>{{ selectedRows().length }}</strong>
            selected
          </span>
          @if (bulkActionsTpl()) {
            <div class="selection-actions">
              <ng-container
                [ngTemplateOutlet]="bulkActionsTpl()!"
                [ngTemplateOutletContext]="{
                  $implicit: selectedRows(),
                  clear: clearSelection.bind(this),
                }"
              />
            </div>
          }
          <button
            type="button"
            class="selection-clear"
            (click)="clearSelection()"
            aria-label="Clear selection"
          >
            Clear
          </button>
        </div>
      }

      <div class="grid-wrapper" [class.hidden]="!loading() && totalItems() === 0">
        <ag-grid-angular
          class="ag-theme-alpine"
          [theme]="'legacy'"
          [rowData]="rowData()"
          [columnDefs]="columnDefs()"
          [defaultColDef]="defaultColDef"
          [suppressMovableColumns]="true"
          [animateRows]="true"
          [loading]="loading()"
          [rowSelection]="rowSelectionOptions()"
          (gridReady)="onGridReady($event)"
          (sortChanged)="onSortChanged($event)"
          (rowClicked)="rowClick.emit($event.data)"
          (rowSelected)="onRowSelected($event)"
          (selectionChanged)="onSelectionChanged($event)"
          style="width: 100%; height: 100%;"
        />
      </div>
      @if (!loading() && totalItems() === 0) {
        <div class="empty-state" role="status" aria-live="polite">
          <div class="empty-icon" aria-hidden="true">📭</div>
          <h3 class="empty-title">No data found</h3>
          <p class="empty-description">Try adjusting your search or filters</p>
        </div>
      }

      @if (!loading() && totalItems() > 0) {
        <nav class="pagination" aria-label="Table pagination">
          <span class="pagination-info" aria-live="polite">
            Showing {{ startItem() }}–{{ endItem() }} of {{ totalItems() }}
          </span>
          <div class="pagination-controls" role="group" aria-label="Pagination controls">
            <button
              type="button"
              class="page-btn"
              (click)="goToPage(currentPage() - 1)"
              [disabled]="currentPage() <= 1"
              aria-label="Previous page"
            >
              ‹
            </button>
            @for (p of visiblePages(); track p) {
              <button
                type="button"
                class="page-btn"
                [class.active]="p === currentPage()"
                (click)="goToPage(p)"
                [attr.aria-label]="'Page ' + p"
                [attr.aria-current]="p === currentPage() ? 'page' : null"
              >
                {{ p }}
              </button>
            }
            <button
              type="button"
              class="page-btn"
              (click)="goToPage(currentPage() + 1)"
              [disabled]="currentPage() >= totalPages()"
              aria-label="Next page"
            >
              ›
            </button>
          </div>
          <label class="page-size">
            <span class="sr-only">Rows per page</span>
            <select
              class="page-size-select"
              [ngModel]="pageSize()"
              (ngModelChange)="onPageSizeChange($event)"
              aria-label="Rows per page"
            >
              <option [value]="10">10</option>
              <option [value]="25">25</option>
              <option [value]="50">50</option>
              <option [value]="100">100</option>
            </select>
          </label>
        </nav>
      }
    </div>
  `,
  styles: [
    `
      .data-table-wrapper {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }

      .table-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4);
        border-bottom: 1px solid var(--border);
        gap: var(--space-3);
      }

      .search-box {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        min-width: 240px;
      }

      .search-icon {
        color: var(--text-tertiary);
        font-size: 14px;
      }

      .search-input {
        border: none;
        background: none;
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        flex: 1;
      }
      .search-input::placeholder {
        color: var(--text-tertiary);
      }

      .toolbar-actions {
        display: flex;
        gap: var(--space-2);
      }

      .selection-toolbar {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: rgba(0, 113, 227, 0.08);
        border-bottom: 1px solid var(--border);
        animation: slideDown 0.15s ease-out;
      }
      .selection-count {
        font-size: var(--text-sm);
        color: var(--accent);
      }
      .selection-count strong {
        font-weight: var(--font-semibold);
      }
      .selection-actions {
        display: flex;
        gap: var(--space-2);
        flex: 1;
      }
      .selection-clear {
        padding: 4px 12px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .selection-clear:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .selection-clear:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      @keyframes slideDown {
        from {
          transform: translateY(-4px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }

      .grid-wrapper {
        width: 100%;
        height: 480px;
      }
      .grid-wrapper.hidden {
        display: none;
      }

      .empty-state {
        text-align: center;
        padding: var(--space-16) var(--space-8);
      }
      .empty-icon {
        font-size: 48px;
        margin-bottom: var(--space-4);
      }
      .empty-title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0 0 var(--space-2);
      }
      .empty-description {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        margin: 0;
      }

      .pagination {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-4);
        border-top: 1px solid var(--border);
        font-size: var(--text-sm);
      }
      .pagination-info {
        color: var(--text-secondary);
      }
      .pagination-controls {
        display: flex;
        gap: var(--space-1);
      }

      .page-btn {
        width: 32px;
        height: 32px;
        border: none;
        border-radius: var(--radius-full);
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-sm);
        font-family: inherit;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s ease;
      }
      .page-btn:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .page-btn.active {
        background: var(--accent);
        color: white;
      }
      .page-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
      .page-btn:focus-visible,
      .page-size-select:focus-visible,
      .search-input:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
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

      .page-size-select {
        height: 32px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        cursor: pointer;
      }

      :host ::ng-deep .ag-theme-alpine {
        --ag-border-color: var(--border);
        --ag-header-background-color: var(--bg-tertiary);
        --ag-row-hover-color: var(--bg-secondary);
        --ag-selected-row-background-color: rgba(0, 113, 227, 0.08);
        --ag-font-family: inherit;
        --ag-font-size: 13px;
      }
    `,
  ],
})
export class DataTableComponent<T> implements OnInit, OnDestroy {
  private readonly tableState = inject(TableStateService);

  columnDefs = input.required<ColDef[]>();
  fetchData = input.required<(params: PagerRequest) => Observable<PagedData<T>>>();
  searchable = input(true);
  selectable = input(false);

  // AG Grid v33 replaced the string `rowSelection` + `suppressRowClickSelection`
  // pair with an options object. Clicks never toggle selection in this app —
  // row-click is reserved for navigating to the detail page — so `enableClickSelection`
  // stays false and the checkbox column handles multi-select explicitly.
  readonly rowSelectionOptions = computed(() =>
    this.selectable()
      ? { mode: 'multiRow' as const, enableClickSelection: false, checkboxes: true }
      : undefined,
  );
  /**
   * Persist filter/pagination/sort to sessionStorage under this key. Set empty
   * to opt out. Defaults to the current pathname (one state slot per route).
   */
  stateKey = input<string | null>(null);

  rowClick = output<T>();
  selectionChange = output<T[]>();

  /** Template projected via `<ng-template #bulkActions let-rows let-clear="clear">…</ng-template>`. */
  bulkActionsTpl = contentChild<TemplateRef<{ $implicit: T[]; clear: () => void }>>('bulkActions');

  rowData = signal<T[]>([]);
  loading = signal(true);
  totalItems = signal(0);
  currentPage = signal(1);
  pageSize = signal(25);
  searchTerm = signal('');
  sortBy = signal<string | undefined>(undefined);
  sortDirection = signal<SortDir | undefined>(undefined);
  selectedRows = signal<T[]>([]);

  defaultColDef: ColDef = {
    sortable: true,
    resizable: true,
    suppressHeaderMenuButton: true,
  };

  private gridApi?: GridApi;
  private search$ = new Subject<string>();
  private destroy$ = new Subject<void>();

  totalPages = signal(1);
  startItem = signal(0);
  endItem = signal(0);
  visiblePages = signal<number[]>([]);

  readonly resolvedStateKey = computed(() => {
    const explicit = this.stateKey();
    if (explicit === '') return null;
    return explicit ?? this.tableState.defaultKey();
  });

  ngOnInit() {
    this.restoreState();

    this.search$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe((term) => {
        this.searchTerm.set(term);
        this.currentPage.set(1);
        this.persistState();
        this.loadData();
      });

    this.loadData();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadData() {
    this.loading.set(true);
    const params: PagerRequest = {
      currentPage: this.currentPage(),
      itemCountPerPage: this.pageSize(),
      filter: this.searchTerm() || null,
    };

    this.fetchData()(params)
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (result) => {
          this.rowData.set(result.data);
          this.totalItems.set(result.pager.totalItemCount);
          this.totalPages.set(result.pager.pageNo || 1);
          this.startItem.set((this.currentPage() - 1) * this.pageSize() + 1);
          this.endItem.set(
            Math.min(this.currentPage() * this.pageSize(), result.pager.totalItemCount),
          );
          this.updateVisiblePages();
          // Loading a fresh page invalidates previously-selected rows.
          this.clearSelection();
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  onGridReady(event: GridReadyEvent) {
    this.gridApi = event.api;
    // Defer auto-sizing until the grid container actually has a width.
    // When the DataTable is mounted inside a hidden tab or a conditional
    // `@if` branch that hasn't painted yet, `sizeColumnsToFit()` runs
    // against a 0-width container and AG Grid logs warning #29. The
    // microtask lets Angular finish its initial paint before we size.
    queueMicrotask(() => {
      if (!this.gridApi) return;
      const range = this.gridApi.getHorizontalPixelRange();
      if (range.right - range.left > 0) this.gridApi.sizeColumnsToFit();
    });
    // Re-apply a restored sort model, if any.
    if (this.sortBy()) {
      event.api.applyColumnState({
        state: [{ colId: this.sortBy()!, sort: this.sortDirection() ?? null }],
        defaultState: { sort: null },
      });
    }
  }

  onSortChanged(event: SortChangedEvent) {
    const sortModel = event.api.getColumnState().filter((c) => c.sort);
    if (sortModel.length > 0) {
      this.sortBy.set(sortModel[0].colId);
      this.sortDirection.set(sortModel[0].sort as SortDir);
    } else {
      this.sortBy.set(undefined);
      this.sortDirection.set(undefined);
    }
    this.persistState();
    this.loadData();
  }

  onSearchChange(term: string) {
    this.search$.next(term);
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages()) return;
    this.currentPage.set(page);
    this.persistState();
    this.loadData();
  }

  onPageSizeChange(size: number) {
    this.pageSize.set(Number(size));
    this.currentPage.set(1);
    this.persistState();
    this.loadData();
  }

  onRowSelected(_event: RowSelectedEvent) {
    /* reserved */
  }

  onSelectionChanged(event: SelectionChangedEvent) {
    const rows = (event.api.getSelectedRows() as T[]) ?? [];
    this.selectedRows.set(rows);
    this.selectionChange.emit(rows);
  }

  clearSelection(): void {
    this.gridApi?.deselectAll();
    this.selectedRows.set([]);
    this.selectionChange.emit([]);
  }

  private updateVisiblePages() {
    const total = this.totalPages();
    const current = this.currentPage();
    const pages: number[] = [];
    const start = Math.max(1, current - 2);
    const end = Math.min(total, current + 2);
    for (let i = start; i <= end; i++) pages.push(i);
    this.visiblePages.set(pages);
  }

  // ── Persisted state ───────────────────────────────────────────────

  private restoreState(): void {
    const key = this.resolvedStateKey();
    if (!key) return;
    const saved = this.tableState.read(key);
    if (!saved) return;
    this.currentPage.set(saved.currentPage);
    this.pageSize.set(saved.pageSize);
    this.searchTerm.set(saved.searchTerm);
    this.sortBy.set(saved.sortBy);
    this.sortDirection.set(saved.sortDirection);
  }

  private persistState(): void {
    const key = this.resolvedStateKey();
    if (!key) return;
    this.tableState.write(key, {
      currentPage: this.currentPage(),
      pageSize: this.pageSize(),
      searchTerm: this.searchTerm(),
      sortBy: this.sortBy(),
      sortDirection: this.sortDirection(),
    });
  }
}
