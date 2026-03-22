import { Component, ChangeDetectionStrategy, inject, signal, viewChild } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { CurrencyPairDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

@Component({
  selector: 'app-currency-pairs-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Currency Pairs" subtitle="Manage tradeable currency pairs">
        <button class="btn btn-primary" (click)="onAddPair()">
          + Add Pair
        </button>
      </app-page-header>

      <app-data-table
        [columnDefs]="columns"
        [fetchData]="fetchData"
      />
    </div>
  `,
  styles: [`
    .page { padding: var(--space-2) 0; }

    .btn {
      height: 36px;
      padding: 0 var(--space-5);
      border: none;
      border-radius: var(--radius-full);
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: var(--space-1);
    }
    .btn:active { transform: scale(0.97); }

    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); }
  `],
})
export class CurrencyPairsPageComponent {
  private readonly currencyPairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);

  columns: ColDef<CurrencyPairDto>[] = [
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 120, sortable: true },
    { headerName: 'Base Currency', field: 'baseCurrency', width: 120 },
    { headerName: 'Quote Currency', field: 'quoteCurrency', width: 130 },
    { headerName: 'Decimal Places', field: 'decimalPlaces', width: 120 },
    {
      headerName: 'Contract Size',
      field: 'contractSize',
      width: 120,
      valueFormatter: (params) => params.value?.toLocaleString() ?? '-',
    },
    {
      headerName: 'Min Lot',
      field: 'minLotSize',
      width: 90,
      valueFormatter: (params) => params.value?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Max Lot',
      field: 'maxLotSize',
      width: 90,
      valueFormatter: (params) => params.value?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Lot Step',
      field: 'lotStep',
      width: 90,
      valueFormatter: (params) => params.value?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Is Active',
      field: 'isActive',
      width: 100,
      cellRenderer: (params: { value: boolean }) => {
        const bg = params.value ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const color = params.value ? '#248A3D' : '#636366';
        const label = params.value ? 'Active' : 'Inactive';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.currencyPairsService.list(params).pipe(
      map((response) => {
        if (response.data) return response.data;
        return { data: [], pager: { totalItemCount: 0, filter: null, currentPage: 1, itemCountPerPage: 25, pageNo: 0, pageSize: 25 } } as PagedData<CurrencyPairDto>;
      }),
    );
  };

  onAddPair(): void {
    this.notifications.info('Add Currency Pair dialog coming soon');
  }
}
