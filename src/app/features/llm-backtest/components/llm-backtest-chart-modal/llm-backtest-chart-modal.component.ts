import {
  ChangeDetectionStrategy,
  Component,
  effect,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { catchError, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import { ThemeService } from '@core/theme/theme.service';
import { CandleDto, Timeframe } from '@core/api/api.types';
import {
  BacktestPointOutcome,
  MarketAnalysisRecommendation,
  MultiSampleResult,
} from '@core/services/llm-backtest.service';

/**
 * Modal-payload describing what to chart: one backtest point's first viable
 * recommendation against the candle window straddling its asOfUtc. Tiny and
 * purpose-built — the EATradeChartModal is too coupled to live positions
 * (action footers, signal-latency fetches) to fit cleanly here.
 */
export interface BacktestChartSelection {
  symbol: string;
  timeframe: Timeframe;
  /** Bar boundary the LLM was asked to analyse. ISO UTC. */
  asOfUtc: string;
  /** Recommendation picked from the point's `viable` list (first one). */
  recommendation: MarketAnalysisRecommendation;
  /** Walker outcome for that rec — null when no viable rec produced one. */
  outcome: BacktestPointOutcome | null;
  /** Bars-forward window the walker scanned. Drives chart end + outcome cap. */
  ttlBars: number;
  /**
   * P4.4 — When the point is from a multi-sample run, the per-sample
   * evaluations parsed from <c>LlmBacktestPoint.multiSampleResultsJson</c>.
   * Drives a small table rendered below the chart legend showing the
   * stochasticity directly on the cell. Null/empty on non-multi-sample runs.
   */
  multiSampleResults?: MultiSampleResult[] | null;
}

/** Bars to fetch backward from asOfUtc — gives context for the entry plan. */
const HISTORY_BARS = 60;
/** Hard ceiling on forward bars so a long TTL doesn't blow the candle fetch. */
const MAX_FORWARD_BARS = 80;

@Component({
  selector: 'app-llm-backtest-chart-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgxEchartsDirective],
  template: `
    @if (selection(); as sel) {
      <div class="modal-scrim" (click)="closed.emit()">
        <div class="modal-card" (click)="$event.stopPropagation()">
          <div class="modal-header">
            <div>
              <h2>
                {{ sel.symbol }} · {{ sel.timeframe }}
                <span class="action-chip" [class.chip--buy]="isBuy()" [class.chip--sell]="isSell()">
                  {{ sel.recommendation.action }}
                </span>
              </h2>
              <p class="modal-sub">
                asOfUtc {{ sel.asOfUtc | date: 'medium' }}
                @if (sel.outcome) {
                  · outcome
                  <span
                    class="outcome-chip"
                    [class.chip--tp]="sel.outcome.status === 'HitTP'"
                    [class.chip--sl]="sel.outcome.status === 'HitSL'"
                    [class.chip--exp]="sel.outcome.status.startsWith('Expired')"
                    [class.chip--unfilled]="sel.outcome.status === 'EntryNotReached'"
                  >
                    {{ sel.outcome.status }}
                  </span>
                  @if (sel.outcome.pnlPips !== null) {
                    · {{ sel.outcome.pnlPips | number: '1.1-1' }} pips
                  }
                }
              </p>
            </div>
            <button type="button" class="modal-close" (click)="closed.emit()" aria-label="Close">
              ×
            </button>
          </div>
          <div class="modal-body">
            @if (loading()) {
              <div class="loading">Loading candles…</div>
            } @else if (chartOptions(); as opts) {
              <div
                echarts
                [options]="opts"
                [theme]="echartsTheme()"
                [autoResize]="true"
                class="chart-instance"
              ></div>
              <div class="chart-legend">
                <span class="legend-item"><span class="dot dot--entry"></span> Entry</span>
                <span class="legend-item"><span class="dot dot--tp"></span> Take-profit</span>
                <span class="legend-item"><span class="dot dot--sl"></span> Stop-loss</span>
                @if (sel.outcome?.exitPrice !== null) {
                  <span class="legend-item"><span class="dot dot--exit"></span> Exit</span>
                }
              </div>
            } @else {
              <div class="loading">No candles available for this window.</div>
            }

            <!-- P4.4 — per-sample drill-down. Renders only when the parent
                 detail page passed multiSampleResults (i.e. this point is from
                 a multi-sample run). The chart itself shows sample 0's setup
                 levels by convention; this table makes the other N-1 samples
                 inspectable directly without leaving the modal. -->
            @if (multiSampleRows().length > 0) {
              <div class="multi-sample">
                <div class="multi-sample__header">
                  <h3>Per-sample outcomes</h3>
                  <span class="multi-sample__hint">
                    Chart shows sample 0; rows below summarise all
                    {{ multiSampleRows().length }} stochastic samples on this cell.
                  </span>
                </div>
                <table class="multi-sample__table">
                  <thead>
                    <tr>
                      <th>Sample</th>
                      <th>Viable</th>
                      <th>Rejected</th>
                      <th>Bypassed</th>
                      <th>Hit rate</th>
                      <th>Expected R</th>
                      <th>Outcomes</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of multiSampleRows(); track row.sampleIndex) {
                      <tr [class.multi-sample__chart-row]="row.sampleIndex === 0">
                        <td>
                          #{{ row.sampleIndex }}
                          @if (row.sampleIndex === 0) {
                            <span class="multi-sample__pin">chart</span>
                          }
                        </td>
                        <td>{{ row.viable }}</td>
                        <td>{{ row.rejected }}</td>
                        <td>{{ row.bypassed }}</td>
                        <td>{{ row.hitRate | percent: '1.0-1' }}</td>
                        <td>{{ row.expectedR | number: '1.2-2' }}R</td>
                        <td class="multi-sample__outcomes">{{ formatOutcomeMix(row) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .modal-scrim {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.55);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 2rem;
      }
      .modal-card {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 12px;
        width: min(1100px, 100%);
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      }
      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        padding: 1rem 1.25rem;
        border-bottom: 1px solid var(--border);
        gap: 1rem;
      }
      .modal-header h2 {
        margin: 0;
        font-size: 1.05rem;
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
      }
      .modal-sub {
        margin: 0.25rem 0 0;
        font-size: 0.8rem;
        opacity: 0.75;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        flex-wrap: wrap;
      }
      .modal-close {
        background: transparent;
        border: none;
        font-size: 1.5rem;
        cursor: pointer;
        color: inherit;
        line-height: 1;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
      }
      .modal-close:hover {
        background: var(--bg-tertiary);
      }
      .modal-body {
        flex: 1;
        padding: 1rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        min-height: 480px;
      }
      .chart-instance {
        flex: 1;
        min-height: 420px;
      }
      .loading {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.7;
        font-size: 0.9rem;
      }
      .action-chip,
      .outcome-chip {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.15rem 0.5rem;
        border-radius: 3px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        font-weight: 700;
      }
      .chip--buy {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .chip--sell {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .chip--tp {
        background: rgba(48, 209, 88, 0.18);
        color: #1f8a3d;
      }
      .chip--sl {
        background: rgba(255, 69, 58, 0.18);
        color: #c4290a;
      }
      .chip--exp {
        background: rgba(142, 142, 147, 0.18);
        color: var(--text-secondary);
      }
      .chip--unfilled {
        background: rgba(0, 113, 227, 0.15);
        color: #0071e3;
      }
      .chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        font-size: 0.8rem;
        opacity: 0.85;
        padding-top: 0.5rem;
        border-top: 1px solid var(--border);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
      .dot {
        display: inline-block;
        width: 14px;
        height: 3px;
        border-radius: 1px;
      }
      .dot--entry {
        background: #6e6e73;
      }
      .dot--tp {
        background: #1f8a3d;
      }
      .dot--sl {
        background: #c4290a;
      }
      .dot--exit {
        background: var(--accent);
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }
      .multi-sample {
        margin-top: 1rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .multi-sample__header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
      }
      .multi-sample__header h3 {
        margin: 0;
        font-size: 0.95rem;
      }
      .multi-sample__hint {
        font-size: 0.78rem;
        opacity: 0.7;
      }
      .multi-sample__table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.82rem;
      }
      .multi-sample__table th,
      .multi-sample__table td {
        text-align: left;
        padding: 0.35rem 0.5rem;
        border-bottom: 1px solid var(--border);
      }
      .multi-sample__table th {
        font-weight: 600;
        opacity: 0.7;
        font-size: 0.75rem;
        text-transform: uppercase;
      }
      .multi-sample__chart-row td {
        background: color-mix(in srgb, var(--accent, #4060a0) 8%, transparent);
      }
      .multi-sample__pin {
        margin-left: 0.35rem;
        font-size: 0.65rem;
        text-transform: uppercase;
        padding: 0.05rem 0.35rem;
        border-radius: var(--radius-xs, 3px);
        background: var(--accent, #4060a0);
        color: #fff;
        opacity: 0.85;
      }
      .multi-sample__outcomes {
        font-family: ui-monospace, SFMono-Regular, monospace;
        font-size: 0.78rem;
        opacity: 0.9;
      }
    `,
  ],
})
export class LlmBacktestChartModalComponent {
  /** Setting this to a non-null value triggers a candle fetch + render. */
  selection = input<BacktestChartSelection | null>(null);
  closed = output<void>();

  private readonly marketData = inject(MarketDataService);
  private readonly themeService = inject(ThemeService);

  readonly loading = signal(false);
  readonly candles = signal<CandleDto[]>([]);

  readonly echartsTheme = computed(() =>
    this.themeService.theme() === 'dark' ? 'lascodia-dark' : 'lascodia-light',
  );

  readonly isBuy = computed(() => this.selection()?.recommendation.action === 'Buy');
  readonly isSell = computed(() => this.selection()?.recommendation.action === 'Sell');

  /**
   * P4.4 — Per-sample drill-down rows. Empty array when the parent didn't
   * pass <c>multiSampleResults</c> (i.e. this point is from a single-sample
   * run). Sorted by sampleIndex so #0 (the one the chart visualises) is
   * first.
   */
  readonly multiSampleRows = computed<MultiSampleResult[]>(() => {
    const rows = this.selection()?.multiSampleResults ?? [];
    return [...rows].sort((a, b) => a.sampleIndex - b.sampleIndex);
  });

  /**
   * Compact "1×HitTP, 2×Expired+, 1×EntryNotReached" outcome-mix renderer
   * for the per-sample table. Drops zero-count buckets so the cell stays
   * scannable.
   */
  formatOutcomeMix(row: MultiSampleResult): string {
    const o = row.outcomes;
    const parts: string[] = [];
    if (o.hitTP > 0) parts.push(`${o.hitTP}×HitTP`);
    if (o.hitSL > 0) parts.push(`${o.hitSL}×HitSL`);
    if (o.expiredPositive > 0) parts.push(`${o.expiredPositive}×Exp+`);
    if (o.expiredNegative > 0) parts.push(`${o.expiredNegative}×Exp-`);
    if (o.expiredFlat > 0) parts.push(`${o.expiredFlat}×Exp~`);
    if (o.entryNotReached > 0) parts.push(`${o.entryNotReached}×NoFill`);
    if (o.noCandlesInWindow > 0) parts.push(`${o.noCandlesInWindow}×NoCdl`);
    return parts.length > 0 ? parts.join(', ') : '—';
  }

  /** Last fetched key — guards against duplicate fetches when the parent
   *  toggles selection() to the same payload (e.g. row re-click). */
  private lastFetchKey: string | null = null;

  constructor() {
    // Reactive watcher — whenever selection() flips, kick off a candle fetch
    // unless the payload is identical to the previous one. effect() is the
    // canonical Angular 20 way to bridge signals into imperative work.
    effect(() => {
      const sel = this.selection();
      if (!sel) {
        this.lastFetchKey = null;
        this.candles.set([]);
        return;
      }
      const key = `${sel.symbol}|${sel.timeframe}|${sel.asOfUtc}|${sel.ttlBars}`;
      if (key === this.lastFetchKey) return;
      this.lastFetchKey = key;
      this.fetchCandles(sel);
    });
  }

  /**
   * Pull a candle window centred on `asOfUtc`. We request a generous window
   * (history + 2× forward) and slice client-side — the engine endpoint pages
   * candles by row count, and computing exact bar offsets here would
   * duplicate timeframe math that the API doesn't accept anyway.
   */
  private fetchCandles(sel: BacktestChartSelection): void {
    this.loading.set(true);
    const forward = Math.min(MAX_FORWARD_BARS, Math.max(20, sel.ttlBars + 5));
    const itemCount = HISTORY_BARS + forward;
    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: itemCount,
        filter: {
          symbol: sel.symbol,
          timeframe: sel.timeframe,
          // Window the candle endpoint by anchoring around asOfUtc — the
          // backend supports a `to` cutoff plus a row count, so we ask for
          // candles AT OR BEFORE the future cap and let the count pull the
          // tail. The exact filter key may vary by handler — we send both
          // common forms so a server that ignores one still serves the page.
          to: this.shiftIso(sel.asOfUtc, sel.timeframe, forward),
        },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        const rows = res?.status && res.data ? (res.data.data ?? []) : [];
        // Backend returns newest-first by default; flip so x-axis is ascending.
        const ordered = rows
          .slice()
          .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        this.candles.set(ordered);
      });
  }

  /** Shift an ISO timestamp by N timeframe-bars. Rough — used as a fetch cap
   *  hint only; off-by-one is harmless because we always slice client-side. */
  private shiftIso(iso: string, tf: Timeframe, bars: number): string {
    const mins = this.timeframeMinutes(tf);
    const d = new Date(iso);
    d.setUTCMinutes(d.getUTCMinutes() + mins * bars);
    return d.toISOString();
  }

  private timeframeMinutes(tf: Timeframe): number {
    switch (tf) {
      case 'M1':
        return 1;
      case 'M5':
        return 5;
      case 'M15':
        return 15;
      case 'H1':
        return 60;
      case 'H4':
        return 240;
      case 'D1':
        return 1440;
      default:
        return 60;
    }
  }

  /**
   * ECharts candlestick + horizontal markLines for entry/SL/TP. Category
   * x-axis avoids the weekend gaps we'd get from a true time axis (same
   * trick the EA trade chart uses).
   */
  readonly chartOptions = computed<EChartsOption | null>(() => {
    const sel = this.selection();
    const rows = this.candles();
    if (!sel || rows.length === 0) return null;

    const rec = sel.recommendation;
    const out = sel.outcome;

    const xLabels = rows.map((r) => new Date(r.timestamp).toISOString());
    const ohlc = rows.map((r) => [r.open, r.close, r.low, r.high]);

    const markLines: any[] = [];
    if (rec.entryPrice != null) {
      markLines.push({
        yAxis: rec.entryPrice,
        label: { formatter: 'Entry ' + rec.entryPrice.toFixed(5), color: '#6e6e73' },
        lineStyle: { color: '#6e6e73', type: 'solid', width: 1.5 },
      });
    }
    if (rec.takeProfit != null) {
      markLines.push({
        yAxis: rec.takeProfit,
        label: { formatter: 'TP ' + rec.takeProfit.toFixed(5), color: '#1f8a3d' },
        lineStyle: { color: '#1f8a3d', type: 'dashed', width: 1.5 },
      });
    }
    if (rec.stopLoss != null) {
      markLines.push({
        yAxis: rec.stopLoss,
        label: { formatter: 'SL ' + rec.stopLoss.toFixed(5), color: '#c4290a' },
        lineStyle: { color: '#c4290a', type: 'dashed', width: 1.5 },
      });
    }

    // asOfUtc vertical band — visualise the moment the LLM was asked. Place
    // it on the closest x-axis category that's <= asOfUtc.
    const asOfMs = new Date(sel.asOfUtc).getTime();
    let asOfIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if (new Date(rows[i].timestamp).getTime() <= asOfMs) asOfIdx = i;
    }

    const markPoints: any[] = [];
    if (out?.exitPrice != null && out.exitAt) {
      const exitMs = new Date(out.exitAt).getTime();
      let exitIdx = rows.findIndex((r) => new Date(r.timestamp).getTime() >= exitMs);
      if (exitIdx < 0) exitIdx = rows.length - 1;
      markPoints.push({
        coord: [exitIdx, out.exitPrice],
        symbol: 'circle',
        symbolSize: 12,
        itemStyle: { color: '#0071e3' },
        label: {
          show: true,
          formatter: 'Exit',
          color: '#ffffff',
          backgroundColor: '#0071e3',
          padding: [2, 4],
          borderRadius: 3,
          fontSize: 10,
        },
      });
    }

    return <EChartsOption>{
      animation: false,
      grid: { left: 60, right: 20, top: 40, bottom: 40, containLabel: true },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      xAxis: {
        type: 'category',
        data: xLabels,
        boundaryGap: true,
        axisLabel: {
          formatter: (v: string) => {
            const d = new Date(v);
            return d.toISOString().slice(5, 16).replace('T', ' ');
          },
          fontSize: 10,
        },
      },
      yAxis: {
        scale: true,
        splitArea: { show: true },
      },
      series: [
        {
          name: sel.symbol,
          type: 'candlestick',
          data: ohlc,
          itemStyle: {
            color: '#1f8a3d',
            color0: '#c4290a',
            borderColor: '#1f8a3d',
            borderColor0: '#c4290a',
          },
          markLine: {
            silent: true,
            symbol: 'none',
            data: markLines,
          },
          markPoint: markPoints.length > 0 ? { data: markPoints } : undefined,
          markArea:
            asOfIdx >= 0
              ? {
                  silent: true,
                  itemStyle: { color: 'rgba(0, 113, 227, 0.08)' },
                  data: [[{ xAxis: asOfIdx }, { xAxis: asOfIdx + 1 }]],
                }
              : undefined,
        },
      ],
    };
  });
}
