import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  effect,
  untracked,
  input,
  output,
  viewChild,
  ElementRef,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import { Subject, timer, switchMap, takeUntil, catchError, of } from 'rxjs';
import { MarketDataService } from '@core/services/market-data.service';
import { PositionsService } from '@core/services/positions.service';
import { NotificationService } from '@core/notifications/notification.service';
import {
  CandleDto,
  LivePriceDto,
  MarketAnalysisRecommendationDto,
  MarketAnalysisResultDto,
  MarketMacroAnalysisResultDto,
  PositionDto,
} from '@core/api/api.types';

// ── Candle countdown helpers ─────────────────────────────────────────────
// Timeframes align to the UTC grid (M1 → top of each minute, H1 → top of
// each hour, H4 → 00/04/…/20 UTC, D1 → 00:00 UTC) so `now % tfMs` is the
// elapsed time inside the current candle and `tfMs - that` is the close
// countdown. The brokers we target (MT5) all emit candles on this grid;
// if a future broker uses a different anchor we'd need to read the latest
// candle's open timestamp instead.
const TIMEFRAME_MINUTES_MAP: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  H1: 60,
  H4: 240,
  D1: 1440,
};

function formatRemainingMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

// ── Indicator catalog ────────────────────────────────────────────────
// Adding a new indicator: extend `IndicatorType`, add a row to
// `INDICATOR_DEFS`, write the math in `calc<Type>`, and add the series
// builder in `buildOverlaySeries` / `buildSubplotSeries`.

export type IndicatorType =
  | 'sma'
  | 'ema'
  | 'bb'
  | 'vwap'
  | 'donchian'
  | 'keltner'
  | 'sr'
  | 'trend'
  | 'wedge' // overlays
  | 'rsi'
  | 'macd'
  | 'atr'
  | 'stoch'
  | 'adx'
  | 'ofi'; // subplots

export interface IndicatorParam {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
}

export interface IndicatorDef {
  type: IndicatorType;
  label: string;
  pane: 'price' | 'subplot';
  defaultColor: string;
  params: IndicatorParam[];
}

export interface IndicatorConfig {
  id: string;
  type: IndicatorType;
  params: Record<string, number>;
  color: string;
}

export const INDICATOR_DEFS: IndicatorDef[] = [
  {
    type: 'sma',
    label: 'SMA',
    pane: 'price',
    defaultColor: '#FF9500',
    params: [{ key: 'period', label: 'Period', default: 20, min: 2, max: 500 }],
  },
  {
    type: 'ema',
    label: 'EMA',
    pane: 'price',
    defaultColor: '#AF52DE',
    params: [{ key: 'period', label: 'Period', default: 20, min: 2, max: 500 }],
  },
  {
    type: 'bb',
    label: 'Bollinger Bands',
    pane: 'price',
    defaultColor: '#5AC8FA',
    params: [
      { key: 'period', label: 'Period', default: 20, min: 2, max: 500 },
      { key: 'std', label: 'Std Dev', default: 2, min: 0.5, max: 5, step: 0.1 },
    ],
  },
  {
    type: 'vwap',
    label: 'VWAP (session)',
    pane: 'price',
    defaultColor: '#0071E3',
    params: [],
  },
  {
    type: 'donchian',
    label: 'Donchian',
    pane: 'price',
    defaultColor: '#5856D6',
    params: [{ key: 'period', label: 'Period', default: 20, min: 2, max: 500 }],
  },
  {
    type: 'keltner',
    label: 'Keltner',
    pane: 'price',
    defaultColor: '#FF2D55',
    params: [
      { key: 'period', label: 'Period', default: 20, min: 2, max: 500 },
      { key: 'mult', label: 'ATR Mult', default: 2, min: 0.5, max: 5, step: 0.1 },
    ],
  },
  {
    type: 'sr',
    label: 'Support/Resistance',
    pane: 'price',
    defaultColor: '#FF9500',
    params: [
      // `lookback` is the number of bars on each side a swing must dominate
      // — bigger value = stricter pivots = fewer, more significant levels.
      { key: 'lookback', label: 'Strength', default: 5, min: 2, max: 30 },
      { key: 'count', label: 'Levels', default: 6, min: 1, max: 20 },
    ],
  },
  {
    type: 'trend',
    label: 'Trend Line (Regression)',
    pane: 'price',
    defaultColor: '#5856D6',
    params: [
      { key: 'period', label: 'Lookback', default: 50, min: 5, max: 500 },
      { key: 'mult', label: 'Band σ', default: 2, min: 0, max: 5, step: 0.1 },
    ],
  },
  {
    type: 'wedge',
    label: 'Wedge Breakout',
    pane: 'price',
    defaultColor: '#FF2D55',
    params: [
      { key: 'lookback', label: 'Lookback', default: 80, min: 20, max: 500 },
      { key: 'strength', label: 'Pivot Strength', default: 3, min: 2, max: 15 },
    ],
  },
  {
    type: 'rsi',
    label: 'RSI',
    pane: 'subplot',
    defaultColor: '#0071E3',
    params: [{ key: 'period', label: 'Period', default: 14, min: 2, max: 100 }],
  },
  {
    type: 'macd',
    label: 'MACD',
    pane: 'subplot',
    defaultColor: '#FF9500',
    params: [
      { key: 'fast', label: 'Fast', default: 12, min: 2, max: 100 },
      { key: 'slow', label: 'Slow', default: 26, min: 2, max: 200 },
      { key: 'signal', label: 'Signal', default: 9, min: 2, max: 100 },
    ],
  },
  {
    type: 'atr',
    label: 'ATR',
    pane: 'subplot',
    defaultColor: '#AF52DE',
    params: [{ key: 'period', label: 'Period', default: 14, min: 2, max: 100 }],
  },
  {
    type: 'stoch',
    label: 'Stochastic',
    pane: 'subplot',
    defaultColor: '#34C759',
    params: [
      { key: 'period', label: 'K Period', default: 14, min: 2, max: 100 },
      { key: 'k', label: '%K Smooth', default: 3, min: 1, max: 20 },
      { key: 'd', label: '%D Smooth', default: 3, min: 1, max: 20 },
    ],
  },
  {
    type: 'adx',
    label: 'ADX',
    pane: 'subplot',
    defaultColor: '#FF3B30',
    params: [{ key: 'period', label: 'Period', default: 14, min: 2, max: 100 }],
  },
  {
    type: 'ofi',
    label: 'Order Flow (est.)',
    pane: 'subplot',
    defaultColor: '#0071E3',
    params: [{ key: 'smoothing', label: 'Bar Smooth', default: 1, min: 1, max: 50 }],
  },
];

const INDICATOR_BY_TYPE: Record<IndicatorType, IndicatorDef> = INDICATOR_DEFS.reduce(
  (acc, def) => {
    acc[def.type] = def;
    return acc;
  },
  {} as Record<IndicatorType, IndicatorDef>,
);

const INDICATOR_STORAGE_PREFIX = 'tradingChart.indicators.v1';

// "Show volume" and "Show positions" are global user preferences — the
// operator wants their visibility choice to apply across whichever
// instrument they're inspecting. Persisting them per-(symbol, timeframe)
// inside INDICATOR_STORAGE_PREFIX was a footgun: an accidental click on
// one chart silently disabled the overlay forever on that symbol while
// leaving every other symbol unchanged.
const SHOW_VOLUME_STORAGE_KEY = 'tradingChart.showVolume';
const SHOW_POSITIONS_STORAGE_KEY = 'tradingChart.showPositions';
// Live-analysis is a global preference like the other toggles — when on,
// a silent spot-analysis fires on every candle close for the focused pair.
const LIVE_ANALYSIS_STORAGE_KEY = 'tradingChart.liveAnalysis';
// Auto-signal generation — when on, each completed spot analysis also asks
// the engine to persist every VIABLE setup as a live trade signal. Global
// preference; OFF by default because these enter the live execution pipeline.
const SIGNAL_AUTOGEN_STORAGE_KEY = 'tradingChart.signalAutoGen';
// The most recent completed analysis is persisted PER (symbol, timeframe)
// so the on-chart bubble defaults to that exact pair's last run after a
// reload or a pair/TF switch — WITHOUT re-running an analysis on load
// (auto-runs only ever fire on candle close). Suffixed with `.<sym>.<tf>`
// just like INDICATOR_STORAGE_PREFIX.
const LAST_ANALYSIS_STORAGE_PREFIX = 'tradingChart.lastAnalysis.v2';
// Pre-per-pair single-slot key. Migrated into the per-pair store on first
// load of the pair it belonged to, then deleted. Kept only for that bridge.
const LEGACY_LAST_ANALYSIS_KEY = 'tradingChart.lastAnalysis.v1';

