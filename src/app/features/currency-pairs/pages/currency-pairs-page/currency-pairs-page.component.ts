import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { map, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CreateCurrencyPairRequest,
  CurrencyPairDto,
  PagedData,
  PagerRequest,
  UpdateCurrencyPairRequest,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';

@Component({
  selector: 'app-currency-pairs-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Currency Pairs" subtitle="Tradeable symbols and their contract specs">
        <button type="button" class="btn btn-primary" (click)="openCreate()">+ Add Pair</button>
      </app-page-header>

      @if (editing()) {
        <form class="panel" [formGroup]="form" (ngSubmit)="submit()">
          <div class="panel-head">
            <h3>{{ editing()?.id ? 'Edit Pair #' + editing()!.id : 'New Currency Pair' }}</h3>
            <button type="button" class="close" (click)="cancel()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field label="Symbol" [required]="true" [control]="form.controls.symbol">
              <input appFormFieldControl formControlName="symbol" placeholder="EURUSD" />
            </app-form-field>
            <app-form-field
              label="Base Currency"
              [required]="true"
              [control]="form.controls.baseCurrency"
            >
              <input appFormFieldControl formControlName="baseCurrency" placeholder="EUR" />
            </app-form-field>
            <app-form-field
              label="Quote Currency"
              [required]="true"
              [control]="form.controls.quoteCurrency"
            >
              <input appFormFieldControl formControlName="quoteCurrency" placeholder="USD" />
            </app-form-field>
            <app-form-field
              label="Decimal Places"
              [required]="true"
              [control]="form.controls.decimalPlaces"
            >
              <input
                appFormFieldControl
                formControlName="decimalPlaces"
                type="number"
                min="0"
                max="8"
              />
            </app-form-field>
            <app-form-field
              label="Contract Size"
              [required]="true"
              [control]="form.controls.contractSize"
            >
              <input appFormFieldControl formControlName="contractSize" type="number" min="0" />
            </app-form-field>
            <app-form-field label="Min Lot" [required]="true" [control]="form.controls.minLotSize">
              <input
                appFormFieldControl
                formControlName="minLotSize"
                type="number"
                step="0.01"
                min="0"
              />
            </app-form-field>
            <app-form-field label="Max Lot" [required]="true" [control]="form.controls.maxLotSize">
              <input
                appFormFieldControl
                formControlName="maxLotSize"
                type="number"
                step="0.01"
                min="0"
              />
            </app-form-field>
            <app-form-field label="Lot Step" [required]="true" [control]="form.controls.lotStep">
              <input
                appFormFieldControl
                formControlName="lotStep"
                type="number"
                step="0.01"
                min="0.01"
              />
            </app-form-field>
            @if (editing()?.id) {
              <div class="field checkbox">
                <label
                  ><input formControlName="isActive" type="checkbox" /><span>Active</span></label
                >
              </div>
            }
            <div class="actions">
              @if (editing()?.id) {
                <button
                  type="button"
                  class="btn btn-destructive"
                  (click)="showDeleteDialog.set(true)"
                  [disabled]="busy()"
                >
                  Delete
                </button>
              }
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancel()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy() || form.invalid">
                @if (busy()) {
                  <span class="spin"></span>
                } @else {
                  Save
                }
              </button>
            </div>
          </div>
        </form>
      }

      <app-data-table
        #table
        [columnDefs]="columns"
        [fetchData]="fetchData"
        (rowClick)="openEdit($event)"
      />

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete Currency Pair"
        [message]="
          'Delete ' +
          (editing()?.symbol ?? 'this pair') +
          '? Strategies and orders using it will fail.'
        "
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="onDelete()"
        (cancelled)="showDeleteDialog.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-destructive {
        background: var(--loss);
        color: white;
        margin-right: auto;
      }
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .close {
        background: transparent;
        border: none;
        font-size: 20px;
        color: var(--text-secondary);
        cursor: pointer;
        width: 32px;
        height: 32px;
        border-radius: var(--radius-full);
      }
      .close:hover {
        background: var(--bg-tertiary);
      }
      .panel-body {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: var(--space-4);
        padding: var(--space-5);
      }
      .field {
        display: flex;
        flex-direction: column;
      }
      .field.checkbox {
        flex-direction: row;
        align-items: center;
      }
      .field.checkbox label {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .field label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: var(--font-medium);
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .actions {
        grid-column: 1 / -1;
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
        margin-top: var(--space-2);
      }
      .spin {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class CurrencyPairsPageComponent {
  private readonly service = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  @ViewChild('table') table?: DataTableComponent<CurrencyPairDto>;

  readonly editing = signal<CurrencyPairDto | Partial<CurrencyPairDto> | null>(null);
  readonly busy = signal(false);
  readonly showDeleteDialog = signal(false);

  readonly form = this.fb.nonNullable.group({
    symbol: ['', Validators.required],
    baseCurrency: ['', Validators.required],
    quoteCurrency: ['', Validators.required],
    decimalPlaces: [5, [Validators.required, Validators.min(0)]],
    contractSize: [100000, [Validators.required, Validators.min(1)]],
    minLotSize: [0.01, [Validators.required, Validators.min(0)]],
    maxLotSize: [100, [Validators.required, Validators.min(0)]],
    lotStep: [0.01, [Validators.required, Validators.min(0.0001)]],
    isActive: [true],
  });

  readonly columns: ColDef<CurrencyPairDto>[] = [
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 120 },
    { headerName: 'Base', field: 'baseCurrency', width: 100 },
    { headerName: 'Quote', field: 'quoteCurrency', width: 100 },
    { headerName: 'Digits', field: 'decimalPlaces', width: 90 },
    {
      headerName: 'Contract Size',
      field: 'contractSize',
      width: 130,
      valueFormatter: (p) => (p.value as number)?.toLocaleString() ?? '-',
    },
    {
      headerName: 'Min Lot',
      field: 'minLotSize',
      width: 100,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Max Lot',
      field: 'maxLotSize',
      width: 100,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Step',
      field: 'lotStep',
      width: 100,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Status',
      field: 'isActive',
      width: 110,
      cellRenderer: (p: { value: unknown }) => {
        const active = Boolean(p.value);
        const bg = active ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const color = active ? '#248A3D' : '#636366';
        const label = active ? 'Active' : 'Inactive';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
  ];

  readonly fetchData = (params: PagerRequest): Observable<PagedData<CurrencyPairDto>> =>
    this.service.list(params).pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  openCreate(): void {
    this.form.reset({
      symbol: '',
      baseCurrency: '',
      quoteCurrency: '',
      decimalPlaces: 5,
      contractSize: 100000,
      minLotSize: 0.01,
      maxLotSize: 100,
      lotStep: 0.01,
      isActive: true,
    });
    this.editing.set({});
  }

  openEdit(row: CurrencyPairDto): void {
    this.form.reset({
      symbol: row.symbol ?? '',
      baseCurrency: row.baseCurrency ?? '',
      quoteCurrency: row.quoteCurrency ?? '',
      decimalPlaces: row.decimalPlaces,
      contractSize: row.contractSize,
      minLotSize: row.minLotSize,
      maxLotSize: row.maxLotSize,
      lotStep: row.lotStep,
      isActive: row.isActive,
    });
    this.editing.set(row);
  }

  cancel(): void {
    this.editing.set(null);
  }

  submit(): void {
    const v = this.form.getRawValue();
    const editing = this.editing();
    this.busy.set(true);
    const isEdit = editing && 'id' in editing && editing.id != null;
    const payload = {
      symbol: v.symbol,
      baseCurrency: v.baseCurrency,
      quoteCurrency: v.quoteCurrency,
      decimalPlaces: v.decimalPlaces,
      contractSize: v.contractSize,
      minLotSize: v.minLotSize,
      maxLotSize: v.maxLotSize,
      lotStep: v.lotStep,
      isActive: v.isActive,
    };
    const op = isEdit
      ? this.service.update(editing.id as number, payload as UpdateCurrencyPairRequest)
      : this.service.create(payload as CreateCurrencyPairRequest);
    op.subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(isEdit ? 'Pair updated' : 'Pair created');
          this.editing.set(null);
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Save failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  onDelete(): void {
    const editing = this.editing();
    if (!editing || !('id' in editing) || editing.id == null) return;
    this.busy.set(true);
    this.service.delete(editing.id).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showDeleteDialog.set(false);
        if (res.status) {
          this.notifications.success('Pair deleted');
          this.editing.set(null);
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Delete failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.showDeleteDialog.set(false);
      },
    });
  }
}

function emptyPager() {
  return {
    totalItemCount: 0,
    filter: null,
    currentPage: 1,
    itemCountPerPage: 25,
    pageNo: 1,
    pageSize: 25,
  };
}
