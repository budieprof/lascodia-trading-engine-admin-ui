import { Component, ChangeDetectionStrategy, inject, signal, viewChild } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { TradeSignalDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { StatusBadgeComponent } from '@shared/components/status-badge/status-badge.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { CurrencyFormatPipe } from '@shared/pipes/currency-format.pipe';

@Component({
  selector: 'app-signals-page',
  standalone: true,
  imports: [DataTableComponent, PageHeaderComponent, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Trade Signals" subtitle="Review and manage trade signals" />

      <app-data-table [columnDefs]="columns" [fetchData]="fetchData" [selectable]="true">
        <div toolbar class="toolbar-buttons">
          <button class="btn btn-success" (click)="bulkApprove()" [disabled]="processing()">
            Bulk Approve
          </button>
          <button class="btn btn-danger" (click)="bulkReject()" [disabled]="processing()">
            Bulk Reject
          </button>
        </div>
      </app-data-table>

      <app-confirm-dialog
        [open]="showRejectDialog()"
        title="Reject Signal"
        [message]="'Are you sure you want to reject signal #' + (selectedSignal()?.id ?? '') + '?'"
        confirmLabel="Reject"
        confirmVariant="destructive"
        [loading]="processing()"
        (confirm)="confirmReject()"
        (cancelled)="showRejectDialog.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

      .toolbar-buttons {
        display: flex;
        gap: var(--space-2);
      }

      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
      }
      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-success {
        background: rgba(52, 199, 89, 0.15);
        color: #248a3d;
      }
      .btn-success:hover:not(:disabled) {
        background: rgba(52, 199, 89, 0.25);
      }

      .btn-danger {
        background: rgba(255, 59, 48, 0.15);
        color: #d70015;
      }
      .btn-danger:hover:not(:disabled) {
        background: rgba(255, 59, 48, 0.25);
      }

      .btn-sm {
        height: 26px;
        padding: 0 var(--space-3);
        font-size: 11px;
        border-radius: var(--radius-full);
      }

      .action-cell {
        display: flex;
        gap: 4px;
        align-items: center;
        height: 100%;
      }

      :host ::ng-deep .pending-row {
        background: rgba(255, 149, 0, 0.04) !important;
      }
    `,
  ],
})
export class SignalsPageComponent {
  private readonly signalsService = inject(TradeSignalsService);
  private readonly notifications = inject(NotificationService);
  private readonly relativeTimePipe = new RelativeTimePipe();
  private readonly dataTable = viewChild(DataTableComponent);

  processing = signal(false);
  showRejectDialog = signal(false);
  selectedSignal = signal<TradeSignalDto | null>(null);

  columns: ColDef<TradeSignalDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, sortable: true },
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 100 },
    {
      headerName: 'Direction',
      field: 'direction',
      width: 90,
      cellRenderer: (params: { value: string }) => {
        const isBuy = params.value === 'Buy';
        const color = isBuy ? '#248A3D' : '#D70015';
        const bg = isBuy ? 'rgba(52,199,89,0.12)' : 'rgba(255,59,48,0.12)';
        return `<span style="color:${color};background:${bg};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    {
      headerName: 'Confidence',
      field: 'confidence',
      width: 110,
      valueFormatter: (params) =>
        params.value != null ? `${(params.value * 100).toFixed(1)}%` : '-',
    },
    { headerName: 'Strategy', field: 'strategyId', width: 90 },
    {
      headerName: 'Status',
      field: 'status',
      width: 110,
      cellRenderer: (params: { value: string }) => {
        const map: Record<string, { bg: string; color: string }> = {
          Pending: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
          Approved: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Executed: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Rejected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Expired: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
        };
        const s = map[params.value] ?? map['Expired'];
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    {
      headerName: 'ML Score',
      field: 'mlConfidenceScore',
      width: 100,
      valueFormatter: (params) =>
        params.value != null ? `${(params.value * 100).toFixed(1)}%` : '-',
    },
    {
      headerName: 'Generated',
      field: 'generatedAt',
      width: 130,
      valueFormatter: (params) => this.relativeTimePipe.transform(params.value),
    },
    {
      headerName: 'Expires',
      field: 'expiresAt',
      width: 130,
      valueFormatter: (params) => this.relativeTimePipe.transform(params.value),
    },
    {
      headerName: 'Actions',
      field: 'id',
      width: 160,
      sortable: false,
      cellRenderer: (params: { data: TradeSignalDto }) => {
        if (params.data?.status !== 'Pending') return '';
        return `<div style="display:flex;gap:4px;align-items:center;height:100%">
          <button class="approve-btn" data-action="approve" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,199,89,0.15);color:#248A3D">Approve</button>
          <button class="reject-btn" data-action="reject" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">Reject</button>
        </div>`;
      },
      onCellClicked: (params: any) => {
        const target = params.event?.target as HTMLElement;
        const action = target?.getAttribute('data-action');
        if (action === 'approve') this.approveSignal(params.data);
        if (action === 'reject') this.rejectSignal(params.data);
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.signalsService.list(params).pipe(
      map((response) => {
        if (response.data) {
          const sorted = [...response.data.data].sort((a, b) => {
            if (a.status === 'Pending' && b.status !== 'Pending') return -1;
            if (a.status !== 'Pending' && b.status === 'Pending') return 1;
            return 0;
          });
          return { ...response.data, data: sorted };
        }
        return {
          data: [],
          pager: {
            totalItemCount: 0,
            filter: null,
            currentPage: 1,
            itemCountPerPage: 25,
            pageNo: 0,
            pageSize: 25,
          },
        } as PagedData<TradeSignalDto>;
      }),
    );
  };

  approveSignal(signal: TradeSignalDto): void {
    this.processing.set(true);
    this.signalsService.approve(signal.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success(`Signal #${signal.id} approved`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to approve signal');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to approve signal');
      },
    });
  }

  rejectSignal(signal: TradeSignalDto): void {
    this.selectedSignal.set(signal);
    this.showRejectDialog.set(true);
  }

  confirmReject(): void {
    const sig = this.selectedSignal();
    if (!sig) return;
    this.processing.set(true);
    this.signalsService.reject(sig.id, { reason: 'Manually rejected by admin' }).subscribe({
      next: (res) => {
        this.processing.set(false);
        this.showRejectDialog.set(false);
        if (res.status) {
          this.notifications.success(`Signal #${sig.id} rejected`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to reject signal');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to reject signal');
      },
    });
  }

  bulkApprove(): void {
    this.notifications.info('Select pending signals to approve in bulk');
  }

  bulkReject(): void {
    this.notifications.info('Select pending signals to reject in bulk');
  }
}
