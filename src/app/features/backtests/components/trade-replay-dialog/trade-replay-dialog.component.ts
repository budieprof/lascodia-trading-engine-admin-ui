import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, of, switchMap } from 'rxjs';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';

import { MarketDataService } from '@core/services/market-data.service';
import type { CandleDto } from '@core/api/api.types';

// Local representation matches the parent page's parsed trade row.
export interface ReplayTrade {
  Direction: number; // 0 = Buy/Long, 1 = Sell/Short
  EntryPrice: number;
  ExitPrice: number;
  LotSize: number;
  PnL: number;
  EntryTime: string;
  ExitTime: string;
  ExitReason: number; // 0 = SL, 1 = TP, 2 = EndOfData
  StopLoss?: number | null;
  TakeProfit?: number | null;
  // Optional 1-based row index from the parent table so the header reads "Trade #N".
  index?: number;
}

const EXIT_LABEL: Record<number, string> = {
  0: 'Stop Loss',
  1: 'Take Profit',
  2: 'End of Data',
};

const TIMEFRAME_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  H1: 60,
  H4: 240,
  D1: 1440,
};

@Component({
  selector: 'app-trade-replay-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective, DatePipe, DecimalPipe],
  template: `
    <dialog
      #nativeDialog
      class="dialog"
      aria-labelledby="trade-replay-title"
      (close)="onNativeDialogClose()"
      (click)="onBackdropClick($event)"
    >
      <div class="dialog-inner" role="document" (click)="$event.stopPropagation()">
        @if (trade(); as t) {
          <header class="dialog-head">
            <div class="head-left">
              <h3 id="trade-replay-title">
                Trade
                @if (t.index) {
                  #{{ t.index }}
                }
                · {{ symbol() }} · {{ timeframe() }}
              </h3>
              <div class="head-meta">
                <span
                  class="pill"
                  [class.long]="t.Direction === 0"
                  [class.short]="t.Direction === 1"
                >
                  {{ t.Direction === 0 ? 'LONG' : 'SHORT' }}
                </span>
                <span class="muted">{{ t.LotSize }} lots</span>
                <span class="muted">·</span>
                <span class="muted"
                  >{{ t.EntryTime | date: 'MMM d, HH:mm' }} →
                  {{ t.ExitTime | date: 'MMM d, HH:mm' }}</span
                >
                <span class="muted">·</span>
                <span class="muted">{{ durationLabel() }}</span>
                <span class="muted">·</span>
                <span class="pill exit" [class]="exitClass(t.ExitReason)">
                  {{ exitLabel(t.ExitReason) }}
                </span>
              </div>
            </div>
            <button type="button" class="btn-close" (click)="close()" aria-label="Close">×</button>
          </header>

          <div class="kpis">
            <div class="kpi">
              <span class="kpi-label">Entry</span>
              <span class="kpi-value mono">{{ t.EntryPrice | number: '1.5-5' }}</span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Exit</span>
              <span class="kpi-value mono">{{ t.ExitPrice | number: '1.5-5' }}</span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Stop-Loss</span>
              <span class="kpi-value mono">{{
                t.StopLoss !== null ? (t.StopLoss | number: '1.5-5') : '—'
              }}</span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Take-Profit</span>
              <span class="kpi-value mono">{{
                t.TakeProfit !== null ? (t.TakeProfit | number: '1.5-5') : '—'
              }}</span>
            </div>
            <div class="kpi">
              <span class="kpi-label">R:R Setup</span>
              <span class="kpi-value mono">{{ riskReward() ?? '—' }}</span>
            </div>
            <div class="kpi">
              <span class="kpi-label">Realised P&L</span>
              <span class="kpi-value mono" [class.gain]="t.PnL > 0" [class.loss]="t.PnL < 0">
                {{ t.PnL >= 0 ? '+' : '' }}{{ t.PnL | number: '1.2-2' }}
              </span>
            </div>
          </div>

          @if (loading()) {
            <div class="chart-placeholder">Loading candles around the trade window…</div>
          } @else if (loadError()) {
            <div class="chart-placeholder error">{{ loadError() }}</div>
          } @else if (candles().length === 0) {
            <div class="chart-placeholder">
              No candles in the database for this window. The trade ran on data the engine had at
              backtest time, but those candles aren't in the live candle store.
            </div>
          } @else {
            <div class="chart-wrap">
              <div
                echarts
                [options]="chartOptions()"
                class="chart"
                (chartInit)="onChartInit($event)"
              ></div>
            </div>
          }
        }
      </div>
    </dialog>
  `,
  styles: [
    `
      .dialog {
        max-width: 1100px;
        width: calc(100vw - var(--space-6));
        max-height: calc(100vh - var(--space-6));
        padding: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      }
      .dialog::backdrop {
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(2px);
      }
      .dialog-inner {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-5);
      }
      .dialog-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-4);
      }
      .head-left {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .head-left h3 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .head-meta {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
        flex-wrap: wrap;
      }
      .muted {
        color: var(--text-tertiary);
      }
      .pill {
        padding: 2px 8px;
        border-radius: 4px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
      }
      .pill.long {
        background: rgba(0, 113, 227, 0.12);
        color: #0071e3;
      }
      .pill.short {
        background: rgba(255, 107, 53, 0.14);
        color: #ff6b35;
      }
      .pill.exit.sl {
        background: rgba(255, 59, 48, 0.12);
        color: #ff3b30;
      }
      .pill.exit.tp {
        background: rgba(52, 199, 89, 0.14);
        color: #34c759;
      }
      .pill.exit.eod {
        background: rgba(142, 142, 147, 0.18);
        color: #6e6e73;
      }
      .btn-close {
        width: 32px;
        height: 32px;
        border-radius: 4px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
      }
      .btn-close:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .kpi {
        padding: var(--space-3);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .kpi:last-child {
        border-right: none;
      }
      .kpi-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .kpi-value {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .kpi-value.mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .kpi-value.gain {
        color: var(--color-success, #34c759);
      }
      .kpi-value.loss {
        color: var(--color-danger, #ff3b30);
      }
      .chart-wrap {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .chart {
        height: 500px;
      }
      .chart-placeholder {
        height: 320px;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: var(--space-5);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
      }
      .chart-placeholder.error {
        color: var(--color-danger, #ff3b30);
        border-color: rgba(255, 59, 48, 0.3);
        background: rgba(255, 59, 48, 0.04);
      }
      @media (max-width: 900px) {
        .kpis {
          grid-template-columns: repeat(3, 1fr);
        }
        .head-meta {
          font-size: var(--text-xs);
        }
      }
    `,
  ],
})
export class TradeReplayDialogComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly nativeDialog = viewChild.required<ElementRef<HTMLDialogElement>>('nativeDialog');

  /** Trade to replay; `null` keeps the dialog dismissed. */
  readonly trade = input<ReplayTrade | null>(null);
  readonly symbol = input<string>('');
  readonly timeframe = input<string>('H1');
  readonly closed = output<void>();

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly candles = signal<CandleDto[]>([]);
  private chartInstance: any = null;

  constructor() {
    // Open / close the native dialog and (re)fetch candles whenever the
    // selected trade changes. Driving showModal() from an effect keeps the
    // dialog purely input-bound — the parent decides whether to mount/show
    // by setting [trade] to the row vs null.
    effect(() => {
      const t = this.trade();
      const el = this.nativeDialog().nativeElement;
      if (!t) {
        if (el.open) {
          try {
            el.close();
          } catch {
            /* ignore */
          }
        }
        return;
      }
      if (!el.open && typeof el.showModal === 'function') {
        try {
          el.showModal();
        } catch {
          /* ignore */
        }
      }
      this.loadCandles(t);
    });
  }

  /** Pads the trade window with ~30 candles on each side so the operator can
   *  read the market structure leading into the entry and following the exit.
   *  Falls back to a 24h pad when the timeframe isn't in the catalog. */
  private loadCandles(t: ReplayTrade): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.candles.set([]);
    const tf = this.timeframe();
    const minutes = TIMEFRAME_MINUTES[tf] ?? 60;
    const padMs = minutes * 60_000 * 30;
    const entryMs = Date.parse(t.EntryTime);
    const exitMs = Date.parse(t.ExitTime);
    if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs)) {
      this.loadError.set('Trade timestamps are malformed.');
      this.loading.set(false);
      return;
    }
    const fromIso = new Date(entryMs - padMs).toISOString();
    const toIso = new Date(exitMs + padMs).toISOString();
    // Cap the page size — beyond ~500 candles the chart's candlestick
    // renderer becomes a wall of pixels anyway. For D1 + 30-bar pad on each
    // side we'd be at ~60 bars; for M1 across a long-running trade we'd
    // genuinely want a few hundred.
    const cap = 500;
    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: cap,
        filter: {
          symbol: this.normaliseSymbol(this.symbol()),
          timeframe: tf,
          from: fromIso,
          to: toIso,
        },
      })
      .pipe(
        catchError((err) => {
          this.loadError.set(err?.message ?? 'Failed to load candles.');
          return of(null);
        }),
        switchMap((res) => of(res?.data?.data ?? [])),
      )
      .subscribe((rows) => {
        // Server sorts most-recent-first; the chart needs chronological asc.
        const sorted = [...rows].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        this.candles.set(sorted);
        this.loading.set(false);
      });
  }

  // ── Display helpers ───────────────────────────────────────────────────

  readonly durationLabel = computed(() => {
    const t = this.trade();
    if (!t) return '';
    const ms = Date.parse(t.ExitTime) - Date.parse(t.EntryTime);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const minutes = ms / 60_000;
    if (minutes < 60) return `${Math.round(minutes)}m`;
    const hours = minutes / 60;
    if (hours < 24) return `${hours.toFixed(1)}h`;
    return `${(hours / 24).toFixed(1)}d`;
  });

  readonly riskReward = computed(() => {
    const t = this.trade();
    if (!t || t.StopLoss == null || t.TakeProfit == null) return null;
    const isLong = t.Direction === 0;
    const risk = isLong ? t.EntryPrice - t.StopLoss : t.StopLoss - t.EntryPrice;
    const reward = isLong ? t.TakeProfit - t.EntryPrice : t.EntryPrice - t.TakeProfit;
    if (risk <= 0 || reward <= 0) return null;
    return `1 : ${(reward / risk).toFixed(2)}`;
  });

  exitLabel(reason: number): string {
    return EXIT_LABEL[reason] ?? 'Unknown';
  }

  exitClass(reason: number): string {
    return reason === 0 ? 'sl' : reason === 1 ? 'tp' : 'eod';
  }

  // ── Chart ─────────────────────────────────────────────────────────────

  readonly chartOptions = computed<EChartsOption>(() => {
    const c = this.candles();
    const t = this.trade();
    if (!t || c.length === 0) {
      return {
        xAxis: { type: 'category', data: [] },
        yAxis: { type: 'value' },
        series: [],
      };
    }
    const dates = c.map((x) => x.timestamp);
    const ohlc = c.map((x) => [x.open, x.close, x.low, x.high]);
    const isLong = t.Direction === 0;

    // Find nearest candle for entry / exit so the markPoints sit on category ticks.
    const entryIdx = nearestIdx(dates, t.EntryTime);
    const exitIdx = nearestIdx(dates, t.ExitTime);

    const precision = pricePrecision(this.symbol());
    const fmt = (v: number) => v.toFixed(precision);

    const entryColor = isLong ? '#0071E3' : '#FF6B35';
    const exitColor = t.PnL >= 0 ? '#34C759' : '#FF3B30';

    const markLineData: any[] = [
      {
        yAxis: t.EntryPrice,
        lineStyle: { color: entryColor, type: 'solid', width: 1.4 },
        label: {
          show: true,
          position: 'insideStartTop',
          formatter: `ENTRY ${fmt(t.EntryPrice)}`,
          backgroundColor: entryColor,
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 600,
        },
      },
    ];
    if (t.StopLoss != null && Number.isFinite(t.StopLoss)) {
      markLineData.push({
        yAxis: t.StopLoss,
        lineStyle: { color: '#FF3B30', type: 'dashed', width: 1 },
        label: {
          show: true,
          position: 'insideStartTop',
          formatter: `SL ${fmt(t.StopLoss)}`,
          backgroundColor: '#FF3B30',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 600,
        },
      });
    }
    if (t.TakeProfit != null && Number.isFinite(t.TakeProfit)) {
      markLineData.push({
        yAxis: t.TakeProfit,
        lineStyle: { color: '#34C759', type: 'dashed', width: 1 },
        label: {
          show: true,
          position: 'insideStartTop',
          formatter: `TP ${fmt(t.TakeProfit)}`,
          backgroundColor: '#34C759',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 600,
        },
      });
    }

    const markPointData: any[] = [];
    if (entryIdx >= 0) {
      markPointData.push({
        name: 'Entry',
        coord: [entryIdx, t.EntryPrice],
        symbol: isLong ? 'triangle' : 'pin',
        symbolSize: 18,
        symbolRotate: isLong ? 0 : 180,
        itemStyle: { color: entryColor, borderColor: '#fff', borderWidth: 2 },
        label: {
          show: true,
          position: isLong ? 'bottom' : 'top',
          formatter: isLong ? '▲ Buy' : '▼ Sell',
          color: entryColor,
          fontSize: 11,
          fontWeight: 600,
        },
      });
    }
    if (exitIdx >= 0) {
      markPointData.push({
        name: 'Exit',
        coord: [exitIdx, t.ExitPrice],
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: { color: exitColor, borderColor: '#fff', borderWidth: 2 },
        label: {
          show: true,
          position: 'top',
          formatter: `Exit ${fmt(t.ExitPrice)}`,
          color: exitColor,
          fontSize: 11,
          fontWeight: 600,
          backgroundColor: 'rgba(255,255,255,0.85)',
          padding: [2, 4],
          borderRadius: 3,
        },
      });
    }

    // Auto-scale the y-axis to include SL/TP/entry/exit even if they fall
    // outside the candle range we fetched (e.g. the SL never got near the
    // price action so it'd be cropped without padding the axis).
    const priceCandidates = [
      ...c.map((x) => x.low),
      ...c.map((x) => x.high),
      t.EntryPrice,
      t.ExitPrice,
      ...(t.StopLoss != null ? [t.StopLoss] : []),
      ...(t.TakeProfit != null ? [t.TakeProfit] : []),
    ].filter(Number.isFinite);
    const yMin = Math.min(...priceCandidates);
    const yMax = Math.max(...priceCandidates);
    const yPad = (yMax - yMin) * 0.1 || yMin * 0.001;

    // Highlight the in-trade region with a translucent rectangle so the eye
    // immediately tracks where the position lived on the timeline.
    // ECharts' generated types insist on a 2-tuple for markArea.data, so we
    // cast — the runtime accepts the same shape we use for markLine.
    const inTradeMark: any[] =
      entryIdx >= 0 && exitIdx >= 0
        ? [[{ xAxis: entryIdx, itemStyle: { color: 'rgba(0,113,227,0.06)' } }, { xAxis: exitIdx }]]
        : [];

    return {
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
      },
      grid: { left: 70, right: 70, top: 30, bottom: 70 },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLabel: {
          fontSize: 10,
          color: '#6E6E73',
          formatter: (value: string) => {
            const d = new Date(value);
            return Number.isFinite(d.getTime())
              ? `${d.toISOString().slice(5, 16).replace('T', ' ')}`
              : value;
          },
        },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: +(yMin - yPad).toFixed(precision),
        max: +(yMax + yPad).toFixed(precision),
        scale: true,
        axisLabel: {
          fontSize: 11,
          color: '#6E6E73',
          formatter: (v: number) => v.toFixed(precision),
        },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 24, bottom: 12 }],
      series: [
        {
          type: 'candlestick',
          name: this.symbol(),
          data: ohlc,
          itemStyle: {
            color: '#34C759', // bullish body
            color0: '#FF3B30', // bearish body
            borderColor: '#34C759',
            borderColor0: '#FF3B30',
          },
          markLine: {
            silent: true,
            symbol: 'none',
            data: markLineData,
          },
          markPoint: {
            symbol: 'circle',
            symbolSize: 12,
            data: markPointData,
            label: { show: true },
          },
          markArea: {
            silent: true,
            itemStyle: { opacity: 0.7 },
            data: inTradeMark,
          },
        },
      ],
    };
  });

  onChartInit(instance: any): void {
    this.chartInstance = instance;
  }

  close(): void {
    const el = this.nativeDialog?.()?.nativeElement;
    try {
      el?.close();
    } catch {
      this.onNativeDialogClose();
    }
  }

  onBackdropClick(event: MouseEvent): void {
    if (event.target === this.nativeDialog().nativeElement) {
      this.close();
    }
  }

  onNativeDialogClose(): void {
    // Dispose the chart so a re-open with a different trade gets a fresh
    // canvas — otherwise ECharts keeps the old data layered behind the
    // mutation, producing weird visual artefacts on the second open.
    try {
      this.chartInstance?.dispose?.();
    } catch {
      /* ignore */
    }
    this.chartInstance = null;
    this.closed.emit();
  }

  private normaliseSymbol(s: string): string {
    return (s ?? '').replace(/\//g, '').toUpperCase();
  }
}

function nearestIdx(dates: string[], target: string): number {
  const t = Date.parse(target);
  if (!Number.isFinite(t)) return -1;
  let best = -1;
  let bestDelta = Infinity;
  for (let i = 0; i < dates.length; i++) {
    const d = Date.parse(dates[i]);
    if (!Number.isFinite(d)) continue;
    const delta = Math.abs(d - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

function pricePrecision(symbol: string): number {
  return symbol.includes('JPY') ? 3 : 5;
}
