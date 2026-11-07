import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import type { PagerRequest } from '@core/api/api.types';
import { TradeSignalsService } from '@core/services/trade-signals.service';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { configHashColumn } from '../../util/config-hash-column';

/**
 * Strategy detail → Signals grid (U13: split out of the strategy detail page, behaviour unchanged): the strategy's
 * rows from the paged list endpoint, filtered to this strategy.
 */
@Component({
  selector: 'app-strategy-signals-grid',
  standalone: true,
  imports: [DataTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-data-table
      [columnDefs]="signalColumns"
      [fetchData]="fetchSignals"
      emptyTitle="No signals match"
      emptyDescription="Clear the search to see every signal of this strategy."
    />
  `,
})
export class StrategySignalsGridComponent {
  private readonly signalsService = inject(TradeSignalsService);
  private readonly relativeTime = new RelativeTimePipe();

  readonly strategyId = input.required<number>();
  /** The strategy's current C1 hash, when known (for the Config column's 'older' mark). */
  readonly currentHash = input<string | null>(null);

  readonly signalColumns: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 70 },
    { field: 'symbol', headerName: 'Symbol', flex: 1 },
    { field: 'direction', headerName: 'Direction', width: 100 },
    {
      field: 'entryPrice',
      headerName: 'Entry Price',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5),
    },
    {
      field: 'stopLoss',
      headerName: 'SL',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'takeProfit',
      headerName: 'TP',
      flex: 1,
      valueFormatter: (p: any) => p.value?.toFixed(5) ?? '-',
    },
    {
      field: 'confidence',
      headerName: 'Confidence',
      width: 100,
      valueFormatter: (p: any) => `${(p.value * 100).toFixed(1)}%`,
    },
    {
      field: 'status',
      headerName: 'Status',
      width: 110,
      cellRenderer: (p: any) => {
        const v = this.getSignalStatusVariant(p.value);
        return `<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${v.bg};color:${v.color}">${p.value}</span>`;
      },
    },
    {
      field: 'generatedAt',
      headerName: 'Generated',
      flex: 1,
      valueFormatter: (p: any) => this.relativeTime.transform(p.value),
    },
    configHashColumn(() => this.currentHash()),
  ];

  readonly fetchSignals = (params: PagerRequest) =>
    this.signalsService
      .list({ ...params, filter: { ...(params.filter ?? {}), strategyId: this.strategyId() } })
      .pipe(map((res) => res.data!));

  private getSignalStatusVariant(status: string): { bg: string; color: string } {
    const m: Record<string, { bg: string; color: string }> = {
      Pending: { bg: 'rgba(255, 149, 0, 0.12)', color: '#C93400' },
      Approved: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Executed: { bg: 'rgba(52, 199, 89, 0.12)', color: '#248A3D' },
      Rejected: { bg: 'rgba(255, 59, 48, 0.12)', color: '#D70015' },
      Expired: { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' },
    };
    return m[status] ?? { bg: 'rgba(142, 142, 147, 0.12)', color: '#636366' };
  }
}
