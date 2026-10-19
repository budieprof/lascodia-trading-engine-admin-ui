import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { Observable, catchError, map, of } from 'rxjs';
import type { ColDef } from 'ag-grid-community';
import type { EChartsOption } from 'echarts';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { DataTableComponent } from '@shared/components/data-table/data-table.component';
import { MarketDataService } from '@core/services/market-data.service';
import type { CandleDto, PagedData, PagerRequest, ResponseData } from '@core/api/api.types';

/** The timeframes the engine stores (its `Timeframe` enum) — anything else is refused with -11. */
const STORED_TIMEFRAMES = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'] as const;
const SAMPLE_BARS = 200;

/**
 * The Market Data page's Candle History tab: one stored series — a symbol at a timeframe — read
 * from `market-data/candle/list`, with analytics over its latest {@link SAMPLE_BARS} bars and the
 * full paged history below.
 *
 * The engine answers that endpoint only for a symbol AND a timeframe (`GetCandlesQuery` returns
 * -11 without a timeframe and matches `Symbol == null` without a symbol). The tab used to send
 * `filter: null` for a cross-symbol "sample", got nothing back on every load, and told the
 * operator to check the EA's backfill — on a database holding years of bars.
 */
@Component({
  selector: 'app-candle-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ChartCardComponent, MetricCardComponent, DataTableComponent],
  template: `
    <div class="series-bar">
      <label>
        <span>Symbol</span>
        <select [value]="symbol()" (change)="symbol.set(asValue($event))">
          @for (s of symbols(); track s) {
            <option [value]="s" [selected]="s === symbol()">{{ s }}</option>
          }
        </select>
      </label>
      <label>
        <span>Timeframe</span>
        <select [value]="timeframe()" (change)="timeframe.set(asValue($event))">
          @for (tf of timeframes; track tf) {
            <option [value]="tf" [selected]="tf === timeframe()">{{ tf }}</option>
          }
        </select>
      </label>
      <span class="muted">
        @if (loading()) {
          Loading…
        } @else if (stats(); as s) {
          Latest {{ s.total }} stored bars · {{ formatUtcMinute(s.firstAt) }} →
          {{ formatUtcMinute(s.lastAt) }} UTC
        }
      </span>
    </div>

    @if (error(); as e) {
      <div class="notice warn" role="status">{{ e }}</div>
    } @else if (!loading() && sample().length === 0) {
      <div class="notice" role="status">
        <span>
          No stored {{ timeframe() }} candles for {{ symbol() }}. The coverage probe shows where a
          series has gaps.
        </span>
        <a class="link-btn" routerLink="/market-data/coverage">Candle coverage →</a>
      </div>
    }

    @if (stats(); as s) {
      <div class="kpi-strip">
        <app-metric-card label="Bars in sample" [value]="s.total" dotColor="#0071E3" />
        <app-metric-card
          label="Bullish %"
          [value]="s.bullPct"
          format="percent"
          [dotColor]="s.bullPct >= 50 ? '#34C759' : '#FF3B30'"
        />
        <app-metric-card
          label="Net change %"
          [value]="s.netChangePct"
          format="percent"
          [colorByValue]="true"
          dotColor="#AF52DE"
        />
        <app-metric-card label="Avg range (pips)" [value]="s.avgRangePips" dotColor="#FF9500" />
        <app-metric-card label="Max range (pips)" [value]="s.maxRangePips" dotColor="#FF2D55" />
        <app-metric-card label="Avg volume" [value]="s.avgVolume" dotColor="#34C759" />
      </div>

      <div class="charts-grid">
        <app-chart-card
          title="Bull vs Bear"
          subtitle="Direction of each bar in the sample"
          [options]="bullBearOptions()"
          height="260px"
        />
        <app-chart-card
          title="Range distribution"
          subtitle="High–low range per bar, in pips"
          [options]="rangeHistogramOptions()"
          height="260px"
        />
      </div>

      <section class="card">
        <header class="card-head">
          <h3>Largest bars in the sample</h3>
          <span class="muted">By body % (open → close)</span>
        </header>
        <table class="board-table">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th class="num">Open</th>
              <th class="num">Close</th>
              <th class="num">Δ pips</th>
              <th class="num">Body %</th>
            </tr>
          </thead>
          <tbody>
            @for (c of notable(); track c.id) {
              <tr>
                <td class="mono">{{ formatUtcMinute(c.timestamp) }}</td>
                <td class="num mono">{{ formatPrice()(c.open, c.symbol) }}</td>
                <td class="num mono">{{ formatPrice()(c.close, c.symbol) }}</td>
                <td
                  class="num mono"
                  [class.profit]="c.deltaPips > 0"
                  [class.loss]="c.deltaPips < 0"
                >
                  {{ c.deltaPips >= 0 ? '+' : '' }}{{ c.deltaPips.toFixed(1) }}
                </td>
                <td class="num mono" [class.profit]="c.bodyPct > 0" [class.loss]="c.bodyPct < 0">
                  {{ c.bodyPct >= 0 ? '+' : '' }}{{ c.bodyPct.toFixed(2) }}%
                </td>
              </tr>
            }
          </tbody>
        </table>
      </section>
    }

    <section class="card">
      <header class="card-head">
        <h3>All {{ symbol() }} {{ timeframe() }} candles</h3>
        <span class="muted">Newest first · the engine's stored history</span>
      </header>
      <!-- Keyed on the series so a new symbol/timeframe starts a fresh table on page 1. -->
      @for (key of [seriesKey()]; track key) {
        <app-data-table
          [columnDefs]="columns"
          [fetchData]="fetchCandles"
          [searchable]="false"
          stateKey=""
          emptyTitle="No candles stored"
          [emptyDescription]="null"
        />
      }
    </section>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .series-bar {
        display: flex;
        align-items: flex-end;
        flex-wrap: wrap;
        gap: var(--space-3);
      }
      .series-bar label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .series-bar select {
        min-width: 120px;
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .notice {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-4);
        border-radius: var(--radius-sm);
        border: 1px solid rgba(0, 113, 227, 0.25);
        background: rgba(0, 113, 227, 0.06);
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
      .notice.warn {
        border-color: rgba(255, 149, 0, 0.4);
        background: rgba(255, 149, 0, 0.1);
      }
      .link-btn {
        flex-shrink: 0;
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        text-decoration: none;
        white-space: nowrap;
      }
      .kpi-strip {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: var(--space-2);
      }
      .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--space-4);
      }
      @media (max-width: 1100px) {
        .kpi-strip {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        .charts-grid {
          grid-template-columns: 1fr;
        }
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .card-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .card-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .board-table {
        width: 100%;
        border-collapse: collapse;
      }
      .board-table th,
      .board-table td {
        padding: 8px var(--space-3);
        text-align: left;
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .board-table tbody tr:last-child td {
        border-bottom: none;
      }
      .board-table th {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .board-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono, 'SF Mono', monospace);
      }
      .profit {
        color: var(--profit);
      }
      .loss {
        color: var(--loss);
      }
    `,
  ],
})
export class CandleHistoryComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly destroyRef = inject(DestroyRef);

  /** Watched symbols in the engine's form ("EURUSD"). */
  readonly symbols = input.required<readonly string[]>();
  /** The series to open on — the main chart's symbol ("EUR/USD" or "EURUSD") and timeframe. */
  readonly initialSymbol = input<string>('EURUSD');
  readonly initialTimeframe = input<string>('H1');
  /** The page's pip rule (catalogue- and broker-aware) and price formatter, so both tabs agree. */
  readonly pipFactor = input.required<(symbol: string | null) => number>();
  readonly formatPrice = input.required<(price: number, symbol: string | null) => string>();

  protected readonly timeframes = STORED_TIMEFRAMES;

  readonly symbol = linkedSignal(() => this.initialSymbol().replace('/', '').toUpperCase());
  readonly timeframe = linkedSignal(() => {
    const tf = this.initialTimeframe().toUpperCase();
    return (STORED_TIMEFRAMES as readonly string[]).includes(tf) ? tf : 'H1';
  });
  protected readonly seriesKey = computed(() => `${this.symbol()}|${this.timeframe()}`);

  readonly sample = signal<CandleDto[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const symbol = this.symbol();
      const timeframe = this.timeframe();
      untracked(() => this.loadSample(symbol, timeframe));
    });
  }

  protected asValue(ev: Event): string {
    return (ev.target as HTMLSelectElement).value;
  }

  private loadSample(symbol: string, timeframe: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.marketData
      .listCandles(
        { currentPage: 1, itemCountPerPage: SAMPLE_BARS, filter: { symbol, timeframe } },
        { silent: true },
      )
      .pipe(
        catchError(() => of(null)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        // A reply for a series the operator has already left is dropped.
        if (symbol !== this.symbol() || timeframe !== this.timeframe()) return;
        this.loading.set(false);
        if (!res) {
          this.error.set('Could not load candles — the engine did not answer.');
          this.sample.set([]);
        } else if (!res.status) {
          this.error.set(res.message || 'The engine refused the candle query.');
          this.sample.set([]);
        } else {
          // The engine returns newest first; the analytics read oldest → newest.
          this.sample.set([...(res.data?.data ?? [])].reverse());
        }
      });
  }

  readonly stats = computed(() => {
    const candles = this.sample();
    if (candles.length === 0) return null;
    const pip = this.pipFactor()(this.symbol());
    let bull = 0;
    let bear = 0;
    let totalRange = 0;
    let maxRange = 0;
    let totalVolume = 0;
    for (const c of candles) {
      if (c.close > c.open) bull++;
      else if (c.close < c.open) bear++;
      const r = (c.high - c.low) * pip;
      totalRange += r;
      if (r > maxRange) maxRange = r;
      totalVolume += c.volume ?? 0;
    }
    const first = candles[0];
    const last = candles[candles.length - 1];
    return {
      total: candles.length,
      bullPct: (bull / candles.length) * 100,
      bearPct: (bear / candles.length) * 100,
      netChangePct: first.open > 0 ? ((last.close - first.open) / first.open) * 100 : 0,
      avgRangePips: +(totalRange / candles.length).toFixed(1),
      maxRangePips: +maxRange.toFixed(1),
      avgVolume: Math.round(totalVolume / candles.length),
      firstAt: first.timestamp,
      lastAt: last.timestamp,
    };
  });

  readonly bullBearOptions = computed<EChartsOption>(() => {
    const s = this.stats();
    if (!s) return {};
    const dojiPct = Math.max(0, 100 - s.bullPct - s.bearPct);
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c}%' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data: [
            { value: +s.bullPct.toFixed(1), name: 'Bullish', itemStyle: { color: '#34C759' } },
            { value: +s.bearPct.toFixed(1), name: 'Bearish', itemStyle: { color: '#FF3B30' } },
            { value: +dojiPct.toFixed(1), name: 'Doji', itemStyle: { color: '#8E8E93' } },
          ],
        },
      ],
    };
  });

  readonly rangeHistogramOptions = computed<EChartsOption>(() => {
    const candles = this.sample();
    if (candles.length === 0) return {};
    const pip = this.pipFactor()(this.symbol());
    const ranges = candles.map((c) => (c.high - c.low) * pip);
    const max = Math.max(...ranges);
    const bins = 16;
    const width = max > 0 ? max / bins : 1;
    const counts = new Array<number>(bins).fill(0);
    for (const r of ranges) counts[Math.min(Math.floor(r / width), bins - 1)]++;
    const digits = width < 1 ? 1 : 0;
    return {
      grid: { top: 10, right: 20, bottom: 30, left: 40 },
      tooltip: {
        trigger: 'axis',
        formatter: (p: unknown) => {
          const first = (p as { name: string; value: number }[])[0];
          return `${first.name} pips<br/>${first.value} bars`;
        },
      },
      xAxis: {
        type: 'category',
        data: counts.map(
          (_, i) => `${(i * width).toFixed(digits)}–${((i + 1) * width).toFixed(digits)}`,
        ),
        axisLabel: { fontSize: 9, color: '#6E6E73', hideOverlap: true },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      series: [
        {
          type: 'bar',
          data: counts.map((value) => ({
            value,
            itemStyle: { color: '#FF9500', borderRadius: [4, 4, 0, 0] },
          })),
          barWidth: '80%',
        },
      ],
    };
  });

  /** The eight bars with the largest body, either direction. */
  readonly notable = computed(() => {
    const pip = this.pipFactor()(this.symbol());
    return this.sample()
      .map((c) => ({
        ...c,
        deltaPips: (c.close - c.open) * pip,
        bodyPct: c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0,
      }))
      .sort((a, b) => Math.abs(b.bodyPct) - Math.abs(a.bodyPct))
      .slice(0, 8);
  });

  /**
   * The table's pager, with the series as the filter. The engine always returns newest first
   * and has no free-text search, so the table offers neither sorting nor a search box.
   */
  readonly fetchCandles = (params: PagerRequest): Observable<PagedData<CandleDto>> => {
    const empty: PagedData<CandleDto> = {
      pager: {
        totalItemCount: 0,
        currentPage: params.currentPage ?? 1,
        itemCountPerPage: params.itemCountPerPage ?? 25,
        pageNo: 0,
        pageSize: params.itemCountPerPage ?? 25,
        filter: null,
      },
      data: [],
    };
    return this.marketData
      .listCandles(
        { ...params, filter: { symbol: this.symbol(), timeframe: this.timeframe() } },
        { silent: true },
      )
      .pipe(
        map((res: ResponseData<PagedData<CandleDto>>) =>
          res.status && res.data ? res.data : empty,
        ),
        catchError(() => of(empty)),
      );
  };

  readonly columns: ColDef[] = [
    {
      field: 'timestamp',
      headerName: 'Time (UTC)',
      sortable: false,
      flex: 1,
      valueFormatter: (p: { value: string }) => this.formatUtcMinute(p.value),
    },
    ...(['open', 'high', 'low', 'close'] as const).map(
      (field): ColDef => ({
        field,
        headerName: field[0].toUpperCase() + field.slice(1),
        sortable: false,
        width: 120,
        cellClass: 'ag-right-aligned-cell',
        valueFormatter: (p: { value: number | null; data?: CandleDto }) =>
          p.value == null ? '—' : this.formatPrice()(p.value, p.data?.symbol ?? null),
      }),
    ),
    {
      field: 'volume',
      headerName: 'Volume',
      sortable: false,
      width: 110,
      cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p: { value: number | null }) =>
        p.value == null ? '—' : p.value.toLocaleString('en-US'),
    },
    {
      field: 'spreadPoints',
      headerName: 'Spread (pts)',
      sortable: false,
      width: 110,
      cellClass: 'ag-right-aligned-cell',
      valueFormatter: (p: { value: number | null | undefined }) =>
        p.value == null ? '—' : String(p.value),
    },
    {
      field: 'isClosed',
      headerName: 'Bar',
      sortable: false,
      width: 100,
      valueFormatter: (p: { value: boolean }) => (p.value ? 'Closed' : 'Forming'),
    },
  ];

  /** yyyy-MM-dd HH:mm in UTC — the one timestamp format on the tab. */
  formatUtcMinute(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
    );
  }
}
