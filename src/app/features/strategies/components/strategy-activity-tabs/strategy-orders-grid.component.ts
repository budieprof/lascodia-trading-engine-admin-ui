import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import type { PagerRequest } from '@core/api/api.types';
import { OrdersService } from '@core/services/orders.service';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * Strategy detail → Orders grid (U13: split out of the strategy detail page, behaviour unchanged): the strategy's
 * rows from the paged list endpoint, filtered to this strategy.
 */
@Component({
  selector: 'app-strategy-orders-grid',
  standalone: true,
  imports: [DataTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-data-table
      [columnDefs]="orderColumns"
      [fetchData]="fetchOrders"
      emptyTitle="No orders match"
      emptyDescription="Clear the search to see every order of this strategy."
    />
  `,
})
export class StrategyOrdersGridComponent {
  private readonly ordersService = inject(OrdersService);
  private readonly relativeTime = new RelativeTimePipe();

  readonly strategyId = input.required<number>();

  readonly orderColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'symbol', headerName: 'Symbol', flex: 1 },
    { field: 'orderType', headerName: 'Side', width: 80 },
    { field: 'executionType', headerName: 'Exec Type', width: 100 },
    { field: 'quantity', headerName: 'Qty', width: 80 },
    {
      field: 'price',
      headerName: 'Price',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'filledPrice',
      headerName: 'Filled',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: (p: any) => {
        const v = this.getOrderStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    {
      field: 'createdAt',
      headerName: 'Created',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
  ];

  readonly fetchOrders = (params: PagerRequest) =>
    this.ordersService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId() } })
      .pipe(map((res) => res.data!));

  private getOrderStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Pending: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Submitted: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      PartialFill: { bg: 'rgba(0, 113, 227, 0.12)', color: '#0040DD' },
      Filled: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Cancelled: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Expired: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }
}