@Component({
  selector: 'app-trading-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective, FormsModule, DatePipe],
  template: `
    <div class="trading-chart">
      <!-- Toolbar -->
      <div class="chart-toolbar">
        <div class="toolbar-left">
          <select
            class="toolbar-select symbol-select"
            [ngModel]="selectedSymbol()"
            (ngModelChange)="onSymbolChange($event)"
          >
            @for (s of symbols; track s) {
              <option [value]="s">{{ s }}</option>
            }
          </select>
          <div class="timeframe-pills">
            @for (tf of timeframes; track tf.value) {
              <button
                class="tf-pill"
                [class.active]="selectedTimeframe() === tf.value"
                (click)="onTimeframeChange(tf.value)"
              >
                {{ tf.label }}
              </button>
            }
          </div>
        </div>
        <div class="toolbar-right">
          @if (livePrice()) {
            <div class="live-price-display">
              <span class="live-label">Live</span>
              <span class="live-dot"></span>
              <span
                class="live-bid"
                [class.up]="priceDirection() === 'up'"
                [class.down]="priceDirection() === 'down'"
              >
                {{ livePrice()!.bid.toFixed(pricePrecision()) }}
              </span>
              <span class="live-separator">/</span>
              <span class="live-ask">{{ livePrice()!.ask.toFixed(pricePrecision()) }}</span>
              <span class="live-spread">{{ livePrice()!.spread.toFixed(1) }} sp</span>
            </div>
          }
          <div
            class="candle-countdown"
            [class.imminent]="candleCountdown().startsWith('00:0')"
            [title]="'Time until ' + selectedTimeframe() + ' candle closes'"
          >
            <span class="countdown-label">Next {{ selectedTimeframe() }}</span>
            <span class="countdown-value">{{ candleCountdown() }}</span>
          </div>
          @if (openPositionsPnL(); as pnl) {
            <div
              class="open-pnl"
              [class.gain]="pnl.sign > 0"
              [class.loss]="pnl.sign < 0"
              [title]="
                'Live unrealised P&L summed across ' +
                pnl.count +
                ' open position(s) on ' +
                selectedSymbol()
              "
            >
              <span class="countdown-label">Open P&L · {{ pnl.count }} pos</span>
              <span class="countdown-value">{{ pnl.display }}</span>
            </div>
          }
          <!--
            Spot LLM analysis trigger. Disabled while a previous call is
            in flight (these typically take 15-60s on the deep-tier model)
            so the operator can't queue duplicate analyses.
          -->
          <button
            type="button"
            class="analyze-btn"
            [disabled]="analyzing()"
            [title]="
              analyzing()
                ? 'Analysis in flight — wait for the current call to complete.'
                : 'Run an LLM spot analysis of the current market for ' +
                  selectedSymbol() +
                  ' ' +
                  selectedTimeframe()
            "
            (click)="runMarketAnalysis()"
          >
            {{ analyzing() ? '⏳ Analysing…' : '🔍 Analyse' }}
          </button>
          <!--
            Longer-horizon macro analysis. D1-anchored, materially costlier
            than spot per call (≈12mo of D1 + COT + 14d catalysts) — a
            deliberate, separate action, never auto-fired on candle close.
          -->
          <button
            type="button"
            class="analyze-btn"
            [disabled]="macroAnalyzing()"
            [title]="
              macroAnalyzing()
                ? 'Macro analysis in flight — wait for it to complete.'
                : 'Run a longer-horizon (multi-week → multi-month) macro analysis for ' +
                  selectedSymbol() +
                  ' (D1-anchored)'
            "
            (click)="runMacroAnalysis()"
          >
            {{ macroAnalyzing() ? '⏳ Macro…' : '🌐 Macro' }}
          </button>
          <button
            type="button"
            class="live-toggle"
            [class.on]="liveAnalysisEnabled()"
            [attr.aria-pressed]="liveAnalysisEnabled()"
            [title]="
              liveAnalysisEnabled()
                ? 'Live analysis ON — a spot analysis runs automatically on every ' +
                  selectedTimeframe() +
                  ' candle close. Click to disable.'
                : 'Enable live analysis — auto-run a spot analysis on every ' +
                  selectedTimeframe() +
                  ' candle close.'
            "
            (click)="toggleLiveAnalysis()"
          >
            <span class="live-dot" [class.pulsing]="liveAnalysisEnabled()"></span>
            Live
          </button>
          <button
            type="button"
            class="live-toggle"
            [class.on]="signalAutoGenEnabled()"
            [attr.aria-pressed]="signalAutoGenEnabled()"
            [title]="
              signalAutoGenEnabled()
                ? 'Auto-signal ON — every analysis run also persists each VIABLE setup as a LIVE trade signal (auto-executes via the normal risk pipeline). Click to disable.'
                : 'Enable auto-signal — each spot analysis also generates live trade signals from every viable setup (timeframe-scaled SL/TP, R:R & confidence gated). Off by default; these can place real trades.'
            "
            (click)="toggleSignalAutoGen()"
          >
            <span class="live-dot" [class.pulsing]="signalAutoGenEnabled()"></span>
            Signals
          </button>
          <div class="chart-toggles">
            @for (cfg of indicators(); track cfg.id) {
              <div class="indicator-chip" [class.editing]="editingIndicatorId() === cfg.id">
                <span
                  class="chip-dot"
                  [style.background]="cfg.color"
                  (click)="toggleEdit(cfg.id)"
                ></span>
                <span class="chip-label" (click)="toggleEdit(cfg.id)">
                  {{ chipSummary(cfg) }}
                </span>
                <button
                  class="chip-remove"
                  (click)="removeIndicator(cfg.id)"
                  [attr.aria-label]="'Remove ' + chipSummary(cfg)"
                  title="Remove"
                >
                  ×
                </button>
                @if (editingIndicatorId() === cfg.id) {
                  <div class="chip-editor" (click)="$event.stopPropagation()">
                    <div class="editor-head">
                      <strong>{{ labelFor(cfg.type) }}</strong>
                      <button class="editor-close" (click)="toggleEdit(cfg.id)">×</button>
                    </div>
                    @for (p of paramsFor(cfg.type); track p.key) {
                      <label class="editor-row">
                        <span class="editor-label">{{ p.label }}</span>
                        <input
                          type="number"
                          class="editor-input"
                          [min]="p.min"
                          [max]="p.max"
                          [step]="p.step ?? 1"
                          [value]="cfg.params[p.key]"
                          (change)="setIndicatorParam(cfg.id, p.key, +$any($event.target).value)"
                        />
                      </label>
                    }
                    <label class="editor-row">
                      <span class="editor-label">Color</span>
                      <input
                        type="color"
                        class="editor-color"
                        [value]="cfg.color"
                        (change)="setIndicatorColor(cfg.id, $any($event.target).value)"
                      />
                    </label>
                  </div>
                }
              </div>
            }
            <button
              class="toggle-btn"
              [class.active]="showVolume()"
              (click)="toggleVolume()"
              title="Volume pane"
            >
              Vol
            </button>
            <button
              class="toggle-btn"
              [class.active]="showPositions()"
              (click)="togglePositions()"
              title="Open position overlays (entry / SL / TP)"
            >
              Pos
            </button>
            <div class="picker-wrapper">
              <button
                class="toggle-btn picker-btn"
                [class.active]="pickerOpen()"
                (click)="togglePicker()"
                title="Add indicator"
              >
                + Indicator
              </button>
              @if (pickerOpen()) {
                <div class="picker-dropdown" (click)="$event.stopPropagation()">
                  <div class="picker-section">
                    <span class="picker-section-title">Overlays</span>
                    @for (def of indicatorCatalog; track def.type) {
                      @if (def.pane === 'price') {
                        <button class="picker-item" (click)="addIndicator(def.type)">
                          <span class="picker-dot" [style.background]="def.defaultColor"></span>
                          {{ def.label }}
                        </button>
                      }
                    }
                  </div>
                  <div class="picker-section">
                    <span class="picker-section-title">Subplot panes</span>
                    @for (def of indicatorCatalog; track def.type) {
                      @if (def.pane === 'subplot') {
                        <button class="picker-item" (click)="addIndicator(def.type)">
                          <span class="picker-dot" [style.background]="def.defaultColor"></span>
                          {{ def.label }}
                        </button>
                      }
                    }
                  </div>
                </div>
              }
            </div>
          </div>
        </div>
      </div>

      <!-- Chart -->
      <div class="chart-container">
        @if (loading()) {
          <div class="chart-skeleton">
            <div class="shimmer"></div>
          </div>
        } @else {
          <div
            echarts
            [options]="chartInitOptions"
            [autoResize]="true"
            (chartInit)="onChartReady($event)"
            class="echart-instance"
          ></div>
        }

        <!-- ── Live recommendation bubble ─────────────────────────────
             ALWAYS shown. Defaults to the last completed analysis (restored
             from storage on load, refreshed by manual + live runs). Colour-
             coded by that recommendation's action; click opens the full
             brief. Empty state until the first analysis ever runs. -->
        @let lastA = lastAnalysis();
        @let rec = lastA?.recommendation ?? null;
        <button
          type="button"
          class="rec-bubble"
          [class.rec-buy]="rec?.action === 'Buy'"
          [class.rec-sell]="rec?.action === 'Sell'"
          [class.rec-hold]="rec?.action === 'Hold'"
          [class.rec-pending]="!lastA"
          [disabled]="!lastA"
          [title]="
            lastA
              ? 'Last analysis · ' +
                lastA.symbol +
                ' ' +
                lastA.timeframe +
                ' · click for the full brief'
              : 'No analysis yet — run Analyse or wait for a candle close'
          "
          (click)="openLastAnalysis()"
        >
          <span class="rec-bubble-dot" [class.pulsing]="analyzing()"></span>
          @if (lastA) {
            <span class="rec-bubble-action">{{ rec?.action ?? 'No call' }}</span>
            @if (rec && rec.action !== 'Hold' && rec.entryPrice !== null) {
              <span class="rec-bubble-levels">
                @ {{ rec.entryPrice }} · SL {{ rec.stopLoss }} · TP {{ rec.takeProfit }}
              </span>
            }
            @if (rec) {
              <span class="rec-bubble-conf">{{ (rec.confidence * 100).toFixed(0) }}%</span>
            }
          } @else {
            <span class="rec-bubble-action">{{
              analyzing() ? 'Analysing…' : 'No analysis yet'
            }}</span>
          }
        </button>
      </div>

      <!-- Info Bar -->
      <div class="chart-info-bar">
        @if (latestCandle(); as c) {
          <div class="info-item">
            <span class="info-label">O</span>
            <span class="info-value">{{ c.open.toFixed(pricePrecision()) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">H</span>
            <span class="info-value high">{{ c.high.toFixed(pricePrecision()) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">L</span>
            <span class="info-value low">{{ c.low.toFixed(pricePrecision()) }}</span>
          </div>
          <div class="info-item">
            <span class="info-label">C</span>
            <span class="info-value" [class.up]="c.close >= c.open" [class.down]="c.close < c.open">
              {{ c.close.toFixed(pricePrecision()) }}
            </span>
          </div>
          <div class="info-item">
            <span class="info-label">Vol</span>
            <span class="info-value">{{ formatVolume(c.volume) }}</span>
          </div>
        }
        <div class="info-item candle-count">
          <span class="info-value muted">{{ candles().length }} candles</span>
        </div>
      </div>

      <!-- ── LLM market-analysis result overlay ─────────────────────────
           Native <dialog> opened via showModal() so the brief renders in
           the browser's top layer above the chart's overflow:hidden box.
           The previous CSS-only backdrop clipped the body when the chart
           container was shorter than 80vh. -->
      <dialog
        #analysisDialog
        class="analysis-dialog"
        [class.error]="!analysisResult() && analysisError()"
        aria-labelledby="analysis-title"
        (close)="onAnalysisDialogClose()"
        (click)="onAnalysisBackdropClick($event)"
      >
        <article class="analysis-card" (click)="$event.stopPropagation()">
          @if (analysisResult(); as ar) {
            <header class="analysis-head">
              <div class="analysis-title-wrap">
                <h3 id="analysis-title">Spot analysis · {{ ar.symbol }} · {{ ar.timeframe }}</h3>
                <div class="analysis-meta">
                  <span class="tag mono">{{ ar.provider }} / {{ ar.model }}</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ ar.latencyMs }} ms</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ ar.completedAt | date: 'MMM d, HH:mm:ss' }}</span>
                  <span class="muted">·</span>
                  <span class="muted">audit #{{ ar.llmInvocationId }}</span>
                </div>
              </div>
              <button
                type="button"
                class="analysis-close"
                aria-label="Close analysis"
                (click)="closeAnalysis()"
              >
                ×
              </button>
            </header>
            @if (ar.recommendation; as rec) {
              <section
                class="rec-card"
                [class.rec-buy]="rec.action === 'Buy'"
                [class.rec-sell]="rec.action === 'Sell'"
                [class.rec-hold]="rec.action === 'Hold'"
              >
                <div class="rec-row">
                  <span class="rec-action">{{ rec.action }}</span>
                  <span class="rec-confidence">
                    confidence
                    <strong>{{ (rec.confidence * 100).toFixed(0) }}%</strong>
                  </span>
                </div>
                @if (rec.action !== 'Hold' && rec.entryPrice !== null) {
                  <div class="rec-levels">
                    <div class="rec-level">
                      <span class="rec-label">Entry</span>
                      <span class="rec-value">{{ rec.entryPrice }}</span>
                    </div>
                    <div class="rec-level">
                      <span class="rec-label">Stop</span>
                      <span class="rec-value">{{ rec.stopLoss }}</span>
                    </div>
                    <div class="rec-level">
                      <span class="rec-label">Target</span>
                      <span class="rec-value">{{ rec.takeProfit }}</span>
                    </div>
                    @if (recRiskReward(rec); as rr) {
                      <div class="rec-level">
                        <span class="rec-label">R:R</span>
                        <span class="rec-value">{{ rr }}</span>
                      </div>
                    }
                  </div>
                }
                @if (rec.rationale) {
                  <p class="rec-rationale">{{ rec.rationale }}</p>
                }
              </section>
            } @else {
              <section class="rec-card rec-missing">
                <div class="rec-row">
                  <span class="rec-action">No recommendation</span>
                </div>
                <p class="rec-rationale">
                  The model didn't emit a structured trade block — review the prose below.
                </p>
              </section>
            }
            <div class="analysis-body">{{ ar.analysis }}</div>
          } @else if (analysisError(); as err) {
            <header class="analysis-head">
              <h3 id="analysis-title">Analysis failed</h3>
              <button type="button" class="analysis-close" (click)="closeAnalysis()">×</button>
            </header>
            <div class="analysis-body">{{ err }}</div>
          }
        </article>
      </dialog>

      <!-- Longer-horizon macro analysis modal. Self-contained sibling of the
           spot dialog above; reuses the same .analysis-* / .rec-* styles. The
           bias chip maps Bullish→buy(green), Bearish→sell(red), Neutral→hold. -->
      <dialog
        #macroAnalysisDialog
        class="analysis-dialog"
        [class.error]="!macroAnalysisResult() && macroAnalysisError()"
        aria-labelledby="macro-analysis-title"
        (close)="onMacroAnalysisDialogClose()"
        (click)="onMacroAnalysisBackdropClick($event)"
      >
        <article class="analysis-card" (click)="$event.stopPropagation()">
          @if (macroAnalysisResult(); as mr) {
            <header class="analysis-head">
              <div class="analysis-title-wrap">
                <h3 id="macro-analysis-title">
                  Macro analysis · {{ mr.symbol }} · {{ mr.timeframe }} (D1-anchored)
                </h3>
                <div class="analysis-meta">
                  <span class="tag mono">{{ mr.provider }} / {{ mr.model }}</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ mr.latencyMs }} ms</span>
                  <span class="muted">·</span>
                  <span class="muted">{{ mr.completedAt | date: 'MMM d, HH:mm:ss' }}</span>
                  <span class="muted">·</span>
                  <span class="muted">audit #{{ mr.llmInvocationId }}</span>
                </div>
              </div>
              <button
                type="button"
                class="analysis-close"
                aria-label="Close macro analysis"
                (click)="closeMacroAnalysis()"
              >
                ×
              </button>
            </header>
            @if (mr.longerHorizon; as lh) {
              <section
                class="rec-card"
                [class.rec-buy]="lh.bias === 'Bullish'"
                [class.rec-sell]="lh.bias === 'Bearish'"
                [class.rec-hold]="lh.bias === 'Neutral'"
              >
                <div class="rec-row">
                  <span class="rec-action">{{ lh.bias }} · weeks–months</span>
                  <span class="rec-confidence">
                    conviction
                    <strong>{{ (lh.confidence * 100).toFixed(0) }}%</strong>
                  </span>
                </div>
                <div class="rec-levels">
                  <div class="rec-level">
                    <span class="rec-label">Structure</span>
                    <span class="rec-value">{{ lh.structure }}</span>
                  </div>
                  <div class="rec-level">
                    <span class="rec-label">Positioning</span>
                    <span class="rec-value">{{ lh.positioning }}</span>
                  </div>
                  <div class="rec-level">
                    <span class="rec-label">Catalysts</span>
                    <span class="rec-value">{{ lh.catalysts }}</span>
                  </div>
                  <div class="rec-level">
                    <span class="rec-label">Key levels</span>
                    <span class="rec-value">{{ lh.keyLevels }}</span>
                  </div>
                </div>
              </section>
            } @else {
              <section class="rec-card rec-missing">
                <div class="rec-row">
                  <span class="rec-action">No structured view</span>
                </div>
                <p class="rec-rationale">
                  The model didn't emit a structured longer-horizon block — review the prose below.
                </p>
              </section>
            }
            <div class="analysis-body">{{ mr.analysis }}</div>
          } @else if (macroAnalysisError(); as merr) {
            <header class="analysis-head">
              <h3 id="macro-analysis-title">Macro analysis failed</h3>
              <button type="button" class="analysis-close" (click)="closeMacroAnalysis()">×</button>
            </header>
            <div class="analysis-body">{{ merr }}</div>
          }
        </article>
      </dialog>
    </div>
  `,
  styles: [
    `
      .trading-chart {
        position: relative;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }

      .chart-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
        gap: var(--space-4);
        flex-wrap: wrap;
      }
      .toolbar-left,
      .toolbar-right {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }

      .toolbar-select {
        height: 32px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        font-family: inherit;
        cursor: pointer;
        outline: none;
      }
      .toolbar-select:focus {
        border-color: var(--accent);
      }
      .symbol-select {
        min-width: 110px;
      }

      .timeframe-pills {
        display: flex;
        gap: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        padding: 2px;
      }
      .tf-pill {
        height: 28px;
        padding: 0 var(--space-3);
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .tf-pill:hover {
        color: var(--text-primary);
      }
      .tf-pill.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
      }

      .live-price-display {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: 4px var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-variant-numeric: tabular-nums;
      }
      .live-label {
        font-size: 9px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
      }
      .live-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--profit);
        animation: pulse 2s infinite;
      }
      @keyframes pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.4;
        }
      }
      .live-bid {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        transition: color 0.3s ease;
      }
      .live-bid.up {
        color: var(--profit);
      }
      .live-bid.down {
        color: var(--loss);
      }
      .live-separator {
        color: var(--text-tertiary);
        font-size: 11px;
      }
      .live-ask {
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .live-spread {
        font-size: 10px;
        color: var(--text-tertiary);
        padding: 1px 6px;
        background: var(--bg-tertiary);
        border-radius: 4px;
      }

      /* Candle-close countdown badge — pinned next to the live-price box
         so the operator can read both the current bid/ask and how long
         until the next bar without taking their eyes off the chrome. */
      .candle-countdown {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        font-size: 11px;
        line-height: 1;
        white-space: nowrap;
        transition:
          background 0.2s,
          color 0.2s,
          border-color 0.2s;
      }
      .countdown-label {
        color: var(--text-tertiary);
        font-weight: var(--font-medium);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .countdown-value {
        color: var(--text-primary);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
      }
      /* Under 10 seconds, flag the imminent close in orange so operators
         can defer manual entries past the bar boundary. */
      .candle-countdown.imminent {
        background: rgba(255, 149, 0, 0.12);
        border-color: rgba(255, 149, 0, 0.4);
      }
      .candle-countdown.imminent .countdown-value {
        color: #ff9500;
      }

      /* Open positions cumulative P&L badge — same shell as the candle
         countdown so the two read as a paired row. Sign tints the
         background and the value so the operator can pick up gain/loss
         from peripheral vision without parsing the digits. */
      .open-pnl {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        border: 1px solid var(--border);
        font-size: 11px;
        line-height: 1;
        white-space: nowrap;
      }
      .open-pnl.gain {
        background: rgba(52, 199, 89, 0.1);
        border-color: rgba(52, 199, 89, 0.35);
      }
      .open-pnl.gain .countdown-value {
        color: #34c759;
      }
      .open-pnl.loss {
        background: rgba(255, 59, 48, 0.1);
        border-color: rgba(255, 59, 48, 0.35);
      }
      .open-pnl.loss .countdown-value {
        color: #ff3b30;
      }

      /* Spot-analysis trigger — primary-styled so it stands out in the
         countdown row + signals "this costs an LLM call". */
      .analyze-btn {
        height: 28px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        border: 1px solid #0071e3;
        background: #0071e3;
        color: #fff;
        font-size: 11px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.02em;
        cursor: pointer;
        white-space: nowrap;
        transition:
          background 0.15s,
          opacity 0.15s;
      }
      .analyze-btn:hover:not(:disabled) {
        background: #005bb5;
      }
      .analyze-btn:disabled {
        opacity: 0.6;
        cursor: progress;
      }

      /* Live-analysis toggle — sits next to the Analyse button. Off state
         is a quiet ghost button; on state goes accent + the dot pulses. */
      .live-toggle {
        height: 28px;
        padding: 0 var(--space-3);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 11px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.02em;
        cursor: pointer;
        white-space: nowrap;
        transition:
          background 0.15s,
          border-color 0.15s,
          color 0.15s;
      }
      .live-toggle:hover {
        border-color: var(--text-tertiary);
        color: var(--text-primary);
      }
      .live-toggle.on {
        border-color: #16a34a;
        color: #16a34a;
        background: rgba(22, 163, 74, 0.08);
      }
      .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--text-tertiary);
      }
      .live-toggle.on .live-dot {
        background: #16a34a;
      }
      .live-dot.pulsing {
        animation: live-pulse 1.6s ease-in-out infinite;
      }
      @keyframes live-pulse {
        0%,
        100% {
          opacity: 1;
          box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.5);
        }
        50% {
          opacity: 0.55;
          box-shadow: 0 0 0 4px rgba(22, 163, 74, 0);
        }
      }

      /* On-chart recommendation bubble — floats over the chart's top-left.
         Colour-coded by the last analysis's action. */
      .rec-bubble {
        position: absolute;
        top: var(--space-3);
        left: var(--space-3);
        z-index: 6;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 30px;
        padding: 0 var(--space-3);
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
        color: var(--text-primary);
        font-size: 12px;
        font-weight: var(--font-semibold);
        cursor: pointer;
        white-space: nowrap;
        transition:
          border-color 0.15s,
          transform 0.1s;
      }
      .rec-bubble:hover:not(:disabled) {
        transform: translateY(-1px);
      }
      .rec-bubble:disabled {
        cursor: default;
        opacity: 0.85;
      }
      .rec-bubble-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--text-tertiary);
        flex: none;
      }
      .rec-bubble-dot.pulsing {
        animation: live-pulse 1.6s ease-in-out infinite;
      }
      .rec-bubble-action {
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .rec-bubble-levels,
      .rec-bubble-conf {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
      }
      .rec-bubble-conf {
        padding-left: 6px;
        border-left: 1px solid var(--border);
      }
      .rec-bubble.rec-buy {
        border-color: #16a34a;
      }
      .rec-bubble.rec-buy .rec-bubble-dot,
      .rec-bubble.rec-buy .rec-bubble-action {
        color: #16a34a;
        background: #16a34a;
      }
      .rec-bubble.rec-buy .rec-bubble-action {
        background: none;
        color: #16a34a;
      }
      .rec-bubble.rec-sell {
        border-color: #dc2626;
      }
      .rec-bubble.rec-sell .rec-bubble-dot {
        background: #dc2626;
      }
      .rec-bubble.rec-sell .rec-bubble-action {
        color: #dc2626;
      }
      .rec-bubble.rec-hold .rec-bubble-dot {
        background: #d97706;
      }
      .rec-bubble.rec-hold .rec-bubble-action {
        color: #d97706;
      }
      .rec-bubble.rec-pending {
        color: var(--text-tertiary);
      }

      /* Modal-style overlay for the analysis result. Anchored inside the
         trading-chart component so the backdrop covers just the chart
         area; mounting it at the page root would require an event bus. */
      /* Native <dialog> sits in the browser's top layer when opened via
         showModal(), so it ignores the chart container's overflow:hidden
         and any ancestor stacking context / transform. UA centers via
         margin:auto on :modal. */
      dialog.analysis-dialog {
        padding: 0;
        background: transparent;
        border: none;
        max-width: none;
        max-height: none;
        color: var(--text-primary);
      }
      dialog.analysis-dialog:modal {
        position: fixed;
        inset: 0;
        margin: auto;
      }
      dialog.analysis-dialog::backdrop {
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(2px);
      }
      .analysis-card {
        width: min(760px, 92vw);
        max-height: 86vh;
        overflow: auto;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
      }
      dialog.analysis-dialog.error .analysis-card {
        border-color: rgba(255, 59, 48, 0.4);
      }
      .analysis-head {
        padding: var(--space-3) var(--space-5);
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .analysis-title-wrap h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .analysis-meta {
        margin-top: 2px;
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        flex-wrap: wrap;
      }
      .analysis-meta .tag {
        padding: 2px 6px;
        border-radius: 3px;
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .analysis-meta .muted {
        color: var(--text-tertiary);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .analysis-close {
        width: 28px;
        height: 28px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-tertiary);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .analysis-close:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .analysis-body {
        padding: var(--space-4) var(--space-5);
        font-size: var(--text-sm);
        line-height: 1.6;
        color: var(--text-primary);
        white-space: pre-wrap;
      }
      dialog.analysis-dialog.error .analysis-body {
        color: #ff3b30;
      }

      /* Trade recommendation card — renders between the head and the prose
         body. Action colour-codes the left border so the operator can
         eyeball Buy / Sell / Hold instantly. */
      .rec-card {
        margin: var(--space-3) var(--space-5) 0;
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--border);
        border-left-width: 4px;
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .rec-card.rec-buy {
        border-left-color: #16a34a;
      }
      .rec-card.rec-sell {
        border-left-color: #dc2626;
      }
      .rec-card.rec-hold,
      .rec-card.rec-missing {
        border-left-color: var(--text-tertiary);
      }
      .rec-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .rec-action {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        letter-spacing: 0.02em;
      }
      .rec-card.rec-buy .rec-action {
        color: #16a34a;
      }
      .rec-card.rec-sell .rec-action {
        color: #dc2626;
      }
      .rec-card.rec-hold .rec-action,
      .rec-card.rec-missing .rec-action {
        color: var(--text-tertiary);
      }
      .rec-confidence {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      .rec-confidence strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
        margin-left: 4px;
      }
      .rec-levels {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: var(--space-3);
      }
      .rec-level {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .rec-label {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .rec-value {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
        color: var(--text-primary);
      }
      .rec-rationale {
        margin: 0;
        font-size: var(--text-xs);
        line-height: 1.5;
        color: var(--text-secondary);
        font-style: italic;
      }

      .chart-toggles {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
        align-items: center;
      }
      .toggle-btn {
        height: 28px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-tertiary);
        font-size: 10px;
        font-weight: var(--font-semibold);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .toggle-btn:hover {
        color: var(--text-secondary);
      }
      .toggle-btn.active {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
        border-color: var(--accent);
      }

      /* Indicator chips — one per active indicator. Click body to open the
         params editor inline; × to remove. */
      .indicator-chip {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 26px;
        padding: 0 6px 0 8px;
        background: rgba(142, 142, 147, 0.08);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .indicator-chip.editing {
        border-color: var(--accent);
        background: rgba(0, 113, 227, 0.08);
      }
      .chip-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        cursor: pointer;
      }
      .chip-label {
        cursor: pointer;
        font-variant-numeric: tabular-nums;
      }
      .chip-remove {
        width: 16px;
        height: 16px;
        border: none;
        background: transparent;
        color: var(--text-tertiary);
        font-size: 14px;
        line-height: 1;
        padding: 0;
        cursor: pointer;
        border-radius: 50%;
      }
      .chip-remove:hover {
        background: rgba(255, 59, 48, 0.16);
        color: #b91c1c;
      }
      .chip-editor {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        z-index: 30;
        min-width: 200px;
        padding: 10px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .editor-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        color: var(--text-primary);
      }
      .editor-close {
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        font-size: 14px;
        cursor: pointer;
        padding: 0;
        line-height: 1;
      }
      .editor-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-size: 10.5px;
        color: var(--text-secondary);
      }
      .editor-label {
        font-weight: var(--font-medium);
      }
      .editor-input {
        width: 70px;
        height: 24px;
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: 11px;
        font-family: inherit;
      }
      .editor-color {
        width: 36px;
        height: 24px;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: transparent;
        cursor: pointer;
      }

      /* "+ Indicator" picker dropdown. */
      .picker-wrapper {
        position: relative;
      }
      .picker-btn {
        padding: 0 8px;
      }
      .picker-dropdown {
        position: absolute;
        top: calc(100% + 4px);
        right: 0;
        z-index: 30;
        min-width: 180px;
        padding: 6px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .picker-section {
        display: flex;
        flex-direction: column;
      }
      .picker-section-title {
        padding: 4px 6px 2px;
        font-size: 9.5px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-tertiary);
        font-weight: var(--font-semibold);
      }
      .picker-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        background: transparent;
        border: none;
        text-align: left;
        font-size: 11px;
        color: var(--text-secondary);
        cursor: pointer;
        font-family: inherit;
        border-radius: 4px;
      }
      .picker-item:hover {
        background: rgba(0, 113, 227, 0.08);
        color: var(--text-primary);
      }
      .picker-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
      }

      .chart-container {
        position: relative;
        height: 500px;
      }
      .echart-instance {
        width: 100%;
        height: 100%;
      }

      .chart-skeleton {
        width: 100%;
        height: 100%;
        background: var(--bg-tertiary);
        position: relative;
        overflow: hidden;
      }
      .shimmer {
        position: absolute;
        inset: 0;
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(255, 255, 255, 0.15) 50%,
          transparent 100%
        );
        animation: shimmer 1.5s infinite;
      }
      @keyframes shimmer {
        0% {
          transform: translateX(-100%);
        }
        100% {
          transform: translateX(100%);
        }
      }

      .chart-info-bar {
        display: flex;
        align-items: center;
        gap: var(--space-5);
        padding: var(--space-2) var(--space-4);
        border-top: 1px solid var(--border);
        font-variant-numeric: tabular-nums;
      }
      .info-item {
        display: flex;
        align-items: center;
        gap: var(--space-1);
      }
      .info-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
      }
      .info-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
      }
      .info-value.high {
        color: var(--profit);
      }
      .info-value.low {
        color: var(--loss);
      }
      .info-value.up {
        color: var(--profit);
      }
      .info-value.down {
        color: var(--loss);
      }
      .info-value.muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .candle-count {
        margin-left: auto;
      }

      @media (max-width: 768px) {
        .chart-toolbar {
          flex-direction: column;
          align-items: stretch;
        }
        .chart-container {
          height: 400px;
        }
      }
    `,
  ],
})
export class TradingChartComponent implements OnInit, OnDestroy {
  private marketData = inject(MarketDataService);
  private positionsService = inject(PositionsService);
  private notifications = inject(NotificationService);
  private destroy$ = new Subject<void>();
  /** Position id currently being SL/TP-modified — prevents stacking concurrent drags. */
  private modifyingPosId: number | null = null;
  /** True from `ondragstart` until either the API resolves or the user cancels.
   *  Live-price ticks skip `buildChartMerge` while this is true so a setOption
   *  with notMerge:true doesn't snap the dragged line back mid-gesture. */
  private dragInProgress = false;

