import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  input,
  output,
  signal,
  computed,
  inject,
  OnInit,
  OnChanges,
  ViewChild,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  StrategyDto,
  StrategyType,
  Timeframe,
  CreateStrategyRequest,
  UpdateStrategyRequest,
  StrategyTemplateDto,
  CreateStrategyTemplateRequest,
  StrategyParameterSchemaDto,
  StrategyParameterFieldDto,
  RunBacktestPreviewRequest,
  BacktestPreviewResult,
  StrategyVersionDto,
  BacktestPreviewSnapshotDto,
  SaveBacktestPreviewSnapshotRequest,
} from '@core/api/api.types';
import { StrategiesService } from '@core/services/strategies.service';
import { NotificationService } from '@core/notifications/notification.service';
import { DslBuilderComponent } from '../dsl-builder/dsl-builder.component';

const STRATEGY_TYPES: StrategyType[] = [
  'MovingAverageCrossover',
  'RSIReversion',
  'BreakoutScalper',
  'BollingerBandReversion',
  'MACDDivergence',
  'SessionBreakout',
  'MomentumTrend',
  'CompositeML',
  'StatisticalArbitrage',
  'VwapReversion',
  'CalendarEffect',
  'NewsFade',
  'CarryTrade',
  'WeekendGapFade',
  'RoundNumberFade',
  'WedgeBreakout',
  'CrossAssetLeadLag',
  'OrderFlowImbalance',
  'SubMinuteEvent',
  'RuleBased',
  'Custom',
];

// Placeholders shown in each sub-config tab so operators see a working schema example
// before they fill anything in. Pulled out as a const so the template stays readable
// and so the same shapes are auto-suggested in any future template editor.
const SUB_CONFIG_PLACEHOLDERS = {
  riskOverrides:
    '{"slMode":"Atr","slMultiplier":1.5,"tpMode":"Atr","tpMultiplier":2.5,"trailingStopAtrMultiplier":1.0}',
  sizing: '{"mode":"PercentEquity","value":0.01}',
  sessionFilter: '{"sessionStartUtc":"08:00","sessionEndUtc":"17:00","tradeWeekends":false}',
  regimeGate: '{"allowedRegimes":["Trending","Breakout"]}',
  multiTimeframeGate: '{"timeframe":"D1","indicator":"EMA","period":200,"comparator":"PriceAbove"}',
} as const;

type FormTab = 'inputs' | 'risk' | 'sizing' | 'filters' | 'gates';

interface OverlayCurve {
  id: string;
  label: string;
  color: string;
  points: string;
  /// Inline-rendered metrics for the legend ("S 1.42 · W 58% · DD 6.3%").
  /// Empty for the live-preview series until a result lands; populated
  /// from each saved snapshot's persisted fields.
  metrics: string;
}

/**
 * Curated DSL examples shown in the Parameters JSON tab when Strategy Type is
 * RuleBased / LlmProposal. Operators pick from a dropdown, click "Insert", and
 * the modal fills the JSON textarea with a working example they can edit. This
 * is the v1 of a visual DSL builder — operators get scaffolded JSON for the
 * common patterns without having to memorise the schema.
 */
const DSL_EXAMPLES: ReadonlyArray<{ id: string; label: string; json: string }> = [
  {
    id: 'rsi-oversold-trend',
    label: 'RSI oversold + EMA200 trend filter',
    json: JSON.stringify(
      {
        Name: 'RSI oversold (above EMA200)',
        Symbol: 'EURUSD',
        Timeframe: 'H1',
        Direction: 'Buy',
        EntryConditionsRoot: {
          Op: 'And',
          Children: [
            {
              Leaf: {
                Type: 'IndicatorThreshold',
                indicatorThreshold: {
                  indicator: 'Rsi',
                  period: 14,
                  operator: 'LessThan',
                  value: 30,
                },
              },
            },
            { Leaf: { Type: 'PriceVsMa', priceVsMa: { maPeriod: 200, operator: 'GreaterThan' } } },
          ],
        },
        StopLossAtrMultiplier: 1.5,
        TakeProfitAtrMultiplier: 2.5,
        AtrPeriod: 14,
        BaseConfidence: 0.6,
      },
      null,
      2,
    ),
  },
  {
    id: 'ema-cross-confirmed',
    label: 'EMA(20)/EMA(50) crossover, ADX>25',
    json: JSON.stringify(
      {
        Name: 'EMA20/50 cross with trend confirmation',
        Symbol: 'EURUSD',
        Timeframe: 'H1',
        Direction: 'Buy',
        EntryConditionsRoot: {
          Op: 'And',
          Children: [
            {
              Leaf: {
                Type: 'IndicatorCrossover',
                indicatorCrossover: {
                  leftIndicator: 'Ema',
                  leftPeriod: 20,
                  rightIndicator: 'Ema',
                  rightPeriod: 50,
                },
              },
            },
            {
              Leaf: {
                Type: 'IndicatorThreshold',
                indicatorThreshold: {
                  indicator: 'Adx',
                  period: 14,
                  operator: 'GreaterThan',
                  value: 25,
                },
              },
            },
          ],
        },
        StopLossAtrMultiplier: 2.0,
        TakeProfitAtrMultiplier: 3.0,
        BaseConfidence: 0.55,
      },
      null,
      2,
    ),
  },
  {
    id: 'breakout-volume',
    label: 'Bollinger breakout + volume burst',
    json: JSON.stringify(
      {
        Name: 'BB upper breakout with volume confirmation',
        Symbol: 'EURUSD',
        Timeframe: 'H1',
        Direction: 'Buy',
        EntryConditionsRoot: {
          Op: 'And',
          Children: [
            {
              Leaf: {
                Type: 'IndicatorComparison',
                indicatorComparison: {
                  leftIndicator: 'BollingerBandUpper',
                  leftPeriod: 20,
                  rightIndicator: 'Sma',
                  rightPeriod: 20,
                  operator: 'LessThan',
                },
              },
            },
            {
              Leaf: {
                Type: 'VolumeRatio',
                volumeRatio: { lookbackBars: 20, operator: 'GreaterThan', threshold: 1.5 },
              },
            },
          ],
        },
        StopLossAtrMultiplier: 1.5,
        TakeProfitAtrMultiplier: 2.0,
        BaseConfidence: 0.5,
      },
      null,
      2,
    ),
  },
  {
    id: 'pinbar-london',
    label: 'Bullish pin bar in London session',
    json: JSON.stringify(
      {
        Name: 'Bullish pin bar (London)',
        Symbol: 'GBPUSD',
        Timeframe: 'H1',
        Direction: 'Buy',
        EntryConditionsRoot: {
          Op: 'And',
          Children: [
            {
              Leaf: { Type: 'CandlePattern', candlePattern: { pattern: 'PinBar', bullish: true } },
            },
            { Leaf: { Type: 'HourWindow', hourWindow: { startHourUtc: 8, endHourUtc: 16 } } },
          ],
        },
        StopLossAtrMultiplier: 1.0,
        TakeProfitAtrMultiplier: 2.5,
        BaseConfidence: 0.55,
      },
      null,
      2,
    ),
  },
  {
    id: 'htf-confirmed',
    label: 'H1 entry confirmed by D1 trend',
    json: JSON.stringify(
      {
        Name: 'H1 RSI oversold confirmed by D1 EMA200',
        Symbol: 'EURUSD',
        Timeframe: 'H1',
        Direction: 'Buy',
        EntryConditionsRoot: {
          Op: 'And',
          Children: [
            {
              Leaf: {
                Type: 'IndicatorThreshold',
                indicatorThreshold: {
                  indicator: 'Rsi',
                  period: 14,
                  operator: 'LessThan',
                  value: 30,
                },
              },
            },
            {
              Leaf: {
                Type: 'HtfIndicatorThreshold',
                htfIndicatorThreshold: {
                  higherTimeframe: 'D1',
                  indicator: 'Ema',
                  period: 200,
                  operator: 'GreaterThan',
                  value: 0,
                },
              },
            },
          ],
        },
        StopLossAtrMultiplier: 1.5,
        TakeProfitAtrMultiplier: 3.0,
        BaseConfidence: 0.6,
      },
      null,
      2,
    ),
  },
  {
    id: 'math-range-expansion',
    label: 'Range-expansion via math expression',
    json: JSON.stringify(
      {
        Name: 'Range-expansion entry',
        Symbol: 'EURUSD',
        Timeframe: 'H1',
        Direction: 'Both',
        EntryConditionsRoot: {
          Leaf: {
            Type: 'MathExpression',
            mathExpression: {
              expression: '(High - Low) / Atr(14)',
              operator: 'GreaterThan',
              threshold: 1.5,
            },
          },
        },
        StopLossAtrMultiplier: 2.0,
        TakeProfitAtrMultiplier: 3.0,
        BaseConfidence: 0.5,
      },
      null,
      2,
    ),
  },
];

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

const TIMEFRAME_LABELS: Record<string, string> = {
  M1: '1 Min',
  M5: '5 Min',
  M15: '15 Min',
  H1: '1 Hour',
  H4: '4 Hours',
  D1: 'Daily',
};

