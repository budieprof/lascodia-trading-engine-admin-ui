import { Component, Input } from '@angular/core';

/**
 * Light stand-ins for the two heavy children the report renders. The real ones need a canvas
 * (echarts) or a full grid runtime that jsdom does not provide; the stubs keep the bound values
 * readable so specs can assert what was handed over.
 */

@Component({
  selector: 'app-chart-card',
  standalone: true,
  template: `<div class="chart-stub" [attr.data-title]="title ?? ''">
    {{ title }}
    @if (emptyMessage) {
      <span class="chart-stub-empty">{{ emptyMessage }}</span>
    }
  </div>`,
})
export class ChartCardStubComponent {
  @Input() title?: string;
  @Input() subtitle?: string;
  @Input() alt?: string;
  @Input() options: unknown = {};
  @Input() height = '300px';
  @Input() loading = false;
  @Input() emptyMessage: string | null = null;
  @Input() emptyHint: string | null = null;
}

@Component({
  selector: 'ag-grid-angular',
  standalone: true,
  template: `<div class="grid-stub" [attr.data-rows]="rowData?.length ?? 0">
    @for (row of rowData ?? []; track $index) {
      <div class="grid-stub-row">{{ describe(row) }}</div>
    }
  </div>`,
})
export class AgGridStubComponent {
  @Input() rowData: unknown[] | null = null;
  @Input() columnDefs: unknown = null;
  @Input() defaultColDef: unknown = null;
  @Input() theme: unknown = null;
  @Input() domLayout: unknown = null;
  @Input() rowHeight: unknown = null;
  @Input() pagination: unknown = null;
  @Input() paginationPageSize: unknown = null;
  @Input() paginationPageSizeSelector: unknown = null;
  @Input() quickFilterText: unknown = null;
  @Input() rowClassRules: unknown = null;
  @Input() getRowId: unknown = null;
  @Input() suppressMovableColumns: unknown = null;
  @Input() enableCellTextSelection: unknown = null;
  @Input() ensureDomOrder: unknown = null;
  @Input() tooltipShowDelay: unknown = null;
  @Input() animateRows: unknown = null;
  @Input() loading: unknown = null;

  describe(row: unknown): string {
    return JSON.stringify(row);
  }
}
