import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';

/**
 * Visual builder for the LlmProposal / RuleBased strategy DSL.
 *
 * The DSL JSON has this shape:
 * <pre>
 * {
 *   Name, Symbol, Timeframe, Direction,
 *   EntryConditionsRoot: {
 *     Op: 'And' | 'Or' | 'Not',
 *     Children: [&lt;node&gt; ...]
 *   } | { Leaf: { Type, &lt;typeName&gt;: { ...fields } } },
 *   StopLossAtrMultiplier, TakeProfitAtrMultiplier, AtrPeriod, BaseConfidence,
 *   ExitConditionsRoot: ... // optional
 * }
 * </pre>
 *
 * The builder renders the {@link EntryConditionsRoot} tree, lets the operator
 * compose And/Or/Not branches and edit typed leaf fields, then serialises back
 * to the same JSON shape via {@link parametersJsonChange}. Leaves with shapes
 * not yet supported (MathExpression / HtfIndicatorThreshold / RegimeMatch /
 * BarsSince) are preserved verbatim and rendered as read-only "advanced" rows
 * so visual edits don't drop existing config.
 */

// Indicator names accepted by the engine's StrategyConfigParser. Kept in sync
// with the form-hint list further down strategy-form.component.ts. The hint
// texts surface as `title` tooltips on each `<option>` so operators don't
// have to memorise what each indicator measures.
const INDICATOR_HINTS: Record<string, string> = {
  Rsi: 'Relative Strength Index — momentum oscillator, 0-100; <30 oversold, >70 overbought',
  Atr: 'Average True Range — absolute volatility in price units',
  AtrRatio: 'ATR ÷ price — volatility as a percentage',
  Adx: 'Average Directional Index — trend strength, 0-100; >25 strong trend',
  Momentum: 'Momentum — close minus close N bars ago',
  Sma: 'Simple Moving Average',
  Ema: 'Exponential Moving Average — recent prices weighted heavier',
  Macd: 'MACD line — fast EMA minus slow EMA (default 12/26)',
  MacdSignal: 'MACD signal line — EMA of the MACD line',
  MacdHistogram: 'MACD histogram — MACD minus signal',
  BollingerBandWidth: 'Bollinger Band width — (upper − lower) ÷ middle',
  BollingerBandUpper: 'Upper Bollinger Band — SMA + N std-dev',
  BollingerBandLower: 'Lower Bollinger Band — SMA − N std-dev',
  StochasticK: 'Stochastic %K — fast oscillator, 0-100',
  StochasticD: 'Stochastic %D — smoothed %K',
  Cci: 'Commodity Channel Index — typical-price deviation, ±100 levels',
  Vwap: 'Volume-Weighted Average Price',
};
const INDICATORS = Object.keys(INDICATOR_HINTS) as readonly string[];

const COMPARATORS = [
  'GreaterThan',
  'LessThan',
  'Equal',
  'GreaterThanOrEqual',
  'LessThanOrEqual',
] as const;

const PRICE_VS_MA_OPS = ['GreaterThan', 'LessThan'] as const;

const CANDLE_PATTERNS = [
  'PinBar',
  'Engulfing',
  'InsideBar',
  'Doji',
  'Hammer',
  'ShootingStar',
  'Harami',
  'MorningStar',
  'EveningStar',
] as const;

// Leaf types this v2 builder edits visually. Other leaf types are preserved
// verbatim and shown as read-only "advanced" rows.
const VISUAL_LEAF_TYPES = [
  'IndicatorThreshold',
  'PriceVsMa',
  'HourWindow',
  'IndicatorComparison',
  'IndicatorCrossover',
  'IndicatorCrossunder',
  'VolumeRatio',
  'CandlePattern',
  'MathExpression',
  'HtfIndicatorThreshold',
  'RegimeMatch',
  'BarsSince',
] as const;

const HTF_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1', 'MN1'] as const;
const REGIMES = ['Trending', 'Ranging', 'Volatile', 'Quiet', 'Breakout', 'Reversal'] as const;

type DslNode = {
  /** Stable id for *ngFor tracking. Synthesised on parse, not part of the on-disk shape. */
  uid: string;
  /** Boolean op when this node is a group; null when this node wraps a leaf. */
  op: 'And' | 'Or' | 'Not' | null;
  children: DslNode[];
  /** Leaf descriptor (type + nested config object) when {@link op} is null. */
  leaf?: {
    type: string;
    config: Record<string, any>;
  };
};

