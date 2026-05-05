import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { map, Observable } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';

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
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
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
    MetricCardComponent,
    ChartCardComponent,
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

      <!-- 8-card KPI strip -->
      <div class="cp-kpis">
        <app-metric-card
          label="Total pairs"
          [value]="cpStats().total"
          format="number"
          dotColor="#0071E3"
        />
        <app-metric-card
          label="Active"
          [value]="cpStats().active"
          format="number"
          dotColor="#34C759"
        />
        <app-metric-card
          label="Inactive"
          [value]="cpStats().inactive"
          format="number"
          [dotColor]="cpStats().inactive > 0 ? '#FF9500' : '#34C759'"
        />
        <app-metric-card
          label="Base currencies"
          [value]="cpStats().baseCurrencies"
          format="number"
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Quote currencies"
          [value]="cpStats().quoteCurrencies"
          format="number"
          dotColor="#5AC8FA"
        />
        <app-metric-card
          label="JPY pairs"
          [value]="cpStats().jpyPairs"
          format="number"
          dotColor="#FF9500"
        />
        <app-metric-card
          label="USD pairs"
          [value]="cpStats().usdPairs"
          format="number"
          dotColor="#FF2D55"
        />
        <app-metric-card
          label="Avg max lot"
          [value]="cpStats().avgMaxLot"
          format="number"
          dotColor="#30D158"
        />
      </div>

      <!-- 3-col chart row: by base, by quote, currency exposure -->
      <div class="cp-charts">
        <app-chart-card
          title="Pairs by base currency"
          subtitle="How many pairs use each currency as the base"
          [options]="byBaseOptions()"
          height="260px"
        />
        <app-chart-card
          title="Pairs by quote currency"
          subtitle="How many pairs use each currency as the quote"
          [options]="byQuoteOptions()"
          height="260px"
        />
        <app-chart-card
          title="Currency exposure"
          subtitle="Total appearances (base + quote) per currency"
          [options]="exposureOptions()"
          height="260px"
        />
      </div>

      <!-- Currency exposure matrix -->
      @if (exposureRows().length > 0) {
        <section class="cp-matrix">
          <header class="cp-matrix-head">
            <h3>Currency exposure matrix</h3>
            <span class="muted">Sorted by total appearances</span>
          </header>
          <table class="cp-matrix-table">
            <thead>
              <tr>
                <th>Currency</th>
                <th class="num">As base</th>
                <th class="num">As quote</th>
                <th class="num">Total pairs</th>
                <th class="num">Active pairs</th>
                <th>Pairs</th>
              </tr>
            </thead>
            <tbody>
              @for (row of exposureRows(); track row.currency) {
                <tr>
                  <td class="mono">{{ row.currency }}</td>
                  <td class="num mono">{{ row.asBase }}</td>
                  <td class="num mono">{{ row.asQuote }}</td>
                  <td class="num mono">{{ row.total }}</td>
                  <td class="num mono">{{ row.activeCount }}</td>
                  <td class="cp-pair-list">
                    @for (sym of row.pairs; track sym) {
                      <span class="cp-pill">{{ sym }}</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
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

      /* Currency-pairs density additions */
      .cp-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .cp-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .cp-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .cp-charts {
        display: grid;
        grid-template-columns: 1fr 1fr 1.4fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .cp-charts {
          grid-template-columns: 1fr;
        }
      }

      .cp-matrix {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .cp-matrix-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .cp-matrix-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .cp-matrix-head .muted,
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .cp-matrix-table {
        width: 100%;
        border-collapse: collapse;
      }
      .cp-matrix-table th,
      .cp-matrix-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .cp-matrix-table tbody tr:last-child td {
        border-bottom: none;
      }
      .cp-matrix-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .cp-matrix-table th.num,
      .cp-matrix-table td.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .cp-matrix-table .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .cp-pair-list {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .cp-pill {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 10.5px;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ],
})
export class CurrencyPairsPageComponent implements OnInit {
  private readonly service = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  @ViewChild('table') table?: DataTableComponent<CurrencyPairDto>;

  readonly editing = signal<CurrencyPairDto | Partial<CurrencyPairDto> | null>(null);
  readonly busy = signal(false);
  readonly showDeleteDialog = signal(false);

  // Analytics sample, separate from the paged table source so KPIs/charts
  // stay stable as the user pages or filters the grid.
  readonly pairsSample = signal<CurrencyPairDto[]>([]);

  cpStats = computed(() => {
    const rows = this.pairsSample();
    if (rows.length === 0) {
      return {
        total: 0,
        active: 0,
        inactive: 0,
        baseCurrencies: 0,
        quoteCurrencies: 0,
        jpyPairs: 0,
        usdPairs: 0,
        avgMaxLot: null as number | null,
      };
    }
    const baseSet = new Set<string>();
    const quoteSet = new Set<string>();
    let active = 0;
    let jpy = 0;
    let usd = 0;
    let lotSum = 0;
    for (const r of rows) {
      if (r.baseCurrency) baseSet.add(r.baseCurrency);
      if (r.quoteCurrency) quoteSet.add(r.quoteCurrency);
      if (r.isActive) active++;
      if ((r.symbol ?? '').includes('JPY')) jpy++;
      if (r.baseCurrency === 'USD' || r.quoteCurrency === 'USD') usd++;
      lotSum += r.maxLotSize ?? 0;
    }
    return {
      total: rows.length,
      active,
      inactive: rows.length - active,
      baseCurrencies: baseSet.size,
      quoteCurrencies: quoteSet.size,
      jpyPairs: jpy,
      usdPairs: usd,
      avgMaxLot: +(lotSum / rows.length).toFixed(2),
    };
  });

  byBaseOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const r of this.pairsSample()) {
      const k = r.baseCurrency ?? '—';
      map[k] = (map[k] ?? 0) + 1;
    }
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: entries.map(([k]) => k),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: entries.map(([, v]) => ({
            value: v,
            itemStyle: { color: '#AF52DE', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  byQuoteOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const r of this.pairsSample()) {
      const k = r.quoteCurrency ?? '—';
      map[k] = (map[k] ?? 0) + 1;
    }
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: entries.map(([k]) => k),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: entries.map(([, v]) => ({
            value: v,
            itemStyle: { color: '#5AC8FA', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  exposureRows = computed(() => {
    type Row = {
      currency: string;
      asBase: number;
      asQuote: number;
      total: number;
      activeCount: number;
      pairs: string[];
    };
    const rows: Record<string, Row> = {};
    for (const p of this.pairsSample()) {
      const sym = p.symbol ?? '';
      const ensure = (c: string): Row => {
        if (!rows[c])
          rows[c] = { currency: c, asBase: 0, asQuote: 0, total: 0, activeCount: 0, pairs: [] };
        return rows[c];
      };
      if (p.baseCurrency) {
        const r = ensure(p.baseCurrency);
        r.asBase++;
        r.total++;
        if (p.isActive) r.activeCount++;
        if (sym && !r.pairs.includes(sym)) r.pairs.push(sym);
      }
      if (p.quoteCurrency) {
        const r = ensure(p.quoteCurrency);
        r.asQuote++;
        r.total++;
        if (p.isActive) r.activeCount++;
        if (sym && !r.pairs.includes(sym)) r.pairs.push(sym);
      }
    }
    return Object.values(rows).sort((a, b) => b.total - a.total);
  });

  exposureOptions = computed<EChartsOption>(() => {
    const rows = this.exposureRows();
    if (rows.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 50 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.currency),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { top: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          name: 'As base',
          type: 'bar',
          stack: 'exp',
          data: rows.map((r) => r.asBase),
          itemStyle: { color: '#AF52DE' },
          barWidth: '50%',
        },
        {
          name: 'As quote',
          type: 'bar',
          stack: 'exp',
          data: rows.map((r) => r.asQuote),
          itemStyle: { color: '#5AC8FA' },
          barWidth: '50%',
          label: {
            show: true,
            position: 'top',
            fontSize: 10,
            color: '#6E6E73',
            formatter: (p: any) => String(rows[p.dataIndex].total),
          },
        },
      ],
    };
  });

  ngOnInit(): void {
    this.loadPairsSample();
  }

  private loadPairsSample(): void {
    this.service.list({ currentPage: 1, itemCountPerPage: 200, filter: null }).subscribe({
      next: (res) => {
        if (res?.data?.data) this.pairsSample.set(res.data.data);
      },
    });
  }

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
    { headerName: 'Symbol', field: 'symbol', flex: 1, minWidth: 110 },
    { headerName: 'Base', field: 'baseCurrency', width: 90 },
    { headerName: 'Quote', field: 'quoteCurrency', width: 90 },
    {
      headerName: 'Class',
      field: 'symbol',
      width: 100,
      valueGetter: (p: any) => this.classifyPair(p.data),
      cellRenderer: (p: { value: string }) => {
        const map: Record<string, { bg: string; color: string }> = {
          Major: { bg: 'rgba(52,199,89,0.12)', color: '#248A3D' },
          Cross: { bg: 'rgba(0,113,227,0.12)', color: '#0040DD' },
          Exotic: { bg: 'rgba(255,149,0,0.12)', color: '#C93400' },
          Other: { bg: 'rgba(142,142,147,0.12)', color: '#636366' },
        };
        const v = map[p.value] ?? map['Other'];
        return `<span style="background:${v.bg};color:${v.color};padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600">${p.value}</span>`;
      },
    },
    { headerName: 'Digits', field: 'decimalPlaces', width: 80 },
    {
      headerName: 'Pip size',
      field: 'decimalPlaces',
      width: 100,
      valueFormatter: (p: any) => {
        const d = p.value as number;
        if (d == null) return '—';
        // FX pip = 10^-(digits-1) for 5/3-digit feeds; 10^-digits otherwise.
        return Math.pow(10, -(d > 0 ? d - 1 : 0)).toFixed(d > 0 ? d - 1 : 0);
      },
    },
    {
      headerName: 'Contract Size',
      field: 'contractSize',
      width: 120,
      valueFormatter: (p) => (p.value as number)?.toLocaleString() ?? '-',
    },
    {
      headerName: 'Min Lot',
      field: 'minLotSize',
      width: 90,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Max Lot',
      field: 'maxLotSize',
      width: 90,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Step',
      field: 'lotStep',
      width: 90,
      valueFormatter: (p) => (p.value as number)?.toFixed(2) ?? '-',
    },
    {
      headerName: 'Lot range',
      field: 'maxLotSize',
      width: 110,
      valueGetter: (p: any) =>
        (p.data?.maxLotSize ?? 0) > 0
          ? Math.round((p.data.maxLotSize - (p.data.minLotSize ?? 0)) / (p.data.lotStep || 1))
          : 0,
      headerTooltip: 'Number of distinct lot sizes between min and max',
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

  // Major: USD vs EUR/GBP/JPY/CHF/AUD/NZD/CAD. Cross: two majors without USD.
  // Exotic: anything else. Quick classification used by the table + KPIs.
  private readonly majorCcys = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD']);
  classifyPair(p?: CurrencyPairDto | null): string {
    if (!p) return 'Other';
    const b = p.baseCurrency ?? '';
    const q = p.quoteCurrency ?? '';
    if (b === 'USD' || q === 'USD') return 'Major';
    if (this.majorCcys.has(b) && this.majorCcys.has(q)) return 'Cross';
    return 'Exotic';
  }

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
          this.loadPairsSample();
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
          this.loadPairsSample();
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
