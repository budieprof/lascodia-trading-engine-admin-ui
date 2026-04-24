import { ChangeDetectionStrategy, Component, ViewChild, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { map, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';

import { EconomicEventsService } from '@core/services/economic-events.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  CreateEconomicEventRequest,
  EconomicEventDto,
  EconomicImpact,
  PagedData,
  PagerRequest,
} from '@core/api/api.types';

import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import {
  FormFieldComponent,
  FormFieldControlDirective,
} from '@shared/components/form-field/form-field.component';

@Component({
  selector: 'app-economic-events-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DataTableComponent,
    PageHeaderComponent,
    ReactiveFormsModule,
    FormFieldComponent,
    FormFieldControlDirective,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Economic Events"
        subtitle="Calendar of macro releases the engine filters signals around"
      >
        <button type="button" class="btn btn-primary" (click)="openCreate()">+ Add Event</button>
      </app-page-header>

      @if (mode() === 'create') {
        <form class="panel" [formGroup]="createForm" (ngSubmit)="submitCreate()">
          <div class="panel-head">
            <h3>New Economic Event</h3>
            <button type="button" class="close" (click)="cancel()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field
              class="wide"
              label="Title"
              [required]="true"
              [control]="createForm.controls.title"
            >
              <input
                appFormFieldControl
                formControlName="title"
                placeholder="e.g. US Non-Farm Payrolls"
              />
            </app-form-field>
            <app-form-field
              label="Currency"
              [required]="true"
              [control]="createForm.controls.currency"
            >
              <input appFormFieldControl formControlName="currency" placeholder="USD" />
            </app-form-field>
            <app-form-field label="Impact" [required]="true" [control]="createForm.controls.impact">
              <select appFormFieldControl formControlName="impact">
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
              </select>
            </app-form-field>
            <app-form-field
              label="Scheduled"
              [required]="true"
              [control]="createForm.controls.scheduledAt"
            >
              <input appFormFieldControl formControlName="scheduledAt" type="datetime-local" />
            </app-form-field>
            <app-form-field label="Source" [required]="true" [control]="createForm.controls.source">
              <select appFormFieldControl formControlName="source">
                <option value="Manual">Manual</option>
                <option value="ForexFactory">ForexFactory</option>
                <option value="Investing">Investing</option>
                <option value="Oanda">Oanda</option>
              </select>
            </app-form-field>
            <app-form-field
              label="Forecast"
              hint="Optional"
              [control]="createForm.controls.forecast"
            >
              <input appFormFieldControl formControlName="forecast" placeholder="optional" />
            </app-form-field>
            <app-form-field
              label="Previous"
              hint="Optional"
              [control]="createForm.controls.previous"
            >
              <input appFormFieldControl formControlName="previous" placeholder="optional" />
            </app-form-field>
            <div class="actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancel()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || createForm.invalid"
              >
                @if (busy()) {
                  <span class="spin"></span>
                } @else {
                  Create
                }
              </button>
            </div>
          </div>
        </form>
      }

      @if (mode() === 'actual' && selectedEvent()) {
        <form class="panel" [formGroup]="actualForm" (ngSubmit)="submitActual()">
          <div class="panel-head">
            <h3>Update Actual — {{ selectedEvent()?.title }}</h3>
            <button type="button" class="close" (click)="cancel()" aria-label="Close">
              &times;
            </button>
          </div>
          <div class="panel-body">
            <app-form-field
              class="wide"
              label="Actual Value"
              [required]="true"
              [control]="actualForm.controls.actual"
            >
              <input appFormFieldControl formControlName="actual" placeholder="e.g. 275K" />
            </app-form-field>
            <div class="actions">
              <button
                type="button"
                class="btn btn-secondary"
                (click)="cancel()"
                [disabled]="busy()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="busy() || actualForm.invalid"
              >
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
        [searchable]="true"
        (rowClick)="openActual($event)"
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
      .field.wide {
        grid-column: 1 / -1;
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
export class EconomicEventsPageComponent {
  private readonly service = inject(EconomicEventsService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);
  private readonly datePipe = new DatePipe('en-US');

  @ViewChild('table') table?: DataTableComponent<EconomicEventDto>;

  readonly mode = signal<'idle' | 'create' | 'actual'>('idle');
  readonly busy = signal(false);
  readonly selectedEvent = signal<EconomicEventDto | null>(null);

  readonly createForm = this.fb.nonNullable.group({
    title: ['', Validators.required],
    currency: ['USD', Validators.required],
    impact: ['Medium' as EconomicImpact, Validators.required],
    scheduledAt: ['', Validators.required],
    source: ['Manual', Validators.required],
    forecast: [''],
    previous: [''],
  });

  readonly actualForm = this.fb.nonNullable.group({
    actual: ['', Validators.required],
  });

  readonly columns: ColDef<EconomicEventDto>[] = [
    { headerName: 'Title', field: 'title', flex: 2, minWidth: 240 },
    { headerName: 'Currency', field: 'currency', width: 110 },
    {
      headerName: 'Impact',
      field: 'impact',
      width: 110,
      cellRenderer: (p: { value: unknown }) => {
        const v = String(p.value ?? '');
        const palette: Record<string, { bg: string; color: string }> = {
          High: { bg: 'rgba(255,59,48,0.12)', color: '#D70015' },
          Medium: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
          Low: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
        };
        const s = palette[v] ?? palette['Low'];
        return `<span style="background:${s.bg};color:${s.color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${v}</span>`;
      },
    },
    { headerName: 'Forecast', field: 'forecast', width: 130 },
    { headerName: 'Previous', field: 'previous', width: 130 },
    {
      headerName: 'Actual',
      field: 'actual',
      width: 130,
      valueFormatter: (p) => (p.value as string) ?? '—',
      cellStyle: (p) => (p.value ? { fontWeight: 600 } : null),
    },
    {
      headerName: 'Scheduled',
      field: 'scheduledAt',
      width: 170,
      valueFormatter: (p) => this.datePipe.transform(p.value as string, 'MMM d, HH:mm') ?? '-',
    },
    { headerName: 'Source', field: 'source', width: 130 },
  ];

  readonly fetchData = (params: PagerRequest): Observable<PagedData<EconomicEventDto>> =>
    this.service.list(params).pipe(map((r) => r.data ?? { pager: emptyPager(), data: [] }));

  openCreate(): void {
    this.createForm.reset({
      title: '',
      currency: 'USD',
      impact: 'Medium',
      scheduledAt: '',
      source: 'Manual',
      forecast: '',
      previous: '',
    });
    this.mode.set('create');
  }

  openActual(row: EconomicEventDto): void {
    this.selectedEvent.set(row);
    this.actualForm.reset({ actual: row.actual ?? '' });
    this.mode.set('actual');
  }

  cancel(): void {
    this.mode.set('idle');
    this.selectedEvent.set(null);
  }

  submitCreate(): void {
    const v = this.createForm.getRawValue();
    this.busy.set(true);
    const request: CreateEconomicEventRequest = {
      title: v.title,
      currency: v.currency,
      impact: v.impact,
      scheduledAt: new Date(v.scheduledAt).toISOString(),
      source: v.source,
      forecast: v.forecast || null,
      previous: v.previous || null,
    };
    this.service.create(request).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success('Event created');
          this.cancel();
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Create failed');
        }
      },
      error: () => this.busy.set(false),
    });
  }

  submitActual(): void {
    const event = this.selectedEvent();
    if (!event) return;
    const v = this.actualForm.getRawValue();
    this.busy.set(true);
    this.service.updateActual(event.id, { actual: v.actual }).subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success('Actual value updated');
          this.cancel();
          this.table?.loadData();
        } else {
          this.notifications.error(res.message ?? 'Update failed');
        }
      },
      error: () => this.busy.set(false),
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
