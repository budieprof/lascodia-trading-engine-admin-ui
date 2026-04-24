import { Component, ChangeDetectionStrategy, inject, signal, viewChild } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import { AlertsService } from '@core/services/alerts.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { AlertDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { EnumLabelPipe } from '@shared/pipes/enum-label.pipe';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

@Component({
  selector: 'app-alerts-page',
  standalone: true,
  imports: [DataTableComponent, PageHeaderComponent, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Alerts" subtitle="Configure alert rules and notifications">
        <button class="btn btn-primary" (click)="onCreateAlert()">+ Create Alert</button>
      </app-page-header>

      <app-data-table [columnDefs]="columns" [fetchData]="fetchData" />

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete Alert"
        [message]="'Are you sure you want to delete alert #' + (selectedAlert()?.id ?? '') + '?'"
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
export class AlertsPageComponent {
  private readonly alertsService = inject(AlertsService);
  private readonly notifications = inject(NotificationService);
  private readonly enumLabelPipe = new EnumLabelPipe();
  private readonly relativeTimePipe = new RelativeTimePipe();
  private readonly dataTable = viewChild(DataTableComponent);

  processing = signal(false);
  showDeleteDialog = signal(false);
  selectedAlert = signal<AlertDto | null>(null);

  columns: ColDef<AlertDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, sortable: true },
    {
      headerName: 'Type',
      field: 'alertType',
      flex: 1,
      minWidth: 150,
      valueFormatter: (params) => this.enumLabelPipe.transform(params.value),
    },
    { headerName: 'Symbol', field: 'symbol', width: 110 },
    {
      headerName: 'Channel',
      field: 'channel',
      width: 100,
      cellRenderer: (params: { value: string }) => {
        const colorMap: Record<string, { bg: string; color: string }> = {
          Email: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          Webhook: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
          Telegram: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
        };
        const s = colorMap[params.value] ?? colorMap['Webhook'];
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
        const label = params.value ? 'Active' : 'Inactive';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Last Triggered',
      field: 'lastTriggeredAt',
      width: 140,
      valueFormatter: (params) => this.relativeTimePipe.transform(params.value),
    },
    {
      headerName: 'Actions',
      field: 'id',
      width: 100,
      sortable: false,
      cellRenderer: () => {
        return `<div style="display:flex;gap:4px;align-items:center;height:100%">
          <button data-action="delete" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">Delete</button>
        </div>`;
      },
      onCellClicked: (params: any) => {
        const action = (params.event?.target as HTMLElement)?.getAttribute('data-action');
        if (action === 'delete') this.deleteAlert(params.data);
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.alertsService.list(params).pipe(
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
        } as PagedData<AlertDto>;
      }),
    );
  };

  onCreateAlert(): void {
    this.notifications.info('Create Alert dialog coming soon');
  }

  deleteAlert(alert: AlertDto): void {
    this.selectedAlert.set(alert);
    this.showDeleteDialog.set(true);
  }

  confirmDelete(): void {
    const alert = this.selectedAlert();
    if (!alert) return;
    this.processing.set(true);
    this.alertsService.delete(alert.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        this.showDeleteDialog.set(false);
        if (res.status) {
          this.notifications.success(`Alert #${alert.id} deleted`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to delete alert');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to delete alert');
      },
    });
  }
}
