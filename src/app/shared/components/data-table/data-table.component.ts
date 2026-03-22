import {
  Component, input, output, signal, effect, ChangeDetectionStrategy, OnInit, OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import type { ColDef, GridReadyEvent, SortChangedEvent, GridApi } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);
import { Observable, Subject, debounceTime, distinctUntilChanged, switchMap, takeUntil, tap } from 'rxjs';
import type { PagedData, PagerRequest } from '@core/api/api.types';

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [AgGridAngular, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="data-table-wrapper">
      @if (searchable()) {
        <div class="table-toolbar">
          <div class="search-box">
            <span class="search-icon">⌕</span>
            <input
              type="text"
              [ngModel]="searchTerm()"
              (ngModelChange)="onSearchChange($event)"
              placeholder="Search..."
              class="search-input"
            />
          </div>
          <div class="toolbar-actions">
            <ng-content select="[toolbar]" />
          </div>
        </div>
      }

      <div class="grid-wrapper" [class.hidden]="!loading() && totalItems() === 0">
        <ag-grid-angular
          class="ag-theme-alpine"
          [rowData]="rowData()"
          [columnDefs]="columnDefs()"
          [defaultColDef]="defaultColDef"
          [suppressMovableColumns]="true"
          [animateRows]="true"
          [loading]="loading()"
          [rowSelection]="selectable() ? 'multiple' : undefined"
          [suppressRowClickSelection]="true"
          (gridReady)="onGridReady($event)"
          (sortChanged)="onSortChanged($event)"
          (rowClicked)="rowClick.emit($event.data)"
          style="width: 100%; height: 100%;"
        />
      </div>
      @if (!loading() && totalItems() === 0) {
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <h3 class="empty-title">No data found</h3>
          <p class="empty-description">Try adjusting your search or filters</p>
        </div>
      }

      @if (!loading() && totalItems() > 0) {
        <div class="pagination">
          <span class="pagination-info">
            Showing {{ startItem() }}–{{ endItem() }} of {{ totalItems() }}
          </span>
          <div class="pagination-controls">
            <button
              class="page-btn"
              (click)="goToPage(currentPage() - 1)"
              [disabled]="currentPage() <= 1"
            >‹</button>
            @for (p of visiblePages(); track p) {
              <button
                class="page-btn"
                [class.active]="p === currentPage()"
                (click)="goToPage(p)"
              >{{ p }}</button>
            }
            <button
              class="page-btn"
              (click)="goToPage(currentPage() + 1)"
              [disabled]="currentPage() >= totalPages()"
            >›</button>
          </div>
          <select
            class="page-size-select"
            [ngModel]="pageSize()"
            (ngModelChange)="onPageSizeChange($event)"
          >
            <option [value]="10">10</option>
            <option [value]="25">25</option>
            <option [value]="50">50</option>
            <option [value]="100">100</option>
          </select>
        </div>
      }
    </div>
  `,
  styles: [`
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

    .search-icon { color: var(--text-tertiary); font-size: 14px; }

    .search-input {
      border: none;
      background: none;
      color: var(--text-primary);
      font-size: var(--text-sm);
      font-family: inherit;
      outline: none;
      flex: 1;
    }
    .search-input::placeholder { color: var(--text-tertiary); }

    .toolbar-actions { display: flex; gap: var(--space-2); }

    .skeleton-table { padding: var(--space-4); }
    .skeleton-row {
      display: flex;
      gap: var(--space-4);
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--border);
    }
    .skeleton-cell {
      flex: 1;
      height: 16px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      overflow: hidden;
      position: relative;
    }
    .shimmer {
      position: absolute;
      inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
      animation: shimmer 1.5s infinite;
    }
    @keyframes shimmer {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
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
    .empty-icon { font-size: 48px; margin-bottom: var(--space-4); }
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

    .pagination-info { color: var(--text-secondary); }

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
    .page-btn:hover:not(:disabled) { background: var(--bg-tertiary); }
    .page-btn.active {
      background: var(--accent);
      color: white;
    }
    .page-btn:disabled { opacity: 0.3; cursor: not-allowed; }

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
  `],
})
export class DataTableComponent<T> implements OnInit, OnDestroy {
  columnDefs = input.required<ColDef[]>();
  fetchData = input.required<(params: PagerRequest) => Observable<PagedData<T>>>();
  searchable = input(true);
  selectable = input(false);

  rowClick = output<T>();

  rowData = signal<T[]>([]);
  loading = signal(true);
  totalItems = signal(0);
  currentPage = signal(1);
  pageSize = signal(25);
  searchTerm = signal('');
  sortBy = signal<string | undefined>(undefined);
  sortDirection = signal<'asc' | 'desc' | undefined>(undefined);

  skeletonRows = Array(5);
  skeletonCols = Array(6);

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

  ngOnInit() {
    this.search$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.destroy$))
      .subscribe((term) => {
        this.searchTerm.set(term);
        this.currentPage.set(1);
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
          this.endItem.set(Math.min(this.currentPage() * this.pageSize(), result.pager.totalItemCount));
          this.updateVisiblePages();
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  onGridReady(event: GridReadyEvent) {
    this.gridApi = event.api;
    event.api.sizeColumnsToFit();
  }

  onSortChanged(event: SortChangedEvent) {
    const sortModel = event.api.getColumnState().filter(c => c.sort);
    if (sortModel.length > 0) {
      this.sortBy.set(sortModel[0].colId);
      this.sortDirection.set(sortModel[0].sort as 'asc' | 'desc');
    } else {
      this.sortBy.set(undefined);
      this.sortDirection.set(undefined);
    }
    this.loadData();
  }

  onSearchChange(term: string) {
    this.search$.next(term);
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages()) return;
    this.currentPage.set(page);
    this.loadData();
  }

  onPageSizeChange(size: number) {
    this.pageSize.set(Number(size));
    this.currentPage.set(1);
    this.loadData();
  }

  private updateVisiblePages() {
    const total = this.totalPages();
    const current = this.currentPage();
    const pages: number[] = [];
    const start = Math.max(1, current - 2);
    const end = Math.min(total, current + 2);
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    this.visiblePages.set(pages);
  }
}
