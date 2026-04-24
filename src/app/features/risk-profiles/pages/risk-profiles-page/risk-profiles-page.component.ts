import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { map, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CreateRiskProfileRequest,
  PagedData,
  PagerRequest,
  RiskProfileDto,
  UpdateRiskProfileRequest,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';

@Component({
  selector: 'app-risk-profiles-page',
  standalone: true,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    ConfirmDialogComponent,
    EmptyStateComponent,
    TabsComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Risk Profiles" subtitle="Per-strategy sizing and drawdown limits">
        <button type="button" class="btn btn-primary" (click)="openCreate()">New Profile</button>
      </app-page-header>

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        @if (activeTab() === 'profiles') {
          @if (editing()) {
            <form class="panel" [formGroup]="form" (ngSubmit)="submit()">
              <div class="panel-head">
                <h3>
                  {{ editing()?.id ? 'Edit Risk Profile #' + editing()!.id : 'New Risk Profile' }}
                </h3>
                <button type="button" class="close" (click)="cancel()" aria-label="Close">
                  &times;
                </button>
              </div>
              <div class="panel-body">
                <app-form-field label="Name" [required]="true" [control]="form.controls.name">
                  <input
                    appFormFieldControl
                    formControlName="name"
                    placeholder="e.g. Conservative"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Lot / Trade"
                  [required]="true"
                  [control]="form.controls.maxLotSizePerTrade"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxLotSizePerTrade"
                    type="number"
                    step="0.01"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Open Positions"
                  [required]="true"
                  [control]="form.controls.maxOpenPositions"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxOpenPositions"
                    type="number"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Daily Trades"
                  [required]="true"
                  [control]="form.controls.maxDailyTrades"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxDailyTrades"
                    type="number"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Daily Drawdown %"
                  [required]="true"
                  [control]="form.controls.maxDailyDrawdownPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxDailyDrawdownPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Total Drawdown %"
                  [required]="true"
                  [control]="form.controls.maxTotalDrawdownPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxTotalDrawdownPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Risk / Trade %"
                  [required]="true"
                  [control]="form.controls.maxRiskPerTradePct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxRiskPerTradePct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Max Symbol Exposure %"
                  [required]="true"
                  [control]="form.controls.maxSymbolExposurePct"
                >
                  <input
                    appFormFieldControl
                    formControlName="maxSymbolExposurePct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Recovery Threshold %"
                  [required]="true"
                  [control]="form.controls.drawdownRecoveryThresholdPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="drawdownRecoveryThresholdPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Recovery Lot Multiplier"
                  [required]="true"
                  [control]="form.controls.recoveryLotSizeMultiplier"
                >
                  <input
                    appFormFieldControl
                    formControlName="recoveryLotSizeMultiplier"
                    type="number"
                    step="0.05"
                    min="0"
                  />
                </app-form-field>
                <app-form-field
                  label="Recovery Exit Threshold %"
                  [required]="true"
                  [control]="form.controls.recoveryExitThresholdPct"
                >
                  <input
                    appFormFieldControl
                    formControlName="recoveryExitThresholdPct"
                    type="number"
                    step="0.1"
                    min="0"
                  />
                </app-form-field>
                <div class="field checkbox">
                  <label>
                    <input formControlName="isDefault" type="checkbox" />
                    <span>Set as default profile</span>
                  </label>
                </div>
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
        }

        @if (activeTab() === 'monitor') {
          <app-empty-state
            title="Risk Monitor requires live portfolio metrics"
            description="Per-strategy position utilization, daily drawdown, and exposure charts compute from the positions + trades streams. Wired in Phase 2 (Worker Health + Calibration) of the upgrade plan."
          />
        }
      </ui-tabs>

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete Risk Profile"
        [message]="
          'Delete ' +
          (editing()?.name ?? 'this profile') +
          '? Strategies using it will lose their risk binding.'
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
      .btn-destructive:hover:not(:disabled) {
        opacity: 0.9;
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
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
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
        justify-content: flex-start;
      }
      .field.checkbox label {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--text-primary);
        font-size: var(--text-sm);
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
export class RiskProfilesPageComponent {
  private readonly service = inject(RiskProfilesService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  @ViewChild('table') table?: DataTableComponent<RiskProfileDto>;

  readonly tabs: TabItem[] = [
    { label: 'Risk Profiles', value: 'profiles' },
    { label: 'Risk Monitor', value: 'monitor' },
  ];
  readonly activeTab = signal('profiles');

  readonly editing = signal<RiskProfileDto | Partial<RiskProfileDto> | null>(null);
  readonly busy = signal(false);
  readonly showDeleteDialog = signal(false);

  readonly form = this.fb.nonNullable.group({
    name: ['', Validators.required],
    maxLotSizePerTrade: [1, [Validators.required, Validators.min(0)]],
    maxOpenPositions: [5, [Validators.required, Validators.min(0)]],
    maxDailyTrades: [20, [Validators.required, Validators.min(0)]],
    maxDailyDrawdownPct: [2.0, [Validators.required, Validators.min(0)]],
    maxTotalDrawdownPct: [10.0, [Validators.required, Validators.min(0)]],
    maxRiskPerTradePct: [1.0, [Validators.required, Validators.min(0)]],
    maxSymbolExposurePct: [25.0, [Validators.required, Validators.min(0)]],
    drawdownRecoveryThresholdPct: [5.0, [Validators.required, Validators.min(0)]],
    recoveryLotSizeMultiplier: [0.5, [Validators.required, Validators.min(0)]],
    recoveryExitThresholdPct: [2.0, [Validators.required, Validators.min(0)]],
    isDefault: [false],
  });

  readonly columns: ColDef<RiskProfileDto>[] = [
    { headerName: 'Name', field: 'name', flex: 1, minWidth: 160 },
    {
      headerName: 'Max Lot',
      field: 'maxLotSizePerTrade',
      width: 110,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Total DD %',
      field: 'maxTotalDrawdownPct',
      width: 120,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    { headerName: 'Max Positions', field: 'maxOpenPositions', width: 130 },
    { headerName: 'Daily Trades', field: 'maxDailyTrades', width: 130 },
    {
      headerName: 'Risk / Trade',
      field: 'maxRiskPerTradePct',
      width: 130,
      valueFormatter: (p) => (p.value != null ? `${(p.value as number).toFixed(1)}%` : '-'),
    },
    {
      headerName: 'Default',
      field: 'isDefault',
      width: 110,
      cellRenderer: (p: { value: unknown }) =>
        p.value
          ? `<span style="background:rgba(0,113,227,0.12);color:#0040DD;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">Default</span>`
          : '',
    },
  ];

  readonly fetchData = (params: PagerRequest): Observable<PagedData<RiskProfileDto>> =>
    this.service.list(params).pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  openCreate(): void {
    this.form.reset({
      name: '',
      maxLotSizePerTrade: 1,
      maxOpenPositions: 5,
      maxDailyTrades: 20,
      maxDailyDrawdownPct: 2.0,
      maxTotalDrawdownPct: 10.0,
      maxRiskPerTradePct: 1.0,
      maxSymbolExposurePct: 25.0,
      drawdownRecoveryThresholdPct: 5.0,
      recoveryLotSizeMultiplier: 0.5,
      recoveryExitThresholdPct: 2.0,
      isDefault: false,
    });
    this.editing.set({});
  }

  openEdit(row: RiskProfileDto): void {
    this.form.reset({
      name: row.name ?? '',
      maxLotSizePerTrade: row.maxLotSizePerTrade,
      maxOpenPositions: row.maxOpenPositions,
      maxDailyTrades: row.maxDailyTrades,
      maxDailyDrawdownPct: row.maxDailyDrawdownPct,
      maxTotalDrawdownPct: row.maxTotalDrawdownPct,
      maxRiskPerTradePct: row.maxRiskPerTradePct,
      maxSymbolExposurePct: row.maxSymbolExposurePct,
      drawdownRecoveryThresholdPct: row.drawdownRecoveryThresholdPct,
      recoveryLotSizeMultiplier: row.recoveryLotSizeMultiplier,
      recoveryExitThresholdPct: row.recoveryExitThresholdPct,
      isDefault: row.isDefault,
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
    const payload = {
      name: v.name,
      maxLotSizePerTrade: v.maxLotSizePerTrade,
      maxDailyDrawdownPct: v.maxDailyDrawdownPct,
      maxTotalDrawdownPct: v.maxTotalDrawdownPct,
      maxOpenPositions: v.maxOpenPositions,
      maxDailyTrades: v.maxDailyTrades,
      maxRiskPerTradePct: v.maxRiskPerTradePct,
      maxSymbolExposurePct: v.maxSymbolExposurePct,
      drawdownRecoveryThresholdPct: v.drawdownRecoveryThresholdPct,
      recoveryLotSizeMultiplier: v.recoveryLotSizeMultiplier,
      recoveryExitThresholdPct: v.recoveryExitThresholdPct,
      isDefault: v.isDefault,
    };
    const op =
      editing && 'id' in editing && editing.id != null
        ? this.service.update(editing.id, payload as UpdateRiskProfileRequest)
        : this.service.create(payload as CreateRiskProfileRequest);
    op.subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(
            editing && 'id' in editing ? 'Profile updated' : 'Profile created',
          );
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
          this.notifications.success('Profile deleted');
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