@Component({
  selector: 'app-dsl-builder',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dsl-builder" tabindex="0" (keydown)="onKeyDown($event)">
      <div class="dsl-mode-toggle">
        <button
          type="button"
          class="btn btn-link"
          [class.active]="mode() === 'visual'"
          (click)="mode.set('visual')"
        >
          Visual
        </button>
        <button
          type="button"
          class="btn btn-link"
          [class.active]="mode() === 'json'"
          (click)="mode.set('json')"
        >
          JSON
        </button>
        <span class="dsl-toolbar-spacer"></span>
        <button
          type="button"
          class="btn btn-link"
          (click)="undo()"
          [disabled]="!canUndo()"
          title="Undo (Cmd/Ctrl+Z)"
        >
          ↶ Undo
        </button>
        <button
          type="button"
          class="btn btn-link"
          (click)="redo()"
          [disabled]="!canRedo()"
          title="Redo (Cmd/Ctrl+Shift+Z)"
        >
          ↷ Redo
        </button>
        @if (parseError(); as err) {
          <span class="dsl-error">⚠ {{ err }}</span>
        }
      </div>

      @if (mode() === 'visual') {
        @if (root(); as r) {
          <ng-container
            *ngTemplateOutlet="nodeTpl; context: { $implicit: r, parent: null, idx: -1, depth: 0 }"
          />
        } @else {
          <p class="muted small">No EntryConditionsRoot yet. Click "Add condition" below.</p>
        }
        <div class="dsl-toolbar">
          <button type="button" class="btn btn-secondary" (click)="addRootIfMissing()">
            @if (root() === null) {
              + Add condition group
            } @else {
              + Reset tree
            }
          </button>
        </div>
      } @else {
        <p class="muted small">
          Edit the raw JSON in the textarea below — the visual builder will pick it up next time you
          switch back.
        </p>
      }
    </div>

    <ng-template #nodeTpl let-n let-parent="parent" let-idx="idx" let-depth="depth">
      <div
        class="dsl-node"
        [class.is-group]="n.op !== null"
        [class.has-issue]="!!validateNode(n)"
        [style.margin-left.px]="depth * 12"
        [attr.draggable]="parent !== null ? 'true' : null"
        (dragstart)="parent && onDragStart(parent, idx, $event)"
        (dragover)="parent && onDragOver(parent, idx, $event)"
        (drop)="parent && onDrop(parent, idx, $event)"
        (dragend)="onDragEnd()"
      >
        @if (n.op !== null) {
          <div class="dsl-node-head">
            @if (parent !== null) {
              <span class="dsl-grip" title="Drag to reorder among siblings">⠿</span>
            }
            <select
              class="form-input dsl-op-select"
              [ngModel]="n.op"
              (ngModelChange)="setOp(n, $event)"
            >
              <option value="And">AND</option>
              <option value="Or">OR</option>
              <option value="Not">NOT</option>
            </select>
            <button type="button" class="btn btn-link" (click)="addLeafChild(n)">+ leaf</button>
            <button type="button" class="btn btn-link" (click)="addGroupChild(n)">+ group</button>
            @if (parent !== null) {
              <button
                type="button"
                class="btn btn-link danger"
                (click)="deleteNode(parent, idx)"
                title="Delete this group"
              >
                ×
              </button>
            }
            @if (validateNode(n); as issue) {
              <span class="dsl-issue" [title]="issue">⚠ {{ issue }}</span>
            }
          </div>
          <div class="dsl-children">
            @for (c of n.children; track c.uid; let i = $index) {
              <ng-container
                *ngTemplateOutlet="
                  nodeTpl;
                  context: { $implicit: c, parent: n, idx: i, depth: depth + 1 }
                "
              />
            }
            @if (n.children.length === 0) {
              <p class="muted small">Empty group — add a leaf or nested group.</p>
            }
          </div>
        } @else if (n.leaf) {
          <div class="dsl-leaf">
            @if (parent !== null) {
              <span class="dsl-grip" title="Drag to reorder among siblings">⠿</span>
            }
            <select
              class="form-input dsl-leaf-type"
              [ngModel]="n.leaf.type"
              (ngModelChange)="setLeafType(n, $event)"
            >
              @for (t of visualLeafTypes; track t) {
                <option [value]="t">{{ t }}</option>
              }
              @if (!isVisualType(n.leaf.type)) {
                <option [value]="n.leaf.type">{{ n.leaf.type }} (advanced — JSON only)</option>
              }
            </select>

            @switch (n.leaf.type) {
              @case ('IndicatorThreshold') {
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['indicator']"
                  (ngModelChange)="setLeafField(n, 'indicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="period"
                  [ngModel]="n.leaf.config['period']"
                  (ngModelChange)="setLeafField(n, 'period', +$event)"
                />
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['operator']"
                  (ngModelChange)="setLeafField(n, 'operator', $event)"
                >
                  @for (o of comparators; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  step="0.01"
                  placeholder="value"
                  [ngModel]="n.leaf.config['value']"
                  (ngModelChange)="setLeafField(n, 'value', +$event)"
                />
                <input
                  class="form-input small"
                  type="number"
                  placeholder="offset"
                  [ngModel]="n.leaf.config['offset']"
                  (ngModelChange)="setLeafField(n, 'offset', $event === '' ? null : +$event)"
                />
              }
              @case ('PriceVsMa') {
                <input
                  class="form-input small"
                  type="number"
                  placeholder="maPeriod"
                  [ngModel]="n.leaf.config['maPeriod']"
                  (ngModelChange)="setLeafField(n, 'maPeriod', +$event)"
                />
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['operator']"
                  (ngModelChange)="setLeafField(n, 'operator', $event)"
                >
                  @for (o of priceVsMaOps; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
              }
              @case ('HourWindow') {
                <input
                  class="form-input small"
                  type="number"
                  min="0"
                  max="23"
                  placeholder="startHourUtc"
                  [ngModel]="n.leaf.config['startHourUtc']"
                  (ngModelChange)="setLeafField(n, 'startHourUtc', +$event)"
                />
                <span class="muted small">→</span>
                <input
                  class="form-input small"
                  type="number"
                  min="0"
                  max="23"
                  placeholder="endHourUtc"
                  [ngModel]="n.leaf.config['endHourUtc']"
                  (ngModelChange)="setLeafField(n, 'endHourUtc', +$event)"
                />
              }
              @case ('IndicatorComparison') {
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['leftIndicator']"
                  (ngModelChange)="setLeafField(n, 'leftIndicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="L period"
                  [ngModel]="n.leaf.config['leftPeriod']"
                  (ngModelChange)="setLeafField(n, 'leftPeriod', +$event)"
                />
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['operator']"
                  (ngModelChange)="setLeafField(n, 'operator', $event)"
                >
                  @for (o of comparators; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['rightIndicator']"
                  (ngModelChange)="setLeafField(n, 'rightIndicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="R period"
                  [ngModel]="n.leaf.config['rightPeriod']"
                  (ngModelChange)="setLeafField(n, 'rightPeriod', +$event)"
                />
              }
              @case ('IndicatorCrossover') {
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['leftIndicator']"
                  (ngModelChange)="setLeafField(n, 'leftIndicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="L period"
                  [ngModel]="n.leaf.config['leftPeriod']"
                  (ngModelChange)="setLeafField(n, 'leftPeriod', +$event)"
                />
                <span class="muted small">crosses above</span>
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['rightIndicator']"
                  (ngModelChange)="setLeafField(n, 'rightIndicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="R period"
                  [ngModel]="n.leaf.config['rightPeriod']"
                  (ngModelChange)="setLeafField(n, 'rightPeriod', +$event)"
                />
              }
              @case ('IndicatorCrossunder') {
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['leftIndicator']"
                  (ngModelChange)="setLeafField(n, 'leftIndicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="L period"
                  [ngModel]="n.leaf.config['leftPeriod']"
                  (ngModelChange)="setLeafField(n, 'leftPeriod', +$event)"
                />
                <span class="muted small">crosses below</span>
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['rightIndicator']"
                  (ngModelChange)="setLeafField(n, 'rightIndicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="R period"
                  [ngModel]="n.leaf.config['rightPeriod']"
                  (ngModelChange)="setLeafField(n, 'rightPeriod', +$event)"
                />
              }
              @case ('VolumeRatio') {
                <input
                  class="form-input small"
                  type="number"
                  placeholder="lookbackBars"
                  [ngModel]="n.leaf.config['lookbackBars']"
                  (ngModelChange)="setLeafField(n, 'lookbackBars', +$event)"
                />
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['operator']"
                  (ngModelChange)="setLeafField(n, 'operator', $event)"
                >
                  @for (o of comparators; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  step="0.1"
                  placeholder="threshold"
                  [ngModel]="n.leaf.config['threshold']"
                  (ngModelChange)="setLeafField(n, 'threshold', +$event)"
                />
              }
              @case ('CandlePattern') {
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['pattern']"
                  (ngModelChange)="setLeafField(n, 'pattern', $event)"
                >
                  @for (p of candlePatterns; track p) {
                    <option [value]="p">{{ p }}</option>
                  }
                </select>
                <label class="dsl-checkbox">
                  <input
                    type="checkbox"
                    [ngModel]="n.leaf.config['bullish']"
                    (ngModelChange)="setLeafField(n, 'bullish', $event)"
                  />
                  <span>bullish</span>
                </label>
              }
              @case ('MathExpression') {
                <input
                  class="form-input"
                  style="min-width:240px;"
                  type="text"
                  placeholder="e.g. (High - Low) / Atr(14)"
                  [ngModel]="n.leaf.config['expression']"
                  (ngModelChange)="setLeafField(n, 'expression', $event)"
                />
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['operator']"
                  (ngModelChange)="setLeafField(n, 'operator', $event)"
                >
                  @for (o of comparators; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  step="0.01"
                  placeholder="threshold"
                  [ngModel]="n.leaf.config['threshold']"
                  (ngModelChange)="setLeafField(n, 'threshold', +$event)"
                />
              }
              @case ('HtfIndicatorThreshold') {
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['higherTimeframe']"
                  (ngModelChange)="setLeafField(n, 'higherTimeframe', $event)"
                >
                  @for (t of htfTimeframes; track t) {
                    <option [value]="t">{{ t }}</option>
                  }
                </select>
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['indicator']"
                  (ngModelChange)="setLeafField(n, 'indicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="period"
                  [ngModel]="n.leaf.config['period']"
                  (ngModelChange)="setLeafField(n, 'period', +$event)"
                />
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['operator']"
                  (ngModelChange)="setLeafField(n, 'operator', $event)"
                >
                  @for (o of comparators; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  step="0.01"
                  placeholder="value"
                  [ngModel]="n.leaf.config['value']"
                  (ngModelChange)="setLeafField(n, 'value', +$event)"
                />
              }
              @case ('RegimeMatch') {
                <span class="muted small">match any of:</span>
                @for (r of regimes; track r) {
                  <label class="dsl-checkbox">
                    <input
                      type="checkbox"
                      [checked]="regimeIsSelected(n, r)"
                      (change)="toggleRegime(n, r, $any($event.target).checked)"
                    />
                    <span>{{ r }}</span>
                  </label>
                }
              }
              @case ('BarsSince') {
                <span class="muted small">bars since</span>
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['indicator']"
                  (ngModelChange)="setLeafField(n, 'indicator', $event)"
                >
                  @for (i of indicators; track i) {
                    <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="period"
                  [ngModel]="n.leaf.config['period']"
                  (ngModelChange)="setLeafField(n, 'period', +$event)"
                />
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['triggerOperator']"
                  (ngModelChange)="setLeafField(n, 'triggerOperator', $event)"
                >
                  @for (o of comparators; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  step="0.01"
                  placeholder="trigger"
                  [ngModel]="n.leaf.config['triggerValue']"
                  (ngModelChange)="setLeafField(n, 'triggerValue', +$event)"
                />
                <span class="muted small">stays</span>
                <select
                  class="form-input"
                  [ngModel]="n.leaf.config['barsOperator']"
                  (ngModelChange)="setLeafField(n, 'barsOperator', $event)"
                >
                  @for (o of comparators; track o) {
                    <option [value]="o">{{ o }}</option>
                  }
                </select>
                <input
                  class="form-input small"
                  type="number"
                  placeholder="bars"
                  [ngModel]="n.leaf.config['maxBars']"
                  (ngModelChange)="setLeafField(n, 'maxBars', +$event)"
                />
              }
              @default {
                <span class="muted small">Edit "{{ n.leaf.type }}" via JSON mode (advanced).</span>
              }
            }

            <button
              type="button"
              class="btn btn-link danger"
              (click)="deleteNode(parent, idx)"
              title="Delete this leaf"
            >
              ×
            </button>
            @if (validateNode(n); as issue) {
              <span class="dsl-issue" [title]="issue">⚠ {{ issue }}</span>
            }
          </div>
        }
      </div>
    </ng-template>
  `,
  styles: [
    `
      .dsl-builder {
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 6px;
        padding: 10px 12px;
        background: var(--bg-primary, #fff);
        margin-bottom: 8px;
      }
      .dsl-mode-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        border-bottom: 1px solid var(--border-subtle, #eef0f3);
        padding-bottom: 6px;
      }
      .dsl-toolbar-spacer {
        flex: 1;
      }
      .dsl-builder {
        outline: none;
      }
      .dsl-builder:focus-visible {
        box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.25);
      }
      .dsl-mode-toggle .btn-link {
        padding: 2px 8px;
        font-size: 12px;
        border: 1px solid transparent;
        border-radius: 4px;
      }
      .dsl-mode-toggle .btn-link.active {
        background: rgba(0, 113, 227, 0.08);
        border-color: rgba(0, 113, 227, 0.3);
        color: #0040dd;
      }
      .dsl-error {
        color: #d70015;
        font-size: 12px;
        margin-left: auto;
      }
      .dsl-node {
        padding: 2px 0;
      }
      .dsl-node.is-group > .dsl-node-head {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
        font-weight: 500;
      }
      .dsl-children {
        border-left: 2px solid rgba(0, 113, 227, 0.15);
        padding-left: 6px;
      }
      .dsl-leaf {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 4px 0;
      }
      .dsl-leaf .form-input,
      .dsl-leaf .dsl-leaf-type,
      .dsl-leaf .dsl-op-select,
      .dsl-node-head .form-input {
        font-size: 11px;
        padding: 2px 6px;
        height: 24px;
      }
      .dsl-leaf .form-input.small {
        width: 80px;
      }
      .dsl-checkbox {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
      }
      .btn-link.danger {
        color: #d70015;
      }
      .dsl-toolbar {
        margin-top: 8px;
      }
      .dsl-op-select {
        width: 80px;
      }
      .dsl-leaf-type {
        min-width: 160px;
      }
      .dsl-grip {
        cursor: grab;
        color: var(--text-secondary, #8e8e93);
        font-size: 14px;
        user-select: none;
        padding: 0 2px;
      }
      .dsl-grip:active {
        cursor: grabbing;
      }
      .dsl-node[draggable='true'] {
        cursor: default;
      }
      .dsl-node.has-issue > .dsl-node-head,
      .dsl-node.has-issue > .dsl-leaf {
        background: rgba(255, 149, 0, 0.06);
        border-left: 2px solid #ff9500;
        padding-left: 4px;
        border-radius: 2px;
      }
      .dsl-issue {
        font-size: 11px;
        color: #c93400;
        margin-left: 6px;
      }
    `,
  ],
})
export class DslBuilderComponent {
  parametersJson = input<string>('');
  parametersJsonChange = output<string>();

  mode = signal<'visual' | 'json'>('visual');
  parseError = signal<string | null>(null);

  // Simple undo/redo stack at the serialised-JSON level. Cheap to copy, no
  // structural sharing needed; capped at 50 entries to bound memory.
  // The stack is *not* updated when the parent input changes — only when the
  // operator drives an edit through the visual builder.
  private historyPast: string[] = [];
  private historyFuture: string[] = [];
  canUndo = signal(false);
  canRedo = signal(false);

  // Internal mutable tree synthesised from the parsed JSON. Mutations on this
  // object trigger {@link emit} which serialises and emits via the output.
  // Using a signal so the template re-renders cleanly on edits.
  private rootSignal = signal<DslNode | null>(null);
  // Top-level scalar fields preserved verbatim — Name, Symbol, Timeframe,
  // Direction, StopLossAtrMultiplier, etc — and the original ExitConditionsRoot.
  private topLevel = signal<Record<string, any>>({});

  readonly indicators = INDICATORS;
  readonly comparators = COMPARATORS;
  readonly priceVsMaOps = PRICE_VS_MA_OPS;
  readonly candlePatterns = CANDLE_PATTERNS;
  readonly visualLeafTypes = VISUAL_LEAF_TYPES;
  readonly htfTimeframes = HTF_TIMEFRAMES;
  readonly regimes = REGIMES;

  root = computed(() => this.rootSignal());

  /// Last value we emitted upstream — used by {@link hydrate} to skip the
  /// re-parse cycle that would otherwise destroy focus and node uids on
  /// every keystroke. We still re-parse when the *parent* drives a change
  /// (DSL example dropdown, undo/redo, programmatic patch).
  private lastEmitted: string | null = null;

  /** Re-parse on every input change — operator may load an example via the
   *  parent's "Insert DSL example" dropdown, and we need to reflect that. */
  private readonly hydrate = effect(() => {
    const raw = this.parametersJson();
    if (raw === this.lastEmitted) return;
    this.parse(raw);
  });

  private parse(raw: string): void {
    if (!raw || !raw.trim()) {
      this.rootSignal.set(null);
      this.topLevel.set({});
      this.parseError.set(null);
      return;
    }
    try {
      const obj = JSON.parse(raw);
      const root = obj['EntryConditionsRoot'] ?? null;
      this.rootSignal.set(root ? toNode(root) : null);
      // Drop EntryConditionsRoot from topLevel — it's the reactive tree above.
      const { EntryConditionsRoot, ...rest } = obj;
      this.topLevel.set(rest);
      this.parseError.set(null);
    } catch (e: any) {
      this.parseError.set(e?.message ?? 'JSON parse error');
    }
  }

  private emit(skipHistory = false): void {
    const top = this.topLevel();
    const root = this.rootSignal();
    const obj: Record<string, any> = { ...top };
    if (root) obj['EntryConditionsRoot'] = fromNode(root);
    const next = JSON.stringify(obj, null, 2);
    if (!skipHistory) {
      const prev = this.parametersJson();
      // Only push real diffs; ignore no-op emits (e.g. initial hydration).
      if (prev !== next) {
        this.historyPast.push(prev);
        if (this.historyPast.length > 50) this.historyPast.shift();
        this.historyFuture = [];
        this.canUndo.set(true);
        this.canRedo.set(false);
      }
    }
    this.lastEmitted = next;
    this.parametersJsonChange.emit(next);
  }

  /** Pop the last edit off the past stack and replay onto the form. */
  undo(): void {
    if (this.historyPast.length === 0) return;
    const current = this.parametersJson();
    const prev = this.historyPast.pop()!;
    this.historyFuture.push(current);
    this.canUndo.set(this.historyPast.length > 0);
    this.canRedo.set(true);
    this.parametersJsonChange.emit(prev);
    this.parse(prev);
  }

  /** Push a previously-undone edit forward again. */
  redo(): void {
    if (this.historyFuture.length === 0) return;
    const current = this.parametersJson();
    const next = this.historyFuture.pop()!;
    this.historyPast.push(current);
    this.canUndo.set(true);
    this.canRedo.set(this.historyFuture.length > 0);
    this.parametersJsonChange.emit(next);
    this.parse(next);
  }

  /** Keyboard shortcuts on the builder root: Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z redo. */
  onKeyDown(ev: KeyboardEvent): void {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const key = ev.key.toLowerCase();
    if (key === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      this.undo();
    } else if (key === 'z' && ev.shiftKey) {
      ev.preventDefault();
      this.redo();
    } else if (key === 'y') {
      ev.preventDefault();
      this.redo();
    }
  }

  isVisualType(t: string): boolean {
    return (VISUAL_LEAF_TYPES as readonly string[]).includes(t);
  }

  /** Human-readable description for an indicator, surfaced as `<option title>`. */
  indicatorHint(i: string): string {
    return INDICATOR_HINTS[i] ?? '';
  }

  // ── Validation hints ────────────────────────────────────────────────────
  // Surface common authoring mistakes inline so operators don't save invalid
  // trees that fail at engine evaluation time. Issues are advisory: the
  // builder still serialises whatever the operator typed.

  validateNode(n: DslNode): string | null {
    if (n.op === 'And' || n.op === 'Or') {
      if (n.children.length === 0)
        return `Empty ${n.op.toUpperCase()} — add at least one child or remove this group.`;
      if (n.children.length === 1)
        return `${n.op.toUpperCase()} with one child is redundant — promote or remove.`;
    }
    if (n.op === 'Not') {
      if (n.children.length !== 1) return 'NOT must have exactly one child.';
    }
    if (n.op === null && n.leaf) {
      const c = n.leaf.config;
      switch (n.leaf.type) {
        case 'IndicatorThreshold':
          if (!c['indicator'] || c['period'] == null || c['period'] <= 0)
            return 'IndicatorThreshold needs an indicator and a positive period.';
          break;
        case 'HourWindow':
          if (c['startHourUtc'] === c['endHourUtc'])
            return "HourWindow start and end can't be the same hour.";
          break;
        case 'IndicatorComparison':
        case 'IndicatorCrossover':
        case 'IndicatorCrossunder':
          if (!c['leftIndicator'] || !c['rightIndicator']) return 'Both indicators must be set.';
          if (c['leftIndicator'] === c['rightIndicator'] && c['leftPeriod'] === c['rightPeriod'])
            return 'Comparing the same indicator+period to itself always evaluates equal.';
          break;
        case 'RegimeMatch':
          if (!Array.isArray(c['allowedRegimes']) || c['allowedRegimes'].length === 0)
            return 'RegimeMatch needs at least one allowed regime.';
          break;
      }
    }
    return null;
  }

  // ── Drag-to-reorder ─────────────────────────────────────────────────────
  // Native HTML5 drag-and-drop (no library). Limits dragging to siblings —
  // moving a node to a different parent would change the tree's logical
  // structure beyond a "reorder", which the operator can already do via
  // delete + add. Constraining to siblings keeps the gesture predictable.

  private dragSource: { parent: DslNode; idx: number } | null = null;

  onDragStart(parent: DslNode, idx: number, ev: DragEvent): void {
    this.dragSource = { parent, idx };
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      // Some browsers require setData for the drag to fire on every target.
      try {
        ev.dataTransfer.setData('text/plain', `${idx}`);
      } catch {
        /* ignore */
      }
    }
  }

  onDragOver(parent: DslNode, _idx: number, ev: DragEvent): void {
    // Only allow drops between siblings of the same parent.
    if (this.dragSource && this.dragSource.parent === parent) {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    }
  }

  onDrop(parent: DslNode, targetIdx: number, ev: DragEvent): void {
    ev.preventDefault();
    const src = this.dragSource;
    this.dragSource = null;
    if (!src || src.parent !== parent || src.idx === targetIdx) return;
    const moved = parent.children.splice(src.idx, 1)[0];
    // After splicing the source out, indices to its right shift down by one,
    // so a forward move targets `targetIdx - 1` to land on the same row;
    // a backward move targets `targetIdx` directly.
    const insertAt = src.idx < targetIdx ? targetIdx - 1 : targetIdx;
    parent.children.splice(insertAt, 0, moved);
    this.rootSignal.set({ ...this.rootSignal()! });
    this.emit();
  }

  onDragEnd(): void {
    this.dragSource = null;
  }

  // ── Tree mutations ──────────────────────────────────────────────────────

  setOp(n: DslNode, op: 'And' | 'Or' | 'Not'): void {
    n.op = op;
    this.emit();
  }

  addLeafChild(n: DslNode): void {
    n.children.push({
      uid: nextUid(),
      op: null,
      children: [],
      leaf: {
        type: 'IndicatorThreshold',
        config: { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 },
      },
    });
    this.rootSignal.set({ ...this.rootSignal()! });
    this.emit();
  }

  addGroupChild(n: DslNode): void {
    n.children.push({ uid: nextUid(), op: 'And', children: [] });
    this.rootSignal.set({ ...this.rootSignal()! });
    this.emit();
  }

  /** Boots a fresh root group when the doc has no EntryConditionsRoot yet. */
  addRootIfMissing(): void {
    if (this.rootSignal() === null) {
      this.rootSignal.set({ uid: nextUid(), op: 'And', children: [] });
    } else {
      // "Reset tree" path — start over fresh. Confirm to avoid accidental wipes.
      if (!confirm('Reset the condition tree? Existing structure will be discarded.')) return;
      this.rootSignal.set({ uid: nextUid(), op: 'And', children: [] });
    }
    this.emit();
  }

  deleteNode(parent: DslNode | null, idx: number): void {
    if (parent === null) {
      // Deleting the root.
      this.rootSignal.set(null);
      this.emit();
      return;
    }
    parent.children.splice(idx, 1);
    this.rootSignal.set({ ...this.rootSignal()! });
    this.emit();
  }

  setLeafType(n: DslNode, newType: string): void {
    if (!n.leaf) return;
    n.leaf.type = newType;
    n.leaf.config = defaultsForLeafType(newType);
    this.emit();
  }

  setLeafField(n: DslNode, field: string, value: any): void {
    if (!n.leaf) return;
    if (value === null || (typeof value === 'number' && Number.isNaN(value))) {
      delete n.leaf.config[field];
    } else {
      n.leaf.config[field] = value;
    }
    this.emit();
  }

  /** RegimeMatch stores `allowedRegimes: string[]`. The checkbox UI maps over
   *  the canonical regime list and toggles membership in that array. */
  regimeIsSelected(n: DslNode, regime: string): boolean {
    const arr = n.leaf?.config['allowedRegimes'];
    return Array.isArray(arr) && arr.includes(regime);
  }

  toggleRegime(n: DslNode, regime: string, on: boolean): void {
    if (!n.leaf) return;
    const cur: string[] = Array.isArray(n.leaf.config['allowedRegimes'])
      ? [...n.leaf.config['allowedRegimes']]
      : [];
    const idx = cur.indexOf(regime);
    if (on && idx === -1) cur.push(regime);
    else if (!on && idx !== -1) cur.splice(idx, 1);
    n.leaf.config['allowedRegimes'] = cur;
    this.emit();
  }
}

// ── Tree (de)serialisation ────────────────────────────────────────────────

let uidCounter = 0;
function nextUid(): string {
  return `n${++uidCounter}`;
}

function toNode(raw: any): DslNode {
  if (raw && typeof raw === 'object' && 'Op' in raw && Array.isArray(raw['Children'])) {
    return {
      uid: nextUid(),
      op: raw['Op'] as 'And' | 'Or' | 'Not',
      children: raw['Children'].map((c: any) => toNode(c)),
    };
  }
  if (raw && typeof raw === 'object' && 'Leaf' in raw && raw['Leaf']) {
    const leaf = raw['Leaf'];
    const type = leaf['Type'];
    // Leaf fields live under a property whose name is the camelCased Type.
    // E.g. Type='IndicatorThreshold' → property 'indicatorThreshold'.
    const cfgKey = type.charAt(0).toLowerCase() + type.slice(1);
    return {
      uid: nextUid(),
      op: null,
      children: [],
      leaf: { type, config: { ...(leaf[cfgKey] ?? {}) } },
    };
  }
  // Fallback: treat unknown shape as an empty AND group.
  return { uid: nextUid(), op: 'And', children: [] };
}

function fromNode(n: DslNode): any {
  if (n.op !== null) {
    return { Op: n.op, Children: n.children.map(fromNode) };
  }
  if (n.leaf) {
    const cfgKey = n.leaf.type.charAt(0).toLowerCase() + n.leaf.type.slice(1);
    return { Leaf: { Type: n.leaf.type, [cfgKey]: { ...n.leaf.config } } };
  }
  return { Op: 'And', Children: [] };
}

function defaultsForLeafType(type: string): Record<string, any> {
  switch (type) {
    case 'IndicatorThreshold':
      return { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 };
    case 'PriceVsMa':
      return { maPeriod: 200, operator: 'GreaterThan' };
    case 'HourWindow':
      return { startHourUtc: 8, endHourUtc: 16 };
    case 'IndicatorComparison':
      return {
        leftIndicator: 'Ema',
        leftPeriod: 20,
        rightIndicator: 'Ema',
        rightPeriod: 50,
        operator: 'GreaterThan',
      };
    case 'IndicatorCrossover':
      return { leftIndicator: 'Ema', leftPeriod: 20, rightIndicator: 'Ema', rightPeriod: 50 };
    case 'IndicatorCrossunder':
      return { leftIndicator: 'Ema', leftPeriod: 20, rightIndicator: 'Ema', rightPeriod: 50 };
    case 'VolumeRatio':
      return { lookbackBars: 20, operator: 'GreaterThan', threshold: 1.5 };
    case 'CandlePattern':
      return { pattern: 'PinBar', bullish: true };
    case 'MathExpression':
      return { expression: '(High - Low) / Atr(14)', operator: 'GreaterThan', threshold: 1.5 };
    case 'HtfIndicatorThreshold':
      return {
        higherTimeframe: 'D1',
        indicator: 'Ema',
        period: 200,
        operator: 'GreaterThan',
        value: 0,
      };
    case 'RegimeMatch':
      return { allowedRegimes: ['Trending'] };
    case 'BarsSince':
      return {
        indicator: 'Rsi',
        period: 14,
        triggerOperator: 'LessThan',
        triggerValue: 30,
        barsOperator: 'LessThanOrEqual',
        maxBars: 5,
      };
    default:
      return {};
  }
}