  symbols = [
    'EUR/USD',
    'GBP/USD',
    'USD/JPY',
    'AUD/USD',
    'EUR/GBP',
    'USD/CHF',
    'NZD/USD',
    'USD/CAD',
  ];
  timeframes = [
    { label: '1m', value: 'M1' },
    { label: '5m', value: 'M5' },
    { label: '15m', value: 'M15' },
    { label: '1H', value: 'H1' },
    { label: '4H', value: 'H4' },
    { label: '1D', value: 'D1' },
  ];

  selectedSymbol = signal('EUR/USD');
  selectedTimeframe = signal('H1');

  /**
   * Emits the chart's currently selected symbol (slash form, e.g. "EUR/USD")
   * whenever the user picks a new instrument. Lets the parent page sync
   * external KPIs / market-insights widgets with the chart focus without
   * duplicating dropdown state.
   */
  readonly symbolChange = output<string>();

  /** Emits the chart's selected timeframe (M1, M5, M15, H1, H4, D1). */
  readonly timeframeChange = output<string>();

  /**
   * Emits the chart's loaded candle series whenever it changes (symbol /
   * timeframe switch, periodic refresh). Parent pages use this to drive
   * price-action analytics (RSI / MACD / ATR / pivots) without making a
   * second round-trip for the same data.
   */
  readonly candlesChange = output<CandleDto[]>();

  /**
   * Fires after the engine accepts a drag-initiated SL/TP modification.
   * Parent pages should refresh their positions feed in response (the
   * engine has already updated the row and queued the EA command).
   */
  readonly slTpModified = output<{ positionId: number; kind: 'SL' | 'TP'; newPrice: number }>();

  /**
   * Open positions to overlay on the chart. Each position contributes up
   * to three horizontal lines: average-entry, stop-loss (if set), and
   * take-profit (if set). The chart filters internally to positions whose
   * `symbol` matches `selectedSymbol()` so the parent can pass the full
   * open-positions list without per-symbol slicing.
   */
  readonly positions = input<PositionDto[]>([]);
  loading = signal(true);
  candles = signal<CandleDto[]>([]);
  livePrice = signal<LivePriceDto | null>(null);
  previousBid = signal<number>(0);
  showVolume = signal(true);

  /** Show open-position overlay lines (entry + SL + TP) on the chart. Default
   *  on; toggleable via the toolbar so the operator can declutter the chart
   *  when reading raw price action. */
  showPositions = signal(true);

  // ── Spot LLM analysis ──────────────────────────────────────────────
  /** True while a /market-data/analyze call is in flight. */
  readonly analyzing = signal(false);
  /** Most recent successful analysis result; non-null renders the modal. */
  readonly analysisResult = signal<MarketAnalysisResultDto | null>(null);
  /** Error string when the most recent call failed; non-null renders the
   *  error modal. Mutually exclusive with `analysisResult`. */
  readonly analysisError = signal<string | null>(null);

  // ── Live analysis ──────────────────────────────────────────────────
  /** When on, a silent spot-analysis fires on every candle close for the
   *  focused (symbol, timeframe). Global preference, persisted. */
  readonly liveAnalysisEnabled = signal(false);
  /** When on, each completed spot analysis (manual OR live) also asks the
   *  engine to persist every viable setup as a LIVE trade signal. Global
   *  preference, persisted. OFF by default — these auto-execute. */
  readonly signalAutoGenEnabled = signal(false);
  /** Last COMPLETED analysis (manual or live) keyed by "symbol|timeframe".
   *  In-memory cache; each pair's entry is also persisted per-pair and
   *  restored lazily by loadChartConfig() on load and on every pair/TF
   *  switch. Use {@link lastAnalysis} for the selected pair's entry. */
  private readonly lastAnalysisByPair = signal<Record<string, MarketAnalysisResultDto>>({});
  /** The last analysis for the CURRENTLY selected (symbol, timeframe) —
   *  what the on-chart bubble shows and what the bubble click opens.
   *  Recomputes when the selection OR the per-pair cache changes, so
   *  switching pair/TF flips the bubble to that pair's last run. */
  readonly lastAnalysis = computed<MarketAnalysisResultDto | null>(
    () =>
      this.lastAnalysisByPair()[this.pairKey(this.selectedSymbol(), this.selectedTimeframe())] ??
      null,
  );
  /** Candle-boundary index (floor(now / tfMs)) at the last live tick.
   *  Plain field, NOT a signal — mutating it inside the candle-close
   *  effect must not retrigger the effect. */
  private lastCandleBoundary: number | null = null;
  /** Symbol|timeframe key at the last live tick. When it changes we
   *  re-baseline the boundary so a pair/TF switch doesn't spuriously
   *  fire an analysis on the very next second. */
  private lastAnalysisContextKey: string | null = null;

  /** Native <dialog> wrapping the analysis brief. Opened via showModal()
   *  so it renders in the top layer above the chart's overflow:hidden box. */
  private readonly analysisDialog = viewChild<ElementRef<HTMLDialogElement>>('analysisDialog');

  // ── Longer-horizon macro analysis ──────────────────────────────────
  /** True while a /market-data/analyze-macro call is in flight. */
  readonly macroAnalyzing = signal(false);
  /** Most recent successful macro result; non-null renders the macro modal. */
  readonly macroAnalysisResult = signal<MarketMacroAnalysisResultDto | null>(null);
  /** Error string when the most recent macro call failed; non-null renders
   *  the macro error modal. Mutually exclusive with `macroAnalysisResult`. */
  readonly macroAnalysisError = signal<string | null>(null);
  /** Native <dialog> wrapping the macro brief — separate element from the
   *  spot dialog so the two modals never collide. */
  private readonly macroAnalysisDialog =
    viewChild<ElementRef<HTMLDialogElement>>('macroAnalysisDialog');

  /** Wall-clock signal updated every second by a setInterval started in
   *  ngOnInit. Drives the candle-close countdown without leaking the
   *  interval (cleaned up in ngOnDestroy). */
  private nowMs = signal<number>(Date.now());
  private countdownTickId: ReturnType<typeof setInterval> | null = null;

  /** Time remaining until the current candle closes, formatted hh:mm:ss
   *  (or mm:ss when under an hour). The candle boundary aligns to the
   *  timeframe's UTC grid — M1 ticks every minute on the dot, H1 at the
   *  top of the hour, H4 at 00/04/08/12/16/20 UTC, D1 at UTC midnight —
   *  so `tfMs - (now % tfMs)` gives the exact remaining ms.
   *
   *  Recomputes on every nowMs tick + every timeframe change. */
  readonly candleCountdown = computed(() => {
    const tfMin = TIMEFRAME_MINUTES_MAP[this.selectedTimeframe()] ?? 60;
    const tfMs = tfMin * 60_000;
    const remaining = tfMs - (this.nowMs() % tfMs);
    return formatRemainingMs(remaining);
  });

  /** Cumulative live unrealised P&L (USD) for every open position whose
   *  symbol matches the focused chart. Mirrors the engine's
   *  PnLConverter so the chart number matches the position table:
   *
   *    raw P&L = priceΔ × lots × contractSize  (in QUOTE currency)
   *    - quote = USD (*USD pairs): raw is already USD
   *    - base  = USD (USDJPY/USDCHF/USDCAD): divide by current price
   *    - cross-rate  (EURJPY, EURGBP): no FX-rate service yet — fall
   *      back to the engine's last-persisted unrealizedPnL so we don't
   *      display a misleadingly large quote-currency number.
   *
   *  Returns null when there are no positions on the focused symbol so
   *  the template hides the badge entirely (instead of showing $0.00). */
  readonly openPositionsPnL = computed<{
    usd: number;
    count: number;
    display: string;
    sign: 1 | 0 | -1;
  } | null>(() => {
    const symJoined = (this.selectedSymbol() ?? '').replace(/\//g, '').toUpperCase();
    const positions = (this.positions() ?? []).filter(
      (p) => p?.symbol && p.symbol.replace(/\//g, '').toUpperCase() === symJoined,
    );
    if (positions.length === 0) return null;

    const lp = this.livePrice();
    const haveLive = !!lp?.bid && Number.isFinite(lp.bid) && !!lp?.ask && Number.isFinite(lp.ask);
    const baseCcy = symJoined.slice(0, 3);
    const quoteCcy = symJoined.slice(3, 6);
    const contractSize = 100_000;
    let totalUsd = 0;

    for (const pos of positions) {
      const isLong = pos.direction === 'Long';
      const refPrice = haveLive ? (isLong ? lp!.bid : lp!.ask) : Number.NaN;
      if (!Number.isFinite(refPrice)) {
        // No live tick yet — engine's last persisted figure is closer than nothing.
        if (Number.isFinite(pos.unrealizedPnL)) totalUsd += Number(pos.unrealizedPnL);
        continue;
      }
      const entry = Number(pos.averageEntryPrice);
      const rawPnL = isLong
        ? (refPrice - entry) * Number(pos.openLots) * contractSize
        : (entry - refPrice) * Number(pos.openLots) * contractSize;
      if (quoteCcy === 'USD') {
        totalUsd += rawPnL;
      } else if (baseCcy === 'USD' && refPrice !== 0) {
        totalUsd += rawPnL / refPrice;
      } else {
        // Cross-rate fallback — engine value if present.
        totalUsd += Number.isFinite(pos.unrealizedPnL) ? Number(pos.unrealizedPnL) : 0;
      }
    }
    const sign: 1 | 0 | -1 = totalUsd > 0 ? 1 : totalUsd < 0 ? -1 : 0;
    const display = `${sign >= 0 ? '+' : '−'}$${Math.abs(totalUsd).toFixed(2)}`;
    return { usd: totalUsd, count: positions.length, display, sign };
  });

  /** Active indicators for the current (symbol, timeframe). Loaded from
   *  localStorage on construction; persisted on every mutation. */
  indicators = signal<IndicatorConfig[]>([]);

  /** Picker dropdown open/closed. */
  pickerOpen = signal(false);

  /** Inline params editor — id of the indicator currently being tuned, or
   *  null when the editor is closed. */
  editingIndicatorId = signal<string | null>(null);

  /** Catalog exposed to the template. */
  readonly indicatorCatalog = INDICATOR_DEFS;

  readonly overlayIndicators = computed(() =>
    this.indicators().filter((i) => INDICATOR_BY_TYPE[i.type].pane === 'price'),
  );
  readonly subplotIndicators = computed(() =>
    this.indicators().filter((i) => INDICATOR_BY_TYPE[i.type].pane === 'subplot'),
  );

  priceDirection = computed(() => {
    const current = this.livePrice()?.bid ?? 0;
    const prev = this.previousBid();
    if (current > prev) return 'up';
    if (current < prev) return 'down';
    return 'none';
  });

  pricePrecision = computed(() => (this.selectedSymbol().includes('JPY') ? 3 : 5));

  latestCandle = computed(() => {
    const c = this.candles();
    return c.length > 0 ? c[c.length - 1] : null;
  });

  // Initial empty chart structure
  chartInitOptions: EChartsOption = {
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: { color: '#6E6E73', width: 0.5, type: 'dashed' },
        lineStyle: { color: '#6E6E73', width: 0.5, type: 'dashed' },
        label: { backgroundColor: '#1D1D1F', fontSize: 10, borderRadius: 4, padding: [4, 8] },
      },
      backgroundColor: 'rgba(255,255,255,0.92)',
      borderColor: 'rgba(0,0,0,0.06)',
      borderRadius: 10,
      padding: [8, 12],
      textStyle: { fontSize: 12, color: '#1D1D1F' },
      extraCssText: 'backdrop-filter:blur(20px);box-shadow:0 4px 12px rgba(0,0,0,0.08);',
    },
    grid: [
      { left: 60, right: 85, top: 30, height: '58%' },
      { left: 60, right: 85, bottom: 30, height: '15%' },
    ],
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    xAxis: [
      {
        type: 'category',
        data: [],
        gridIndex: 0,
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        axisTick: { show: false },
        boundaryGap: true,
      },
      {
        type: 'category',
        data: [],
        gridIndex: 1,
        axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
        axisLabel: { show: false },
        axisTick: { show: false },
      },
    ],
    yAxis: [
      {
        type: 'value',
        scale: true,
        gridIndex: 0,
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        position: 'right',
      },
      {
        type: 'value',
        gridIndex: 1,
        splitLine: { show: false },
        axisLabel: { show: false },
        axisLine: { show: false },
      },
    ],
    dataZoom: [
      // X-axis: mouse wheel zooms time, drag pans time. moveOnMouseWheel
      // is disabled so the wheel always zooms (matches MetaTrader/TradingView).
      {
        type: 'inside',
        xAxisIndex: [0, 1],
        start: 0,
        end: 100,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: false,
      },
      // Y-axis (price grid only): plain drag pans price along with the x-axis
      // pan above (so click-hold-drag moves the chart freely in 2D), shift+wheel
      // zooms price. filterMode 'none' so candles outside the visible y range
      // are viewport-clipped rather than dropped — without this echarts would
      // remove off-screen candles from the dataset and break the candlestick
      // series during a y-zoom.
      {
        type: 'inside',
        yAxisIndex: 0,
        filterMode: 'none',
        zoomOnMouseWheel: 'shift',
        moveOnMouseMove: true,
      },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        left: 60,
        right: 85,
        bottom: 5,
        height: 16,
        borderColor: 'rgba(0,0,0,0.06)',
        backgroundColor: 'rgba(0,0,0,0.02)',
        fillerColor: 'rgba(0,113,227,0.08)',
        handleStyle: { color: '#0071E3' },
        textStyle: { fontSize: 9, color: '#6E6E73' },
      },
      // Y-axis slider on the right edge of the price grid. Top/bottom track
      // the price grid (grid[0]), so the slider resizes when the Volume pane
      // is hidden — see buildFullOption for the live-recomputed bounds.
      {
        type: 'slider',
        yAxisIndex: 0,
        right: 5,
        width: 16,
        top: 30,
        height: '58%',
        showDataShadow: false,
        showDetail: false,
        borderColor: 'rgba(0,0,0,0.06)',
        backgroundColor: 'rgba(0,0,0,0.02)',
        fillerColor: 'rgba(0,113,227,0.08)',
        handleStyle: { color: '#0071E3' },
      },
    ],
    series: [
      {
        name: 'Price',
        type: 'candlestick',
        data: [],
        xAxisIndex: 0,
        yAxisIndex: 0,
        // Cap the body width so a sparse window (2–3 candles) still renders
        // narrow vertical candles like MetaTrader, not chart-wide horizontal
        // bars. ECharts otherwise auto-stretches each body to fill available
        // x-axis space when item count is low.
        barMaxWidth: 14,
        itemStyle: {
          // ECharts candlestick convention: `color` = bullish (close > open),
          // `color0` = bearish (close ≤ open). Match MetaTrader's green/red.
          color: '#34C759',
          color0: '#FF3B30',
          borderColor: '#34C759',
          borderColor0: '#FF3B30',
          borderWidth: 1,
        },
      },
      { name: 'Volume', type: 'bar', data: [], xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%' },
      // ── Live BID line ────────────────────────────────────────────
      // Rendered as a dedicated line series rather than a candlestick
      // markLine because ECharts' markLine merge caches the `yAxis`
      // pixel coords from the first tick and never updates them — the
      // label string updates per-tick but the line stays put. Using a
      // regular line series with `data: [bid, bid, ..., bid]` sidesteps
      // that bug entirely; line-series data updates land predictably.
      {
        name: 'BID',
        type: 'line',
        data: [],
        symbol: 'none',
        silent: true,
        animation: false,
        smooth: false,
        sampling: 'lttb',
        lineStyle: { color: '#34C759', width: 1.2, type: 'solid' },
        endLabel: {
          show: false,
          formatter: '',
          backgroundColor: '#34C759',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 600,
          offset: [0, 8],
        },
        xAxisIndex: 0,
        yAxisIndex: 0,
        z: 10,
      },
      // ── Live ASK line ────────────────────────────────────────────
      {
        name: 'ASK',
        type: 'line',
        data: [],
        symbol: 'none',
        silent: true,
        animation: false,
        smooth: false,
        sampling: 'lttb',
        lineStyle: { color: '#FF3B30', width: 1.2, type: 'dashed' },
        endLabel: {
          show: false,
          formatter: '',
          backgroundColor: '#FF3B30',
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 600,
          offset: [0, -8],
        },
        xAxisIndex: 0,
        yAxisIndex: 0,
        z: 10,
      },
    ],
  };