@Component({
  selector: 'app-strategy-form',
  standalone: true,
  imports: [ReactiveFormsModule, DatePipe, DecimalPipe, DslBuilderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="overlay"
        role="presentation"
        tabindex="-1"
        (click)="onCancel()"
        (keydown.escape)="onCancel()"
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="dialog-header">
            <h3 class="dialog-title">{{ strategy() ? 'Edit Strategy' : 'Create Strategy' }}</h3>
            @if (!strategy() && availableTemplates().length > 0) {
              <div class="template-loader">
                <label class="template-loader-label">Load from template</label>
                <select
                  class="form-input template-loader-select"
                  [value]="selectedTemplateId() ?? ''"
                  (change)="onTemplateSelect($any($event.target).value)"
                >
                  <option value="">— none —</option>
                  @for (t of availableTemplates(); track t.id) {
                    <option [value]="t.id">{{ t.name }}</option>
                  }
                </select>
              </div>
            }
          </div>
          <form [formGroup]="form" (ngSubmit)="onSubmit()" class="dialog-body">
            <!-- Tab strip — TradingView-style — splits the modal into discrete config sections -->
            <div class="tab-strip" role="tablist">
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'inputs'"
                role="tab"
                (click)="activeTab.set('inputs')"
              >
                Inputs
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'risk'"
                role="tab"
                (click)="activeTab.set('risk')"
              >
                Risk
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'sizing'"
                role="tab"
                (click)="activeTab.set('sizing')"
              >
                Sizing
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'filters'"
                role="tab"
                (click)="activeTab.set('filters')"
              >
                Filters
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'gates'"
                role="tab"
                (click)="activeTab.set('gates')"
              >
                Gates
              </button>
            </div>

            <!-- ========== INPUTS TAB ========== -->
            @if (activeTab() === 'inputs') {
              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Name <span class="required">*</span></label>
                  <input
                    type="text"
                    formControlName="name"
                    class="form-input"
                    placeholder="e.g. EURUSD MA Crossover"
                  />
                  @if (form.get('name')?.touched && form.get('name')?.hasError('required')) {
                    <span class="form-error">Name is required</span>
                  }
                </div>
                <div class="form-group">
                  <label class="form-label">
                    Symbol(s) <span class="required">*</span>
                    @if (parsedSymbols().length > 1) {
                      <span class="multi-symbol-hint">
                        — {{ parsedSymbols().length }} pairs detected
                      </span>
                    }
                  </label>
                  <input
                    type="text"
                    formControlName="symbol"
                    class="form-input"
                    placeholder="e.g. EURUSD or EURUSD, GBPUSD, USDJPY"
                  />
                  <span class="form-hint">
                    Comma-separated to bulk-create — one strategy per symbol with the same
                    parameters.
                  </span>
                  @if (form.get('symbol')?.touched && form.get('symbol')?.hasError('required')) {
                    <span class="form-error">Symbol is required</span>
                  }
                </div>
              </div>

              <div class="form-row">
                <div class="form-group">
                  <label class="form-label">Timeframe</label>
                  <select formControlName="timeframe" class="form-input">
                    @for (tf of timeframes; track tf) {
                      <option [value]="tf">{{ timeframeLabels[tf] }}</option>
                    }
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Strategy Type</label>
                  <select formControlName="strategyType" class="form-input">
                    @for (st of strategyTypes; track st) {
                      <option [value]="st">{{ formatType(st) }}</option>
                    }
                  </select>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label">Risk Profile ID</label>
                <input
                  type="number"
                  formControlName="riskProfileId"
                  class="form-input"
                  placeholder="Optional"
                />
              </div>

              <div class="form-group">
                <label class="form-label">Description</label>
                <textarea
                  formControlName="description"
                  class="form-input form-textarea"
                  rows="2"
                  placeholder="Strategy description..."
                ></textarea>
              </div>

              <!-- Typed parameter form (v1) — drives the Parameters JSON textarea
                   below for strategy types with a registered schema. Operators on
                   types without a schema see only the textarea (legacy behaviour). -->
              @if (parameterSchema(); as schema) {
                <div class="typed-params">
                  <header class="typed-params-head">
                    <span>Typed parameters · {{ schema.fields.length }} fields</span>
                    <span class="muted small">edits sync to Parameters JSON below</span>
                  </header>
                  <div class="typed-params-grid">
                    @for (f of schema.fields; track f.name) {
                      <div class="typed-params-field">
                        <label class="form-label" [title]="f.description ?? ''">
                          {{ f.label }}
                          @if (f.description) {
                            <span class="muted small"> — {{ f.description }}</span>
                          }
                        </label>
                        @if (f.kind === 'enum' && f.enumValues; as opts) {
                          <select
                            class="form-input"
                            [value]="parameterValues()[f.name] ?? f.default"
                            (change)="setParameter(f.name, $any($event.target).value)"
                          >
                            @for (o of opts; track o) {
                              <option [value]="o">{{ o }}</option>
                            }
                          </select>
                        } @else if (f.kind === 'bool') {
                          <input
                            type="checkbox"
                            [checked]="$any(parameterValues()[f.name] ?? f.default)"
                            (change)="setParameter(f.name, $any($event.target).checked)"
                          />
                        } @else {
                          <input
                            class="form-input"
                            [type]="f.kind === 'int' || f.kind === 'decimal' ? 'number' : 'text'"
                            [min]="f.min ?? null"
                            [max]="f.max ?? null"
                            [step]="f.step ?? (f.kind === 'int' ? 1 : 0.01)"
                            [value]="parameterValues()[f.name] ?? f.default"
                            (input)="
                              setParameter(
                                f.name,
                                f.kind === 'int'
                                  ? +$any($event.target).value
                                  : f.kind === 'decimal'
                                    ? +$any($event.target).value
                                    : $any($event.target).value
                              )
                            "
                          />
                        }
                      </div>
                    }
                  </div>
                </div>
              }

              <div class="form-group">
                <label class="form-label">
                  Parameters JSON
                  <span class="dsl-example-loader">
                    <button
                      type="button"
                      class="btn btn-link dsl-format-btn"
                      (click)="formatParametersJson()"
                      title="Pretty-print the JSON"
                    >
                      Format
                    </button>
                    <select
                      class="dsl-example-select"
                      (change)="
                        loadDslExample($any($event.target).value); $any($event.target).value = ''
                      "
                    >
                      <option value="">Insert DSL example…</option>
                      @for (ex of dslExamples; track ex.id) {
                        <option [value]="ex.id">{{ ex.label }}</option>
                      }
                    </select>
                  </span>
                </label>
                @if (
                  form.get('strategyType')?.value === 'RuleBased' ||
                  form.get('strategyType')?.value === 'LlmProposal'
                ) {
                  <app-dsl-builder
                    [parametersJson]="$any(form.get('parametersJson'))?.value ?? ''"
                    (parametersJsonChange)="onDslBuilderChange($event)"
                  />
                }
                <textarea
                  formControlName="parametersJson"
                  class="form-input form-textarea form-mono"
                  rows="8"
                  placeholder='{"period": 14, "threshold": 0.5}'
                ></textarea>
                @if (dslChecking()) {
                  <span class="form-hint dsl-checking">Validating DSL…</span>
                }
                @if (dslSummary(); as summary) {
                  <span class="dsl-summary">📖 {{ summary }}</span>
                }
                @if (dslError(); as err) {
                  <span class="dsl-error">⚠ {{ err }}</span>
                }

                <span class="form-hint">
                  Strategy-type-specific tuning. For RuleBased / LlmProposal, paste the condition
                  DSL here. Supports a boolean tree (<code>EntryConditionsRoot</code> with
                  <code>And</code> / <code>Or</code> / <code>Not</code>) plus 9 condition types:
                  <code>IndicatorThreshold</code>, <code>PriceVsMa</code>, <code>RegimeMatch</code>,
                  <code>HourWindow</code>, <code>IndicatorComparison</code>,
                  <code>IndicatorCrossover</code>, <code>IndicatorCrossunder</code>,
                  <code>VolumeRatio</code>, <code>BarsSince</code>. Indicators: <code>Rsi</code>,
                  <code>Atr</code>, <code>AtrRatio</code>, <code>Adx</code>, <code>Momentum</code>,
                  <code>Sma</code>, <code>Ema</code>, <code>Macd</code>, <code>MacdSignal</code>,
                  <code>MacdHistogram</code>, <code>BollingerBandWidth</code>,
                  <code>BollingerBandUpper</code>, <code>BollingerBandLower</code>,
                  <code>StochasticK</code>, <code>StochasticD</code>, <code>Cci</code>,
                  <code>Vwap</code>. Optional <code>ExitConditionsRoot</code> for per-strategy exit
                  logic; <code>Offset</code> on IndicatorThreshold/IndicatorComparison reads N bars
                  ago. The flat <code>EntryConditions</code> form still works as an implicit
                  <code>And</code> for backward compatibility.
                </span>
              </div>
            }

            <!-- ========== RISK OVERRIDES TAB ========== -->
            @if (activeTab() === 'risk') {
              <div class="form-group">
                <label class="form-label">Risk Overrides JSON</label>
                <textarea
                  formControlName="riskOverridesJson"
                  class="form-input form-textarea form-mono"
                  rows="6"
                  [placeholder]="placeholders.riskOverrides"
                ></textarea>
                <span class="form-hint">
                  Optional. SL/TP/trailing-stop overrides for signals from this strategy. Leave
                  blank to inherit from the assigned risk profile. Modes:
                  <code>Atr</code> (multiplier × ATR) or <code>Pips</code> (literal pips).
                </span>
              </div>
            }

            <!-- ========== SIZING TAB ========== -->
            @if (activeTab() === 'sizing') {
              <div class="form-group">
                <label class="form-label">Sizing Config JSON</label>
                <textarea
                  formControlName="sizingConfigJson"
                  class="form-input form-textarea form-mono"
                  rows="6"
                  [placeholder]="placeholders.sizing"
                ></textarea>
                <span class="form-hint">
                  Optional. Position-sizing model. Modes:
                  <code>FixedLot</code>, <code>PercentEquity</code>, <code>AtrBased</code>,
                  <code>KellyFraction</code>. Leave blank to use the engine default lot size.
                </span>
              </div>
            }

            <!-- ========== FILTERS TAB (session + news) ========== -->
            @if (activeTab() === 'filters') {
              <div class="form-group">
                <label class="form-label">Session Filter JSON</label>
                <textarea
                  formControlName="sessionFilterJson"
                  class="form-input form-textarea form-mono"
                  rows="6"
                  [placeholder]="placeholders.sessionFilter"
                ></textarea>
                <span class="form-hint">
                  Optional. Time-of-day window (UTC) plus optional news embargo.
                  <code>sessionStartUtc</code> / <code>sessionEndUtc</code> as <code>HH:mm</code>;
                  set <code>tradeWeekends:false</code> to skip Saturday/Sunday. Leave blank to trade
                  24/5.
                </span>
              </div>
            }

            <!-- ========== GATES TAB (regime + higher-TF) ========== -->
            @if (activeTab() === 'gates') {
              <div class="form-group">
                <label class="form-label">Regime Gate JSON</label>
                <textarea
                  formControlName="regimeGateJson"
                  class="form-input form-textarea form-mono"
                  rows="4"
                  [placeholder]="placeholders.regimeGate"
                ></textarea>
                <span class="form-hint">
                  Optional. Allowlist of regimes where this strategy may emit signals. Values:
                  <code>Trending</code>, <code>Ranging</code>, <code>Breakout</code>,
                  <code>HighVolatility</code>, <code>LowVolatility</code>, <code>Crisis</code>.
                </span>
              </div>

              <div class="form-group">
                <label class="form-label">Multi-Timeframe Gate JSON</label>
                <textarea
                  formControlName="multiTimeframeGateJson"
                  class="form-input form-textarea form-mono"
                  rows="4"
                  [placeholder]="placeholders.multiTimeframeGate"
                ></textarea>
                <span class="form-hint">
                  Optional. Higher-timeframe confirmation. Comparator:
                  <code>PriceAbove</code>, <code>PriceBelow</code>, <code>Crossover</code>,
                  <code>Crossunder</code>.
                </span>
              </div>
            }

            <!-- Backtest preview panel — synchronous, server-bounded (≤90d, ≤6000
                 candles, 60s deadline). Operators see real Sharpe / win-rate / max DD
                 before saving. Single-symbol only; multi-symbol previews are too noisy
                 to interpret in one panel. -->
            <div class="preview-panel">
              <div class="preview-controls">
                <label class="form-label" style="margin:0;">
                  Backtest preview window
                  <select
                    class="form-input preview-window-select"
                    [value]="previewLookbackDays()"
                    (change)="previewLookbackDays.set(+$any($event.target).value)"
                  >
                    <option [value]="7">7 days</option>
                    <option [value]="14">14 days</option>
                    <option [value]="30">30 days</option>
                    <option [value]="60">60 days</option>
                    <option [value]="90">90 days</option>
                  </select>
                </label>
                <button
                  type="button"
                  class="btn btn-secondary preview-run-btn"
                  (click)="runBacktestPreview()"
                  [disabled]="runningPreview() || form.invalid"
                >
                  @if (runningPreview()) {
                    <span class="spinner-sm"></span> Running…
                  } @else {
                    Run preview
                  }
                </button>
              </div>
              @if (previewError(); as err) {
                <div class="preview-error">{{ err }}</div>
              }
              @if (previewResult(); as r) {
                <div class="preview-stats">
                  <div class="preview-stat">
                    <span class="preview-stat-label">Trades</span>
                    <span class="preview-stat-value mono">{{ r.totalTrades }}</span>
                    <span class="preview-stat-sub"
                      >{{ r.winningTrades }}W / {{ r.losingTrades }}L</span
                    >
                  </div>
                  <div class="preview-stat">
                    <span class="preview-stat-label">Win rate</span>
                    <span
                      class="preview-stat-value mono"
                      [class.positive]="r.winRate >= 50"
                      [class.negative]="r.winRate < 50 && r.totalTrades > 0"
                      >{{ r.winRate.toFixed(1) }}%</span
                    >
                  </div>
                  <div class="preview-stat">
                    <span class="preview-stat-label">Sharpe</span>
                    <span
                      class="preview-stat-value mono"
                      [class.positive]="r.sharpeRatio >= 1"
                      [class.negative]="r.sharpeRatio < 0"
                      >{{ r.sharpeRatio.toFixed(2) }}</span
                    >
                  </div>
                  <div class="preview-stat">
                    <span class="preview-stat-label">Profit factor</span>
                    <span
                      class="preview-stat-value mono"
                      [class.positive]="r.profitFactor >= 1.5"
                      [class.negative]="r.profitFactor < 1 && r.totalTrades > 0"
                      >{{ r.profitFactor.toFixed(2) }}</span
                    >
                  </div>
                  <div class="preview-stat">
                    <span class="preview-stat-label">Max DD</span>
                    <span class="preview-stat-value mono" [class.negative]="r.maxDrawdownPct >= 10"
                      >{{ r.maxDrawdownPct.toFixed(1) }}%</span
                    >
                  </div>
                  <div class="preview-stat">
                    <span class="preview-stat-label">Return</span>
                    <span
                      class="preview-stat-value mono"
                      [class.positive]="r.totalReturn > 0"
                      [class.negative]="r.totalReturn < 0"
                      >{{ r.totalReturn.toFixed(1) }}%</span
                    >
                  </div>
                </div>
                @if (r.equityCurve && r.equityCurve.length > 1) {
                  <div class="equity-sparkline">
                    <span class="muted small">Equity curve</span>
                    <svg width="100%" height="80" preserveAspectRatio="none" viewBox="0 0 400 80">
                      <polyline
                        [attr.points]="equitySparklinePoints(r.equityCurve, 400, 80)"
                        fill="none"
                        [attr.stroke]="r.finalBalance >= r.initialBalance ? '#248A3D' : '#D70015'"
                        stroke-width="1.5"
                      />
                      <line
                        [attr.x1]="0"
                        [attr.x2]="400"
                        [attr.y1]="equityBaselineY(r.equityCurve, r.initialBalance, 80)"
                        [attr.y2]="equityBaselineY(r.equityCurve, r.initialBalance, 80)"
                        stroke="rgba(0,0,0,0.15)"
                        stroke-dasharray="2,3"
                        stroke-width="1"
                      />
                    </svg>
                  </div>
                }
                <div class="preview-meta">
                  {{ r.candlesAnalyzed | number }} candles analysed · final balance &#36;{{
                    r.finalBalance.toFixed(0)
                  }}
                  @if (r.note) {
                    · <em>{{ r.note }}</em>
                  }
                  <button
                    type="button"
                    class="btn btn-link preview-snapshot-btn"
                    (click)="snapshotPreview()"
                    title="Save this preview to compare against later runs"
                  >
                    📌 Snapshot
                  </button>
                </div>
              }
              @if (previewSnapshots().length > 0) {
                <div class="preview-snapshots">
                  <div class="preview-snapshots-head">
                    <span class="muted small"
                      >Saved snapshots ({{ previewSnapshots().length }})</span
                    >
                    <span class="muted small">·</span>
                    <button
                      type="button"
                      class="btn btn-link"
                      (click)="toggleSnapshotFilter()"
                      [title]="
                        snapshotFilterMode() === 'matching'
                          ? 'Currently matching this config — click to show all configs'
                          : 'Currently all configs — click to filter to this config'
                      "
                    >
                      {{ snapshotFilterMode() === 'matching' ? 'this config' : 'all configs' }}
                    </button>
                    <span class="muted small">·</span>
                    <button
                      type="button"
                      class="btn btn-link"
                      (click)="toggleSnapshotScope()"
                      [title]="
                        snapshotScope() === 'mine'
                          ? 'Currently your snapshots — click to include other operators'
                          : 'Currently every operator — click to filter to yours'
                      "
                    >
                      {{ snapshotScope() === 'mine' ? 'yours' : 'everyone' }}
                    </button>
                  </div>
                  <table class="preview-snapshot-table">
                    <thead>
                      <tr>
                        <th>Captured</th>
                        <th>Strategy</th>
                        <th>Sharpe</th>
                        <th>Win %</th>
                        <th>Max DD</th>
                        <th>Return</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (s of previewSnapshots(); track s.id) {
                        <tr>
                          <td>{{ s.capturedAt | date: 'MM-dd HH:mm' }}</td>
                          <td class="mono" [title]="s.label ?? ''">
                            {{ s.symbol }}/{{ s.timeframe }} · {{ s.strategyType }}
                          </td>
                          <td class="mono">{{ s.sharpeRatio.toFixed(2) }}</td>
                          <td class="mono">{{ s.winRate.toFixed(1) }}%</td>
                          <td class="mono">{{ s.maxDrawdownPct.toFixed(1) }}%</td>
                          <td class="mono">{{ s.totalReturn.toFixed(1) }}%</td>
                          <td>
                            <button
                              type="button"
                              class="btn btn-link"
                              (click)="toggleSnapshotNotes(s)"
                              [title]="s.notes ? 'Edit notes — currently: ' + s.notes : 'Add notes'"
                            >
                              📝
                            </button>
                            <button
                              type="button"
                              class="btn btn-link"
                              (click)="deleteSnapshot(s)"
                              [disabled]="deletingSnapshotId() === s.id"
                              title="Delete this saved snapshot"
                            >
                              🗑
                            </button>
                          </td>
                        </tr>
                        @if (editingNotesId() === s.id) {
                          <tr class="snapshot-notes-row">
                            <td colspan="7">
                              <textarea
                                class="form-input form-textarea"
                                rows="2"
                                placeholder="Notes (optional)…"
                                [value]="editingNotesText()"
                                (input)="editingNotesText.set($any($event.target).value)"
                              ></textarea>
                              <div
                                style="margin-top:4px;display:flex;gap:8px;justify-content:flex-end;"
                              >
                                <button
                                  type="button"
                                  class="btn btn-link"
                                  (click)="editingNotesId.set(null)"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  class="btn btn-link"
                                  (click)="saveSnapshotNotes(s)"
                                >
                                  Save notes
                                </button>
                              </div>
                            </td>
                          </tr>
                        }
                      }
                    </tbody>
                  </table>
                  @if (overlayCurves().length > 0) {
                    <div class="overlay-chart">
                      <div class="overlay-chart-head">
                        <span class="muted small">
                          Equity-curve overlay · {{ visibleCurves().length }}/{{
                            overlayCurves().length
                          }}
                          series
                        </span>
                        <label
                          class="dsl-checkbox"
                          title="Plot all curves on a shared y-axis to compare absolute returns instead of just shape"
                        >
                          <input
                            type="checkbox"
                            [checked]="overlaySharedY()"
                            (change)="overlaySharedY.set($any($event.target).checked)"
                          />
                          <span class="muted small">shared y-axis</span>
                        </label>
                        <button
                          type="button"
                          class="btn btn-link"
                          (click)="exportOverlayPng()"
                          title="Download the overlay chart as a PNG"
                        >
                          📥 PNG
                        </button>
                      </div>
                      <div class="overlay-svg-wrap">
                        @if (overlaySharedY() && overlayBounds(); as b) {
                          <span class="overlay-y-max muted small">{{
                            b.max | number: '1.0-0'
                          }}</span>
                          <span class="overlay-y-min muted small">{{
                            b.min | number: '1.0-0'
                          }}</span>
                        }
                        <svg
                          #overlaySvg
                          class="overlay-svg"
                          viewBox="0 0 320 80"
                          preserveAspectRatio="none"
                        >
                          @for (c of visibleCurves(); track c.id) {
                            <polyline
                              fill="none"
                              [attr.stroke]="c.color"
                              stroke-width="1.4"
                              [attr.points]="c.points"
                            />
                          }
                        </svg>
                      </div>
                      <div class="overlay-legend">
                        @for (c of overlayCurves(); track c.id) {
                          <button
                            type="button"
                            class="overlay-legend-item"
                            [class.is-hidden]="hiddenCurves().has(c.id)"
                            (click)="toggleCurveVisibility(c.id)"
                            [title]="
                              hiddenCurves().has(c.id) ? 'Show ' + c.label : 'Hide ' + c.label
                            "
                          >
                            <span class="overlay-legend-swatch" [style.background]="c.color"></span>
                            <span class="overlay-legend-text">{{ c.label }}</span>
                            @if (c.metrics) {
                              <span class="overlay-legend-metrics muted small">{{
                                c.metrics
                              }}</span>
                            }
                          </button>
                        }
                      </div>
                    </div>
                  }
                </div>
              }
            </div>

            @if (strategy(); as s) {
              <div class="version-history">
                <div class="version-history-head">
                  <button
                    type="button"
                    class="btn btn-link"
                    (click)="toggleVersionHistory()"
                    [attr.aria-expanded]="showVersionHistory()"
                  >
                    {{ showVersionHistory() ? '▾' : '▸' }} Version history
                    @if (versions().length > 0) {
                      <span class="muted small">({{ versions().length }})</span>
                    }
                  </button>
                  @if (loadingVersions()) {
                    <span class="muted small">Loading…</span>
                  }
                </div>
                @if (showVersionHistory()) {
                  <div class="version-manual-capture">
                    <input
                      class="form-input small"
                      type="text"
                      placeholder="Reason / label (optional)"
                      [value]="manualCaptureReason()"
                      (input)="manualCaptureReason.set($any($event.target).value)"
                    />
                    <button
                      type="button"
                      class="btn btn-link"
                      [disabled]="capturingVersion()"
                      (click)="captureVersionNow()"
                      title="Bookmark the current configuration as a fresh version. Roll back later if needed."
                    >
                      📌 Capture snapshot now
                    </button>
                  </div>
                  @if (versions().length === 0 && !loadingVersions()) {
                    <p class="muted small" style="padding:6px 4px;">
                      No prior versions captured. The first edit will create a snapshot of the
                      current state.
                    </p>
                  }
                  @if (versions().length > 0) {
                    <table class="version-table">
                      <thead>
                        <tr>
                          <th>v</th>
                          <th>Captured</th>
                          <th>Reason</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (v of versions(); track v.id) {
                          <tr>
                            <td class="mono">v{{ v.versionNumber }}</td>
                            <td>{{ v.capturedAt | date: 'yyyy-MM-dd HH:mm:ss' }}</td>
                            <td class="muted small">{{ v.changeReason ?? '' }}</td>
                            <td>
                              <button
                                type="button"
                                class="btn btn-link"
                                (click)="diffWithCurrent(v)"
                                title="Show what changed between this version and current"
                              >
                                Diff
                              </button>
                              <button
                                type="button"
                                class="btn btn-link"
                                [disabled]="rollingBack()"
                                (click)="rollbackToVersion(v)"
                                [title]="'Restore strategy to v' + v.versionNumber"
                              >
                                Roll back
                              </button>
                            </td>
                          </tr>
                        }
                      </tbody>
                    </table>
                    @if (diffVersion(); as dv) {
                      <div class="version-diff">
                        <div class="version-diff-head">
                          <strong>Diff: v{{ dv.versionNumber }} → current</strong>
                          <button
                            type="button"
                            class="btn btn-link"
                            (click)="diffVersion.set(null)"
                          >
                            close
                          </button>
                        </div>
                        @if (diffRows().length === 0) {
                          <p class="muted small">
                            No differences — current state matches v{{ dv.versionNumber }}.
                          </p>
                        } @else {
                          <table class="version-diff-table">
                            <thead>
                              <tr>
                                <th>Field</th>
                                <th>v{{ dv.versionNumber }}</th>
                                <th>Current</th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (d of diffRows(); track d.field) {
                                <tr>
                                  <td class="mono small">{{ d.field }}</td>
                                  <td class="mono small">{{ d.before }}</td>
                                  <td class="mono small">{{ d.after }}</td>
                                </tr>
                              }
                            </tbody>
                          </table>
                        }
                      </div>
                    }
                  }
                }
              </div>
            }

            <div class="dialog-actions">
              @if (!strategy()) {
                <button
                  type="button"
                  class="btn btn-link save-template-btn"
                  (click)="saveAsTemplate()"
                  [disabled]="form.invalid || savingTemplate()"
                  title="Save the current configuration as a reusable template"
                >
                  @if (savingTemplate()) {
                    <span class="spinner-sm"></span>
                  } @else {
                    Save as template…
                  }
                </button>
              }
              <button
                type="button"
                class="btn btn-secondary"
                (click)="onCancel()"
                [disabled]="submitting()"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-primary"
                [disabled]="form.invalid || submitting()"
              >
                @if (submitting()) {
                  <span class="spinner"></span>
                } @else {
                  {{ strategy() ? 'Update' : 'Create' }}
                }
              </button>
            </div>
          </form>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fadeIn 0.15s ease;
      }

      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 560px;
        max-height: 90vh;
        overflow-y: auto;
        animation: scaleIn 0.2s ease-out;
      }

      .dialog-header {
        padding: var(--space-5) var(--space-6) 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
      }

      .dialog-title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }

      .dialog-body {
        padding: var(--space-4) var(--space-6) var(--space-5);
      }

      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }

      .form-group {
        margin-bottom: var(--space-4);
      }

      .form-label {
        display: block;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
      }

      .required {
        color: var(--loss);
      }

      .form-input {
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s ease;
      }

      .form-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
      }

      .form-textarea {
        height: auto;
        padding: var(--space-2) var(--space-3);
        resize: vertical;
        line-height: 1.5;
      }

      .form-mono {
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 12px;
      }

      .form-error {
        display: block;
        font-size: var(--text-xs);
        color: var(--loss);
        margin-top: 2px;
      }

      .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
        padding-top: var(--space-2);
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
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 80px;
      }

      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        opacity: 0.8;
      }

      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }

      .spinner {
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
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes scaleIn {
        from {
          transform: scale(0.96);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }

      .template-loader {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
      .template-loader-label {
        color: var(--text-secondary, #636366);
        white-space: nowrap;
      }
      .template-loader-select {
        max-width: 200px;
        font-size: 12px;
        padding: 4px 8px;
      }

      .tab-strip {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--border, #e5e5ea);
        margin-bottom: 16px;
      }
      .tab {
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary, #636366);
        cursor: pointer;
        transition:
          color 0.15s,
          border-color 0.15s;
      }
      .tab:hover {
        color: var(--text-primary, #1d1d1f);
      }
      .tab.active {
        color: #0071e3;
        border-bottom-color: #0071e3;
      }

      .form-hint {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-tertiary, #8e8e93);
      }
      .form-hint code {
        font-family: 'SF Mono', 'Menlo', monospace;
        background: rgba(142, 142, 147, 0.12);
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 10.5px;
      }

      .save-template-btn {
        margin-right: auto;
        font-size: 12px;
      }
      .spinner-sm {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid rgba(0, 113, 227, 0.3);
        border-top-color: #0071e3;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      .dsl-example-loader {
        float: right;
      }
      .dsl-example-select {
        font-size: 11px;
        padding: 2px 6px;
        border: 1px solid var(--border, #e5e5ea);
        border-radius: 4px;
        background: var(--bg-secondary, #fafafa);
        color: var(--text-secondary, #636366);
        cursor: pointer;
      }
      .multi-symbol-hint {
        font-size: 11px;
        color: #0071e3;
        font-weight: normal;
      }
      .typed-params {
        background: var(--bg-tertiary, #fafafa);
        border: 1px solid var(--border, #e5e5ea);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .typed-params-head {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #636366);
        margin-bottom: 8px;
      }
      .typed-params-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 8px 12px;
      }
      .typed-params-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .modal-footer-hint {
        font-size: 11px;
        color: var(--text-tertiary, #8e8e93);
        background: rgba(0, 113, 227, 0.06);
        padding: 8px 12px;
        border-radius: 6px;
        margin: 12px 0;
      }
      .preview-panel {
        background: var(--bg-tertiary, #fafafa);
        border: 1px solid var(--border, #e5e5ea);
        border-radius: 8px;
        padding: 12px;
        margin: 12px 0;
      }
      .preview-controls {
        display: flex;
        align-items: flex-end;
        gap: 12px;
        margin-bottom: 8px;
      }
      .preview-window-select {
        width: 110px;
        font-size: 12px;
      }
      .preview-run-btn {
        font-size: 12px;
        padding: 6px 14px;
      }
      .preview-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 8px;
        margin-top: 8px;
      }
      .preview-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 8px;
        background: var(--bg-primary, #fff);
        border-radius: 4px;
      }
      .preview-stat-label {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #636366);
      }
      .preview-stat-value {
        font-size: 14px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .preview-stat-sub {
        font-size: 10px;
        color: var(--text-tertiary, #8e8e93);
      }
      .preview-stat-value.positive {
        color: #248a3d;
      }
      .preview-stat-value.negative {
        color: #d70015;
      }
      .preview-meta {
        font-size: 11px;
        color: var(--text-tertiary, #8e8e93);
        margin-top: 8px;
      }
      .preview-error {
        background: rgba(255, 59, 48, 0.08);
        border: 1px solid rgba(255, 59, 48, 0.32);
        color: #d70015;
        padding: 8px 12px;
        border-radius: 4px;
        font-size: 12px;
        margin-top: 8px;
      }
      .dsl-checking {
        color: var(--text-tertiary, #8e8e93);
        font-style: italic;
      }
      .dsl-summary {
        display: block;
        margin-top: 6px;
        padding: 8px 10px;
        background: rgba(52, 199, 89, 0.08);
        border-left: 3px solid #248a3d;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.4;
        color: #1d4d1d;
      }
      .dsl-error {
        display: block;
        margin-top: 6px;
        padding: 8px 10px;
        background: rgba(255, 59, 48, 0.08);
        border-left: 3px solid #d70015;
        border-radius: 4px;
        font-size: 12px;
        color: #8e1010;
      }
      .equity-sparkline {
        display: block;
        margin-top: 8px;
        padding: 8px;
        background: var(--bg-primary, #fff);
        border-radius: 4px;
      }
      .equity-sparkline svg {
        display: block;
      }
      .dsl-format-btn {
        margin-left: 8px;
        font-size: 11px;
        padding: 2px 8px;
      }
      .preview-snapshot-btn {
        font-size: 11px;
        padding: 2px 8px;
        margin-left: 8px;
      }
      .preview-snapshots {
        margin-top: 12px;
        padding: 10px;
        background: var(--bg-secondary, #f7f8fa);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 6px;
      }
      .preview-snapshots-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .preview-snapshot-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .preview-snapshot-table th,
      .preview-snapshot-table td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border-subtle, #eef0f3);
      }
      .preview-snapshot-table th {
        font-weight: var(--font-semibold, 600);
        color: var(--text-secondary, #5a6273);
      }
      .preview-snapshot-table tr:last-child td {
        border-bottom: none;
      }
      .overlay-chart {
        margin-top: 8px;
        padding: 6px 4px 0;
        border-top: 1px solid var(--border-subtle, #eef0f3);
      }
      .overlay-chart-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
        gap: 12px;
      }
      .overlay-svg-wrap {
        position: relative;
      }
      .overlay-svg {
        width: 100%;
        height: 80px;
        display: block;
      }
      .overlay-y-max,
      .overlay-y-min {
        position: absolute;
        right: 4px;
        font-variant-numeric: tabular-nums;
        background: rgba(255, 255, 255, 0.7);
        padding: 0 3px;
        border-radius: 2px;
      }
      .overlay-y-max {
        top: 0;
      }
      .overlay-y-min {
        bottom: 0;
      }
      .overlay-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        margin-top: 6px;
      }
      .overlay-legend-item {
        background: transparent;
        border: 1px solid transparent;
        padding: 2px 6px;
        font-size: 11px;
        color: var(--text-primary, #1d1d1f);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border-radius: 3px;
      }
      .overlay-legend-item:hover {
        background: rgba(0, 113, 227, 0.06);
      }
      .overlay-legend-item.is-hidden {
        opacity: 0.4;
        text-decoration: line-through;
      }
      .overlay-legend-swatch {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 2px;
      }
      .overlay-legend-metrics {
        font-variant-numeric: tabular-nums;
        font-family: 'SF Mono', Menlo, monospace;
        font-size: 10px;
      }
      .dsl-checkbox {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        cursor: pointer;
      }
      .version-history {
        margin-top: 16px;
        padding: 10px 12px;
        background: var(--bg-secondary, #f7f8fa);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 6px;
      }
      .version-history-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .version-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        margin-top: 8px;
      }
      .version-table th,
      .version-table td {
        text-align: left;
        padding: 4px 6px;
        border-bottom: 1px solid var(--border-subtle, #eef0f3);
      }
      .version-table tr:last-child td {
        border-bottom: none;
      }
      .version-diff {
        margin-top: 10px;
        padding: 8px 10px;
        background: var(--bg-primary, #fff);
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 4px;
      }
      .version-diff-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .version-diff-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
      }
      .version-diff-table th,
      .version-diff-table td {
        text-align: left;
        padding: 3px 6px;
        border-bottom: 1px solid var(--border-subtle, #eef0f3);
        word-break: break-word;
      }
      .version-diff-table tr:last-child td {
        border-bottom: none;
      }
      .version-manual-capture {
        display: flex;
        gap: 6px;
        align-items: center;
        padding: 6px 0;
        margin-bottom: 6px;
        border-bottom: 1px dashed var(--border-subtle, #eef0f3);
      }
      .version-manual-capture .form-input {
        flex: 1;
        font-size: 12px;
        padding: 4px 6px;
        height: 26px;
      }
      .snapshot-notes-row td {
        padding: 6px 4px;
        background: var(--bg-secondary, #fafbfc);
      }
    `,
  ],
})
export class StrategyFormComponent implements OnInit, OnChanges {
  private readonly fb = inject(FormBuilder);
  private readonly strategiesService = inject(StrategiesService);
  private readonly notifications = inject(NotificationService);

  open = input(false);
  strategy = input<StrategyDto | null>(null);

  submitted = output<CreateStrategyRequest | UpdateStrategyRequest>();
  cancelled = output<void>();

  submitting = signal(false);
  savingTemplate = signal(false);
  activeTab = signal<FormTab>('inputs');
  availableTemplates = signal<StrategyTemplateDto[]>([]);
  selectedTemplateId = signal<number | null>(null);

  // Live count of comma-separated symbols typed into the Symbol input —
  // used by the label and submit button to switch between single-create
  // and multi-create messaging without reading the form on every render.
  symbolInputValue = signal<string>('');
  parsedSymbols = computed<string[]>(() => {
    const raw = this.symbolInputValue();
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  });

  // Typed parameter schema for the currently-selected StrategyType (when one
  // is registered server-side). Drives the typed-input form above the
  // Parameters JSON textarea — operators don't need to know the JSON shape
  // for common types like RSIReversion / MovingAverageCrossover.
  parameterSchema = signal<StrategyParameterSchemaDto | null>(null);
  parameterValues = signal<Record<string, unknown>>({});

  // ── Real-time DSL validation / summary ──────────────────────────────────
  // When StrategyType is RuleBased / LlmProposal, the Parameters JSON field
  // is the DSL. As the operator types we POST it to the summariser endpoint
  // (debounced 600ms) and show either a human-readable summary or the parse
  // error inline — no submit-time surprises.
  dslSummary = signal<string | null>(null);
  dslError = signal<string | null>(null);
  dslChecking = signal(false);
  private dslSummaryTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Backtest preview state ──────────────────────────────────────────────
  // Synchronous preview backtest of the unsaved configuration. Bounded by
  // the server (≤90d / ≤6000 candles / 60s) so the call returns within
  // seconds. Operators see real Sharpe / win-rate / max DD before saving.
  runningPreview = signal(false);
  previewResult = signal<BacktestPreviewResult | null>(null);
  previewError = signal<string | null>(null);
  previewLookbackDays = signal<number>(30);
  /// Saved snapshots of past previews for side-by-side comparison. Backed by
  /// the engine's BacktestPreviewSnapshot table — visible across browsers and
  /// sessions, with no 3-row localStorage cap.
  previewSnapshots = signal<BacktestPreviewSnapshotDto[]>([]);
  /// 'matching' filters snapshots to the current symbol/timeframe/strategyType
  /// so the overlay compares like-for-like; 'all' shows everything.
  snapshotFilterMode = signal<'matching' | 'all'>('matching');
  /// 'mine' (default) limits the listing to the current operator's snapshots;
  /// 'all' surfaces every operator's snapshots for cross-operator comparison.
  snapshotScope = signal<'mine' | 'all'>('mine');
  savingSnapshot = signal(false);
  deletingSnapshotId = signal<number | null>(null);

  /// 'true' = all curves share one y-axis (compare absolute returns);
  /// 'false' = each curve normalised to its own min/max (compare shapes).
  overlaySharedY = signal(false);
  /// Curve ids the operator has hidden via the legend. Toggled per-id.
  hiddenCurves = signal<Set<string>>(new Set());

  /// SVG polyline series for the overlay chart: every saved snapshot's equity
  /// curve plus the current live preview if any. Reads {@link overlaySharedY}
  /// to decide between own-min/max (shape compare) and global min/max
  /// (absolute compare).
  overlayCurves = computed<OverlayCurve[]>(() => {
    const palette = ['#0071e3', '#34c759', '#ff9500', '#af52de', '#5ac8fa', '#ff3b30', '#8e8e93'];
    const series: { id: string; label: string; values: number[]; metrics: string }[] = [];

    const live = this.previewResult();
    if (live?.equityCurve && live.equityCurve.length > 1) {
      series.push({
        id: 'live',
        label: 'Live preview',
        values: live.equityCurve,
        metrics: `S ${live.sharpeRatio.toFixed(2)} · W ${live.winRate.toFixed(0)}% · DD ${live.maxDrawdownPct.toFixed(1)}% · R ${live.totalReturn.toFixed(1)}%`,
      });
    }
    for (const s of this.previewSnapshots()) {
      if (!s.equityCurveJson) continue;
      try {
        const v = JSON.parse(s.equityCurveJson);
        if (Array.isArray(v) && v.length > 1) {
          const label = s.label?.trim() || `${s.symbol}/${s.timeframe} #${s.id}`;
          series.push({
            id: `s${s.id}`,
            label,
            values: v as number[],
            metrics: `S ${s.sharpeRatio.toFixed(2)} · W ${s.winRate.toFixed(0)}% · DD ${s.maxDrawdownPct.toFixed(1)}% · R ${s.totalReturn.toFixed(1)}%`,
          });
        }
      } catch {
        /* skip malformed */
      }
    }

    // Shared-y bounds across all visible series.
    let globalMin = Infinity,
      globalMax = -Infinity;
    if (this.overlaySharedY()) {
      for (const s of series) {
        for (const v of s.values) {
          if (v < globalMin) globalMin = v;
          if (v > globalMax) globalMax = v;
        }
      }
      if (!isFinite(globalMin)) {
        globalMin = 0;
        globalMax = 1;
      }
    }

    return series.map((s, idx) => {
      const min = this.overlaySharedY() ? globalMin : Math.min(...s.values);
      const max = this.overlaySharedY() ? globalMax : Math.max(...s.values);
      const range = max - min || 1;
      const pts = s.values
        .map((v, i) => {
          const x = (i / (s.values.length - 1)) * 320;
          const y = 80 - ((v - min) / range) * 80;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
      return {
        id: s.id,
        label: s.label,
        color: s.id === 'live' ? '#0040dd' : palette[idx % palette.length],
        points: pts,
        metrics: s.metrics,
      };
    });
  });

  /// Curves the chart actually plots — overlayCurves minus any the operator
  /// has toggled off via the legend.
  visibleCurves = computed<OverlayCurve[]>(() => {
    const hidden = this.hiddenCurves();
    return this.overlayCurves().filter((c) => !hidden.has(c.id));
  });

  /// Global min/max across visible series — surfaced as the y-axis label
  /// pair when shared-y is on so operators can tell scale at a glance.
  overlayBounds = computed<{ min: number; max: number } | null>(() => {
    const curves = this.visibleCurves();
    if (!this.overlaySharedY() || curves.length === 0) return null;
    // The polyline points are normalised; we need to recompute from raw values.
    const live = this.previewResult();
    const all: number[] = [];
    if (live?.equityCurve) all.push(...live.equityCurve);
    for (const s of this.previewSnapshots()) {
      if (!s.equityCurveJson) continue;
      try {
        const v = JSON.parse(s.equityCurveJson);
        if (Array.isArray(v)) all.push(...(v as number[]));
      } catch {
        /* skip */
      }
    }
    if (all.length === 0) return null;
    return { min: Math.min(...all), max: Math.max(...all) };
  });

  /** Toggle whether a particular curve renders in the overlay chart. */
  toggleCurveVisibility(id: string): void {
    const next = new Set(this.hiddenCurves());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.hiddenCurves.set(next);
  }

  @ViewChild('overlaySvg') overlaySvgRef?: ElementRef<SVGSVGElement>;

  /**
   * Rasterise the overlay SVG to a PNG and trigger a download. Uses the
   * standard "serialise SVG → blob URL → Image → canvas → toDataURL" pipeline
   * so no canvas-rendering library is needed. Browser-quirk-safe; works in
   * every modern Chromium / Safari.
   */
  exportOverlayPng(): void {
    const svg = this.overlaySvgRef?.nativeElement;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // 2x scale for crisp PNG on retina; 320x80 logical → 640x160 pixels.
      canvas.width = 640;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        return;
      }
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const a = document.createElement('a');
      a.download = `equity-overlay-${Date.now()}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }

  // Captured-version history for an existing strategy. Lazily loaded on
  // first expand to keep the create-modal payload light.
  showVersionHistory = signal(false);
  loadingVersions = signal(false);
  versions = signal<StrategyVersionDto[]>([]);
  rollingBack = signal(false);
  capturingVersion = signal(false);
  /// Free-text reason for the manual-snapshot button OR the next update —
  /// stored on the auto-captured pre-edit version row so operators see why
  /// the change was made.
  manualCaptureReason = signal('');
  updateChangeReason = signal('');
  /// When non-null, a snapshot row's notes editor is open for that id.
  editingNotesId = signal<number | null>(null);
  editingNotesText = signal('');
  // Currently-selected version for the diff panel. Null when no diff open.
  diffVersion = signal<StrategyVersionDto | null>(null);
  /// Field-by-field changes between the selected version and the current
  /// form state. Recomputes whenever either side changes.
  diffRows = computed<{ field: string; before: string; after: string }[]>(() => {
    const v = this.diffVersion();
    if (!v) return [];
    const fv = this.form?.value ?? {};
    const fields: [string, any, any][] = [
      ['name', v.name, fv.name],
      ['description', v.description, fv.description],
      ['parametersJson', v.parametersJson, fv.parametersJson],
      ['riskProfileId', v.riskProfileId, fv.riskProfileId],
      ['riskOverridesJson', v.riskOverridesJson, fv.riskOverridesJson],
      ['sizingConfigJson', v.sizingConfigJson, fv.sizingConfigJson],
      ['sessionFilterJson', v.sessionFilterJson, fv.sessionFilterJson],
      ['regimeGateJson', v.regimeGateJson, fv.regimeGateJson],
      ['multiTimeframeGateJson', v.multiTimeframeGateJson, fv.multiTimeframeGateJson],
    ];
    const fmt = (x: any) =>
      x == null || x === '' ? '∅' : String(x).slice(0, 80) + (String(x).length > 80 ? '…' : '');
    return fields
      .filter(([, b, a]) => (b ?? '') !== (a ?? ''))
      .map(([k, b, a]) => ({ field: k, before: fmt(b), after: fmt(a) }));
  });

  readonly strategyTypes = STRATEGY_TYPES;
  readonly timeframes = TIMEFRAMES;
  readonly timeframeLabels = TIMEFRAME_LABELS;
  readonly placeholders = SUB_CONFIG_PLACEHOLDERS;
  readonly dslExamples = DSL_EXAMPLES;

  loadDslExample(id: string): void {
    if (!id) return;
    const example = this.dslExamples.find((e) => e.id === id);
    if (!example) return;
    this.form.patchValue({
      strategyType: 'RuleBased',
      parametersJson: example.json,
    });
    this.notifications.success(`Loaded DSL example: ${example.label}`);
  }

  form!: FormGroup;

  ngOnInit(): void {
    this.form = this.fb.group({
      name: ['', Validators.required],
      symbol: ['', Validators.required],
      timeframe: ['H1'],
      strategyType: ['MovingAverageCrossover'],
      parametersJson: [''],
      riskProfileId: [null],
      description: [''],
      // Phase-1 typed sub-config fields. All optional; submitted as null when empty.
      riskOverridesJson: [''],
      sizingConfigJson: [''],
      sessionFilterJson: [''],
      regimeGateJson: [''],
      multiTimeframeGateJson: [''],
    });

    // Lazy-load template chooser the first time the modal mounts. Volume is
    // operator-curated (typically <50 templates) so a single fetch is fine.
    this.strategiesService.listTemplates().subscribe({
      next: (res) => this.availableTemplates.set(res?.data ?? []),
      error: () => this.availableTemplates.set([]),
    });

    // Hydrate server-side preview snapshots filtered to the current form
    // context so the comparison chart compares apples to apples.
    this.refreshPreviewSnapshots();

    // Mirror the symbol field into a signal so the parsedSymbols computed
    // updates as the operator types — drives the multi-symbol label and the
    // submit button's "Create N strategies" copy.
    this.form.get('symbol')?.valueChanges.subscribe((value: string) => {
      this.symbolInputValue.set(value ?? '');
    });

    // Wire the DSL summariser — debounced revalidation as operators edit JSON.
    this.form.get('parametersJson')?.valueChanges.subscribe((raw: string) => {
      const type = this.form.get('strategyType')?.value;
      if (type !== 'RuleBased' && type !== 'LlmProposal') {
        this.dslSummary.set(null);
        this.dslError.set(null);
        return;
      }
      if (!raw || raw.trim().length === 0) {
        this.dslSummary.set(null);
        this.dslError.set(null);
        return;
      }
      this.scheduleDslCheck(raw);
    });

    // Re-fetch the typed parameter schema whenever the StrategyType changes.
    // Schema is registered server-side per type; null = fall back to free-form
    // JSON textarea (existing behaviour).
    this.form.get('strategyType')?.valueChanges.subscribe((value: string) => {
      if (!value) {
        this.parameterSchema.set(null);
        return;
      }
      this.strategiesService.getParameterSchema(value).subscribe({
        next: (res) => {
          this.parameterSchema.set(res?.data ?? null);
          // Hydrate typed inputs from the current ParametersJson when possible
          // so the user doesn't lose values when switching schemas.
          const raw = this.form.get('parametersJson')?.value as string;
          if (raw) {
            try {
              this.parameterValues.set(JSON.parse(raw));
            } catch {
              this.parameterValues.set({});
            }
          } else {
            this.parameterValues.set({});
          }
        },
        error: () => this.parameterSchema.set(null),
      });
    });
    // Trigger once for the initial StrategyType.
    const initialType = this.form.get('strategyType')?.value;
    if (initialType) this.form.get('strategyType')?.setValue(initialType);
  }

  /**
   * Updates a single typed parameter and pushes the merged JSON into the
   * Parameters JSON textarea — the textarea stays the source of truth so the
   * existing submit pipeline doesn't need rewiring.
   */
  setParameter(name: string, value: unknown): void {
    const merged = { ...this.parameterValues(), [name]: value };
    this.parameterValues.set(merged);
    this.form.patchValue({ parametersJson: JSON.stringify(merged, null, 2) });
  }

  parameterValueOrDefault(field: StrategyParameterFieldDto): unknown {
    const map = this.parameterValues();
    return field.name in map ? map[field.name] : field.default;
  }

  /**
   * Debounced DSL validate-and-summarise. Triggered by ParametersJson
   * valueChanges — the 600ms wait coalesces typing bursts into a single
   * round-trip. Endpoint is pure-function so we don't have to worry about
   * server-side side-effects from the chatty calls.
   */
  private scheduleDslCheck(raw: string): void {
    if (this.dslSummaryTimer !== null) clearTimeout(this.dslSummaryTimer);
    this.dslChecking.set(true);
    this.dslSummaryTimer = setTimeout(() => {
      this.dslSummaryTimer = null;
      this.strategiesService.summariseDsl(raw).subscribe({
        next: (res) => {
          this.dslChecking.set(false);
          if (res?.status && res.data) {
            this.dslSummary.set(res.data);
            this.dslError.set(null);
          } else {
            this.dslSummary.set(null);
            this.dslError.set(res?.message ?? 'DSL invalid');
          }
        },
        error: () => {
          this.dslChecking.set(false);
          this.dslSummary.set(null);
          this.dslError.set('DSL check failed');
        },
      });
    }, 600);
  }

  /**
   * Visual-builder edit → patch the parametersJson form control with the
   * builder's serialised tree. Skips the patch if the new JSON matches the
   * current value (avoids re-triggering valueChanges → re-render → cursor jump).
   */
  onDslBuilderChange(json: string): void {
    const current = this.form.get('parametersJson')?.value as string | null;
    if (current === json) return;
    this.form.patchValue({ parametersJson: json });
  }

  /**
   * Pretty-print the Parameters JSON via the browser's built-in JSON.parse +
   * JSON.stringify roundtrip. Two-space indentation matches the placeholders
   * and DSL examples; preserves field order as-is. Reverts the edit on parse
   * error so the user keeps their (possibly unfinished) original text.
   */
  formatParametersJson(): void {
    const raw = this.form.get('parametersJson')?.value as string;
    if (!raw || !raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      this.form.patchValue({ parametersJson: JSON.stringify(parsed, null, 2) });
      this.notifications.success('Formatted');
    } catch (e) {
      this.notifications.error('JSON parse error — fix the syntax first');
    }
  }

  /**
   * Persist the current preview as a server-side snapshot so it's visible
   * across browsers and sessions. Replaces the v1 localStorage-only path
   * which lost snapshots on browser clear and capped at 3 rows.
   */
  snapshotPreview(): void {
    const r = this.previewResult();
    if (r === null || this.savingSnapshot()) return;
    const v = this.form.value;

    const req: SaveBacktestPreviewSnapshotRequest = {
      label: `${v.symbol} ${v.timeframe} ${v.strategyType} · Sharpe ${r.sharpeRatio.toFixed(2)} · DD ${r.maxDrawdownPct.toFixed(1)}%`,
      symbol: v.symbol,
      timeframe: v.timeframe,
      strategyType: v.strategyType,
      lookbackDays: this.previewLookbackDays(),
      initialBalance: r.initialBalance,
      parametersJson: v.parametersJson || null,
      riskProfileId: v.riskProfileId ?? null,
      riskOverridesJson: v.riskOverridesJson || null,
      sizingConfigJson: v.sizingConfigJson || null,
      sessionFilterJson: v.sessionFilterJson || null,
      regimeGateJson: v.regimeGateJson || null,
      multiTimeframeGateJson: v.multiTimeframeGateJson || null,
      candlesAnalyzed: r.candlesAnalyzed,
      fromUtc: r.fromUtc,
      toUtc: r.toUtc,
      finalBalance: r.finalBalance,
      totalReturn: r.totalReturn,
      totalTrades: r.totalTrades,
      winningTrades: r.winningTrades,
      losingTrades: r.losingTrades,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      maxDrawdownPct: r.maxDrawdownPct,
      sharpeRatio: r.sharpeRatio,
      expectancy: r.expectancy,
      exposurePct: r.exposurePct,
      equityCurveJson:
        r.equityCurve && r.equityCurve.length > 0 ? JSON.stringify(r.equityCurve) : null,
    };

    this.savingSnapshot.set(true);
    this.strategiesService.savePreviewSnapshot(req).subscribe({
      next: (res) => {
        this.savingSnapshot.set(false);
        if (res?.status) {
          this.notifications.success('Snapshot saved');
          this.refreshPreviewSnapshots();
        } else {
          this.notifications.error(res?.message ?? 'Failed to save snapshot');
        }
      },
      error: () => {
        this.savingSnapshot.set(false);
        this.notifications.error('Failed to save snapshot');
      },
    });
  }

  /**
   * Refresh the saved-snapshot list from the engine. Filtered to the current
   * symbol/timeframe/strategyType when {@link snapshotFilterMode} is 'matching'
   * so the overlay chart compares like-for-like; flips to unfiltered when the
   * operator wants to see snapshots from other symbols too.
   */
  refreshPreviewSnapshots(): void {
    const v = this.form?.value ?? {};
    const matching = this.snapshotFilterMode() === 'matching';
    const filter = {
      symbol: matching ? v.symbol : undefined,
      timeframe: matching ? v.timeframe : undefined,
      strategyType: matching ? v.strategyType : undefined,
      scope: this.snapshotScope(),
      limit: 50,
    };
    this.strategiesService.listPreviewSnapshots(filter).subscribe({
      next: (res) => this.previewSnapshots.set(res?.data ?? []),
      error: () => this.previewSnapshots.set([]),
    });
  }

  /** Toggle between matching-only and all-snapshots views; refetches. */
  toggleSnapshotFilter(): void {
    this.snapshotFilterMode.set(this.snapshotFilterMode() === 'matching' ? 'all' : 'matching');
    this.refreshPreviewSnapshots();
  }

  /** Toggle between own-snapshots and every-operator view; refetches. */
  toggleSnapshotScope(): void {
    this.snapshotScope.set(this.snapshotScope() === 'mine' ? 'all' : 'mine');
    this.refreshPreviewSnapshots();
  }

  /** Soft-delete a single snapshot. */
  deleteSnapshot(s: BacktestPreviewSnapshotDto): void {
    if (this.deletingSnapshotId() != null) return;
    this.deletingSnapshotId.set(s.id);
    this.strategiesService.deletePreviewSnapshot(s.id).subscribe({
      next: (res) => {
        this.deletingSnapshotId.set(null);
        if (res?.status) {
          this.previewSnapshots.update((rows) => rows.filter((r) => r.id !== s.id));
        } else {
          this.notifications.error(res?.message ?? 'Failed to delete snapshot');
        }
      },
      error: () => {
        this.deletingSnapshotId.set(null);
        this.notifications.error('Failed to delete snapshot');
      },
    });
  }

  /** Open the inline diff panel for the chosen version. */
  diffWithCurrent(v: StrategyVersionDto): void {
    this.diffVersion.set(v);
  }

  /**
   * Manually snapshot the strategy's current state. The optional reason from
   * {@link manualCaptureReason} annotates the version row so operators see
   * what the bookmark was for.
   */
  captureVersionNow(): void {
    const s = this.strategy();
    if (!s || this.capturingVersion()) return;
    this.capturingVersion.set(true);
    this.strategiesService.captureVersion(s.id, this.manualCaptureReason()).subscribe({
      next: (res) => {
        this.capturingVersion.set(false);
        if (res?.status) {
          this.notifications.success(res.message ?? 'Snapshot captured');
          this.manualCaptureReason.set('');
          this.refreshVersionHistory();
        } else {
          this.notifications.error(res?.message ?? 'Failed to capture snapshot');
        }
      },
      error: () => {
        this.capturingVersion.set(false);
        this.notifications.error('Failed to capture snapshot');
      },
    });
  }

  /** Toggle the inline notes editor for a snapshot row. */
  toggleSnapshotNotes(s: BacktestPreviewSnapshotDto): void {
    if (this.editingNotesId() === s.id) {
      this.editingNotesId.set(null);
      this.editingNotesText.set('');
    } else {
      this.editingNotesId.set(s.id);
      this.editingNotesText.set(s.notes ?? '');
    }
  }

  /** Persist the in-progress notes value to the engine. */
  saveSnapshotNotes(s: BacktestPreviewSnapshotDto): void {
    const next = this.editingNotesText().trim() || null;
    this.strategiesService.updatePreviewSnapshotNotes(s.id, next).subscribe({
      next: (res) => {
        if (res?.status) {
          // Patch the local list so the operator sees the change without
          // refetching the whole list.
          this.previewSnapshots.update((rows) =>
            rows.map((r) => (r.id === s.id ? { ...r, notes: next } : r)),
          );
          this.editingNotesId.set(null);
          this.editingNotesText.set('');
          this.notifications.success('Notes updated');
        } else {
          this.notifications.error(res?.message ?? 'Failed to update notes');
        }
      },
      error: () => this.notifications.error('Failed to update notes'),
    });
  }

  /**
   * Toggle the version-history drawer. Lazy-loads the version list on first
   * expand so the modal payload stays light when operators don't open it.
   */
  toggleVersionHistory(): void {
    const next = !this.showVersionHistory();
    this.showVersionHistory.set(next);
    if (next && this.versions().length === 0 && !this.loadingVersions()) {
      this.refreshVersionHistory();
    }
  }

  private refreshVersionHistory(): void {
    const s = this.strategy();
    if (!s) return;
    this.loadingVersions.set(true);
    this.strategiesService.getVersions(s.id, 100).subscribe({
      next: (res) => {
        this.loadingVersions.set(false);
        this.versions.set(res?.data ?? []);
      },
      error: () => {
        this.loadingVersions.set(false);
        this.versions.set([]);
        this.notifications.error('Failed to load version history');
      },
    });
  }

  /**
   * Restore the strategy to a captured version. The engine snapshots the
   * current state first, so the rollback is reversible (operators see the
   * "pre-rollback" snapshot appear in the list afterwards). After the
   * server confirms the rollback we re-fetch the strategy and patch the
   * form fields in place so the operator sees the restored values without
   * having to close and reopen the modal.
   */
  rollbackToVersion(v: StrategyVersionDto): void {
    const s = this.strategy();
    if (!s || this.rollingBack()) return;
    if (
      !confirm(
        `Roll strategy "${s.name}" back to v${v.versionNumber}? Current state will be snapshotted first so this is reversible.`,
      )
    )
      return;

    this.rollingBack.set(true);
    this.strategiesService.rollbackVersion(s.id, v.id).subscribe({
      next: (res) => {
        if (res?.status) {
          // Refetch the strategy so the form patches with the restored
          // server-side state — the rollback handler updates the row
          // in-place; we just need the new values.
          this.strategiesService.getById(s.id).subscribe({
            next: (g) => {
              this.rollingBack.set(false);
              const restored = g?.data;
              if (restored) {
                this.form.patchValue({
                  name: restored.name,
                  description: restored.description,
                  parametersJson: restored.parametersJson ?? '',
                  riskProfileId: restored.riskProfileId,
                  riskOverridesJson: restored.riskOverridesJson ?? '',
                  sizingConfigJson: restored.sizingConfigJson ?? '',
                  sessionFilterJson: restored.sessionFilterJson ?? '',
                  regimeGateJson: restored.regimeGateJson ?? '',
                  multiTimeframeGateJson: restored.multiTimeframeGateJson ?? '',
                });
              }
              this.notifications.success(res.message ?? `Rolled back to v${v.versionNumber}`);
              this.refreshVersionHistory();
            },
            error: () => {
              this.rollingBack.set(false);
              // Even if the refetch fails, the rollback itself succeeded.
              this.notifications.success(
                `Rolled back to v${v.versionNumber} (form will refresh on next open)`,
              );
              this.refreshVersionHistory();
            },
          });
        } else {
          this.rollingBack.set(false);
          this.notifications.error(res?.message ?? 'Rollback failed');
        }
      },
      error: () => {
        this.rollingBack.set(false);
        this.notifications.error('Rollback failed');
      },
    });
  }

  /**
   * Renders an equity curve as a SVG polyline points string. Y-axis is
   * inverted (SVG origin top-left) so higher equity is at the top of the
   * sparkline. Min/max scaling fits the available height.
   */
  equitySparklinePoints(curve: number[], width: number, height: number): string {
    if (!curve || curve.length === 0) return '';
    const min = Math.min(...curve);
    const max = Math.max(...curve);
    const range = max - min || 1;
    return curve
      .map((v, i) => {
        const x = (i / Math.max(curve.length - 1, 1)) * width;
        const y = height - ((v - min) / range) * height;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }

  /** Y-coordinate of the initial-balance baseline so operators see breakeven. */
  equityBaselineY(curve: number[], initial: number, height: number): number {
    if (!curve || curve.length === 0) return height;
    const min = Math.min(...curve);
    const max = Math.max(...curve);
    const range = max - min || 1;
    return height - ((initial - min) / range) * height;
  }

  /**
   * Fires a backtest preview against the current form values. Symbol is
   * required and must be a single value (multi-symbol is for save-time only).
   * The server enforces the bounds; this method only drives the loading state
   * and result display.
   */
  runBacktestPreview(): void {
    if (this.form.invalid) {
      this.notifications.error('Fix form errors before running a preview');
      return;
    }
    const v = this.form.value;
    const symbols = (v.symbol as string)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (symbols.length === 0) {
      this.notifications.error('Symbol is required');
      return;
    }
    if (symbols.length > 1) {
      this.notifications.error(
        'Preview supports a single symbol — pick one for the run, then save with the full basket.',
      );
      return;
    }

    const req: RunBacktestPreviewRequest = {
      symbol: symbols[0],
      timeframe: v.timeframe,
      strategyType: v.strategyType,
      parametersJson: v.parametersJson || '{}',
      lookbackDays: this.previewLookbackDays(),
      initialBalance: 10000,
      riskOverridesJson: v.riskOverridesJson || null,
      sizingConfigJson: v.sizingConfigJson || null,
      sessionFilterJson: v.sessionFilterJson || null,
      regimeGateJson: v.regimeGateJson || null,
      multiTimeframeGateJson: v.multiTimeframeGateJson || null,
    };

    this.runningPreview.set(true);
    this.previewError.set(null);
    this.previewResult.set(null);
    this.strategiesService.runBacktestPreview(req).subscribe({
      next: (res) => {
        this.runningPreview.set(false);
        if (res?.status && res.data) {
          this.previewResult.set(res.data);
          if (res.data.timedOut) this.previewError.set(res.data.note ?? 'Timed out');
        } else {
          this.previewError.set(res?.message ?? 'Preview failed');
        }
      },
      error: () => {
        this.runningPreview.set(false);
        this.previewError.set('Preview request failed');
      },
    });
  }

  ngOnChanges(): void {
    const s = this.strategy();
    // Reset version-history drawer when the focused strategy changes — stale
    // versions from a previously edited row would mislead the operator.
    this.showVersionHistory.set(false);
    this.versions.set([]);
    if (s && this.form) {
      this.form.patchValue({
        name: s.name,
        symbol: s.symbol,
        timeframe: s.timeframe,
        strategyType: s.strategyType,
        parametersJson: s.parametersJson ?? '',
        riskProfileId: s.riskProfileId,
        description: s.description,
        riskOverridesJson: s.riskOverridesJson ?? '',
        sizingConfigJson: s.sizingConfigJson ?? '',
        sessionFilterJson: s.sessionFilterJson ?? '',
        regimeGateJson: s.regimeGateJson ?? '',
        multiTimeframeGateJson: s.multiTimeframeGateJson ?? '',
      });
    } else if (this.form) {
      this.form.reset({
        name: '',
        symbol: '',
        timeframe: 'H1',
        strategyType: 'MovingAverageCrossover',
        parametersJson: '',
        riskProfileId: null,
        description: '',
        riskOverridesJson: '',
        sizingConfigJson: '',
        sessionFilterJson: '',
        regimeGateJson: '',
        multiTimeframeGateJson: '',
      });
      this.activeTab.set('inputs');
      this.selectedTemplateId.set(null);
    }
  }

  formatType(type: string): string {
    return type.replace(/([A-Z])/g, ' $1').trim();
  }

  /**
   * Hydrate the form from a template — does NOT touch Symbol or Name (those are
   * always strategy-specific). Operators usually load a template, then tweak the
   * symbol + give the new strategy a fresh name. Pre-filling those would be wrong.
   */
  onTemplateSelect(rawId: string): void {
    if (!rawId) {
      this.selectedTemplateId.set(null);
      return;
    }
    const id = Number(rawId);
    if (!Number.isFinite(id)) return;
    const t = this.availableTemplates().find((x) => x.id === id);
    if (!t) return;
    this.selectedTemplateId.set(id);
    this.form.patchValue({
      strategyType: t.strategyType,
      parametersJson: t.parametersJson ?? '',
      riskProfileId: t.riskProfileId,
      riskOverridesJson: t.riskOverridesJson ?? '',
      sizingConfigJson: t.sizingConfigJson ?? '',
      sessionFilterJson: t.sessionFilterJson ?? '',
      regimeGateJson: t.regimeGateJson ?? '',
      multiTimeframeGateJson: t.multiTimeframeGateJson ?? '',
      description: t.description ?? this.form.get('description')?.value,
    });
    this.notifications.success(`Loaded template: ${t.name}`);
  }

  /**
   * Persist the current form values as a reusable template. Operators are
   * prompted for the template name (via the strategy name field as default,
   * augmented with " template" so saving an "EURUSD MA Cross" strategy gives
   * "EURUSD MA Cross template").
   */
  saveAsTemplate(): void {
    if (this.form.invalid) return;
    const val = this.form.value;
    const baseName = (val.name as string)?.trim() || 'Untitled';
    const proposed = window.prompt('Template name (must be unique):', `${baseName} template`);
    if (!proposed || !proposed.trim()) return;

    const data: CreateStrategyTemplateRequest = {
      name: proposed.trim(),
      description: val.description || null,
      strategyType: val.strategyType,
      parametersJson: val.parametersJson || '{}',
      riskProfileId: val.riskProfileId || null,
      riskOverridesJson: val.riskOverridesJson || null,
      sizingConfigJson: val.sizingConfigJson || null,
      sessionFilterJson: val.sessionFilterJson || null,
      regimeGateJson: val.regimeGateJson || null,
      multiTimeframeGateJson: val.multiTimeframeGateJson || null,
    };

    this.savingTemplate.set(true);
    this.strategiesService.createTemplate(data).subscribe({
      next: (res) => {
        this.savingTemplate.set(false);
        if (res?.status) {
          this.notifications.success(`Template '${proposed}' saved`);
          // Refresh dropdown so the new template appears immediately.
          this.strategiesService.listTemplates().subscribe({
            next: (list) => this.availableTemplates.set(list?.data ?? []),
          });
        } else {
          this.notifications.error(res?.message ?? 'Failed to save template');
        }
      },
      error: () => {
        this.savingTemplate.set(false);
        this.notifications.error('Failed to save template');
      },
    });
  }

  onSubmit(): void {
    if (this.form.invalid) return;
    const val = this.form.value;
    // The Symbol field accepts comma-separated values; split here rather than
    // at submit time downstream so the parent can decide whether to fan-out
    // to N create calls or send a single one. The Strategy entity itself is
    // single-symbol — bulk create is N round-trips, parallelised.
    const symbols = (val.symbol as string)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    const data: any = {
      name: val.name,
      description: val.description || '',
      strategyType: val.strategyType,
      // For single-symbol back-compat the request still carries `symbol`. For
      // multi-symbol the parent component reads the new `symbols` field and
      // fans out one create call per symbol.
      symbol: symbols[0] ?? val.symbol,
      symbols,
      timeframe: val.timeframe,
      parametersJson: val.parametersJson || null,
      riskProfileId: val.riskProfileId || null,
      riskOverridesJson: val.riskOverridesJson || null,
      sizingConfigJson: val.sizingConfigJson || null,
      sessionFilterJson: val.sessionFilterJson || null,
      regimeGateJson: val.regimeGateJson || null,
      multiTimeframeGateJson: val.multiTimeframeGateJson || null,
      // Only meaningful for edit mode — annotates the auto-captured pre-edit
      // snapshot. Parent ignores it for create. Reset after submit.
      changeReason: this.updateChangeReason()?.trim() || null,
    };
    this.submitted.emit(data);
  }

  onCancel(): void {
    this.cancelled.emit();
  }
}
