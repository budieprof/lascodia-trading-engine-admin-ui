import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';

import {
  BARS_SINCE_INNER_TYPES,
  CANDLE_PATTERNS,
  COMPARATORS,
  CONDITION_TYPES,
  CURRENT_DSL_VERSION,
  DIRECTIONS,
  DslCondition,
  DslDoc,
  DslIssue,
  DslNode,
  INDICATOR_KINDS,
  INDICATOR_PARAMS,
  IndicatorParamKey,
  MARKET_REGIMES,
  PRICE_SOURCES,
  RANGE_MODES,
  conditionTypeInfo,
  effectiveDslVersion,
  emitDsl,
  higherTimeframes,
  indexIssues,
  indicatorInfo,
  newCondition,
  newDoc,
  newGroupNode,
  newLeafNode,
  parseDsl,
  relevantParamKeys,
  upgradeDocToV2,
  validateDsl,
} from '../../dsl/dsl-model';

type TreeKey = 'entry' | 'exit';

/**
 * Visual editor for the RuleBased / LlmProposal strategy DSL.
 *
 * Edits the whole document, not just the entry tree: the entry and exit
 * condition trees (And/Or/Not groups over any of the 14 condition types,
 * including a BarsSince whose inner condition is edited in place), the
 * direction, the ATR stop/target multiples, the ATR period, the base
 * confidence and the math version. Serialises back to canonical camelCase
 * through `dsl-model`, which also guarantees that nothing it does not
 * understand is dropped.
 *
 * Issues (engine paths) are attached to the node they point at. The parent
 * passes the engine's verdict via `issues`; without it the builder shows its
 * own client-side checks.
 */
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
      </div>

      @if (mode() === 'visual') {
        @if (parseError(); as err) {
          <p class="dsl-parse-error">
            ⚠ {{ err }} — fix the JSON below to keep editing visually. Nothing is rewritten while it
            does not parse.
          </p>
        } @else if (doc(); as d) {
          <section class="dsl-section dsl-settings">
            <div class="dsl-section-head">
              <span class="dsl-section-title">Rule settings</span>
              <span
                class="dsl-rule-id muted"
                [title]="'The DSL names ' + (d.fields['symbol'] ?? '?')"
              >
                {{ d.fields['name'] || '(unnamed)' }} · {{ d.fields['symbol'] || '—' }} ·
                {{ d.fields['timeframe'] || '—' }}
              </span>
            </div>

            <div class="dsl-version-row">
              @if (version() >= 2) {
                <span class="dsl-badge v2" title="dslVersion 2 — TradingView-exact indicator math"
                  >Pine-exact math (v2)</span
                >
              } @else {
                <span class="dsl-badge v1">
                  Legacy math (v1){{ hasExplicitVersion() ? '' : ' — no dslVersion set' }}
                </span>
                @if (canUpgrade()) {
                  <button type="button" class="btn btn-link" (click)="upgradeRequested.emit()">
                    Upgrade to Pine-exact math (v2)…
                  </button>
                } @else if (isNew()) {
                  <button
                    type="button"
                    class="btn btn-link"
                    (click)="useV2()"
                    title="Set dslVersion 2; Spread conditions become BarRange so they keep measuring the bar range"
                  >
                    Use Pine-exact math (v2)
                  </button>
                  @if (!hasExplicitVersion()) {
                    <span class="muted small">New strategies are created on v2.</span>
                  }
                }
              }
              @if (notice(); as msg) {
                <span class="dsl-notice">{{ msg }}</span>
              }
            </div>

            <div class="dsl-settings-grid">
              <label class="dsl-field" [class.has-error]="topSeverity('direction') === 'error'">
                <span>Direction</span>
                <select
                  class="form-input"
                  [ngModel]="d.fields['direction']"
                  (ngModelChange)="setTopField('direction', $event)"
                >
                  @for (dir of directions; track dir) {
                    <option [value]="dir">{{ dir }}</option>
                  }
                  @if (d.fields['direction'] && !isKnown(directions, d.fields['direction'])) {
                    <option [value]="d.fields['direction']">
                      {{ d.fields['direction'] }} (unknown)
                    </option>
                  }
                </select>
              </label>
              <label
                class="dsl-field"
                [class.has-error]="topSeverity('stopLossAtrMultiplier') === 'error'"
              >
                <span>Stop loss × ATR</span>
                <input
                  class="form-input"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="10"
                  [ngModel]="d.fields['stopLossAtrMultiplier']"
                  (ngModelChange)="setTopField('stopLossAtrMultiplier', $event)"
                />
              </label>
              <label
                class="dsl-field"
                [class.has-error]="topSeverity('takeProfitAtrMultiplier') === 'error'"
              >
                <span>Take profit × ATR</span>
                <input
                  class="form-input"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="10"
                  [ngModel]="d.fields['takeProfitAtrMultiplier']"
                  (ngModelChange)="setTopField('takeProfitAtrMultiplier', $event)"
                />
              </label>
              <label class="dsl-field" [class.has-error]="topSeverity('atrPeriod') === 'error'">
                <span>ATR period</span>
                <input
                  class="form-input"
                  type="number"
                  step="1"
                  min="2"
                  max="500"
                  placeholder="14"
                  [ngModel]="d.fields['atrPeriod']"
                  (ngModelChange)="setTopField('atrPeriod', $event)"
                />
              </label>
              <label
                class="dsl-field"
                [class.has-warning]="topSeverity('baseConfidence') !== null"
                title="Starting confidence of every signal this rule emits, 0–1"
              >
                <span>Base confidence</span>
                <input
                  class="form-input"
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  placeholder="0.5"
                  [ngModel]="d.fields['baseConfidence']"
                  (ngModelChange)="setTopField('baseConfidence', $event)"
                />
              </label>
            </div>

            @if (topLevelIssues().length > 0) {
              <ul class="dsl-issues">
                @for (i of topLevelIssues(); track $index) {
                  <li [class.warning]="i.severity === 'warning'">{{ i.message }}</li>
                }
              </ul>
              @if (canFillFromStrategy()) {
                <button type="button" class="btn btn-link" (click)="fillFromStrategy()">
                  Use the strategy's name / symbol / timeframe
                </button>
              }
            }
          </section>

          @for (tree of trees; track tree) {
            <section class="dsl-section">
              <div class="dsl-section-head">
                <span class="dsl-section-title">
                  {{ tree === 'entry' ? 'Entry conditions' : 'Exit conditions' }}
                </span>
                @if (tree === 'exit') {
                  <span class="muted small">
                    optional — closes this strategy's open position when true; SL/TP still apply
                  </span>
                }
                <span class="dsl-toolbar-spacer"></span>
                <button type="button" class="btn btn-link" (click)="addToTree(tree)">
                  + condition
                </button>
                @if (rootOf(tree)) {
                  <button
                    type="button"
                    class="btn btn-link danger"
                    (click)="clearTree(tree)"
                    [title]="'Remove every ' + tree + ' condition'"
                  >
                    Clear
                  </button>
                }
              </div>
              @if (rootOf(tree); as r) {
                <ng-container
                  *ngTemplateOutlet="
                    nodeTpl;
                    context: { $implicit: r, parent: null, idx: -1, depth: 0, tree: tree }
                  "
                />
              } @else {
                <p class="muted small dsl-empty">
                  @if (tree === 'entry') {
                    No entry conditions — the engine rejects a rule without them.
                  } @else {
                    No exit conditions — positions close on stop loss / take profit.
                  }
                </p>
              }
            </section>
          }
        } @else {
          <div class="dsl-empty-doc">
            <p class="muted small">No rules yet.</p>
            <button type="button" class="btn btn-secondary" (click)="startNewDoc()">
              Start a new rule (Pine-exact math)
            </button>
          </div>
        }
      } @else {
        <p class="muted small">
          Edit the raw JSON below — the visual builder picks it up when you switch back. Keys may be
          in any casing; the builder writes camelCase.
        </p>
      }
    </div>

    <!-- ── One tree node (group, leaf or unrecognised) ─────────────────── -->
    <ng-template #nodeTpl let-n let-parent="parent" let-idx="idx" let-depth="depth" let-tree="tree">
      <div
        class="dsl-node"
        [class.is-group]="n.op !== null"
        [class.has-error]="nodeSeverity(n) === 'error'"
        [class.has-warning]="nodeSeverity(n) === 'warning'"
        [style.margin-left.px]="depth === 0 ? 0 : 12"
        [attr.data-path-uid]="n.uid"
        [attr.draggable]="parent !== null ? 'true' : null"
        (dragstart)="parent && onDragStart(parent, idx, $event)"
        (dragover)="parent && onDragOver(parent, idx, $event)"
        (drop)="parent && onDrop(parent, idx, $event)"
        (dragend)="onDragEnd()"
      >
        @if (n.raw !== undefined) {
          <div class="dsl-leaf">
            <span class="dsl-raw" [title]="rawPreview(n.raw, 2000)"
              >Unrecognised node {{ rawPreview(n.raw, 80) }} — edit it in JSON</span
            >
            <button
              type="button"
              class="btn btn-link danger"
              (click)="deleteNode(tree, parent, idx)"
              title="Delete this node"
            >
              ×
            </button>
          </div>
        } @else if (n.op !== null) {
          <div class="dsl-node-head">
            @if (parent !== null) {
              <span class="dsl-grip" title="Drag to reorder among siblings">⠿</span>
            }
            <select
              class="form-input dsl-op-select"
              [ngModel]="n.op"
              (ngModelChange)="setOp(n, $event)"
              title="AND: all must hold · OR: any · NOT: the one condition must not hold"
            >
              <option value="And">AND</option>
              <option value="Or">OR</option>
              <option value="Not">NOT</option>
              @if (!isKnown(logicOps, n.op)) {
                <option [value]="n.op">{{ n.op }} (unknown)</option>
              }
            </select>
            <button type="button" class="btn btn-link" (click)="addLeafChild(n)">
              + condition
            </button>
            <button type="button" class="btn btn-link" (click)="addGroupChild(n)">+ group</button>
            @if (n.children.length === 1) {
              <button
                type="button"
                class="btn btn-link"
                (click)="unwrapGroup(tree, parent, idx, n)"
                title="Replace this group with its only condition"
              >
                unwrap
              </button>
            }
            <button
              type="button"
              class="btn btn-link danger"
              (click)="deleteNode(tree, parent, idx)"
              title="Delete this group and everything in it"
            >
              ×
            </button>
          </div>
          <ng-container *ngTemplateOutlet="issuesTpl; context: { $implicit: n }" />
          <div class="dsl-children">
            @for (c of n.children; track c.uid; let i = $index) {
              <ng-container
                *ngTemplateOutlet="
                  nodeTpl;
                  context: { $implicit: c, parent: n, idx: i, depth: depth + 1, tree: tree }
                "
              />
            }
            @if (n.children.length === 0) {
              <p class="muted small">Empty group — add a condition or a nested group.</p>
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
              [title]="typeDescription(n.leaf.type)"
            >
              @for (t of conditionTypes; track t.type) {
                <option [value]="t.type" [title]="t.description">{{ t.label }}</option>
              }
              @if (!isKnownType(n.leaf.type)) {
                <option [value]="n.leaf.type">{{ n.leaf.type || '(no type)' }} — JSON only</option>
              }
            </select>
            <ng-container *ngTemplateOutlet="condTpl; context: { $implicit: n.leaf }" />
            <span class="dsl-leaf-actions">
              <button
                type="button"
                class="btn btn-link"
                (click)="wrapInGroup(tree, parent, idx, n)"
                title="Wrap this condition in an AND group with a new condition"
              >
                ⊕ AND
              </button>
              <button
                type="button"
                class="btn btn-link danger"
                (click)="deleteNode(tree, parent, idx)"
                title="Delete this condition"
              >
                ×
              </button>
            </span>
          </div>
          <ng-container *ngTemplateOutlet="issuesTpl; context: { $implicit: n }" />
        }
      </div>
    </ng-template>

    <!-- ── Issues attached to a node ────────────────────────────────────── -->
    <ng-template #issuesTpl let-n>
      @if (nodeIssues(n).length > 0) {
        <ul class="dsl-issues">
          @for (i of nodeIssues(n); track $index) {
            <li [class.warning]="i.severity === 'warning'" [title]="i.path">{{ i.message }}</li>
          }
        </ul>
      }
    </ng-template>

    <!-- ── The fields of one condition (also used for a BarsSince inner) ── -->
    <ng-template #condTpl let-c>
      @switch (c.type) {
        @case ('IndicatorThreshold') {
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'indicator', period: 'period' }
            "
          />
          <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
          <input
            class="form-input num"
            type="number"
            step="any"
            placeholder="value"
            title="value"
            [ngModel]="c.config['value']"
            (ngModelChange)="setField(c, 'value', $event)"
          />
          <input
            class="form-input num"
            type="number"
            min="0"
            max="500"
            placeholder="0"
            title="Bars ago (offset): 0 = the last closed bar"
            [ngModel]="c.config['offset']"
            (ngModelChange)="setField(c, 'offset', $event)"
          />
          <span class="muted small">bars ago</span>
          <ng-container *ngTemplateOutlet="paramsTpl; context: { $implicit: c }" />
        }
        @case ('HtfIndicatorThreshold') {
          <select
            class="form-input"
            [ngModel]="c.config['higherTimeframe']"
            (ngModelChange)="setField(c, 'higherTimeframe', $event)"
            title="Higher timeframe — must be above the strategy's own"
          >
            @for (tf of htfOptions(); track tf) {
              <option [value]="tf">{{ tf }}</option>
            }
            @if (
              c.config['higherTimeframe'] && !isKnown(htfOptions(), c.config['higherTimeframe'])
            ) {
              <option [value]="c.config['higherTimeframe']">
                {{ c.config['higherTimeframe'] }} (not higher than {{ timeframe() }})
              </option>
            }
          </select>
          @if (htfOptions().length === 0) {
            <span class="dsl-inline-error"
              >no engine timeframe is higher than {{ timeframe() }}</span
            >
          }
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'indicator', period: 'period' }
            "
          />
          <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
          <input
            class="form-input num"
            type="number"
            step="any"
            placeholder="value"
            title="value"
            [ngModel]="c.config['value']"
            (ngModelChange)="setField(c, 'value', $event)"
          />
          <ng-container *ngTemplateOutlet="paramsTpl; context: { $implicit: c }" />
        }
        @case ('PriceVsMa') {
          <span class="muted small">close</span>
          <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
          <span class="muted small">SMA</span>
          <input
            class="form-input num"
            type="number"
            min="2"
            max="500"
            placeholder="period"
            title="SMA period"
            [ngModel]="c.config['maPeriod']"
            (ngModelChange)="setField(c, 'maPeriod', $event)"
          />
        }
        @case ('RegimeMatch') {
          <span class="muted small">regime is any of</span>
          @for (r of regimeOptions(c); track r) {
            <label class="dsl-checkbox" [class.unknown]="!isKnown(regimes, r)">
              <input
                type="checkbox"
                [checked]="regimeIsSelected(c, r)"
                (change)="toggleRegime(c, r, $any($event.target).checked)"
              />
              <span>{{ r }}{{ isKnown(regimes, r) ? '' : ' (unknown)' }}</span>
            </label>
          }
        }
        @case ('HourWindow') {
          <span class="muted small">UTC hour from</span>
          <input
            class="form-input num"
            type="number"
            min="0"
            max="23"
            title="start hour (UTC, inclusive)"
            [ngModel]="c.config['startHourUtc']"
            (ngModelChange)="setField(c, 'startHourUtc', $event)"
          />
          <span class="muted small">to</span>
          <input
            class="form-input num"
            type="number"
            min="0"
            max="23"
            title="end hour (UTC, exclusive; wraps past midnight)"
            [ngModel]="c.config['endHourUtc']"
            (ngModelChange)="setField(c, 'endHourUtc', $event)"
          />
        }
        @case ('IndicatorComparison') {
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'leftIndicator', period: 'leftPeriod' }
            "
          />
          <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'rightIndicator', period: 'rightPeriod' }
            "
          />
          <input
            class="form-input num"
            type="number"
            min="0"
            max="500"
            placeholder="0"
            title="Bars ago (offset): 0 = the last closed bar"
            [ngModel]="c.config['offset']"
            (ngModelChange)="setField(c, 'offset', $event)"
          />
          <span class="muted small">bars ago</span>
          <ng-container *ngTemplateOutlet="paramsTpl; context: { $implicit: c }" />
        }
        @case ('IndicatorCrossover') {
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'leftIndicator', period: 'leftPeriod' }
            "
          />
          <span class="muted small">crosses above</span>
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'rightIndicator', period: 'rightPeriod' }
            "
          />
          <ng-container *ngTemplateOutlet="paramsTpl; context: { $implicit: c }" />
        }
        @case ('IndicatorCrossunder') {
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'leftIndicator', period: 'leftPeriod' }
            "
          />
          <span class="muted small">crosses below</span>
          <ng-container
            *ngTemplateOutlet="
              indTpl;
              context: { $implicit: c, kind: 'rightIndicator', period: 'rightPeriod' }
            "
          />
          <ng-container *ngTemplateOutlet="paramsTpl; context: { $implicit: c }" />
        }
        @case ('VolumeRatio') {
          <span class="muted small">volume ÷ average of last</span>
          <input
            class="form-input num"
            type="number"
            min="2"
            max="500"
            title="lookback bars"
            [ngModel]="c.config['lookbackBars']"
            (ngModelChange)="setField(c, 'lookbackBars', $event)"
          />
          <span class="muted small">bars</span>
          <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
          <input
            class="form-input num"
            type="number"
            step="0.1"
            min="0"
            title="ratio threshold"
            [ngModel]="c.config['threshold']"
            (ngModelChange)="setField(c, 'threshold', $event)"
          />
        }
        @case ('BarsSince') {
          <span class="muted small">bars since</span>
          <span class="dsl-inner">
            @if (innerOf(c); as inner) {
              <select
                class="form-input dsl-leaf-type"
                [ngModel]="inner.type"
                (ngModelChange)="setInnerType(c, $event)"
                title="The condition to look back for (any type but BarsSince)"
              >
                @for (t of innerTypes; track t) {
                  <option [value]="t">{{ typeLabel(t) }}</option>
                }
                @if (!isKnown(innerTypes, inner.type)) {
                  <option [value]="inner.type">
                    {{ inner.type || '(no type)' }} — invalid here
                  </option>
                }
              </select>
              <ng-container *ngTemplateOutlet="condTpl; context: { $implicit: inner }" />
            } @else {
              <button
                type="button"
                class="btn btn-link"
                (click)="setInnerType(c, 'IndicatorThreshold')"
              >
                + inner condition
              </button>
            }
          </span>
          <span class="muted small">was last true</span>
          <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
          <input
            class="form-input num"
            type="number"
            min="0"
            title="bar count"
            [ngModel]="c.config['value']"
            (ngModelChange)="setField(c, 'value', $event)"
          />
          <span class="muted small">bars ago, scanning up to</span>
          <input
            class="form-input num"
            type="number"
            min="1"
            max="500"
            title="max lookback (bars scanned)"
            [ngModel]="c.config['maxLookback']"
            (ngModelChange)="setField(c, 'maxLookback', $event)"
          />
          <span class="muted small">bars</span>
        }
        @case ('Spread') {
          <span class="muted small" [title]="spreadHint()">{{
            version() >= 2 ? 'bid/ask spread' : 'spread (v1: bar high − low)'
          }}</span>
          <ng-container *ngTemplateOutlet="rangeTpl; context: { $implicit: c }" />
        }
        @case ('BarRange') {
          <span class="muted small">bar range (high − low)</span>
          <ng-container *ngTemplateOutlet="rangeTpl; context: { $implicit: c }" />
        }
        @case ('CandlePattern') {
          <select
            class="form-input"
            [ngModel]="c.config['pattern']"
            (ngModelChange)="setField(c, 'pattern', $event)"
          >
            @for (p of candlePatterns; track p) {
              <option [value]="p">{{ p }}</option>
            }
            @if (c.config['pattern'] && !isKnown(candlePatterns, c.config['pattern'])) {
              <option [value]="c.config['pattern']">{{ c.config['pattern'] }} (unknown)</option>
            }
          </select>
          <select
            class="form-input"
            [ngModel]="bullishValue(c)"
            (ngModelChange)="setBullish(c, $event)"
            title="Which direction of the pattern counts"
          >
            <option value="either">either direction</option>
            <option value="bullish">bullish</option>
            <option value="bearish">bearish</option>
          </select>
        }
        @case ('MathExpression') {
          <input
            class="form-input dsl-expr"
            type="text"
            placeholder="e.g. (High - Low) / Atr(14)"
            title="Numbers, + - * /, parentheses, Open/High/Low/Close and indicator calls like Rsi(14)"
            [ngModel]="c.config['expression']"
            (ngModelChange)="setField(c, 'expression', $event)"
          />
          <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
          <input
            class="form-input num"
            type="number"
            step="any"
            title="threshold"
            [ngModel]="c.config['threshold']"
            (ngModelChange)="setField(c, 'threshold', $event)"
          />
        }
        @default {
          <span class="dsl-raw" [title]="rawPreview(c.config, 2000)">
            {{ c.type || 'Untyped condition' }} {{ rawPreview(c.config, 60) }} — edit in JSON; kept
            unchanged
          </span>
        }
      }
    </ng-template>

    <!-- ── Indicator + period pair ─────────────────────────────────────── -->
    <ng-template #indTpl let-c let-kind="kind" let-period="period">
      <select
        class="form-input dsl-ind"
        [ngModel]="c.config[kind]"
        (ngModelChange)="setField(c, kind, $event)"
        [title]="indicatorHint(c.config[kind])"
      >
        @for (i of indicatorKinds; track i) {
          <option [value]="i" [title]="indicatorHint(i)">{{ i }}</option>
        }
        @if (c.config[kind] && !isKnown(indicatorKinds, c.config[kind])) {
          <option [value]="c.config[kind]">{{ c.config[kind] }} (unknown)</option>
        }
      </select>
      <input
        class="form-input num"
        type="number"
        min="2"
        max="500"
        placeholder="period"
        title="period"
        [ngModel]="c.config[period]"
        (ngModelChange)="setField(c, period, $event)"
      />
    </ng-template>

    <!-- ── Comparison operator ─────────────────────────────────────────── -->
    <ng-template #opTpl let-c>
      <select
        class="form-input dsl-op"
        [ngModel]="c.config['operator']"
        (ngModelChange)="setField(c, 'operator', $event)"
        [title]="operatorLabel(c.config['operator'])"
      >
        @for (o of comparators; track o.value) {
          <option [value]="o.value" [title]="o.label">{{ o.symbol }}</option>
        }
        @if (c.config['operator'] && !isKnown(comparatorValues, c.config['operator'])) {
          <option [value]="c.config['operator']">{{ c.config['operator'] }} (unknown)</option>
        }
      </select>
    </ng-template>

    <!-- ── Spread / BarRange threshold + mode ──────────────────────────── -->
    <ng-template #rangeTpl let-c>
      <ng-container *ngTemplateOutlet="opTpl; context: { $implicit: c }" />
      <input
        class="form-input num"
        type="number"
        step="any"
        min="0"
        title="threshold"
        [ngModel]="c.config['threshold']"
        (ngModelChange)="setField(c, 'threshold', $event)"
      />
      <select
        class="form-input"
        [ngModel]="c.config['mode'] ?? 'Pips'"
        (ngModelChange)="setField(c, 'mode', $event)"
      >
        <option value="Pips">pips</option>
        <option value="AtrFraction">× ATR</option>
        @if (c.config['mode'] && !isKnown(rangeModes, c.config['mode'])) {
          <option [value]="c.config['mode']">{{ c.config['mode'] }} (unknown)</option>
        }
      </select>
      @if (c.config['mode'] === 'AtrFraction') {
        <span class="muted small">ATR period</span>
        <input
          class="form-input num"
          type="number"
          min="2"
          max="500"
          placeholder="14"
          title="ATR period"
          [ngModel]="c.config['atrPeriod']"
          (ngModelChange)="setField(c, 'atrPeriod', $event)"
        />
      }
    </ng-template>

    <!-- ── Optional indicator params (only those that matter) ───────────── -->
    <ng-template #paramsTpl let-c>
      @if (paramKeys(c).length > 0 && (version() >= 2 || hasParams(c))) {
        <button
          type="button"
          class="btn btn-link dsl-params-toggle"
          (click)="toggleParams(c)"
          [title]="'Indicator settings: ' + paramKeys(c).join(', ')"
        >
          ⚙ {{ paramsOpen(c) ? 'hide' : 'params' }}{{ hasParams(c) ? ' •' : '' }}
        </button>
      }
      @if (paramsOpen(c)) {
        <span class="dsl-params">
          @if (isTwoSided(c)) {
            <span class="muted small">applies to both indicators ·</span>
          }
          @for (p of paramFields(c); track p.key) {
            <label class="dsl-param" [class.irrelevant]="!paramKeys(c).includes(p.key)">
              <span>{{ p.label }}</span>
              @if (p.kind === 'source') {
                <select
                  class="form-input"
                  [ngModel]="paramValue(c, p.key) ?? ''"
                  (ngModelChange)="setParam(c, p.key, $event)"
                >
                  <option value="">default</option>
                  @for (s of priceSources; track s) {
                    <option [value]="s">{{ s }}</option>
                  }
                </select>
              } @else {
                <input
                  class="form-input num"
                  type="number"
                  [step]="p.kind === 'int' ? 1 : 0.1"
                  min="0"
                  placeholder="default"
                  [ngModel]="paramValue(c, p.key)"
                  (ngModelChange)="setParam(c, p.key, $event)"
                />
              }
            </label>
          }
        </span>
      }
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
        outline: none;
      }
      .dsl-builder:focus-visible {
        box-shadow: 0 0 0 2px rgba(0, 113, 227, 0.25);
      }
      .dsl-mode-toggle,
      .dsl-section-head,
      .dsl-version-row {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .dsl-mode-toggle {
        margin-bottom: 8px;
        border-bottom: 1px solid var(--border-subtle, #eef0f3);
        padding-bottom: 6px;
      }
      .dsl-toolbar-spacer {
        flex: 1;
      }
      .btn-link {
        padding: 2px 6px;
        font-size: 12px;
        border: 1px solid transparent;
        border-radius: 4px;
        background: transparent;
        cursor: pointer;
        color: var(--accent, #0071e3);
      }
      .btn-link:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .dsl-mode-toggle .btn-link.active {
        background: rgba(0, 113, 227, 0.08);
        border-color: rgba(0, 113, 227, 0.3);
      }
      .btn-link.danger {
        color: var(--loss, #d70015);
      }
      .dsl-section {
        border-top: 1px solid var(--border-subtle, #eef0f3);
        padding: 8px 0 4px;
      }
      .dsl-section.dsl-settings {
        border-top: none;
        padding-top: 0;
      }
      .dsl-section-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #636366);
      }
      .dsl-rule-id {
        font-size: 11px;
        font-family: var(--font-mono, monospace);
      }
      .dsl-version-row {
        margin: 6px 0;
      }
      .dsl-badge {
        font-size: 11px;
        font-weight: 600;
        padding: 2px 8px;
        border-radius: 999px;
      }
      .dsl-badge.v2 {
        background: rgba(52, 199, 89, 0.12);
        color: var(--profit, #248a3d);
      }
      .dsl-badge.v1 {
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
      }
      .dsl-notice {
        font-size: 11px;
        color: var(--accent, #0071e3);
      }
      .dsl-settings-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
        gap: 6px 10px;
      }
      .dsl-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 11px;
        color: var(--text-secondary, #636366);
      }
      .dsl-field.has-error .form-input {
        border-color: var(--loss, #d70015);
      }
      .dsl-field.has-warning .form-input {
        border-color: #ff9500;
      }
      .form-input {
        font-size: 11px;
        padding: 2px 6px;
        height: 24px;
        border: 1px solid var(--border, #e4e7eb);
        border-radius: 4px;
        background: var(--bg-primary, #fff);
        color: var(--text-primary, #1d1d1f);
        box-sizing: border-box;
      }
      .form-input.num {
        width: 64px;
      }
      .dsl-expr {
        min-width: 220px;
        flex: 1 1 220px;
        font-family: var(--font-mono, monospace);
      }
      .dsl-op-select,
      .dsl-op {
        width: auto;
        min-width: 44px;
      }
      .dsl-leaf-type {
        min-width: 150px;
        font-weight: 500;
      }
      .dsl-node {
        padding: 2px 0;
        border-left: 2px solid transparent;
      }
      .dsl-node-head,
      .dsl-leaf {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 3px 0;
      }
      .dsl-leaf-actions {
        margin-left: auto;
        display: inline-flex;
      }
      .dsl-children {
        border-left: 2px solid rgba(0, 113, 227, 0.15);
        padding-left: 6px;
      }
      .dsl-node.has-error {
        border-left-color: var(--loss, #d70015);
        background: rgba(255, 59, 48, 0.04);
        padding-left: 4px;
      }
      .dsl-node.has-warning {
        border-left-color: #ff9500;
        background: rgba(255, 149, 0, 0.05);
        padding-left: 4px;
      }
      .dsl-issues {
        margin: 0 0 4px;
        padding-left: 18px;
        font-size: 11px;
        color: var(--loss, #d70015);
      }
      .dsl-issues li.warning {
        color: #c93400;
      }
      .dsl-inner {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        border: 1px dashed rgba(0, 113, 227, 0.35);
        border-radius: 4px;
        background: rgba(0, 113, 227, 0.03);
      }
      .dsl-params {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--bg-secondary, #f7f8fa);
      }
      .dsl-param {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 11px;
        color: var(--text-secondary, #636366);
      }
      .dsl-param.irrelevant {
        text-decoration: line-through;
      }
      .dsl-checkbox {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 11px;
      }
      .dsl-checkbox.unknown {
        color: var(--loss, #d70015);
      }
      .dsl-raw {
        font-size: 11px;
        font-family: var(--font-mono, monospace);
        color: var(--text-secondary, #636366);
        overflow-wrap: anywhere;
      }
      .dsl-inline-error {
        font-size: 11px;
        color: var(--loss, #d70015);
      }
      .dsl-parse-error {
        font-size: 12px;
        color: var(--loss, #d70015);
      }
      .dsl-grip {
        cursor: grab;
        color: var(--text-secondary, #8e8e93);
        user-select: none;
        padding: 0 2px;
      }
      .dsl-empty,
      .dsl-empty-doc {
        margin: 4px 0;
      }
      .muted {
        color: var(--text-tertiary, #8e8e93);
      }
      .small {
        font-size: 11px;
      }
    `,
  ],
})
export class DslBuilderComponent {
  /** The DSL JSON (the form's Parameters JSON). */
  parametersJson = input<string>('');
  /** The strategy's own timeframe: HTF options must be strictly higher. */
  timeframe = input<string | null>(null);
  /** The strategy's symbol and name — used to seed a new rule and fix a mismatch. */
  symbol = input<string | null>(null);
  strategyName = input<string | null>(null);
  /**
   * Issues to show (engine paths). Null → the builder shows its own
   * client-side checks. The strategy form passes the engine's verdict once it
   * matches the current JSON.
   */
  issues = input<readonly DslIssue[] | null>(null);
  /** A saved v1 strategy: offer the engine-side upgrade. */
  canUpgrade = input(false);
  /** A strategy not yet created: the version can be switched client-side. */
  isNew = input(true);

  parametersJsonChange = output<string>();
  upgradeRequested = output<void>();

  mode = signal<'visual' | 'json'>('visual');
  parseError = signal<string | null>(null);
  /** One-line note after an automatic rewrite (e.g. Spread → BarRange). */
  notice = signal<string | null>(null);

  /** The parsed document. Nodes are mutated in place; {@link commit} re-emits. */
  readonly doc = signal<DslDoc | null>(null);

  // Undo/redo at the serialised-JSON level; capped at 50 entries. Only edits
  // made through the builder push history, not parent-driven input changes.
  private historyPast: string[] = [];
  private historyFuture: string[] = [];
  canUndo = signal(false);
  canRedo = signal(false);

  readonly trees: readonly TreeKey[] = ['entry', 'exit'];
  readonly conditionTypes = CONDITION_TYPES;
  readonly innerTypes = BARS_SINCE_INNER_TYPES;
  readonly indicatorKinds = INDICATOR_KINDS;
  readonly comparators = COMPARATORS;
  readonly comparatorValues = COMPARATORS.map((c) => c.value);
  readonly regimes = MARKET_REGIMES;
  readonly candlePatterns = CANDLE_PATTERNS;
  readonly rangeModes = RANGE_MODES;
  readonly directions = DIRECTIONS;
  readonly priceSources = PRICE_SOURCES;
  readonly logicOps = ['And', 'Or', 'Not'];

  readonly version = computed(() => {
    const d = this.doc();
    return d ? effectiveDslVersion(d) : CURRENT_DSL_VERSION;
  });
  readonly hasExplicitVersion = computed(() => {
    const v = this.doc()?.fields['dslVersion'];
    return v !== undefined && v !== null;
  });
  readonly htfOptions = computed<string[]>(() => higherTimeframes(this.timeframe()));

  readonly effectiveIssues = computed<readonly DslIssue[]>(() => {
    const given = this.issues();
    if (given) return given;
    const d = this.doc();
    return d ? validateDsl(d, { timeframe: this.timeframe(), symbol: this.symbol() }) : [];
  });
  private readonly issueIndex = computed(() => indexIssues(this.doc(), this.effectiveIssues()));

  /** Issues on top-level fields — shown under the settings grid. */
  readonly topLevelIssues = computed<DslIssue[]>(() => {
    const out: DslIssue[] = [];
    for (const list of this.issueIndex().byTopField.values()) out.push(...list);
    return out;
  });

  /** Parameters toggled open, by condition identity. */
  private readonly openParams = new WeakSet<DslCondition>();

  /** Last value emitted upstream: skips the re-parse that would reset uids and focus. */
  private lastEmitted: string | null = null;
  /**
   * The JSON the builder currently shows. History records this rather than
   * the input, which only catches up after the parent's next change detection.
   */
  private currentJson = '';

  private readonly hydrate = effect(() => {
    const raw = this.parametersJson();
    if (raw === this.lastEmitted) return;
    untracked(() => this.load(raw));
  });

  /** Replaces the builder's document with `raw` (parent-driven change). */
  load(raw: string): void {
    this.currentJson = raw ?? '';
    this.notice.set(null);
    if (!raw || !raw.trim()) {
      this.doc.set(null);
      this.parseError.set(null);
      return;
    }
    const r = parseDsl(raw);
    if (r.ok) {
      this.doc.set(r.doc);
      this.parseError.set(null);
    } else {
      // Never keep editing a stale tree over JSON the operator is fixing:
      // the next visual edit would overwrite their text.
      this.doc.set(null);
      this.parseError.set(r.error);
    }
  }

  /** Re-renders after an in-place mutation and emits the new JSON. */
  private commit(): void {
    const d = this.doc();
    if (!d) return;
    this.doc.set({ ...d });
    this.emit();
  }

  private emit(): void {
    const d = this.doc();
    if (!d) return;
    const next = emitDsl(d);
    const prev = this.currentJson;
    if (prev !== next) {
      this.historyPast.push(prev);
      if (this.historyPast.length > 50) this.historyPast.shift();
      this.historyFuture = [];
      this.canUndo.set(true);
      this.canRedo.set(false);
    }
    this.currentJson = next;
    this.lastEmitted = next;
    this.parametersJsonChange.emit(next);
  }

  undo(): void {
    if (this.historyPast.length === 0) return;
    const prev = this.historyPast.pop()!;
    this.historyFuture.push(this.currentJson);
    this.canUndo.set(this.historyPast.length > 0);
    this.canRedo.set(true);
    this.lastEmitted = prev;
    this.parametersJsonChange.emit(prev);
    this.load(prev);
  }

  redo(): void {
    if (this.historyFuture.length === 0) return;
    const next = this.historyFuture.pop()!;
    this.historyPast.push(this.currentJson);
    this.canUndo.set(true);
    this.canRedo.set(this.historyFuture.length > 0);
    this.lastEmitted = next;
    this.parametersJsonChange.emit(next);
    this.load(next);
  }

  /** Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y redo. */
  onKeyDown(ev: KeyboardEvent): void {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const key = ev.key.toLowerCase();
    if (key === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      this.undo();
    } else if ((key === 'z' && ev.shiftKey) || key === 'y') {
      ev.preventDefault();
      this.redo();
    }
  }

  // ── Document-level actions ───────────────────────────────────────────────

  startNewDoc(): void {
    this.doc.set(
      newDoc({ name: this.strategyName(), symbol: this.symbol(), timeframe: this.timeframe() }),
    );
    this.parseError.set(null);
    this.emit();
  }

  /** Client-side switch to v2 for a strategy that does not exist yet. */
  useV2(): void {
    const d = this.doc();
    if (!d) return;
    const converted = upgradeDocToV2(d);
    this.notice.set(
      converted > 0
        ? `Converted ${converted} Spread condition${converted === 1 ? '' : 's'} to BarRange — v1 Spread measured the bar range.`
        : null,
    );
    this.commit();
  }

  setTopField(key: string, value: unknown): void {
    const d = this.doc();
    if (!d) return;
    if (value === null || value === undefined || value === '') delete d.fields[key];
    else d.fields[key] = value;
    this.commit();
  }

  canFillFromStrategy(): boolean {
    const keys = new Set(this.issueIndex().byTopField.keys());
    return (
      (keys.has('name') && !!this.strategyName()) ||
      (keys.has('symbol') && !!this.symbol()) ||
      (keys.has('timeframe') && !!this.timeframe())
    );
  }

  /** Writes the strategy's own name/symbol/timeframe into the rule where they are missing or differ. */
  fillFromStrategy(): void {
    const d = this.doc();
    if (!d) return;
    const name = this.strategyName()?.trim();
    if (name && (typeof d.fields['name'] !== 'string' || !String(d.fields['name']).trim())) {
      d.fields['name'] = name;
    }
    if (this.symbol()) d.fields['symbol'] = this.symbol();
    if (this.timeframe()) d.fields['timeframe'] = this.timeframe();
    this.commit();
  }

  // ── Tree mutations ───────────────────────────────────────────────────────

  rootOf(tree: TreeKey): DslNode | null {
    const d = this.doc();
    if (!d) return null;
    return tree === 'entry' ? d.entryRoot : d.exitRoot;
  }

  private setRoot(tree: TreeKey, node: DslNode | null): void {
    const d = this.doc();
    if (!d) return;
    if (tree === 'entry') {
      d.entryRoot = node;
      // Once edited, the tree is written as entryConditionsRoot.
      d.entryFromLegacyList = false;
    } else {
      d.exitRoot = node;
    }
  }

  private defaultLeaf(tree: TreeKey): DslNode {
    const leaf = newLeafNode('IndicatorThreshold', { timeframe: this.timeframe() });
    if (tree === 'exit') {
      // A sensible exit: momentum has swung back.
      leaf.leaf!.config = { indicator: 'Rsi', period: 14, operator: 'GreaterThan', value: 70 };
    }
    return leaf;
  }

  /** Adds a condition to a tree: starts it, appends to a root group, or wraps a root leaf. */
  addToTree(tree: TreeKey): void {
    const root = this.rootOf(tree);
    const leaf = this.defaultLeaf(tree);
    if (!root) this.setRoot(tree, leaf);
    else if (root.op !== null && root.raw === undefined) root.children.push(leaf);
    else this.setRoot(tree, newGroupNode('And', [root, leaf]));
    this.commit();
  }

  clearTree(tree: TreeKey): void {
    if (!confirm(`Remove every ${tree} condition?`)) return;
    this.setRoot(tree, null);
    this.commit();
  }

  setOp(n: DslNode, op: string): void {
    n.op = op;
    this.commit();
  }

  addLeafChild(n: DslNode): void {
    n.children.push(newLeafNode('IndicatorThreshold', { timeframe: this.timeframe() }));
    this.commit();
  }

  addGroupChild(n: DslNode): void {
    n.children.push(
      newGroupNode('And', [newLeafNode('IndicatorThreshold', { timeframe: this.timeframe() })]),
    );
    this.commit();
  }

  /** Replaces a node with an AND of itself and a new condition. */
  wrapInGroup(tree: TreeKey, parent: DslNode | null, idx: number, n: DslNode): void {
    const group = newGroupNode('And', [
      n,
      newLeafNode('IndicatorThreshold', { timeframe: this.timeframe() }),
    ]);
    if (parent === null) this.setRoot(tree, group);
    else parent.children.splice(idx, 1, group);
    this.commit();
  }

  /** Replaces a one-child group with that child. */
  unwrapGroup(tree: TreeKey, parent: DslNode | null, idx: number, n: DslNode): void {
    if (n.children.length !== 1) return;
    const child = n.children[0];
    if (parent === null) this.setRoot(tree, child);
    else parent.children.splice(idx, 1, child);
    this.commit();
  }

  deleteNode(tree: TreeKey, parent: DslNode | null, idx: number): void {
    if (parent === null) this.setRoot(tree, null);
    else parent.children.splice(idx, 1);
    this.commit();
  }

  setLeafType(n: DslNode, type: string): void {
    if (!n.leaf || n.leaf.type === type) return;
    // A new type gets a fresh, valid payload; unrelated extra keys stay.
    const extra = n.leaf.extra;
    n.leaf = {
      ...newCondition(type, { timeframe: this.timeframe() }),
      ...(extra ? { extra } : {}),
    };
    this.commit();
  }

  innerOf(c: DslCondition): DslCondition | null {
    const inner = c.config['inner'];
    return inner && typeof inner === 'object' && typeof inner.type === 'string' && inner.config
      ? (inner as DslCondition)
      : null;
  }

  setInnerType(c: DslCondition, type: string): void {
    const inner = this.innerOf(c);
    if (inner?.type === type) return;
    c.config['inner'] = newCondition(type, { timeframe: this.timeframe() });
    this.commit();
  }

  setField(c: DslCondition, field: string, value: unknown): void {
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      (typeof value === 'number' && Number.isNaN(value))
    ) {
      delete c.config[field];
    } else {
      c.config[field] = value;
    }
    if (field === 'mode' && value === 'AtrFraction' && c.config['atrPeriod'] == null) {
      c.config['atrPeriod'] = 14;
    }
    if (field === 'indicator' || field === 'leftIndicator' || field === 'rightIndicator') {
      this.pruneParams(c);
    }
    this.commit();
  }

  /** Drops known params that the newly-selected indicator(s) ignore. */
  private pruneParams(c: DslCondition): void {
    const params = c.config['params'];
    if (!params || typeof params !== 'object') return;
    const keep = new Set<string>(relevantParamKeys(c));
    const known = new Set<string>(INDICATOR_PARAMS.map((p) => p.key));
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (!known.has(k) || keep.has(k)) next[k] = v;
    }
    if (Object.keys(next).length === 0) delete c.config['params'];
    else c.config['params'] = next;
  }

  bullishValue(c: DslCondition): string {
    const b = c.config['bullish'];
    return b === true ? 'bullish' : b === false ? 'bearish' : 'either';
  }

  setBullish(c: DslCondition, v: string): void {
    // Absent = either direction (the engine's null).
    this.setField(c, 'bullish', v === 'bullish' ? true : v === 'bearish' ? false : null);
  }

  regimeOptions(c: DslCondition): string[] {
    const selected: unknown[] = Array.isArray(c.config['allowedRegimes'])
      ? c.config['allowedRegimes']
      : [];
    const unknown = selected.filter(
      (r): r is string =>
        typeof r === 'string' && !(MARKET_REGIMES as readonly string[]).includes(r),
    );
    return [...MARKET_REGIMES, ...unknown];
  }

  regimeIsSelected(c: DslCondition, regime: string): boolean {
    const arr = c.config['allowedRegimes'];
    return Array.isArray(arr) && arr.includes(regime);
  }

  toggleRegime(c: DslCondition, regime: string, on: boolean): void {
    const cur: unknown[] = Array.isArray(c.config['allowedRegimes'])
      ? [...c.config['allowedRegimes']]
      : [];
    const idx = cur.indexOf(regime);
    if (on && idx === -1) cur.push(regime);
    else if (!on && idx !== -1) cur.splice(idx, 1);
    c.config['allowedRegimes'] = cur;
    this.commit();
  }

  // ── Params ───────────────────────────────────────────────────────────────

  paramKeys(c: DslCondition): IndicatorParamKey[] {
    return relevantParamKeys(c);
  }

  /** Relevant params plus any known param already set (so it can be cleared). */
  paramFields(c: DslCondition) {
    const relevant = new Set<string>(this.paramKeys(c));
    const params = c.config['params'];
    return INDICATOR_PARAMS.filter(
      (p) => relevant.has(p.key) || (params && typeof params === 'object' && p.key in params),
    );
  }

  hasParams(c: DslCondition): boolean {
    const p = c.config['params'];
    return !!p && typeof p === 'object' && Object.keys(p).length > 0;
  }

  paramsOpen(c: DslCondition): boolean {
    return this.openParams.has(c);
  }

  toggleParams(c: DslCondition): void {
    if (this.openParams.has(c)) this.openParams.delete(c);
    else this.openParams.add(c);
    const d = this.doc();
    if (d) this.doc.set({ ...d });
  }

  paramValue(c: DslCondition, key: string): unknown {
    const p = c.config['params'];
    return p && typeof p === 'object' ? p[key] : undefined;
  }

  setParam(c: DslCondition, key: string, value: unknown): void {
    const current = c.config['params'];
    const next: Record<string, unknown> =
      current && typeof current === 'object' ? { ...current } : {};
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      (typeof value === 'number' && Number.isNaN(value))
    ) {
      delete next[key];
    } else {
      next[key] = value;
    }
    if (Object.keys(next).length === 0) delete c.config['params'];
    else c.config['params'] = next;
    this.openParams.add(c);
    this.commit();
  }

  isTwoSided(c: DslCondition): boolean {
    return 'leftIndicator' in c.config || 'rightIndicator' in c.config;
  }

  // ── Display helpers ──────────────────────────────────────────────────────

  isKnown(list: readonly string[], value: unknown): boolean {
    return typeof value === 'string' && list.includes(value);
  }

  isKnownType(t: string): boolean {
    return CONDITION_TYPES.some((x) => x.type === t);
  }

  typeLabel(t: string): string {
    return conditionTypeInfo(t)?.label ?? t;
  }

  typeDescription(t: string): string {
    return conditionTypeInfo(t)?.description ?? 'Not a condition type this console knows';
  }

  /** Human-readable description for an indicator, surfaced as a tooltip. */
  indicatorHint(i: unknown): string {
    return indicatorInfo(i)?.hint ?? '';
  }

  operatorLabel(op: unknown): string {
    return COMPARATORS.find((c) => c.value === op)?.label ?? String(op ?? '');
  }

  spreadHint(): string {
    return this.version() >= 2
      ? 'v2: the real bid/ask spread. For the old high − low measure use BarRange.'
      : 'v1: measured the bar high − low range. Upgrading to v2 turns it into BarRange.';
  }

  rawPreview(v: unknown, max: number): string {
    let s: string;
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  nodeIssues(n: DslNode): DslIssue[] {
    return this.issueIndex().byNode.get(n.uid) ?? [];
  }

  nodeSeverity(n: DslNode): 'error' | 'warning' | null {
    const list = this.nodeIssues(n);
    if (list.some((i) => i.severity === 'error')) return 'error';
    return list.length > 0 ? 'warning' : null;
  }

  topSeverity(key: string): 'error' | 'warning' | null {
    const list = this.issueIndex().byTopField.get(key) ?? [];
    if (list.some((i) => i.severity === 'error')) return 'error';
    return list.length > 0 ? 'warning' : null;
  }

  // ── Drag-to-reorder among siblings ───────────────────────────────────────

  private dragSource: { parent: DslNode; idx: number } | null = null;

  onDragStart(parent: DslNode, idx: number, ev: DragEvent): void {
    // The event bubbles through every ancestor node; only the innermost
    // (the row actually grabbed) may claim the drag.
    ev.stopPropagation();
    this.dragSource = { parent, idx };
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      try {
        ev.dataTransfer.setData('text/plain', `${idx}`);
      } catch {
        /* some browsers refuse; the drag still works */
      }
    }
  }

  onDragOver(parent: DslNode, _idx: number, ev: DragEvent): void {
    if (this.dragSource && this.dragSource.parent === parent) {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    }
  }

  onDrop(parent: DslNode, targetIdx: number, ev: DragEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    const src = this.dragSource;
    this.dragSource = null;
    if (!src || src.parent !== parent || src.idx === targetIdx) return;
    // The dragged row takes the target's place: removing it first shifts the
    // later rows left, so inserting at targetIdx lands it exactly there.
    const moved = parent.children.splice(src.idx, 1)[0];
    parent.children.splice(targetIdx, 0, moved);
    this.commit();
  }

  onDragEnd(): void {
    this.dragSource = null;
  }
}
