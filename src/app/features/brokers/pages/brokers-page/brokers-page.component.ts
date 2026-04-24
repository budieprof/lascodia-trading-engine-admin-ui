import { Component, ChangeDetectionStrategy, inject, signal, viewChild } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import { BrokersService } from '@core/services/brokers.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { BrokerDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';

@Component({
  selector: 'app-brokers-page',
  standalone: true,
  imports: [DataTableComponent, PageHeaderComponent, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Brokers" subtitle="Manage broker connections">
        <button class="btn btn-primary" (click)="onAddBroker()">+ Add Broker</button>
      </app-page-header>

      <app-data-table [columnDefs]="columns" [fetchData]="fetchData" />

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete Broker"
        [message]="'Are you sure you want to delete broker ' + (selectedBroker()?.name ?? '') + '?'"
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="processing()"
        (confirm)="confirmDelete()"
        (cancelled)="showDeleteDialog.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
      }

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
      .btn:active {
        transform: scale(0.97);
      }

      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }
    `,
  ],
})
export class BrokersPageComponent {
  private readonly brokersService = inject(BrokersService);
  private readonly notifications = inject(NotificationService);
  private readonly dataTable = viewChild(DataTableComponent);

  processing = signal(false);
  showDeleteDialog = signal(false);
  selectedBroker = signal<BrokerDto | null>(null);

  columns: ColDef<BrokerDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, sortable: true },
    { headerName: 'Name', field: 'name', flex: 1, minWidth: 140 },
    { headerName: 'Type', field: 'brokerType', width: 100 },
    { headerName: 'Environment', field: 'environment', width: 110 },
    {
      headerName: 'Status',
      field: 'status',
      width: 120,
      cellRenderer: (params: { value: string }) => {
        const statusMap: Record<string, { bg: string; color: string }> = {
          Connected: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Disconnected: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Error: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
        };
        const s = statusMap[params.value] ?? statusMap['Error'];
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value}</span>`;
      },
    },
    {
      headerName: 'Is Active',
      field: 'isActive',
      width: 100,
      cellRenderer: (params: { value: boolean }) => {
        const bg = params.value ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const color = params.value ? '#248A3D' : '#636366';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value ? 'Yes' : 'No'}</span>`;
      },
    },
    {
      headerName: 'Is Paper',
      field: 'isPaper',
      width: 90,
      cellRenderer: (params: { value: boolean }) => {
        const bg = params.value ? 'rgba(0,113,227,0.12)' : 'rgba(142,142,147,0.12)';
        const color = params.value ? '#0040DD' : '#636366';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${params.value ? 'Yes' : 'No'}</span>`;
      },
    },
    {
      headerName: 'Actions',
      field: 'id',
      width: 280,
      sortable: false,
      cellRenderer: () => {
        return `<div style="display:flex;gap:4px;align-items:center;height:100%">
          <button data-action="activate" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,199,89,0.15);color:#248A3D">Activate</button>
          <button data-action="health" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(0,113,227,0.15);color:#0040DD">Health</button>
          <button data-action="switch" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,149,0,0.15);color:#C93400">Switch</button>
          <button data-action="delete" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">Delete</button>
        </div>`;
      },
      onCellClicked: (params: any) => {
        const action = (params.event?.target as HTMLElement)?.getAttribute('data-action');
        if (action === 'activate') this.activateBroker(params.data);
        if (action === 'health') this.checkHealth();
        if (action === 'switch') this.switchActive();
        if (action === 'delete') this.deleteBroker(params.data);
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.brokersService.list(params).pipe(
      map((response) => {
        if (response.data) return response.data;
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
        } as PagedData<BrokerDto>;
      }),
    );
  };

  onAddBroker(): void {
    this.notifications.info('Add Broker dialog coming soon');
  }

  activateBroker(broker: BrokerDto): void {
    this.processing.set(true);
    this.brokersService.activate(broker.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success(`Broker "${broker.name}" activated`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to activate broker');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to activate broker');
      },
    });
  }

  checkHealth(): void {
    this.processing.set(true);
    this.brokersService.health().subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success('Broker health check passed');
        } else {
          this.notifications.warning(res.message ?? 'Broker health check returned issues');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Broker health check failed');
      },
    });
  }

  switchActive(): void {
    this.processing.set(true);
    this.brokersService.switch().subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success('Active broker switched successfully');
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to switch active broker');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to switch active broker');
      },
    });
  }

  deleteBroker(broker: BrokerDto): void {
    this.selectedBroker.set(broker);
    this.showDeleteDialog.set(true);
  }

  confirmDelete(): void {
    const broker = this.selectedBroker();
    if (!broker) return;
    this.processing.set(true);
    this.brokersService.delete(broker.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        this.showDeleteDialog.set(false);
        if (res.status) {
          this.notifications.success(`Broker "${broker.name}" deleted`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to delete broker');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to delete broker');
      },
    });
  }
}
