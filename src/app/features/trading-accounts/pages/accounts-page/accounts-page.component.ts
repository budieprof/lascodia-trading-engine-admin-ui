import { Component, ChangeDetectionStrategy, inject, signal, viewChild } from '@angular/core';
import type { ColDef } from 'ag-grid-community';
import { map } from 'rxjs';

import { TradingAccountsService } from '@core/services/trading-accounts.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { TradingAccountDto, PagedData, PagerRequest } from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { CurrencyFormatPipe } from '@shared/pipes/currency-format.pipe';

@Component({
  selector: 'app-accounts-page',
  standalone: true,
  imports: [DataTableComponent, PageHeaderComponent, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Trading Accounts" subtitle="Manage broker trading accounts">
        <button class="btn btn-primary" (click)="onAddAccount()">+ Add Account</button>
      </app-page-header>

      <app-data-table [columnDefs]="columns" [fetchData]="fetchData" />

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete Account"
        [message]="
          'Are you sure you want to delete account ' + (selectedAccount()?.accountName ?? '') + '?'
        "
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
export class AccountsPageComponent {
  private readonly accountsService = inject(TradingAccountsService);
  private readonly notifications = inject(NotificationService);
  private readonly currencyPipe = new CurrencyFormatPipe();
  private readonly dataTable = viewChild(DataTableComponent);

  processing = signal(false);
  showDeleteDialog = signal(false);
  selectedAccount = signal<TradingAccountDto | null>(null);

  columns: ColDef<TradingAccountDto>[] = [
    { headerName: 'ID', field: 'id', width: 70, sortable: true },
    { headerName: 'Name', field: 'accountName', flex: 1, minWidth: 140 },
    { headerName: 'Broker ID', field: 'brokerId', width: 90 },
    {
      headerName: 'Balance',
      field: 'balance',
      width: 130,
      valueFormatter: (params) =>
        this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD'),
    },
    {
      headerName: 'Equity',
      field: 'equity',
      width: 130,
      valueFormatter: (params) =>
        this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD'),
    },
    {
      headerName: 'Margin Used',
      field: 'marginUsed',
      width: 120,
      valueFormatter: (params) =>
        this.currencyPipe.transform(params.value, params.data?.currency ?? 'USD'),
    },
    {
      headerName: 'Status',
      field: 'isActive',
      width: 100,
      cellRenderer: (params: { value: boolean }) => {
        const active = params.value;
        const bg = active ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const color = active ? '#248A3D' : '#636366';
        const label = active ? 'Active' : 'Inactive';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
    {
      headerName: 'Environment',
      field: 'isPaper',
      width: 110,
      cellRenderer: (params: { data: TradingAccountDto }) => {
        const isPaper = params.data?.isPaper;
        const bg = isPaper ? 'rgba(0,113,227,0.12)' : 'rgba(255,149,0,0.12)';
        const color = isPaper ? '#0040DD' : '#C93400';
        const label = isPaper ? 'Paper' : 'Live';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
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
      width: 220,
      sortable: false,
      cellRenderer: () => {
        return `<div style="display:flex;gap:4px;align-items:center;height:100%">
          <button data-action="activate" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(52,199,89,0.15);color:#248A3D">Activate</button>
          <button data-action="sync" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(0,113,227,0.15);color:#0040DD">Sync</button>
          <button data-action="delete" style="height:26px;padding:0 10px;border:none;border-radius:999px;font-size:11px;font-weight:600;cursor:pointer;background:rgba(255,59,48,0.15);color:#D70015">Delete</button>
        </div>`;
      },
      onCellClicked: (params: any) => {
        const action = (params.event?.target as HTMLElement)?.getAttribute('data-action');
        if (action === 'activate') this.activateAccount(params.data);
        if (action === 'sync') this.syncBalance(params.data);
        if (action === 'delete') this.deleteAccount(params.data);
      },
    },
  ];

  fetchData = (params: PagerRequest) => {
    return this.accountsService.list(params).pipe(
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
        } as PagedData<TradingAccountDto>;
      }),
    );
  };

  onAddAccount(): void {
    this.notifications.info('Add Account dialog coming soon');
  }

  activateAccount(account: TradingAccountDto): void {
    this.processing.set(true);
    this.accountsService.activate(account.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success(`Account "${account.accountName}" activated`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to activate account');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to activate account');
      },
    });
  }

  syncBalance(account: TradingAccountDto): void {
    this.processing.set(true);
    this.accountsService.sync(account.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        if (res.status) {
          this.notifications.success(`Balance synced for "${account.accountName}"`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to sync balance');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to sync balance');
      },
    });
  }

  deleteAccount(account: TradingAccountDto): void {
    this.selectedAccount.set(account);
    this.showDeleteDialog.set(true);
  }

  confirmDelete(): void {
    const acct = this.selectedAccount();
    if (!acct) return;
    this.processing.set(true);
    this.accountsService.delete(acct.id).subscribe({
      next: (res) => {
        this.processing.set(false);
        this.showDeleteDialog.set(false);
        if (res.status) {
          this.notifications.success(`Account "${acct.accountName}" deleted`);
          this.dataTable()?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Failed to delete account');
        }
      },
      error: () => {
        this.processing.set(false);
        this.notifications.error('Failed to delete account');
      },
    });
  }
}