  chartMerge = signal<EChartsOption>({});

  /**
   * The live ECharts instance, captured via the directive's `(chartInit)`
   * event. Used to push markLine/candle updates directly via `setOption`
   * — the `[merge]` binding alone has shown intermittent staleness on the
   * markLine when the merge happens during a live-price tick before the
   * chart has finished its previous frame.
   */
  private echartsInstance: any = null;

  onChartReady(instance: any) {
    this.echartsInstance = instance;
    // Apply current state immediately so the chart isn't blank between
    // init and the next tick. buildChartMerge bails out if candles
    // haven't loaded yet, in which case the next loadCandles tick will
    // fire it via the constructor effect.
    this.buildChartMerge();
    // Reposition the draggable SL/TP handles when the operator pans /
    // zooms — the chart's pixel→price mapping changes and the existing
    // graphic.position values go stale. We deliberately do NOT listen
    // to `finished`: `updateSlTpHandles` itself calls `setOption`,
    // which fires `finished` again, which would call setOption again
    // → infinite loop (ECharts logs "setOption should not be called
    // during main process" hundreds of times). The handles get
    // refreshed at the end of every `buildChartMerge`, which is the
    // only other place the chart redraws.
    instance.on?.('dataZoom', this.onDataZoom);
  }

  // Pre-bound so `off` can detach the same reference on destroy.
  private onDataZoom = () => this.updateSlTpHandles();

  /** Returns true when the chart instance is live (non-null and not yet
   *  disposed by ngx-echarts). Every setOption / convert* call should
   *  go through this guard so post-teardown callbacks (dataZoom fired
   *  during dispose, late-resolving observables) don't write into a
   *  half-destroyed ECharts instance and produce
   *  "Instance ec_… has been disposed" / "Cannot set properties of
   *  null (setting 'innerHTML')" floods. */
  private isChartLive(): boolean {
    const c = this.echartsInstance;
    return !!c && typeof c.setOption === 'function' && !c.isDisposed?.();
  }

  // Tracks the candle count of the last merge that wrote dataZoom. On live
  // price ticks we skip dataZoom so the operator's pan/zoom persists; we only
  // re-emit the default zoom window when the candle dataset itself changes
  // (initial load or symbol/timeframe switch).
  private lastZoomCandleCount = -1;

  constructor() {
    // Re-run buildChartMerge whenever the live price ticks. Folding the
    // bid/ask markLine into the same merge stream that owns the candle data
    // keeps a later candle merge from accidentally clobbering the markLine —
    // an issue we hit when the markLine was pushed through a separate
    // setOption side-channel.
    effect(() => {
      // Re-render whenever live price ticks OR the candle series mutates
      // (server reload / live tick patching the in-progress bar) OR the
      // open-positions overlay changes OR the indicator config changes
      // (add / remove / param edit).
      this.livePrice();
      this.candles();
      this.positions();
      this.indicators();
      this.showVolume();
      this.showPositions();
      this.buildChartMerge();
    });

    // Mirror selected symbol/timeframe into outputs so parents can react
    // to chart focus changes without duplicating dropdown state.
    effect(() => this.symbolChange.emit(this.selectedSymbol()));
    effect(() => this.timeframeChange.emit(this.selectedTimeframe()));

    // Re-emit the candle series whenever it changes — parents wire price
    // action analytics off this stream.
    effect(() => this.candlesChange.emit(this.candles()));

    // Drive the native <dialog> off the result/error signals so callers
    // don't need to call showModal/close directly. viewChild resolves
    // post-render — `el` is undefined on the first run, which is fine
    // (signals start null so no open is attempted).
    effect(() => {
      const open = !!this.analysisResult() || !!this.analysisError();
      const el = this.analysisDialog()?.nativeElement;
      if (!el) return;
      if (open && !el.open && typeof el.showModal === 'function') {
        el.showModal();
      } else if (!open && el.open) {
        el.close();
      }
    });

    // Same modal driver for the separate macro dialog.
    effect(() => {
      const open = !!this.macroAnalysisResult() || !!this.macroAnalysisError();
      const el = this.macroAnalysisDialog()?.nativeElement;
      if (!el) return;
      if (open && !el.open && typeof el.showModal === 'function') {
        el.showModal();
      } else if (!open && el.open) {
        el.close();
      }
    });

    // Live-analysis candle-close trigger. The 1 s nowMs tick is the only
    // tracked dependency that changes second-to-second; symbol/timeframe/
    // enabled are tracked so flipping any of them re-evaluates. Everything
    // that mutates state (boundary bookkeeping, the analysis kick-off) runs
    // untracked so this effect never feeds back into itself.
    effect(() => {
      const now = this.nowMs();
      const enabled = this.liveAnalysisEnabled();
      const sym = this.selectedSymbol();
      const tf = this.selectedTimeframe();
      if (!enabled) return;

      untracked(() => {
        const tfMin = TIMEFRAME_MINUTES_MAP[tf] ?? 60;
        const tfMs = tfMin * 60_000;
        const boundary = Math.floor(now / tfMs);
        const ctxKey = `${sym}|${tf}`;

        // Pair/timeframe switch (or first run) — adopt the current boundary
        // as the baseline and wait for the NEXT close before firing.
        if (this.lastAnalysisContextKey !== ctxKey || this.lastCandleBoundary === null) {
          this.lastAnalysisContextKey = ctxKey;
          this.lastCandleBoundary = boundary;
          return;
        }

        if (boundary > this.lastCandleBoundary) {
          this.lastCandleBoundary = boundary;
          // Skip if a call (manual or prior live) is still in flight — the
          // deep model takes 60-250s, longer than some timeframes; we'd
          // rather miss a close than queue overlapping calls.
          if (!this.analyzing()) this.runMarketAnalysis(true);
        }
      });
    });
  }

  ngOnInit() {
    this.loadChartConfig();
    this.loadCandles();
    this.startLivePricePolling();
    // 1 s tick drives the candle-close countdown shown in the toolbar.
    // setInterval is enough — sub-second precision isn't useful when the
    // displayed value rounds to whole seconds.
    this.countdownTickId = setInterval(() => this.nowMs.set(Date.now()), 1000);
    // NOTE: deliberately NO analysis run on load/reload, even if live
    // analysis was left on. Auto-runs fire ONLY on candle close (see the
    // candle-close effect). The bubble isn't blank on load because the last
    // completed analysis was restored from storage in loadChartConfig().
  }

