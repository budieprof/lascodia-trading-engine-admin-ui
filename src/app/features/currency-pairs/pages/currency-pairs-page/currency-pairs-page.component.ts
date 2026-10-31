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
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
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
    ErrorStateComponent,
    EmptyStateComponent,
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

      <!-- KPI strip — six tiles so every label fits on one line. The
           "JPY pairs" and "Avg max lot" tiles were dropped: the former is
           readable off the base/quote charts, the latter averaged a
           broker-imposed cap and answered no operator question. -->
      <!-- Tiles read "—" while the catalogue fetch is failing: a dead
           endpoint must not look like an empty catalogue of zero pairs. -->
      <div class="cp-kpis">
        <app-metric-card
          label="Total pairs"
          [value]="sampleError() ? null : cpStats().total"
          format="number"
          dotColor="#0071E3"
          [caption]="nonPairsCaption()"
        />
        <app-metric-card
          label="Active"
          [value]="sampleError() ? null : cpStats().active"
          format="number"
          [dotColor]="cpStats().active > 0 ? '#34C759' : undefined"
          caption="tradeable now"
        />
        <app-metric-card
          label="Inactive"
          [value]="sampleError() ? null : cpStats().inactive"
          format="number"
          [dotColor]="cpStats().inactive > 0 ? '#FF9500' : undefined"
          [caption]="cpStats().inactive > 0 ? 'switched off' : 'none switched off'"
        />
        <app-metric-card
          label="Base currencies"
          [value]="sampleError() ? null : cpStats().baseCurrencies"
          format="number"
          dotColor="#AF52DE"
        />
        <app-metric-card
          label="Quote currencies"
          [value]="sampleError() ? null : cpStats().quoteCurrencies"
          format="number"
          dotColor="#5AC8FA"
        />
        <!-- FX pairs only: index CFDs (NAS100 / US500 report USD on both sides) are not pairs. -->
        <app-metric-card
          label="USD pairs (FX)"
          [value]="sampleError() ? null : cpStats().usdPairs"
          format="number"
          dotColor="#FF2D55"
          [caption]="'of ' + (cpStats().total - cpStats().nonPairs) + ' FX pairs'"
        />
      </div>

      @if (sampleError()) {
        <section class="cp-matrix">
          <app-error-state
            title="Could not load the currency-pair catalogue"
            [message]="sampleError()"
            (retry)="loadPairsSample()"
          />
        </section>
      } @else if (pairsSample().length === 0) {
        <section class="cp-matrix">
          <app-empty-state
            title="No currency pairs yet"
            description="Charts and the exposure matrix appear once the first pair is added."
            actionLabel="+ Add Pair"
            (actionClick)="openCreate()"
          />
        </section>
      } @else {
        <!-- 3-col chart row: by base, by quote, currency exposure -->
        <div class="cp-charts">
          <app-chart-card
            title="Pairs by base currency"
            subtitle="How many currency pairs use each currency as the base (indices excluded)"
            [options]="byBaseOptions()"
            height="260px"
          />
          <app-chart-card
            title="Pairs by quote currency"
            subtitle="How many currency pairs use each currency as the quote (indices excluded)"
            [options]="byQuoteOptions()"
            height="260px"
          />
          <app-chart-card
            title="Currency exposure"
            subtitle="Total appearances (base + quote) per currency, currency pairs only"
            [options]="exposureOptions()"
            height="260px"
          />
        </div>

        <!-- Currency exposure matrix -->
        @if (exposureRows().length > 0) {
          <section class="cp-matrix">
            <header class="cp-matrix-head">
              <h3>Currency exposure matrix</h3>
              <span class="count-chip">{{ exposureRows().length }}</span>
              <span class="muted head-note">
                <i class="key base"></i> as base <i class="key quote"></i> as quote · sorted by
                total appearances
              </span>
            </header>
            <div class="board-scroll">
              <table class="cp-matrix-table">
                <thead>
                  <tr>
                    <th>Currency</th>
                    <th class="num">As base</th>
                    <th class="num">As quote</th>
                    <th class="mix-col">Split</th>
                    <th class="num">Total</th>
                    <th class="num">Active</th>
                    <th>Pairs</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of exposureRows(); track row.currency) {
                    <tr>
                      <td class="mono strong">{{ row.currency }}</td>
                      <td class="num" [class.zero]="row.asBase === 0">{{ row.asBase }}</td>
                      <td class="num" [class.zero]="row.asQuote === 0">{{ row.asQuote }}</td>
                      <td class="mix-col">
                        <span
                          class="mix-bar"
                          [style.width.px]="mixWidth(row.total)"
                          [title]="row.asBase + ' as base · ' + row.asQuote + ' as quote'"
                        >
                          @if (row.asBase > 0) {
                            <i class="base" [style.flex]="row.asBase"></i>
                          }
                          @if (row.asQuote > 0) {
                            <i class="quote" [style.flex]="row.asQuote"></i>
                          }
                        </span>
                      </td>
                      <td class="num strong">{{ row.total }}</td>
                      <td class="num" [class.warn]="row.activeCount < row.total">
                        {{ row.activeCount }}
                      </td>
                      <td>
                        <div class="cp-pair-list">
                          @for (sym of row.pairs; track sym) {
                            <span class="cp-pill">{{ sym }}</span>
                          }
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      }

      <div class="cp-grid">
        <app-data-table
          #table
          [columnDefs]="columns"
          [fetchData]="fetchData"
          (rowClick)="openEdit($event)"
        />
      </div>

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
  styleUrl: './currency-pairs-page.component.scss',
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
  /** Why the catalogue sample failed to load, or null. */
  readonly sampleError = signal<string | null>(null);

  /**
   * Symbols that are not currency pairs. An index CFD carries its denomination as both "base" and
   * "quote" (NAS100 = USD/USD, DE40 = EUR/EUR), so counting it as a pair labelled NAS100 a "Major",
   * made it a "USD pair" and counted USD twice in the exposure matrix (14 appearances, 12 symbols).
   */
  isNonPair(p: CurrencyPairDto): boolean {
    return p.assetClass === 'Index' || (!!p.baseCurrency && p.baseCurrency === p.quoteCurrency);
  }
  /** The catalogue minus index symbols — what the currency charts and the matrix count. */
  private readonly fxSample = computed(() => this.pairsSample().filter((p) => !this.isNonPair(p)));

  cpStats = computed(() => {
    const rows = this.pairsSample();
    if (rows.length === 0) {
      return {
        total: 0,
        active: 0,
        inactive: 0,
        baseCurrencies: 0,
        quoteCurrencies: 0,
        usdPairs: 0,
        nonPairs: 0,
      };
    }
    const baseSet = new Set<string>();
    const quoteSet = new Set<string>();
    let active = 0;
    let usd = 0;
    for (const r of rows) {
      if (r.isActive) active++;
    }
    const fx = this.fxSample();
    for (const r of fx) {
      if (r.baseCurrency) baseSet.add(r.baseCurrency);
      if (r.quoteCurrency) quoteSet.add(r.quoteCurrency);
      if (r.baseCurrency === 'USD' || r.quoteCurrency === 'USD') usd++;
    }
    return {
      total: rows.length,
      active,
      inactive: rows.length - active,
      baseCurrencies: baseSet.size,
      quoteCurrencies: quoteSet.size,
      usdPairs: usd,
      nonPairs: rows.length - fx.length,
    };
  });

  /** "+ 4 index symbols" style context for the Total pairs tile. */
  readonly nonPairsCaption = computed(() => {
    const n = this.cpStats().nonPairs;
    return n > 0 ? `incl. ${n} index symbol${n === 1 ? '' : 's'}` : 'all currency pairs';
  });

  /** Split-bar width scaled to the busiest currency, so bar length reads as exposure. */
  mixWidth(total: number): number {
    const max = this.exposureRows()[0]?.total ?? 0;
    return max > 0 ? Math.max(8, Math.round((total / max) * 100)) : 0;
  }

  /**
   * Category axis for a handful of 3-letter currency codes. `interval: 0`
   * forces every label — the theme's overlap-hiding otherwise dropped
   * labels on a 7-bar axis and left bars unidentifiable — and the codes are
   * short enough that they never actually collide at these widths.
   */
  private categoryAxis(categories: string[]): EChartsOption['xAxis'] {
    return {
      type: 'category',
      data: categories,
      axisLabel: {
        fontSize: 11,
        color: '#6E6E73',
        interval: 0,
        hideOverlap: false,
        rotate: categories.length > 9 ? 35 : 0,
      },
    };
  }

  /**
   * Count axis with headroom for the bar-top value labels — the tallest
   * bar's label was clipped by the plot edge with a tight top margin.
   */
  private countAxis(maxValue: number): EChartsOption['yAxis'] {
    return {
      type: 'value',
      minInterval: 1,
      max: Math.max(1, Math.ceil(maxValue * 1.2)),
      axisLabel: { fontSize: 10, color: '#6E6E73' },
      splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
    };
  }

  private countByCurrency(pick: (r: CurrencyPairDto) => string | null): [string, number][] {
    const map: Record<string, number> = {};
    for (const r of this.fxSample()) {
      const k = pick(r) ?? '—';
      map[k] = (map[k] ?? 0) + 1;
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }

  private countBarOptions(entries: [string, number][], color: string): EChartsOption {
    if (entries.length === 0) return {};
    return {
      grid: { top: 24, right: 20, bottom: 30, left: 40, containLabel: false },
      xAxis: this.categoryAxis(entries.map(([k]) => k)),
      yAxis: this.countAxis(Math.max(...entries.map(([, v]) => v))),
      series: [
        {
          type: 'bar',
          data: entries.map(([, v]) => ({
            value: v,
            itemStyle: { color, borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '60%',
          label: { show: true, position: 'top', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  }

  byBaseOptions = computed<EChartsOption>(() =>
    this.countBarOptions(
      this.countByCurrency((r) => r.baseCurrency),
      '#AF52DE',
    ),
  );

  byQuoteOptions = computed<EChartsOption>(() =>
    this.countBarOptions(
      this.countByCurrency((r) => r.quoteCurrency),
      '#5AC8FA',
    ),
  );

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
    for (const p of this.fxSample()) {
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
      // Legend sits in the top band; the plot starts below it so the
      // stacked-total labels have room above the tallest bar.
      grid: { top: 40, right: 20, bottom: 30, left: 40, containLabel: false },
      xAxis: this.categoryAxis(rows.map((r) => r.currency)),
      yAxis: this.countAxis(Math.max(...rows.map((r) => r.total))),
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

  loadPairsSample(): void {
    this.service.list({ currentPage: 1, itemCountPerPage: 200, filter: null }).subscribe({
      next: (res) => {
        if (res?.data?.data) {
          this.pairsSample.set(res.data.data);
          this.sampleError.set(null);
        } else {
          this.sampleError.set(res?.message || 'The engine returned no catalogue data.');
        }
      },
      error: (err: { message?: string }) =>
        this.sampleError.set(err?.message || 'Network error — is the engine reachable?'),
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
    {
      headerName: 'Symbol',
      field: 'symbol',
      flex: 1,
      minWidth: 96,
      cellStyle: { fontWeight: '600' },
    },
    { headerName: 'Base', field: 'baseCurrency', width: 70, minWidth: 70 },
    { headerName: 'Quote', field: 'quoteCurrency', width: 74, minWidth: 74 },
    {
      headerName: 'Class',
      field: 'symbol',
      width: 92,
      minWidth: 92,
      valueGetter: (p: any) => this.classifyPair(p.data),
      cellRenderer: (p: { value: string }) => {
        const map: Record<string, { bg: string; color: string }> = {
          Major: { bg: 'rgba(52,199,89,0.12)', color: 'var(--tone-green)' },
          Cross: { bg: 'rgba(0,113,227,0.12)', color: 'var(--tone-blue)' },
          Exotic: { bg: 'rgba(255,149,0,0.12)', color: 'var(--tone-amber)' },
          Index: { bg: 'rgba(175,82,222,0.14)', color: 'var(--tone-purple)' },
          Commodity: { bg: 'rgba(255,204,0,0.16)', color: 'var(--tone-amber)' },
          Crypto: { bg: 'rgba(90,200,250,0.16)', color: 'var(--tone-blue)' },
          Other: { bg: 'rgba(142,142,147,0.12)', color: 'var(--tone-grey)' },
        };
        const v = map[p.value] ?? map['Other'];
        return `<span style="background:${v.bg};color:${v.color};padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600">${p.value}</span>`;
      },
    },
    {
      headerName: 'Digits',
      field: 'decimalPlaces',
      width: 72,
      minWidth: 72,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
    },
    {
      headerName: 'Pip size',
      field: 'decimalPlaces',
      width: 88,
      minWidth: 88,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p: any) => {
        const d = p.value as number;
        if (d == null) return '—';
        // FX pip = 10^-(digits-1) for 5/3-digit feeds; 10^-digits otherwise.
        return Math.pow(10, -(d > 0 ? d - 1 : 0)).toFixed(d > 0 ? d - 1 : 0);
      },
    },
    {
      headerName: 'Contract size',
      field: 'contractSize',
      width: 132,
      minWidth: 132,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => formatCount(p.value as number | null | undefined),
    },
    {
      headerName: 'Min lot',
      field: 'minLotSize',
      width: 84,
      minWidth: 84,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => formatLots(p.value as number | null | undefined),
    },
    {
      headerName: 'Max lot',
      field: 'maxLotSize',
      width: 92,
      minWidth: 92,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => formatLots(p.value as number | null | undefined),
    },
    {
      headerName: 'Lot step',
      field: 'lotStep',
      width: 86,
      minWidth: 86,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueFormatter: (p) => formatLots(p.value as number | null | undefined),
    },
    {
      headerName: 'Lot steps',
      field: 'maxLotSize',
      width: 94,
      minWidth: 94,
      type: 'rightAligned',
      cellStyle: NUM_CELL,
      valueGetter: (p: any) =>
        (p.data?.maxLotSize ?? 0) > 0
          ? Math.round((p.data.maxLotSize - (p.data.minLotSize ?? 0)) / (p.data.lotStep || 1))
          : 0,
      valueFormatter: (p) => formatCount(p.value as number | null | undefined),
      headerTooltip: 'Number of distinct lot sizes between min and max',
    },
    {
      headerName: 'Status',
      field: 'isActive',
      width: 96,
      minWidth: 96,
      cellRenderer: (p: { value: unknown }) => {
        const active = Boolean(p.value);
        const bg = active ? 'rgba(52,199,89,0.12)' : 'rgba(142,142,147,0.12)';
        const color = active ? 'var(--tone-green)' : 'var(--tone-grey)';
        const label = active ? 'Active' : 'Inactive';
        return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${label}</span>`;
      },
    },
  ];

  /**
   * The engine's AssetClass is authoritative — it drives pip/point conventions — so it is shown
   * whenever set. The old inference ("USD on either side ⇒ Major") called NAS100, US500, USDNGN and
   * USDCNH Majors and DE40 a Cross. The inference remains only for pairs the engine left at None.
   */
  private readonly majorCcys = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD']);
  private static readonly ASSET_CLASS_LABEL: Record<string, string> = {
    FxMajor: 'Major',
    FxMinor: 'Cross',
    FxExotic: 'Exotic',
    Index: 'Index',
    Commodity: 'Commodity',
    Crypto: 'Crypto',
  };
  classifyPair(p?: CurrencyPairDto | null): string {
    if (!p) return 'Other';
    const engine = p.assetClass ? CurrencyPairsPageComponent.ASSET_CLASS_LABEL[p.assetClass] : null;
    if (engine) return engine;
    if (this.isNonPair(p)) return 'Index';
    const b = p.baseCurrency ?? '';
    const q = p.quoteCurrency ?? '';
    if (b === 'XAU' || b === 'XAG' || b === 'XPT' || b === 'XPD') return 'Commodity';
    if (!this.majorCcys.has(b) || !this.majorCcys.has(q)) return 'Exotic';
    return b === 'USD' || q === 'USD' ? 'Major' : 'Cross';
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

/**
 * Numeric cells: tabular figures so digits line up down the column. The theme makes .ag-cell a
 * flex row, so the rightAligned type's text-align alone never moved the value — justify it too.
 */
const NUM_CELL = { fontVariantNumeric: 'tabular-nums', justifyContent: 'flex-end' };

/* One number format per page: counts get thousands separators, lot sizes
   get separators plus exactly two decimals — "100,000" beside "49999" and
   "500.00" beside "0.01" came from three formatters on one table. */
const COUNT_FMT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const LOTS_FMT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
function formatCount(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : COUNT_FMT.format(v);
}
function formatLots(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : LOTS_FMT.format(v);
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