  ngOnDestroy() {
    // Detach the dataZoom listener BEFORE clearing the instance ref so
    // ECharts doesn't fire it against a disposed instance after teardown
    // (the source of the "Instance ec_… has been disposed" + "Cannot set
    // properties of null (setting 'innerHTML')" floods in the console).
    try {
      this.echartsInstance?.off?.('dataZoom', this.onDataZoom);
    } catch {
      /* ignore */
    }
    this.echartsInstance = null;
    if (this.countdownTickId !== null) {
      clearInterval(this.countdownTickId);
      this.countdownTickId = null;
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  onSymbolChange(symbol: string) {
    this.selectedSymbol.set(symbol);
    this.loading.set(true);
    this.loadChartConfig();
    this.loadCandles();
  }

  onTimeframeChange(tf: string) {
    this.selectedTimeframe.set(tf);
    this.loading.set(true);
    this.loadChartConfig();
    this.loadCandles();
  }

  toggleVolume() {
    this.showVolume.set(!this.showVolume());
    this.persistGlobalToggle(SHOW_VOLUME_STORAGE_KEY, this.showVolume());
    this.buildChartMerge();
  }

  togglePositions() {
    this.showPositions.set(!this.showPositions());
    this.persistGlobalToggle(SHOW_POSITIONS_STORAGE_KEY, this.showPositions());
    this.buildChartMerge();
  }

  /**
   * Fires a one-shot LLM spot analysis for the focused (symbol, timeframe).
   * The engine gathers candles / regime / order book / liquidity history /
   * economic events / sentiment server-side, builds a structured prompt,
   * and calls the configured deep-tier LLM.
   *
   * @param silent when true (live-mode background run) the result only
   *   updates `lastAnalysis` (the on-chart bubble) and does NOT pop the
   *   modal or surface errors as a blocking overlay — a flaky background
   *   call shouldn't interrupt the operator. When false (manual button)
   *   the modal opens as before.
   */
  runMarketAnalysis(silent = false): void {
    if (this.analyzing()) return;
    this.analyzing.set(true);
    if (!silent) {
      this.analysisResult.set(null);
      this.analysisError.set(null);
    }
    // Snapshot the pair NOW: the call takes 60-250s and the operator may
    // switch symbol/TF while it runs — the result must be filed under the
    // pair it was actually requested for, not whatever's selected on return.
    const reqSym = this.selectedSymbol();
    const reqTf = this.selectedTimeframe();
    const reqKey = this.pairKey(reqSym, reqTf);
    this.marketData
      .analyzeMarket(reqSym, reqTf, this.signalAutoGenEnabled())
      .pipe(
        catchError((err) => {
          if (!silent) {
            const msg = err?.error?.message ?? err?.message ?? String(err);
            this.analysisError.set(`Analysis request failed: ${msg}`);
          }
          return of(null);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.analyzing.set(false);
        if (res?.status && res.data) {
          // File under the REQUESTED pair (manual + live both feed this) and
          // persist per-pair so the bubble defaults to it after a reload.
          // If the operator already switched pair the bubble won't flip to
          // this — it stays scoped to whatever pair is now selected.
          const data = res.data;
          this.lastAnalysisByPair.update((m) => ({ ...m, [reqKey]: data }));
          this.persistLastAnalysis(reqSym, reqTf, data);
          if (!silent) this.analysisResult.set(data);
        } else if (res && !silent) {
          this.analysisError.set(res.message ?? 'Analysis refused by the engine.');
        }
      });
  }

  /** Toggle live analysis. Persisted globally. Enabling does NOT run an
   *  analysis immediately — auto-runs fire only on candle close. The bubble
   *  meanwhile shows the last completed run (restored from storage). */
  toggleLiveAnalysis(): void {
    const next = !this.liveAnalysisEnabled();
    this.liveAnalysisEnabled.set(next);
    this.persistGlobalToggle(LIVE_ANALYSIS_STORAGE_KEY, next);
    if (next) {
      // Re-baseline the candle-close detector so the FIRST auto-run is the
      // next close after enabling — not an immediate fire on the current,
      // already-open candle.
      this.lastCandleBoundary = null;
      this.lastAnalysisContextKey = null;
    }
  }

  /** Toggle auto-signal generation. Persisted globally. When ON, the
   *  generateSignals flag is sent on every spot-analysis call (manual + live);
   *  the engine persists each viable setup as a live, auto-executing trade
   *  signal. Enabling does NOT run anything immediately. */
  toggleSignalAutoGen(): void {
    const next = !this.signalAutoGenEnabled();
    this.signalAutoGenEnabled.set(next);
    this.persistGlobalToggle(SIGNAL_AUTOGEN_STORAGE_KEY, next);
  }

  /** Bubble click → open the last completed analysis in the modal. */
  openLastAnalysis(): void {
    const last = this.lastAnalysis();
    if (last) this.analysisResult.set(last);
  }

  /** Dismiss whichever overlay is currently visible (success or error). */
  closeAnalysis(): void {
    this.analysisResult.set(null);
    this.analysisError.set(null);
  }

  /** Native <dialog> emits `close` on Escape and programmatic .close().
   *  Clear signals so the effect doesn't try to reopen on the next tick. */
  onAnalysisDialogClose(): void {
    this.analysisResult.set(null);
    this.analysisError.set(null);
  }

  /**
   * Reward-to-risk ratio for the LLM's proposed trade — |TP - entry| / |entry - SL|.
   * Returns null when any field is missing or the math would divide by zero.
   * Surfaced as a 4th column on the levels grid so the operator can sanity-
   * check the setup at a glance (we want ≥ 1.5 typically; ≪ 1 means the
   * model has cited a high-probability low-payout setup that probably isn't
   * worth taking).
   */
  recRiskReward(rec: MarketAnalysisRecommendationDto): string | null {
    const e = rec.entryPrice;
    const s = rec.stopLoss;
    const t = rec.takeProfit;
    if (e === null || s === null || t === null) return null;
    const risk = Math.abs(e - s);
    if (risk === 0) return null;
    const reward = Math.abs(t - e);
    return `${(reward / risk).toFixed(2)} : 1`;
  }

  /** Native <dialog> backdrop clicks land on the dialog element itself
   *  (not on the inner card, which stops propagation). Treat that as dismiss. */
  onAnalysisBackdropClick(event: MouseEvent): void {
    if (event.target === this.analysisDialog()?.nativeElement) {
      this.closeAnalysis();
    }
  }

  /**
   * Run the longer-horizon macro analysis for the selected pair. Deliberately
   * NOT silent, NOT live-fired, and NOT cached per-pair: it's a costly,
   * operator-initiated one-shot (the cost trade-off the separate command was
   * chosen for). The result opens its own modal; spot state is untouched.
   */
  runMacroAnalysis(): void {
    if (this.macroAnalyzing()) return;
    this.macroAnalyzing.set(true);
    this.macroAnalysisResult.set(null);
    this.macroAnalysisError.set(null);
    const reqSym = this.selectedSymbol();
    const reqTf = this.selectedTimeframe();
    this.marketData
      .analyzeMacro(reqSym, reqTf)
      .pipe(
        catchError((err) => {
          const msg = err?.error?.message ?? err?.message ?? String(err);
          this.macroAnalysisError.set(`Macro analysis request failed: ${msg}`);
          return of(null);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.macroAnalyzing.set(false);
        if (res?.status && res.data) {
          this.macroAnalysisResult.set(res.data);
        } else if (res) {
          this.macroAnalysisError.set(res.message ?? 'Macro analysis refused by the engine.');
        }
      });
  }

  /** Dismiss the macro overlay (success or error). */
  closeMacroAnalysis(): void {
    this.macroAnalysisResult.set(null);
    this.macroAnalysisError.set(null);
  }

  /** <dialog> close (Escape / programmatic) → clear macro signals. */
  onMacroAnalysisDialogClose(): void {
    this.macroAnalysisResult.set(null);
    this.macroAnalysisError.set(null);
  }

  /** Macro backdrop click (outside the inner card) → dismiss. */
  onMacroAnalysisBackdropClick(event: MouseEvent): void {
    if (event.target === this.macroAnalysisDialog()?.nativeElement) {
      this.closeMacroAnalysis();
    }
  }

  /** Open / close the "+ Indicator" picker dropdown. */
  togglePicker() {
    this.pickerOpen.set(!this.pickerOpen());
  }

  /** Open / close the inline params editor for an indicator chip. */
  toggleEdit(id: string) {
    this.editingIndicatorId.set(this.editingIndicatorId() === id ? null : id);
  }

  /** Add an indicator with its catalog default params. */
  addIndicator(type: IndicatorType) {
    const def = INDICATOR_BY_TYPE[type];
    const params: Record<string, number> = {};
    for (const p of def.params) params[p.key] = p.default;
    const cfg: IndicatorConfig = {
      id: this.makeIndicatorId(type),
      type,
      params,
      color: def.defaultColor,
    };
    this.indicators.update((list) => [...list, cfg]);
    this.pickerOpen.set(false);
    this.persistChartConfig();
    this.buildChartMerge();
  }

  removeIndicator(id: string) {
    this.indicators.update((list) => list.filter((i) => i.id !== id));
    if (this.editingIndicatorId() === id) this.editingIndicatorId.set(null);
    this.persistChartConfig();
    this.buildChartMerge();
  }

  /** Update a single param on an indicator chip. */
  setIndicatorParam(id: string, key: string, value: number) {
    this.indicators.update((list) =>
      list.map((i) => (i.id === id ? { ...i, params: { ...i.params, [key]: value } } : i)),
    );
    this.persistChartConfig();
    this.buildChartMerge();
  }

  setIndicatorColor(id: string, color: string) {
    this.indicators.update((list) => list.map((i) => (i.id === id ? { ...i, color } : i)));
    this.persistChartConfig();
    this.buildChartMerge();
  }

  paramsFor(type: IndicatorType): IndicatorParam[] {
    return INDICATOR_BY_TYPE[type]?.params ?? [];
  }

  labelFor(type: IndicatorType): string {
    return INDICATOR_BY_TYPE[type]?.label ?? type;
  }

  chipSummary(cfg: IndicatorConfig): string {
    const def = INDICATOR_BY_TYPE[cfg.type];
    if (!def || def.params.length === 0) return def?.label ?? cfg.type;
    const parts = def.params.map((p) => cfg.params[p.key]);
    return `${def.label}(${parts.join(',')})`;
  }

  private makeIndicatorId(type: IndicatorType): string {
    return `${type}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }

  // ── Persistence per (symbol, timeframe) ────────────────────────────
  private chartConfigStorageKey(): string {
    return `${INDICATOR_STORAGE_PREFIX}.${this.selectedSymbol()}.${this.selectedTimeframe()}`;
  }

  /** In-memory cache key for a (symbol, timeframe) pair. */
  private pairKey(symbol: string, timeframe: string): string {
    return `${symbol}|${timeframe}`;
  }

  /** localStorage key holding the last analysis for one (symbol, timeframe). */
  private lastAnalysisStorageKey(symbol: string, timeframe: string): string {
    return `${LAST_ANALYSIS_STORAGE_PREFIX}.${symbol}.${timeframe}`;
  }

  private loadChartConfig(): void {
    if (typeof localStorage === 'undefined') return;

    // Indicators are per-(symbol, timeframe) because the operator likely
    // wants different overlays on different pairs (an RSI on majors,
    // none on crosses) — that part stays in the prefixed key.
    const raw = localStorage.getItem(this.chartConfigStorageKey());
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { indicators?: IndicatorConfig[] };
        const valid = (parsed.indicators ?? []).filter((i) => i?.type && INDICATOR_BY_TYPE[i.type]);
        this.indicators.set(valid);
      } catch {
        // fall through to defaults
        this.applyDefaultIndicators();
      }
    } else {
      this.applyDefaultIndicators();
    }

    // Volume / positions toggles are GLOBAL user preferences — read from
    // their dedicated keys, falling back to the signal defaults (both
    // true) when unset. Defensive bool check guards against any stale
    // non-boolean string that might be lurking from a prior storage shape.
    const vol = localStorage.getItem(SHOW_VOLUME_STORAGE_KEY);
    if (vol === 'true' || vol === 'false') this.showVolume.set(vol === 'true');
    const pos = localStorage.getItem(SHOW_POSITIONS_STORAGE_KEY);
    if (pos === 'true' || pos === 'false') this.showPositions.set(pos === 'true');
    const live = localStorage.getItem(LIVE_ANALYSIS_STORAGE_KEY);
    if (live === 'true' || live === 'false') this.liveAnalysisEnabled.set(live === 'true');

    const autoGen = localStorage.getItem(SIGNAL_AUTOGEN_STORAGE_KEY);
    if (autoGen === 'true' || autoGen === 'false')
      this.signalAutoGenEnabled.set(autoGen === 'true');

    // Default the bubble to the SELECTED pair's last completed analysis.
    // loadChartConfig() runs on init and after every symbol/TF switch (with
    // the new selection already applied), so this lazily warms the cache for
    // exactly the pair on screen. RESTORE only — it never triggers a run, so
    // a reload/switch shows that pair's last recommendation without
    // re-analysing. Skip if the cache already holds a (fresher) entry for
    // this pair so an in-flight result isn't clobbered by a stale disk copy.
    const sym = this.selectedSymbol();
    const tf = this.selectedTimeframe();
    const key = this.pairKey(sym, tf);
    if (!this.lastAnalysisByPair()[key]) {
      let restored: MarketAnalysisResultDto | null = null;

      const lastRaw = localStorage.getItem(this.lastAnalysisStorageKey(sym, tf));
      if (lastRaw) {
        try {
          const parsed = JSON.parse(lastRaw) as MarketAnalysisResultDto;
          if (parsed && typeof parsed === 'object' && parsed.completedAt) {
            restored = parsed;
          }
        } catch {
          // corrupt cache — ignore; bubble falls back to its empty state
        }
      }

      // One-time bridge from the old single-slot v1 key. v1 held exactly one
      // DTO; adopt it ONLY for the pair it actually belonged to (slash-
      // insensitive symbol match, since the DTO's echoed symbol may be
      // 'EURUSD' while the selector uses 'EUR/USD'), re-file it under the
      // new per-pair key, and delete v1 so this runs at most once.
      if (!restored) {
        const legacyRaw = localStorage.getItem(LEGACY_LAST_ANALYSIS_KEY);
        if (legacyRaw) {
          try {
            const legacy = JSON.parse(legacyRaw) as MarketAnalysisResultDto;
            const norm = (s: string) => (s ?? '').replace(/\//g, '').toUpperCase();
            if (
              legacy?.completedAt &&
              norm(legacy.symbol) === norm(sym) &&
              legacy.timeframe === tf
            ) {
              restored = legacy;
              this.persistLastAnalysis(sym, tf, legacy);
              localStorage.removeItem(LEGACY_LAST_ANALYSIS_KEY);
            }
          } catch {
            // corrupt legacy blob — drop it so it can't wedge the bridge
            localStorage.removeItem(LEGACY_LAST_ANALYSIS_KEY);
          }
        }
      }

      if (restored) {
        const r = restored;
        this.lastAnalysisByPair.update((m) => ({ ...m, [key]: r }));
      }
    }

    // localStorage above is only an INSTANT (possibly stale / browser-local)
    // paint. The engine is the source of truth — replay the real last
    // analysis for this pair from the audit ledger and let it override.
    // Runs unconditionally (even when the cache had an entry) so a run made
    // in another browser/device/session is reflected here too.
    this.hydrateLastAnalysisFromEngine(sym, tf);
  }

  /**
   * Pull the authoritative last analysis for (sym, tf) from the engine's
   * stored audit row (no new LLM call) and fold it into the per-pair cache,
   * also refreshing the localStorage paint-cache. Silent: a -14 (pair never
   * analysed) or any transport error leaves whatever the cache already had.
   * Keyed by the REQUESTED pair so a mid-flight pair switch can't cross-file
   * the result onto the wrong bubble.
   */
  private hydrateLastAnalysisFromEngine(sym: string, tf: string): void {
    const key = this.pairKey(sym, tf);
    this.marketData
      .getLatestAnalysis(sym, tf)
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        if (res?.status && res.data) {
          const data = res.data;
          this.lastAnalysisByPair.update((m) => ({ ...m, [key]: data }));
          this.persistLastAnalysis(sym, tf, data);
        }
      });
  }

  private applyDefaultIndicators(): void {
    // First-time indicator defaults — keep parity with the old hard-coded
    // MA20/MA50 toggle.
    this.indicators.set([
      {
        id: this.makeIndicatorId('sma'),
        type: 'sma',
        params: { period: 20 },
        color: '#FF9500',
      },
      {
        id: this.makeIndicatorId('sma'),
        type: 'sma',
        params: { period: 50 },
        color: '#AF52DE',
      },
    ]);
  }

  private persistChartConfig(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      // Only persist indicators in the per-(symbol, timeframe) key.
      // Toggles live in their own global keys so an operator never
      // ends up with "Pos" off on GBP/USD but on for EUR/USD just
      // because of a stray click weeks ago.
      localStorage.setItem(
        this.chartConfigStorageKey(),
        JSON.stringify({ indicators: this.indicators() }),
      );
    } catch {
      // storage full / disabled — operator just won't get persistence
    }
  }

  private persistGlobalToggle(key: string, value: boolean): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // storage full / disabled — operator just won't get persistence
    }
  }

  /** Persist the latest completed analysis under its (symbol, timeframe) so
   *  the bubble defaults to that pair's recommendation after a reload,
   *  without re-running. */
  private persistLastAnalysis(
    symbol: string,
    timeframe: string,
    result: MarketAnalysisResultDto,
  ): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.lastAnalysisStorageKey(symbol, timeframe), JSON.stringify(result));
    } catch {
      // storage full / disabled — bubble just won't survive a reload
    }
  }

  private loadCandles() {
    const sym = this.selectedSymbol().replace(/\//g, '');
    const tf = this.selectedTimeframe();

    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: 1000,
        filter: { symbol: sym, timeframe: tf },
      })
      .pipe(
        catchError(() => of(null)),
        takeUntil(this.destroy$),
      )
      .subscribe((res: any) => {
        let data: CandleDto[] = res?.data?.data ?? [];

        // If backend returns no candles, generate sample data
        if (data.length === 0) {
          data = this.generateSampleCandles();
        }

        // Backend returns candles in DESCENDING timestamp order (newest first
        // so the paged endpoint can serve "give me the latest N" cheaply).
        // ECharts renders the data array left-to-right, so without this sort
        // the chart ends up with newest candles on the LEFT — the inverse of
        // every charting platform an operator has used. Sort ascending so the
        // chart reads time-forward like MetaTrader / TradingView.
        data = [...data].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        // Forex markets are closed Fri 22:00 → Sun 22:00 UTC. Candles stamped
        // inside that window are either filler (engine-generated when no
        // ticks arrived) or stale-feed echoes; either way they shouldn't
        // appear on the chart because they distort indicators and visually
        // imply price activity that didn't happen. Crypto pairs (24/7) skip
        // the filter — see `LooksLikeForexSymbol` in the engine for the same
        // 6-alpha-char heuristic used by the worker-side weekend guards.
        if (this.looksLikeForexSymbol(this.selectedSymbol())) {
          data = data.filter((c) => !this.isForexWeekendClosed(new Date(c.timestamp)));
        }

        this.candles.set(data);
        this.loading.set(false);
        this.buildChartMerge();
      });
  }

  /**
   * Mirrors `ForexMarketHours.IsForexWeekendClosed` on the engine side.
   * Window: Friday ≥ 22:00 UTC, all of Saturday, Sunday &lt; 22:00 UTC
   * (NY close → Sydney open).
   */
  private isForexWeekendClosed(d: Date): boolean {
    const day = d.getUTCDay();
    const hour = d.getUTCHours();
    if (day === 6) return true; // Saturday — full day
    if (day === 0 && hour < 22) return true; // Sunday before 22:00 UTC
    if (day === 5 && hour >= 22) return true; // Friday at/after 22:00 UTC
    return false;
  }

  /** Heuristic: 6 alpha chars after stripping the `/` separator (EURUSD,
   *  GBPUSD, USDJPY, …). Crypto symbols (BTCUSDT, 7+ chars) skip the filter. */
  private looksLikeForexSymbol(symbol: string): boolean {
    const stripped = symbol.replace(/\//g, '');
    return /^[A-Za-z]{6}$/.test(stripped);
  }

  private startLivePricePolling() {
    timer(0, 3000)
      .pipe(
        switchMap(() =>
          this.marketData.getLivePrice(this.selectedSymbol()).pipe(catchError(() => of(null))),
        ),
        takeUntil(this.destroy$),
      )
      .subscribe((res: any) => {
        const price: LivePriceDto | null = res?.data ?? null;
        if (price?.bid) {
          // Engine returns spread in raw price units; FX convention is pips.
          // Convert at the source so the "0.0 sp" badge in the chart header
          // shows pip values consistent with the rest of the page.
          const sym = price.symbol ?? this.selectedSymbol();
          const isJPY = (sym ?? '').includes('JPY');
          const pipFactor = isJPY ? 100 : 10000;
          const normalised: LivePriceDto = {
            ...price,
            spread: +(price.spread * pipFactor).toFixed(1),
          };
          this.previousBid.set(this.livePrice()?.bid ?? 0);
          this.livePrice.set(normalised);
          // Paint the live tick onto the in-progress (rightmost) candle so
          // the chart breathes between server-side candle refreshes.
          this.patchLastCandleWithTick(price.bid);
        }
      });

    // Periodic candle re-fetch keeps the chart honest with the server's
    // bar transitions — without this the patched last candle would drift
    // forever and never roll into a new bar. 60s is a balance: low enough
    // that intra-bar painting stays close to truth, high enough that we
    // don't flood the API just to re-draw history that hasn't changed.
    timer(60_000, 60_000)
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.loadCandles());
  }

  /**
   * Update the rightmost candle's high/low/close to reflect a live tick.
   * Doesn't try to roll into a new bar on its own — the periodic
   * `loadCandles()` re-fetch in `startLivePricePolling` is what brings the
   * fresh server-side bar in. Until that happens, the current bar simply
   * keeps growing, which matches what an operator expects to see between
   * candle closes.
   */
  private patchLastCandleWithTick(tickPrice: number): void {
    if (!Number.isFinite(tickPrice) || tickPrice <= 0) return;
    const data = this.candles();
    if (data.length === 0) return;
    const last = data[data.length - 1];
    // Skip if the tick is identical to the existing close — no visual
    // change and no need to re-emit candlesChange to subscribers.
    if (last.close === tickPrice && last.high >= tickPrice && last.low <= tickPrice) return;
    const updated: CandleDto = {
      ...last,
      close: tickPrice,
      high: Math.max(last.high, tickPrice),
      low: Math.min(last.low, tickPrice),
    };
    this.candles.set([...data.slice(0, -1), updated]);
  }

  private buildChartMerge() {
    const data = this.candles();
    if (data.length === 0) return;

    const dates = data.map((c) => this.formatDate(c.timestamp));
    const ohlc = data.map((c) => [c.open, c.close, c.low, c.high]);
    const closes = data.map((c) => c.close);
    const volumes = data.map((c) => ({
      value: c.volume,
      itemStyle: { color: c.close >= c.open ? 'rgba(52,199,89,0.35)' : 'rgba(255,59,48,0.35)' },
    }));

    // Build dynamic indicator series. Overlays render on the price grid;
    // subplot indicators each get their own grid below volume.
    const overlaySeries = this.buildOverlaySeries(data, closes);
    const subplotSeriesList = this.subplotIndicators().map((cfg, i) =>
      this.buildSubplotSeries(cfg, data, closes, /* gridIndex */ 2 + i),
    );
    const subplotSeries = subplotSeriesList.flatMap((s) => s.series);

    // Calculate Y-axis range — include the live bid/ask AND any open-position
    // entry / SL / TP prices for the focused symbol so the chart auto-zooms
    // to keep all the overlay lines on screen, not just the candles.
    const allPrices = data.flatMap((c) => [c.open, c.high, c.low, c.close]);
    const livePriceForRange = this.livePrice();
    if (livePriceForRange?.bid && Number.isFinite(livePriceForRange.bid)) {
      allPrices.push(livePriceForRange.bid);
    }
    if (livePriceForRange?.ask && Number.isFinite(livePriceForRange.ask)) {
      allPrices.push(livePriceForRange.ask);
    }
    const symJoinedRange = (this.selectedSymbol() ?? '').replace(/\//g, '').toUpperCase();
    for (const p of this.positions() ?? []) {
      if ((p?.symbol ?? '').replace(/\//g, '').toUpperCase() !== symJoinedRange) continue;
      if (Number.isFinite(p.averageEntryPrice)) allPrices.push(p.averageEntryPrice);
      if (p.stopLoss !== null && p.stopLoss !== undefined && Number.isFinite(p.stopLoss)) {
        allPrices.push(p.stopLoss);
      }
      if (p.takeProfit !== null && p.takeProfit !== undefined && Number.isFinite(p.takeProfit)) {
        allPrices.push(p.takeProfit);
      }
    }
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const range = maxPrice - minPrice;
    const padding = range > 0 ? range * 0.15 : minPrice * 0.002;

    // Show last 80 candles by default
    const zoomStart = Math.max(0, ((data.length - 80) / data.length) * 100);

    // BID/ASK are rendered as dedicated line series (see chartInitOptions
    // for the rationale) — `data: [bid, bid, ..., bid]` across all candle
    // categories. The endLabel shows the price tag at the right edge.
    //
    // The candlestick still carries a markLine, but only for the "no feed"
    // fallback (a static neutral dashed line at the latest candle's close).
    // That single line is stable across ticks, so it doesn't trigger the
    // markLine merge-cache bug that bit the BID/ASK case.
    const price = this.livePrice();
    const precision = this.pricePrecision();
    const fmt = (v: number) => v.toFixed(precision);
    const haveLive =
      !!price?.bid && Number.isFinite(price.bid) && !!price?.ask && Number.isFinite(price.ask);
    const bidLineData: number[] = haveLive ? data.map(() => price!.bid) : [];
    const askLineData: number[] = haveLive ? data.map(() => price!.ask) : [];
    const bidLabel = haveLive ? `BID ${fmt(price!.bid)}` : '';
    const askLabel = haveLive ? `ASK ${fmt(price!.ask)}` : '';

    const markLineData: { yAxis: number; lineStyle: any; label: any }[] = [];
    if (!haveLive) {
      const last = data[data.length - 1];
      if (last && Number.isFinite(last.close)) {
        markLineData.push({
          yAxis: last.close,
          lineStyle: { color: '#8E8E93', width: 1, type: 'dashed' },
          label: {
            show: true,
            position: 'insideEndTop',
            formatter: `LAST ${fmt(last.close)} · no feed`,
            backgroundColor: '#8E8E93',
            color: '#fff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
          },
        });
      }
    }

    // ── Open-position overlays ────────────────────────────────────
    // Per position on the focused symbol, render up to three horizontal
    // line series: average-entry (direction-coloured solid), stop-loss
    // (red dashed), and take-profit (green dashed). Each carries an
    // endLabel pinned to the right edge so the operator can read price /
    // direction / lots at a glance even when the lines stack near each
    // other in tight markets. Lines below 0 (no SL/TP set) are skipped.
    const symJoined = (this.selectedSymbol() ?? '').replace(/\//g, '').toUpperCase();
    const symbolPositions = this.showPositions()
      ? (this.positions() ?? []).filter((p) => {
          if (!p?.symbol) return false;
          return p.symbol.replace(/\//g, '').toUpperCase() === symJoined;
        })
      : [];
    const pipFactor = symJoined.includes('JPY') ? 100 : 10000;
    const positionSeries: any[] = [];
    for (const pos of symbolPositions) {
      const isLong = pos.direction === 'Long';
      const dirLetter = isLong ? 'L' : 'S';
      const entryColor = isLong ? '#0071E3' : '#FF6B35';
      const entryY = pos.averageEntryPrice;

      // P&L in pips relative to current bid (for long) or ask (for short).
      const refPrice = haveLive
        ? isLong
          ? price!.bid
          : price!.ask
        : (data[data.length - 1]?.close ?? entryY);
      const pnlPips = isLong ? (refPrice - entryY) * pipFactor : (entryY - refPrice) * pipFactor;
      const pnlSign = pnlPips >= 0 ? '+' : '';
      const pnlText = `${pnlSign}${pnlPips.toFixed(1)}p`;

      // ── Entry line ────────────────────────────────────────────
      positionSeries.push({
        name: `Entry #${pos.id}`,
        type: 'line',
        data: data.map(() => entryY),
        symbol: 'none',
        silent: true,
        animation: false,
        smooth: false,
        sampling: 'lttb',
        lineStyle: { color: entryColor, width: 1.4, type: 'solid' },
        endLabel: {
          show: true,
          formatter: `${dirLetter} ${pos.openLots} @ ${fmt(entryY)} · ${pnlText}`,
          backgroundColor: entryColor,
          color: '#fff',
          padding: [2, 6],
          borderRadius: 3,
          fontSize: 10,
          fontWeight: 600,
          offset: [0, 0],
        },
        xAxisIndex: 0,
        yAxisIndex: 0,
        z: 9,
      });

      // ── Stop-loss line ────────────────────────────────────────
      if (pos.stopLoss !== null && pos.stopLoss !== undefined && Number.isFinite(pos.stopLoss)) {
        positionSeries.push({
          name: `SL #${pos.id}`,
          type: 'line',
          data: data.map(() => pos.stopLoss!),
          symbol: 'none',
          silent: true,
          animation: false,
          smooth: false,
          sampling: 'lttb',
          lineStyle: { color: '#FF3B30', width: 1, type: 'dashed', opacity: 0.85 },
          endLabel: {
            show: true,
            formatter: `SL ${fmt(pos.stopLoss)}`,
            backgroundColor: '#FF3B30',
            color: '#fff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 600,
            offset: [0, 0],
          },
          xAxisIndex: 0,
          yAxisIndex: 0,
          z: 8,
        });
      }

      // ── Take-profit line ──────────────────────────────────────
      if (
        pos.takeProfit !== null &&
        pos.takeProfit !== undefined &&
        Number.isFinite(pos.takeProfit)
      ) {
        positionSeries.push({
          name: `TP #${pos.id}`,
          type: 'line',
          data: data.map(() => pos.takeProfit!),
          symbol: 'none',
          silent: true,
          animation: false,
          smooth: false,
          sampling: 'lttb',
          lineStyle: { color: '#34C759', width: 1, type: 'dashed', opacity: 0.85 },
          endLabel: {
            show: true,
            formatter: `TP ${fmt(pos.takeProfit)}`,
            backgroundColor: '#34C759',
            color: '#fff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 9,
            fontWeight: 600,
            offset: [0, 0],
          },
          xAxisIndex: 0,
          yAxisIndex: 0,
          z: 8,
        });
      }
    }

    // Subplot panes share the price grid's x dates but get independent y
    // axes — fed straight from each subplot indicator's value range so the
    // pane auto-scales (e.g. RSI pinned to 0..100, ATR to its own range).
    const subplotXAxes = subplotSeriesList.map(() => ({ data: dates }));
    const subplotYAxes = subplotSeriesList.map((s) => s.yAxis ?? {});

    const merge: EChartsOption = {
      xAxis: [{ data: dates }, { data: dates }, ...subplotXAxes],
      yAxis: [
        {
          min: +(minPrice - padding).toFixed(this.pricePrecision()),
          max: +(maxPrice + padding).toFixed(this.pricePrecision()),
          axisLabel: { formatter: (v: number) => v.toFixed(this.pricePrecision()) },
        },
        {},
        ...subplotYAxes,
      ],
      series: [
        // Index 0: candlestick (matches chartInitOptions.series[0]).
        {
          data: ohlc,
          markLine: {
            silent: true,
            symbol: ['none', 'none'],
            animation: false,
            data: markLineData,
          },
        },
        // Index 1: volume bars (matches chartInitOptions.series[1]).
        { data: this.showVolume() ? volumes : [] },
        // Index 2: BID overlay (matches chartInitOptions.series[2]).
        {
          data: bidLineData,
          // Full endLabel config every tick — series-level shallow merge in
          // `buildFullOption` would otherwise replace the styled endLabel
          // from `chartInitOptions` with `{ show, formatter }` and lose
          // the colour / padding / offset, causing BID and ASK labels to
          // collapse onto each other at the right edge of the chart.
          endLabel: {
            show: haveLive,
            formatter: bidLabel,
            backgroundColor: '#34C759',
            color: '#fff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            offset: [0, 12],
          },
        },
        // Index 3: ASK overlay (matches chartInitOptions.series[3]).
        {
          data: askLineData,
          endLabel: {
            show: haveLive,
            formatter: askLabel,
            backgroundColor: '#FF3B30',
            color: '#fff',
            padding: [2, 6],
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            offset: [0, -12],
          },
        },
        // Indicator overlays + subplot indicator series come past the base
        // four. They're full series configs with their own type/style
        // because there's no init-counterpart — buildFullOption uses the
        // merge entry directly past the init series length.
        ...overlaySeries,
        ...subplotSeries,
        // Open-position overlays appended after indicators. Each position
        // contributes 1–3 series (entry + optional SL + optional TP), all
        // pre-built with full type/style configs.
        ...positionSeries,
      ],
    };

    // Only emit dataZoom when the candle dataset actually changes — emitting
    // it on every live-price tick would snap the chart back to the default
    // 80-candle window and break manual pan/zoom.
    if (data.length !== this.lastZoomCandleCount) {
      // Order must mirror chartInitOptions.dataZoom:
      //   [inside-x, inside-y, slider-x, slider-y].
      // The y-axis entries get empty overrides so the operator's manual y-zoom
      // (drag on the slider, or shift+wheel) isn't snapped back when new
      // candles arrive.
      merge.dataZoom = [{ start: zoomStart, end: 100 }, {}, { start: zoomStart, end: 100 }, {}];
      this.lastZoomCandleCount = data.length;
    }

    this.chartMerge.set(merge);

    // ngx-echarts calls `chart.setOption(merge)` with no `opts` →
    // `notMerge` defaults to false → property-level merge. ECharts then
    // caches the markLine's pixel coordinates from the first tick's
    // yAxis value and never updates them on subsequent ticks, even
    // though the label `formatter` string does update. Symptom: BID/ASK
    // label reads the new price but the line stays at the original
    // position.
    //
    // Defeat the cache by calling `setOption` with `notMerge: true` —
    // forces a full re-evaluation of every option. We deep-merge the
    // init options with the per-tick merge so the chart still has its
    // type/style config, and we preserve the user's pan/zoom state by
    // reading the current `dataZoom` before the replace.
    if (this.isChartLive()) {
      // Skip the full notMerge:true rebuild while an SL/TP drag is in
      // flight — it would clobber the live line preview and snap the
      // grip back to the engine-side level mid-gesture. The next tick
      // after drag completion rebuilds normally.
      if (this.dragInProgress) return;
      try {
        this.echartsInstance.setOption(this.buildFullOption(merge), true);
        // Draggable SL/TP grips live in the `graphic` array. `setOption`
        // with `notMerge: true` clears any previously-set graphics, so
        // we have to re-emit them after every full replace. The handles
        // compute their pixel positions from the freshly-applied price
        // grid so they sit exactly on the SL/TP line.
        this.updateSlTpHandles();
      } catch {
        // ignore — the [merge] binding will retry on the next tick
      }
    }
  }

  // ── Draggable SL/TP grips ─────────────────────────────────────────────
  // Renders a small filled circle on the right edge of each open
  // position's SL and TP line. Operator drags the circle vertically; on
  // mouse-up we confirm with a native dialog and POST
  // /position/{id}/modify-sl-tp. Success → emit `slTpModified` so the
  // parent can refresh; failure or cancel → snap the handle back by
  // re-running this method.
  private updateSlTpHandles(): void {
    if (!this.isChartLive()) return;
    if (!this.showPositions()) {
      try {
        this.echartsInstance.setOption({ graphic: [] });
      } catch {
        /* ignore */
      }
      return;
    }
    const symJoined = (this.selectedSymbol() ?? '').replace(/\//g, '').toUpperCase();
    const positions = (this.positions() ?? []).filter(
      (p) => p?.symbol && p.symbol.replace(/\//g, '').toUpperCase() === symJoined,
    );

    const handles: any[] = [];
    for (const pos of positions) {
      if (pos.stopLoss !== null && pos.stopLoss !== undefined && Number.isFinite(pos.stopLoss)) {
        const h = this.makeSlTpHandle(pos.id, 'SL', pos.stopLoss, '#FF3B30');
        if (h) handles.push(h);
      }
      if (
        pos.takeProfit !== null &&
        pos.takeProfit !== undefined &&
        Number.isFinite(pos.takeProfit)
      ) {
        const h = this.makeSlTpHandle(pos.id, 'TP', pos.takeProfit, '#34C759');
        if (h) handles.push(h);
      }
    }
    try {
      this.echartsInstance.setOption({ graphic: handles });
    } catch {
      /* ignore — next tick rebuild will retry */
    }
  }

  private makeSlTpHandle(
    positionId: number,
    kind: 'SL' | 'TP',
    price: number,
    color: string,
  ): any | null {
    if (!this.isChartLive()) return null;
    try {
      // Price → pixel for the price grid (gridIndex 0). ECharts returns
      // `[pixelX, pixelY]`; we only care about the Y component because
      // the handle is pinned to a fixed X (the grid's right edge).
      const pixel = this.echartsInstance.convertToPixel({ gridIndex: 0 }, [0, price]);
      const pixelY = Array.isArray(pixel) ? pixel[1] : NaN;
      if (!Number.isFinite(pixelY)) return null;

      const gridModel = this.echartsInstance.getModel?.()?.getComponent?.('grid', 0);
      const rect = gridModel?.coordinateSystem?.getRect?.() ?? gridModel?.getRect?.();
      if (!rect) return null;
      // Pin the grip ~10px to the LEFT of the right axis tick zone so it
      // sits between the dashed price line and its label badge.
      const handleX = rect.x + rect.width - 18;
      const yMin = rect.y;
      const yMax = rect.y + rect.height;

      return {
        id: `sltp-${kind}-${positionId}`,
        type: 'circle',
        shape: { r: 6 },
        position: [handleX, pixelY],
        draggable: 'vertical',
        cursor: 'ns-resize',
        z: 100,
        invisible: false,
        style: {
          fill: color,
          stroke: '#ffffff',
          lineWidth: 2,
          shadowBlur: 4,
          shadowColor: 'rgba(0,0,0,0.25)',
        },
        // Latch the drag flag so live-price ticks don't fight the
        // preview. Cleared in `confirmAndSubmitSlTp` once the API
        // resolves (or the user cancels).
        ondragstart: () => {
          this.dragInProgress = true;
        },
        // Constrain drag to the price grid bounds — letting the operator
        // drop the handle outside the visible price range produces a
        // nonsense price. As the grip moves, push the new price into the
        // matching SL/TP line series so the dashed price line tracks the
        // grip in real time.
        ondrag: (params: any) => {
          if (!this.isChartLive()) return;
          const t = params?.target;
          if (!t) return;
          if (t.y < yMin) t.y = yMin;
          else if (t.y > yMax) t.y = yMax;
          const converted = this.echartsInstance.convertFromPixel({ gridIndex: 0 }, [0, t.y]);
          const dragPrice = Array.isArray(converted) ? converted[1] : NaN;
          if (!Number.isFinite(dragPrice) || dragPrice <= 0) return;
          this.previewSlTpLine(positionId, kind, dragPrice, color);
        },
        ondragend: (params: any) => {
          if (!this.isChartLive()) {
            this.dragInProgress = false;
            return;
          }
          const newPixelY = params?.target?.y;
          if (!Number.isFinite(newPixelY)) {
            this.dragInProgress = false;
            this.buildChartMerge();
            return;
          }
          const converted = this.echartsInstance.convertFromPixel({ gridIndex: 0 }, [0, newPixelY]);
          const newPrice = Array.isArray(converted) ? converted[1] : NaN;
          if (!Number.isFinite(newPrice) || newPrice <= 0) {
            this.dragInProgress = false;
            this.buildChartMerge();
            return;
          }
          this.confirmAndSubmitSlTp(positionId, kind, price, newPrice);
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Live-preview helper called from each `ondrag` tick. Updates the
   * SL/TP line series so the dashed price line tracks the grip without
   * waiting for a server round-trip. Matches the series by name —
   * ECharts' default merge mode preserves every other series so this
   * touches only the one being dragged.
   */
  private previewSlTpLine(
    positionId: number,
    kind: 'SL' | 'TP',
    price: number,
    color: string,
  ): void {
    if (!this.isChartLive()) return;
    const candleCount = this.candles().length;
    if (candleCount === 0) return;
    const precision = this.pricePrecision();
    const seriesName = `${kind} #${positionId}`;
    const data = new Array(candleCount).fill(price);
    try {
      this.echartsInstance.setOption({
        series: [
          {
            name: seriesName,
            type: 'line',
            data,
            endLabel: {
              show: true,
              formatter: `${kind} ${price.toFixed(precision)}`,
              backgroundColor: color,
              color: '#fff',
              padding: [2, 6],
              borderRadius: 3,
              fontSize: 9,
              fontWeight: 600,
              offset: [0, 0],
            },
          },
        ],
      });
    } catch {
      /* ignore — next ondrag tick will retry */
    }
  }

  private confirmAndSubmitSlTp(
    positionId: number,
    kind: 'SL' | 'TP',
    oldPrice: number,
    newPrice: number,
  ): void {
    const precision = this.pricePrecision();
    const rounded = +newPrice.toFixed(precision);
    if (rounded === +oldPrice.toFixed(precision)) {
      // No-op drag — snap back without bothering the operator.
      this.dragInProgress = false;
      this.buildChartMerge();
      return;
    }
    if (this.modifyingPosId === positionId) {
      // A previous modification is still in-flight — refuse and snap back.
      this.dragInProgress = false;
      this.buildChartMerge();
      return;
    }
    const verb = kind === 'SL' ? 'Stop-Loss' : 'Take-Profit';
    const ok = window.confirm(
      `Move ${verb} on position #${positionId}\n` +
        `from ${oldPrice.toFixed(precision)} to ${rounded.toFixed(precision)}?\n\n` +
        `The engine will queue an EA command so MT5 applies the new level broker-side.`,
    );
    if (!ok) {
      this.dragInProgress = false;
      this.buildChartMerge();
      return;
    }

    this.modifyingPosId = positionId;
    const payload = {
      stopLoss: kind === 'SL' ? rounded : null,
      takeProfit: kind === 'TP' ? rounded : null,
    };
    this.positionsService
      .modifySlTp(positionId, payload.stopLoss, payload.takeProfit)
      .pipe(
        catchError((err) => {
          const msg = (err?.error?.message as string | undefined) ?? err?.message ?? String(err);
          this.notifications.error?.(`${verb} update failed: ${msg}`);
          return of(null);
        }),
        takeUntil(this.destroy$),
      )
      .subscribe((res) => {
        this.modifyingPosId = null;
        this.dragInProgress = false;
        if (res?.status) {
          this.notifications.success?.(
            `${verb} on #${positionId} → ${rounded.toFixed(precision)} queued for MT5.`,
          );
          this.slTpModified.emit({ positionId, kind, newPrice: rounded });
          // The parent's refresh will push a new positions input, which
          // re-runs buildChartMerge with the authoritative engine-side
          // price. No manual rebuild needed.
        } else {
          if (res) this.notifications.error?.(res.message ?? `${verb} update refused.`);
          // Refused or errored — full rebuild so the line snaps back to
          // the engine-side level (not just the grip).
          this.buildChartMerge();
        }
      });
  }

  /**
   * Compose `chartInitOptions` and the per-tick `merge` into a complete
   * option object suitable for `setOption(opt, true)`. Every series gets
   * its full type/style config from init, with `data` / `markLine` from
   * the merge. The user's current dataZoom interaction state is preserved
   * so a full replace doesn't snap the chart back to the default window.
   */
  private buildFullOption(merge: EChartsOption): EChartsOption {
    const initSeries = (this.chartInitOptions.series as any[]) ?? [];
    const mergeSeries = (merge.series as any[]) ?? [];
    // Position overlays append extra series past the base 8 — those entries
    // are full series configs and don't have an init counterpart, so use
    // them directly.
    const baseLen = initSeries.length;
    const fullSeries = mergeSeries.map((m, i) =>
      i < baseLen ? { ...initSeries[i], ...(m ?? {}) } : { ...m },
    );
    // Carry over any init-only series (none today, but keeps the loop safe
    // if the merge ever ships fewer series than init).
    for (let i = mergeSeries.length; i < initSeries.length; i++) {
      fullSeries.push({ ...initSeries[i] });
    }

    // Subplot axis templates — used to fill in missing fields (type,
    // gridIndex, axisLine, etc.) for axes that don't have an init
    // counterpart. The merge entry only carries indicator-specific bits
    // (data, min/max), so we layer it on top of the template.
    const subXAxisTemplate = (gridIndex: number) => ({
      type: 'category',
      data: [],
      gridIndex,
      axisLine: { lineStyle: { color: 'rgba(0,0,0,0.06)' } },
      axisLabel: { show: false },
      axisTick: { show: false },
    });
    const subYAxisTemplate = (gridIndex: number) => this.subplotValueAxis(gridIndex);

    const initXAxis = (this.chartInitOptions.xAxis as any[]) ?? [];
    const mergeXAxis = (merge.xAxis as any[]) ?? [];
    const fullXAxis = initXAxis.map((s, i) => ({ ...s, ...(mergeXAxis[i] ?? {}) }));
    // Merge entries past the init length are subplot xAxes. The merge only
    // carries `{ data: dates }` for these, so we layer the template under it
    // to supply type / gridIndex / axisLabel — without the template, echarts
    // sees an axis missing required fields and silently drops the whole
    // chart's gridlines, axis labels and slider.
    for (let i = initXAxis.length; i < mergeXAxis.length; i++) {
      fullXAxis.push({ ...subXAxisTemplate(i), ...mergeXAxis[i] });
    }

    const initYAxis = (this.chartInitOptions.yAxis as any[]) ?? [];
    const mergeYAxis = (merge.yAxis as any[]) ?? [];
    const fullYAxis = initYAxis.map((s, i) => ({ ...s, ...(mergeYAxis[i] ?? {}) }));
    // Subplot yAxis configs in `mergeYAxis[i]` already carry indicator-
    // specific bounds (RSI 0..100, ATR auto-scale, etc.) and a gridIndex,
    // so the template merge is mostly idempotent — but we keep it for
    // defence against future indicators that ship a partial config.
    for (let i = initYAxis.length; i < mergeYAxis.length; i++) {
      fullYAxis.push({ ...subYAxisTemplate(i), ...mergeYAxis[i] });
    }

    // Preserve the operator's current pan/zoom — without this, every tick
    // would snap the visible window back to the default 80-candle slice.
    let dataZoom: any = this.chartInitOptions.dataZoom;
    try {
      const current = this.echartsInstance?.getOption?.();
      if (current?.dataZoom) dataZoom = current.dataZoom;
    } catch {
      /* fall back to init dataZoom */
    }

    // ── Dynamic grid layout ────────────────────────────────────────
    // Layout in percent of the chart container. Price always shown.
    // Volume optional. Each subplot indicator stacks below.
    //   total = top + price + (vol+gap) + N*(sub+gap) + bottomReserved
    // Solve for price height so the rest fits.
    const showVol = this.showVolume();
    const subN = this.subplotIndicators().length;
    const TOP_PCT = 4; // top margin for legend / chrome
    const BOTTOM_PCT = 11; // x-axis labels + dataZoom slider
    const GAP_PCT = 1.2;
    const VOL_PCT = 11;
    const SUB_PCT = 14;

    const otherPanesPct = (showVol ? VOL_PCT + GAP_PCT : 0) + subN * (SUB_PCT + GAP_PCT);
    const pricePct = Math.max(20, 100 - TOP_PCT - BOTTOM_PCT - otherPanesPct);
    const priceTopPct = TOP_PCT;
    const priceBottomPct = priceTopPct + pricePct;

    const grid: any[] = [
      // Grid 0: price.
      {
        left: 60,
        right: 85,
        top: `${priceTopPct}%`,
        height: `${pricePct}%`,
      },
      // Grid 1: volume — always present (data is empty when hidden so the
      // series still has a place to render into).
      showVol
        ? {
            left: 60,
            right: 85,
            top: `${priceBottomPct + GAP_PCT}%`,
            height: `${VOL_PCT}%`,
          }
        : {
            left: 60,
            right: 85,
            top: `${priceBottomPct}%`,
            height: 0,
          },
    ];
    // Subplot grids — each `SUB_PCT%` tall, stacked below volume.
    let cursor = priceBottomPct + (showVol ? VOL_PCT + 2 * GAP_PCT : GAP_PCT);
    for (let i = 0; i < subN; i++) {
      grid.push({
        left: 60,
        right: 85,
        top: `${cursor}%`,
        height: `${SUB_PCT}%`,
      });
      cursor += SUB_PCT + GAP_PCT;
    }

    // ── DataZoom ───────────────────────────────────────────────────
    // Inside zooms link x across all panes so a wheel scroll on the price
    // grid pans every subplot in sync. The y-axis inside zoom + slider
    // only affect the price grid (yAxisIndex 0) — operators rarely need
    // to clip an RSI's range.
    const allXAxisIndex = [0, 1];
    for (let i = 0; i < subN; i++) allXAxisIndex.push(2 + i);

    // Preserve the current pan/zoom start/end values so a full replace
    // doesn't snap the chart back to defaults. We always rebuild the
    // position config (top/right/etc) from the live grid layout, and
    // only carry forward the user's interaction state.
    const initDz = (this.chartInitOptions.dataZoom as any[]) ?? [];
    const currentDz = (() => {
      try {
        const cur = this.echartsInstance?.getOption?.();
        return (cur?.dataZoom as any[] | undefined) ?? null;
      } catch {
        return null;
      }
    })();

    const carry = (i: number) => {
      const cur = currentDz?.[i];
      if (!cur) return {};
      const out: any = {};
      if (cur.start !== undefined) out.start = cur.start;
      if (cur.end !== undefined) out.end = cur.end;
      return out;
    };

    const ySliderTopPct = priceTopPct;
    const ySliderHeightPct = pricePct;

    dataZoom = [
      // 0: inside x — linked across all panes
      { ...initDz[0], xAxisIndex: allXAxisIndex, ...carry(0) },
      // 1: inside y — price grid only
      { ...initDz[1], ...carry(1) },
      // 2: slider x — at the bottom, linked across all panes
      { ...initDz[2], xAxisIndex: allXAxisIndex, ...carry(2) },
      // 3: slider y — tracks the price grid's height
      {
        ...initDz[3],
        top: `${ySliderTopPct}%`,
        height: `${ySliderHeightPct}%`,
        bottom: undefined,
        ...carry(3),
      },
    ];

    // Defensive: if `mergeXAxis` was shorter than expected (e.g. a future
    // refactor forgets to ship an entry per subplot), top up with the
    // template so axis count still matches grid count.
    while (fullXAxis.length < 2 + subN) {
      fullXAxis.push(subXAxisTemplate(fullXAxis.length));
    }
    while (fullYAxis.length < 2 + subN) {
      fullYAxis.push(subYAxisTemplate(fullYAxis.length));
    }

    return {
      ...this.chartInitOptions,
      grid,
      xAxis: fullXAxis,
      yAxis: fullYAxis,
      series: fullSeries,
      dataZoom,
    };
  }

  // ── Indicator math ──────────────────────────────────────────────────
  // All helpers return arrays aligned to the candle index. Warmup periods
  // are filled with null so ECharts skips them rather than drawing zero.

  private calcSMA(values: number[], period: number): (number | null)[] {
    return values.map((_, i) => {
      if (i < period - 1) return null;
      const slice = values.slice(i - period + 1, i + 1);
      return slice.reduce((a, b) => a + b, 0) / period;
    });
  }

  /** Backwards-compat alias. Kept until we're certain nothing else calls it. */
  private calcMA(data: number[], period: number): (number | null)[] {
    return this.calcSMA(data, period);
  }

  private calcEMA(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = ema;
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }

  private calcBollinger(data: number[], period: number, stdDev: number) {
    const middle = this.calcSMA(data, period);
    const upper: (number | null)[] = [];
    const lower: (number | null)[] = [];
    for (let i = 0; i < data.length; i++) {
      if (i < period - 1 || middle[i] === null) {
        upper.push(null);
        lower.push(null);
      } else {
        const slice = data.slice(i - period + 1, i + 1);
        const mean = middle[i]!;
        const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
        const sd = Math.sqrt(variance);
        upper.push(mean + stdDev * sd);
        lower.push(mean - stdDev * sd);
      }
    }
    return { upper, lower, middle };
  }

  /** Wilder-smoothed RSI aligned to every candle, null during warmup. */
  private calcRSI(values: number[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(values.length).fill(null);
    if (values.length <= period) return out;
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) avgGain += d;
      else avgLoss -= d;
    }
    avgGain /= period;
    avgLoss /= period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  private trueRanges(candles: CandleDto[]): number[] {
    const trs: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (i === 0) {
        trs.push(candles[0].high - candles[0].low);
      } else {
        const c = candles[i];
        const p = candles[i - 1];
        trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
      }
    }
    return trs;
  }

  private calcATR(candles: CandleDto[], period: number): (number | null)[] {
    const trs = this.trueRanges(candles);
    const out: (number | null)[] = new Array(candles.length).fill(null);
    if (candles.length < period) return out;
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out[period - 1] = atr;
    for (let i = period; i < candles.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      out[i] = atr;
    }
    return out;
  }

  /** Cumulative session VWAP — running average of typical-price weighted by volume. */
  private calcVWAP(candles: CandleDto[]): (number | null)[] {
    const out: (number | null)[] = [];
    let cumPV = 0;
    let cumV = 0;
    for (const c of candles) {
      const v = c.volume ?? 0;
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * v;
      cumV += v;
      out.push(cumV > 0 ? cumPV / cumV : null);
    }
    return out;
  }

  private calcDonchian(candles: CandleDto[], period: number) {
    const upper: (number | null)[] = [];
    const lower: (number | null)[] = [];
    const middle: (number | null)[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (i < period - 1) {
        upper.push(null);
        lower.push(null);
        middle.push(null);
      } else {
        const slice = candles.slice(i - period + 1, i + 1);
        let h = -Infinity;
        let l = Infinity;
        for (const c of slice) {
          if (c.high > h) h = c.high;
          if (c.low < l) l = c.low;
        }
        upper.push(h);
        lower.push(l);
        middle.push((h + l) / 2);
      }
    }
    return { upper, lower, middle };
  }

  /** Keltner channels: EMA of close ± mult × ATR. */
  private calcKeltner(candles: CandleDto[], period: number, mult: number) {
    const closes = candles.map((c) => c.close);
    const ema = this.calcEMA(closes, period);
    const atr = this.calcATR(candles, period);
    const upper: (number | null)[] = [];
    const lower: (number | null)[] = [];
    for (let i = 0; i < candles.length; i++) {
      if (ema[i] !== null && atr[i] !== null) {
        upper.push(ema[i]! + mult * atr[i]!);
        lower.push(ema[i]! - mult * atr[i]!);
      } else {
        upper.push(null);
        lower.push(null);
      }
    }
    return { upper, lower, middle: ema };
  }

  /** Standard MACD — EMA(fast) − EMA(slow), signal = EMA(macd, signal). */
  private calcMACD(closes: number[], fast: number, slow: number, signalP: number) {
    const fastE = this.calcEMA(closes, fast);
    const slowE = this.calcEMA(closes, slow);
    const macd: (number | null)[] = closes.map((_, i) =>
      fastE[i] !== null && slowE[i] !== null ? fastE[i]! - slowE[i]! : null,
    );
    const firstIdx = macd.findIndex((v) => v !== null);
    const validMacd: number[] = firstIdx >= 0 ? (macd.slice(firstIdx) as number[]) : [];
    const signalRaw = this.calcEMA(validMacd, signalP);
    const signal: (number | null)[] = new Array(closes.length).fill(null);
    if (firstIdx >= 0) {
      for (let j = 0; j < signalRaw.length; j++) {
        signal[firstIdx + j] = signalRaw[j];
      }
    }
    const hist: (number | null)[] = closes.map((_, i) =>
      macd[i] !== null && signal[i] !== null ? macd[i]! - signal[i]! : null,
    );
    return { macd, signal, hist };
  }

  /** Stochastic oscillator — smoothed %K and %D in the 0..100 range. */
  private calcStoch(candles: CandleDto[], period: number, kSmooth: number, dSmooth: number) {
    const rawK: (number | null)[] = candles.map((_, i) => {
      if (i < period - 1) return null;
      const slice = candles.slice(i - period + 1, i + 1);
      let high = -Infinity;
      let low = Infinity;
      for (const c of slice) {
        if (c.high > high) high = c.high;
        if (c.low < low) low = c.low;
      }
      if (high === low) return 50;
      return ((candles[i].close - low) / (high - low)) * 100;
    });
    const kSmoothArr = this.calcSMA(
      rawK.map((v) => v ?? 0),
      kSmooth,
    );
    const k: (number | null)[] = kSmoothArr.map((v, i) => (rawK[i] === null ? null : v));
    const dArr = this.calcSMA(
      k.map((v) => v ?? 0),
      dSmooth,
    );
    const d: (number | null)[] = dArr.map((v, i) => (k[i] === null ? null : v));
    return { k, d };
  }

  /**
   * Order Flow Imbalance proxy from OHLCV. We don't capture aggressor-
   * tagged ticks at this depth, so buy/sell volume is split by the
   * close's position within the bar's range:
   *   buyShare  = (close - low) / (high - low)
   *   sellShare = 1 - buyShare
   *   delta     = buyVol - sellVol = volume * (2*buyShare - 1)
   * Cumulative delta is the running sum — when it trends up, buyers are
   * winning the tape; when it rolls over while price holds, that's bull
   * exhaustion. Both series share one y-axis so the bars stay near the
   * baseline while the cumulative line drifts above/below.
   */
  private calcOFI(
    candles: CandleDto[],
    smoothing: number,
  ): { delta: (number | null)[]; cumulative: (number | null)[] } {
    const rawDelta: number[] = [];
    const cumulative: number[] = [];
    let cum = 0;
    for (const c of candles) {
      const v = c.volume ?? 0;
      const range = c.high - c.low;
      const buyShare = range > 0 ? (c.close - c.low) / range : 0.5;
      const d = v * (2 * buyShare - 1);
      rawDelta.push(d);
      cum += d;
      cumulative.push(cum);
    }
    const delta: (number | null)[] = smoothing > 1 ? this.calcSMA(rawDelta, smoothing) : rawDelta;
    return { delta, cumulative };
  }

  /**
   * Pattern detection between the last two swing highs and last two swing
   * lows. Always returns the two trendlines when at least 2H + 2L can be
   * found in the lookback window, classifying the resulting shape:
   *   - rising wedge   (both up & converging)   — bearish bias
   *   - falling wedge  (both down & converging) — bullish bias
   *   - sym triangle   (opposite slopes & converging)
   *   - asc triangle   (flat top, rising bottom)
   *   - desc triangle  (falling top, flat bottom)
   *   - channel        (parallel-ish, no convergence)
   *
   * `breakout` fires when the current close has crossed the relevant line:
   * down-bias patterns flag a downside break of support, up-bias patterns
   * flag an upside break of resistance, channels flag whichever side the
   * close has crossed.
   *
   * Returns null only when there aren't enough swings to draw lines at all.
   */
  private calcWedge(
    candles: CandleDto[],
    lookback: number,
    strength: number,
  ): {
    type:
      | 'rising wedge'
      | 'falling wedge'
      | 'sym triangle'
      | 'asc triangle'
      | 'desc triangle'
      | 'channel';
    breakout: 'up' | 'down' | null;
    upper: (number | null)[];
    lower: (number | null)[];
  } | null {
    if (candles.length < strength * 2 + 4) return null;
    const startIdx = Math.max(strength, candles.length - lookback);
    const highs: { idx: number; price: number }[] = [];
    const lows: { idx: number; price: number }[] = [];
    for (let i = startIdx; i < candles.length - strength; i++) {
      const c = candles[i];
      let isHigh = true;
      let isLow = true;
      for (let j = i - strength; j <= i + strength; j++) {
        if (j === i || j < 0 || j >= candles.length) continue;
        if (candles[j].high >= c.high) isHigh = false;
        if (candles[j].low <= c.low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) highs.push({ idx: i, price: c.high });
      if (isLow) lows.push({ idx: i, price: c.low });
    }
    if (highs.length < 2 || lows.length < 2) return null;
    const [H1, H2] = highs.slice(-2);
    const [L1, L2] = lows.slice(-2);
    const upperSlope = (H2.price - H1.price) / (H2.idx - H1.idx);
    const lowerSlope = (L2.price - L1.price) / (L2.idx - L1.idx);

    const anchorIdx = Math.min(H1.idx, L1.idx);
    const currentIdx = candles.length - 1;
    const upperAt = (i: number) => H1.price + upperSlope * (i - H1.idx);
    const lowerAt = (i: number) => L1.price + lowerSlope * (i - L1.idx);
    const initialGap = Math.abs(upperAt(anchorIdx) - lowerAt(anchorIdx));
    const currentGap = Math.abs(upperAt(currentIdx) - lowerAt(currentIdx));
    const converging = currentGap < initialGap * 0.95;

    // Treat slopes very close to zero as flat — flatness threshold scales
    // with the wedge's price range so we don't classify a 1-pip drift on
    // EURUSD the same as a 1-pip drift on a 1.5-handle move.
    const flatThreshold = initialGap > 0 ? initialGap * 0.001 : 1e-9;
    const upDir = upperSlope > flatThreshold ? 1 : upperSlope < -flatThreshold ? -1 : 0;
    const dnDir = lowerSlope > flatThreshold ? 1 : lowerSlope < -flatThreshold ? -1 : 0;

    let type:
      | 'rising wedge'
      | 'falling wedge'
      | 'sym triangle'
      | 'asc triangle'
      | 'desc triangle'
      | 'channel';
    if (upDir > 0 && dnDir > 0 && converging) type = 'rising wedge';
    else if (upDir < 0 && dnDir < 0 && converging) type = 'falling wedge';
    else if (upDir === 0 && dnDir > 0) type = 'asc triangle';
    else if (upDir < 0 && dnDir === 0) type = 'desc triangle';
    else if (upDir < 0 && dnDir > 0 && converging) type = 'sym triangle';
    else type = 'channel';

    const upper: (number | null)[] = new Array(candles.length).fill(null);
    const lower: (number | null)[] = new Array(candles.length).fill(null);
    for (let i = anchorIdx; i <= currentIdx; i++) {
      upper[i] = upperAt(i);
      lower[i] = lowerAt(i);
    }

    const lastClose = candles[currentIdx].close;
    let breakout: 'up' | 'down' | null = null;
    if (lastClose > upperAt(currentIdx)) breakout = 'up';
    else if (lastClose < lowerAt(currentIdx)) breakout = 'down';

    return { type, breakout, upper, lower };
  }

  /**
   * Linear regression channel over the last `period` closes. Returns the
   * fitted line + ±mult·σ deviation bands aligned to candle indexes (null
   * for bars before the lookback window). Slope is exposed so the caller
   * can label the chip with up/down/flat once we wire that.
   */
  private calcTrendline(
    candles: CandleDto[],
    period: number,
    mult: number,
  ): {
    line: (number | null)[];
    upper: (number | null)[];
    lower: (number | null)[];
    slope: number;
  } {
    const empty = new Array(candles.length).fill(null);
    if (candles.length < 2 || period < 2) {
      return { line: empty, upper: empty, lower: empty, slope: 0 };
    }
    const n = Math.min(period, candles.length);
    const start = candles.length - n;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    for (let i = 0; i < n; i++) {
      const x = i;
      const y = candles[start + i].close;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    }
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    const line: (number | null)[] = new Array(candles.length).fill(null);
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const pred = slope * i + intercept;
      line[start + i] = pred;
      const actual = candles[start + i].close;
      sumSq += (actual - pred) ** 2;
    }
    const sigma = Math.sqrt(sumSq / n);
    const upper: (number | null)[] = line.map((v) => (v === null ? null : v + mult * sigma));
    const lower: (number | null)[] = line.map((v) => (v === null ? null : v - mult * sigma));
    return { line, upper, lower, slope };
  }

  /**
   * Swing-pivot support / resistance — finds bars whose high (low) strictly
   * dominates the `lookback` bars on either side, then returns the most
   * recent `count` of each as price levels. The latest `lookback` candles
   * are skipped because their right-side window isn't yet complete (a
   * swing isn't a swing until both sides are confirmed).
   */
  private calcSR(
    candles: CandleDto[],
    lookback: number,
    count: number,
  ): { resistance: number[]; support: number[] } {
    const highs: number[] = [];
    const lows: number[] = [];
    if (candles.length < lookback * 2 + 1) return { resistance: [], support: [] };
    for (let i = lookback; i < candles.length - lookback; i++) {
      const c = candles[i];
      let isHigh = true;
      let isLow = true;
      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j === i) continue;
        if (candles[j].high >= c.high) isHigh = false;
        if (candles[j].low <= c.low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) highs.push(c.high);
      if (isLow) lows.push(c.low);
    }
    return {
      resistance: highs.slice(-count),
      support: lows.slice(-count),
    };
  }

  /** Wilder ADX in the 0..100 range. Trend strength only — no direction. */
  private calcADX(candles: CandleDto[], period: number): (number | null)[] {
    const out: (number | null)[] = new Array(candles.length).fill(null);
    if (candles.length < period * 2 + 1) return out;
    const trs: number[] = new Array(candles.length).fill(0);
    const pdms: number[] = new Array(candles.length).fill(0);
    const ndms: number[] = new Array(candles.length).fill(0);
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i - 1];
      trs[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      const upMove = c.high - p.high;
      const dnMove = p.low - c.low;
      pdms[i] = upMove > dnMove && upMove > 0 ? upMove : 0;
      ndms[i] = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    }
    let smTR = 0;
    let smPDM = 0;
    let smNDM = 0;
    for (let i = 1; i <= period; i++) {
      smTR += trs[i];
      smPDM += pdms[i];
      smNDM += ndms[i];
    }
    const dxs: (number | null)[] = new Array(candles.length).fill(null);
    const writeDx = (i: number) => {
      const pdi = smTR === 0 ? 0 : (smPDM / smTR) * 100;
      const ndi = smTR === 0 ? 0 : (smNDM / smTR) * 100;
      dxs[i] = pdi + ndi === 0 ? 0 : (Math.abs(pdi - ndi) / (pdi + ndi)) * 100;
    };
    writeDx(period);
    for (let i = period + 1; i < candles.length; i++) {
      smTR = smTR - smTR / period + trs[i];
      smPDM = smPDM - smPDM / period + pdms[i];
      smNDM = smNDM - smNDM / period + ndms[i];
      writeDx(i);
    }
    // ADX = Wilder smoothing of DX over `period` values.
    const firstDxIdx = period;
    if (firstDxIdx + period - 1 >= candles.length) return out;
    let adx = 0;
    for (let i = firstDxIdx; i < firstDxIdx + period; i++) adx += dxs[i] ?? 0;
    adx /= period;
    out[firstDxIdx + period - 1] = adx;
    for (let i = firstDxIdx + period; i < candles.length; i++) {
      adx = (adx * (period - 1) + (dxs[i] ?? 0)) / period;
      out[i] = adx;
    }
    return out;
  }

  // ── Series builders ────────────────────────────────────────────────

  /** Build the ECharts line series for every overlay indicator. */
  private buildOverlaySeries(candles: CandleDto[], closes: number[]): any[] {
    const series: any[] = [];
    for (const cfg of this.overlayIndicators()) {
      switch (cfg.type) {
        case 'sma':
          series.push(
            this.lineSeries(
              this.chipSummary(cfg),
              cfg.color,
              this.calcSMA(closes, cfg.params['period']),
            ),
          );
          break;
        case 'ema':
          series.push(
            this.lineSeries(
              this.chipSummary(cfg),
              cfg.color,
              this.calcEMA(closes, cfg.params['period']),
            ),
          );
          break;
        case 'bb': {
          const bb = this.calcBollinger(closes, cfg.params['period'], cfg.params['std']);
          series.push(this.lineSeries(`${this.chipSummary(cfg)} ↑`, cfg.color, bb.upper, 0.7));
          series.push(
            this.lineSeries(`${this.chipSummary(cfg)} ↓`, cfg.color, bb.lower, 0.7, true),
          );
          series.push(this.lineSeries(`${this.chipSummary(cfg)} mid`, cfg.color, bb.middle, 0.4));
          break;
        }
        case 'vwap':
          series.push(this.lineSeries(this.chipSummary(cfg), cfg.color, this.calcVWAP(candles)));
          break;
        case 'donchian': {
          const d = this.calcDonchian(candles, cfg.params['period']);
          series.push(this.lineSeries(`${this.chipSummary(cfg)} ↑`, cfg.color, d.upper, 0.7));
          series.push(this.lineSeries(`${this.chipSummary(cfg)} ↓`, cfg.color, d.lower, 0.7));
          series.push(this.lineSeries(`${this.chipSummary(cfg)} mid`, cfg.color, d.middle, 0.4));
          break;
        }
        case 'keltner': {
          const k = this.calcKeltner(candles, cfg.params['period'], cfg.params['mult']);
          series.push(this.lineSeries(`${this.chipSummary(cfg)} ↑`, cfg.color, k.upper, 0.7));
          series.push(this.lineSeries(`${this.chipSummary(cfg)} ↓`, cfg.color, k.lower, 0.7, true));
          series.push(this.lineSeries(`${this.chipSummary(cfg)} mid`, cfg.color, k.middle, 0.4));
          break;
        }
        case 'trend': {
          const t = this.calcTrendline(candles, cfg.params['period'], cfg.params['mult']);
          // Direction badge in the line label so the operator can read
          // bias at a glance without reading slope numbers.
          const arrow = t.slope > 0 ? '▲' : t.slope < 0 ? '▼' : '→';
          series.push(this.lineSeries(`${this.chipSummary(cfg)} ${arrow}`, cfg.color, t.line, 1));
          if (cfg.params['mult'] > 0) {
            series.push(this.lineSeries(`${this.chipSummary(cfg)} ↑`, cfg.color, t.upper, 0.55));
            series.push(this.lineSeries(`${this.chipSummary(cfg)} ↓`, cfg.color, t.lower, 0.55));
          }
          break;
        }
        case 'wedge': {
          const w = this.calcWedge(candles, cfg.params['lookback'], cfg.params['strength']);
          if (w) {
            // Lines coloured by directional bias — bearish patterns (rising
            // wedge, descending triangle) red; bullish (falling wedge, asc
            // triangle) green; neutral (channel, sym triangle) use cfg.color.
            const bullish = w.type === 'falling wedge' || w.type === 'asc triangle';
            const bearish = w.type === 'rising wedge' || w.type === 'desc triangle';
            const lineColor = bullish ? '#34C759' : bearish ? '#FF3B30' : cfg.color;
            const head = `${this.chipSummary(cfg)} · ${w.type}`;
            series.push(this.lineSeries(`${head} ↑`, lineColor, w.upper, 0.85));
            series.push(this.lineSeries(`${head} ↓`, lineColor, w.lower, 0.85));
            // Breakout flag — a single-point dot at the last candle with a
            // labelled badge. Direction follows whichever line the close
            // has crossed.
            if (w.breakout) {
              const arrow = w.breakout === 'up' ? '▲ BREAKOUT' : '▼ BREAKDOWN';
              const badgeColor = w.breakout === 'up' ? '#34C759' : '#FF3B30';
              const lastPrice = candles[candles.length - 1].close;
              const badgeData = candles.map((_, i) =>
                i === candles.length - 1 ? lastPrice : null,
              );
              series.push({
                name: `${head} ${arrow}`,
                type: 'line',
                data: badgeData,
                symbol: 'circle',
                symbolSize: 8,
                silent: true,
                lineStyle: { color: badgeColor, width: 0 },
                itemStyle: { color: badgeColor, borderColor: '#fff', borderWidth: 1.5 },
                endLabel: {
                  show: true,
                  formatter: arrow,
                  backgroundColor: badgeColor,
                  color: '#fff',
                  padding: [3, 7],
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  offset: [0, w.breakout === 'up' ? -16 : 16],
                },
                xAxisIndex: 0,
                yAxisIndex: 0,
                z: 12,
              });
            }
          }
          break;
        }
        case 'sr': {
          const sr = this.calcSR(candles, cfg.params['lookback'], cfg.params['count']);
          // Resistance in red, support in green — convention from every
          // major trading platform. We ignore cfg.color here; the chip
          // dot still uses it but the line tags carry their own role
          // colour for instant read.
          for (const level of sr.resistance) {
            series.push(this.srLineSeries(level, 'R', '#FF3B30', candles.length));
          }
          for (const level of sr.support) {
            series.push(this.srLineSeries(level, 'S', '#34C759', candles.length));
          }
          break;
        }
      }
    }
    return series;
  }

  private srLineSeries(level: number, role: 'R' | 'S', color: string, len: number) {
    const formatted = level.toFixed(this.pricePrecision());
    return {
      name: `${role} ${formatted}`,
      type: 'line',
      data: new Array(len).fill(level),
      symbol: 'none',
      silent: true,
      smooth: false,
      sampling: 'lttb',
      lineStyle: { color, width: 1, type: 'dashed', opacity: 0.55 },
      endLabel: {
        show: true,
        formatter: `${role} ${formatted}`,
        backgroundColor: color,
        color: '#fff',
        padding: [2, 6],
        borderRadius: 3,
        fontSize: 9,
        fontWeight: 600,
        offset: [0, 0],
      },
      xAxisIndex: 0,
      yAxisIndex: 0,
      z: 7,
    };
  }

  private lineSeries(
    name: string,
    color: string,
    data: (number | null)[],
    opacity = 1,
    fill = false,
  ) {
    return {
      name,
      type: 'line',
      data,
      smooth: true,
      symbol: 'none',
      sampling: 'lttb',
      lineStyle: { color, width: 1.2, opacity },
      ...(fill ? { areaStyle: { color, opacity: 0.05 } } : {}),
      xAxisIndex: 0,
      yAxisIndex: 0,
    };
  }

  /** Build the ECharts series + the y-axis spec for one subplot indicator. */
  private buildSubplotSeries(
    cfg: IndicatorConfig,
    candles: CandleDto[],
    closes: number[],
    gridIndex: number,
  ): { series: any[]; yAxis: any } {
    const x = gridIndex;
    const y = gridIndex;
    const baseLine = (data: (number | null)[], color: string, name: string, width = 1.2) => ({
      name,
      type: 'line',
      data,
      smooth: false,
      symbol: 'none',
      sampling: 'lttb',
      lineStyle: { color, width },
      xAxisIndex: x,
      yAxisIndex: y,
    });

    switch (cfg.type) {
      case 'rsi': {
        const data = this.calcRSI(closes, cfg.params['period']);
        return {
          series: [
            baseLine(data, cfg.color, this.chipSummary(cfg)),
            // 30 / 70 reference bands
            {
              name: 'RSI 70',
              type: 'line',
              data: closes.map(() => 70),
              symbol: 'none',
              silent: true,
              lineStyle: { color: '#FF3B30', width: 0.5, type: 'dashed', opacity: 0.5 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
            {
              name: 'RSI 30',
              type: 'line',
              data: closes.map(() => 30),
              symbol: 'none',
              silent: true,
              lineStyle: { color: '#34C759', width: 0.5, type: 'dashed', opacity: 0.5 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
          ],
          yAxis: {
            type: 'value',
            scale: false,
            min: 0,
            max: 100,
            gridIndex,
            splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
            axisLabel: { fontSize: 9, color: '#6E6E73' },
            position: 'right',
          },
        };
      }
      case 'macd': {
        const m = this.calcMACD(
          closes,
          cfg.params['fast'],
          cfg.params['slow'],
          cfg.params['signal'],
        );
        const histColored = m.hist.map((v) => ({
          value: v,
          itemStyle: {
            color: v == null ? '#8E8E93' : v >= 0 ? 'rgba(52,199,89,0.6)' : 'rgba(255,59,48,0.6)',
          },
        }));
        return {
          series: [
            {
              name: this.chipSummary(cfg),
              type: 'line',
              data: m.macd,
              symbol: 'none',
              sampling: 'lttb',
              lineStyle: { color: cfg.color, width: 1.2 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
            {
              name: `${this.chipSummary(cfg)} signal`,
              type: 'line',
              data: m.signal,
              symbol: 'none',
              sampling: 'lttb',
              lineStyle: { color: '#5AC8FA', width: 1 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
            {
              name: `${this.chipSummary(cfg)} hist`,
              type: 'bar',
              data: histColored,
              barWidth: '55%',
              xAxisIndex: x,
              yAxisIndex: y,
            },
          ],
          yAxis: this.subplotValueAxis(gridIndex),
        };
      }
      case 'atr': {
        const data = this.calcATR(candles, cfg.params['period']);
        return {
          series: [baseLine(data, cfg.color, this.chipSummary(cfg))],
          yAxis: this.subplotValueAxis(gridIndex),
        };
      }
      case 'stoch': {
        const s = this.calcStoch(candles, cfg.params['period'], cfg.params['k'], cfg.params['d']);
        return {
          series: [
            baseLine(s.k, cfg.color, `${this.chipSummary(cfg)} %K`),
            baseLine(s.d, '#FF9500', `${this.chipSummary(cfg)} %D`, 1),
            {
              name: 'Stoch 80',
              type: 'line',
              data: closes.map(() => 80),
              symbol: 'none',
              silent: true,
              lineStyle: { color: '#FF3B30', width: 0.5, type: 'dashed', opacity: 0.5 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
            {
              name: 'Stoch 20',
              type: 'line',
              data: closes.map(() => 20),
              symbol: 'none',
              silent: true,
              lineStyle: { color: '#34C759', width: 0.5, type: 'dashed', opacity: 0.5 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
          ],
          yAxis: {
            type: 'value',
            min: 0,
            max: 100,
            gridIndex,
            splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
            axisLabel: { fontSize: 9, color: '#6E6E73' },
            position: 'right',
          },
        };
      }
      case 'ofi': {
        const o = this.calcOFI(candles, cfg.params['smoothing']);
        const histColored = o.delta.map((v) => ({
          value: v,
          itemStyle: {
            color: v == null ? '#8E8E93' : v >= 0 ? 'rgba(52,199,89,0.55)' : 'rgba(255,59,48,0.55)',
          },
        }));
        return {
          series: [
            {
              name: `${this.chipSummary(cfg)} cum`,
              type: 'line',
              data: o.cumulative,
              symbol: 'none',
              sampling: 'lttb',
              lineStyle: { color: cfg.color, width: 1.4 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
            {
              name: `${this.chipSummary(cfg)} bar`,
              type: 'bar',
              data: histColored,
              barWidth: '55%',
              xAxisIndex: x,
              yAxisIndex: y,
            },
            // Zero baseline so positive/negative pressure is read at a
            // glance against a stable reference line.
            {
              name: 'OFI 0',
              type: 'line',
              data: candles.map(() => 0),
              symbol: 'none',
              silent: true,
              lineStyle: { color: '#8E8E93', width: 0.5, type: 'dashed', opacity: 0.5 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
          ],
          yAxis: this.subplotValueAxis(gridIndex),
        };
      }
      case 'adx': {
        const data = this.calcADX(candles, cfg.params['period']);
        return {
          series: [
            baseLine(data, cfg.color, this.chipSummary(cfg)),
            {
              name: 'ADX 25',
              type: 'line',
              data: closes.map(() => 25),
              symbol: 'none',
              silent: true,
              lineStyle: { color: '#8E8E93', width: 0.5, type: 'dashed', opacity: 0.5 },
              xAxisIndex: x,
              yAxisIndex: y,
            },
          ],
          yAxis: {
            type: 'value',
            min: 0,
            max: 100,
            gridIndex,
            splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
            axisLabel: { fontSize: 9, color: '#6E6E73' },
            position: 'right',
          },
        };
      }
      default:
        return { series: [], yAxis: this.subplotValueAxis(gridIndex) };
    }
  }

  private subplotValueAxis(gridIndex: number) {
    return {
      type: 'value',
      scale: true,
      gridIndex,
      splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      axisLabel: { fontSize: 9, color: '#6E6E73' },
      position: 'right',
    };
  }

  private formatDate(timestamp: string): string {
    const d = new Date(timestamp);
    const tf = this.selectedTimeframe();
    if (tf === 'D1') return `${d.getMonth() + 1}/${d.getDate()}`;
    if (tf === 'H4' || tf === 'H1') return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
    return `${d.getHours()}:${d.getMinutes().toString().padStart(2, '0')}`;
  }

  formatVolume(v: number | undefined | null): string {
    if (v == null) return '-';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return v.toFixed(0);
  }

  private generateSampleCandles(): CandleDto[] {
    const candles: CandleDto[] = [];
    const symbol = this.selectedSymbol();
    const isJPY = symbol.includes('JPY');
    let price = isJPY ? 150.5 : 1.085;
    const volatility = isJPY ? 0.2 : 0.0008;
    const now = new Date();
    const tfMinutes: Record<string, number> = { M1: 1, M5: 5, M15: 15, H1: 60, H4: 240, D1: 1440 };
    const interval = tfMinutes[this.selectedTimeframe()] ?? 60;

    for (let i = 199; i >= 0; i--) {
      const time = new Date(now.getTime() - i * interval * 60000);
      const change = (Math.random() - 0.48) * volatility;
      const open = price;
      const close = price + change;
      const high = Math.max(open, close) + Math.random() * volatility * 0.5;
      const low = Math.min(open, close) - Math.random() * volatility * 0.5;
      const volume = Math.floor(500 + Math.random() * 2000);
      price = close;

      candles.push({
        id: 200 - i,
        symbol,
        timeframe: this.selectedTimeframe(),
        open: +open.toFixed(isJPY ? 3 : 5),
        high: +high.toFixed(isJPY ? 3 : 5),
        low: +low.toFixed(isJPY ? 3 : 5),
        close: +close.toFixed(isJPY ? 3 : 5),
        volume,
        timestamp: time.toISOString(),
        isClosed: i > 0,
      });
    }
    return candles;
  }
}
