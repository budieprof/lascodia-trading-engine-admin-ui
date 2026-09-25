import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';

import { DslBuilderComponent } from './dsl-builder.component';
import {
  CONDITION_TYPES,
  emitCondition,
  newCondition,
  type DslCondition,
  type DslNode,
} from '../../dsl/dsl-model';

// The builder's behaviour lives in public methods over its parsed document,
// so the tests drive those directly and read what it emits. Signal inputs are
// left at their defaults (no strategy timeframe/symbol, client-side issues):
// the JIT test harness cannot vary signal inputs before the first render.

/** An LLM-written rule: PascalCase everywhere. */
const LLM_RULE = JSON.stringify({
  Name: 'RSI dip',
  Symbol: 'EURUSD',
  Timeframe: 'H1',
  Direction: 'Buy',
  EntryConditionsRoot: {
    Op: 'And',
    Children: [
      {
        Leaf: {
          Type: 'IndicatorThreshold',
          IndicatorThreshold: { Indicator: 'Rsi', Period: 14, Operator: 'LessThan', Value: 30 },
        },
      },
      {
        Leaf: {
          Type: 'CandlePattern',
          CandlePattern: { Pattern: 'Engulfing', Bullish: true },
        },
      },
    ],
  },
  StopLossAtrMultiplier: 1.5,
  TakeProfitAtrMultiplier: 2.5,
});

describe('DslBuilderComponent', () => {
  let cmp: DslBuilderComponent;
  let emitted: string[];

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [DslBuilderComponent] });
    const fixture = TestBed.createComponent(DslBuilderComponent);
    cmp = fixture.componentInstance;
    emitted = [];
    cmp.parametersJsonChange.subscribe((v) => emitted.push(v));
    (globalThis as any).confirm = () => true;
  });

  const root = (): DslNode => cmp.doc()!.entryRoot!;
  const last = () => JSON.parse(emitted[emitted.length - 1]);

  describe('loading', () => {
    it('loads an LLM-written (PascalCase) rule with its payloads', () => {
      cmp.load(LLM_RULE);
      expect(root().op).toBe('And');
      expect(root().children[0].leaf).toEqual({
        type: 'IndicatorThreshold',
        config: { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 },
      });
      expect(root().children[1].leaf!.config).toEqual({ pattern: 'Engulfing', bullish: true });
    });

    it('loads a camelCase rule instead of an empty AND', () => {
      cmp.load(
        JSON.stringify({
          entryConditionsRoot: {
            op: 'Or',
            children: [
              { leaf: { type: 'HourWindow', hourWindow: { startHourUtc: 7, endHourUtc: 16 } } },
              { leaf: { type: 'PriceVsMa', priceVsMa: { maPeriod: 50, operator: 'GreaterThan' } } },
            ],
          },
        }),
      );
      expect(root().op).toBe('Or');
      expect(root().children.map((c) => c.leaf!.type)).toEqual(['HourWindow', 'PriceVsMa']);
    });

    it('stops visual editing while the JSON does not parse', () => {
      cmp.load('{ "name": ');
      expect(cmp.doc()).toBeNull();
      expect(cmp.parseError()).toMatch(/Invalid JSON/);
    });
  });

  describe('editing', () => {
    it('keeps every other payload on the first visual edit — it used to wipe them', () => {
      cmp.load(LLM_RULE);
      cmp.setField(root().children[0].leaf!, 'value', 25);
      const out = last();
      expect(out.entryConditionsRoot.children[0].leaf.indicatorThreshold).toEqual({
        indicator: 'Rsi',
        period: 14,
        operator: 'LessThan',
        value: 25,
      });
      expect(out.entryConditionsRoot.children[1].leaf).toEqual({
        type: 'CandlePattern',
        candlePattern: { pattern: 'Engulfing', bullish: true },
      });
      expect(out.name).toBe('RSI dip');
      expect(out.stopLossAtrMultiplier).toBe(1.5);
      expect(out.Name).toBeUndefined();
    });

    it('edits the top-level settings', () => {
      cmp.load(LLM_RULE);
      cmp.setTopField('direction', 'Sell');
      cmp.setTopField('baseConfidence', 0.7);
      cmp.setTopField('atrPeriod', null);
      const out = last();
      expect(out.direction).toBe('Sell');
      expect(out.baseConfidence).toBe(0.7);
      expect('atrPeriod' in out).toBe(false);
    });

    it('edits a BarsSince inner condition in the engine shape', () => {
      cmp.load(LLM_RULE);
      cmp.setLeafType(root().children[1], 'BarsSince');
      const barsSince = root().children[1].leaf!;
      cmp.setInnerType(barsSince, 'IndicatorCrossover');
      cmp.setField(cmp.innerOf(barsSince)!, 'rightPeriod', 100);
      cmp.setField(barsSince, 'value', 3);
      const leaf = last().entryConditionsRoot.children[1].leaf;
      expect(leaf.type).toBe('BarsSince');
      expect(leaf.barsSince).toEqual({
        inner: {
          type: 'IndicatorCrossover',
          indicatorCrossover: {
            leftIndicator: 'Ema',
            leftPeriod: 20,
            rightIndicator: 'Ema',
            rightPeriod: 100,
          },
        },
        maxLookback: 50,
        operator: 'LessThanOrEqual',
        value: 3,
      });
    });

    it('offers every condition type but BarsSince for the inner condition', () => {
      expect(cmp.innerTypes).not.toContain('BarsSince');
      expect(cmp.innerTypes).toContain('BarRange');
      expect(cmp.innerTypes).toHaveLength(13);
      expect(cmp.conditionTypes).toHaveLength(14);
    });

    it('maps the candle direction to true / false / absent', () => {
      cmp.load(LLM_RULE);
      const c = root().children[1].leaf!;
      cmp.setBullish(c, 'bearish');
      expect(last().entryConditionsRoot.children[1].leaf.candlePattern.bullish).toBe(false);
      cmp.setBullish(c, 'either');
      expect('bullish' in last().entryConditionsRoot.children[1].leaf.candlePattern).toBe(false);
      expect(cmp.bullishValue(c)).toBe('either');
    });

    it('offers only engine regimes and keeps an unknown one visible so it can be removed', () => {
      cmp.load(
        JSON.stringify({
          ...JSON.parse(LLM_RULE),
          EntryConditionsRoot: {
            Leaf: {
              Type: 'RegimeMatch',
              RegimeMatch: { AllowedRegimes: ['Volatile', 'Trending'] },
            },
          },
        }),
      );
      const c = root().leaf!;
      expect(cmp.regimeOptions(c)).toEqual([
        'Trending',
        'Ranging',
        'HighVolatility',
        'LowVolatility',
        'Crisis',
        'Breakout',
        'Volatile',
      ]);
      expect(cmp.nodeSeverity(root())).toBe('error');
      cmp.toggleRegime(c, 'Volatile', false);
      cmp.toggleRegime(c, 'Crisis', true);
      expect(last().entryConditionsRoot.leaf.regimeMatch.allowedRegimes).toEqual([
        'Trending',
        'Crisis',
      ]);
      expect(cmp.nodeSeverity(root())).toBeNull();
    });

    it('offers the six engine comparators including Equal and NotEqual', () => {
      expect(cmp.comparators.map((c) => c.value)).toEqual([
        'LessThan',
        'LessThanOrEqual',
        'GreaterThan',
        'GreaterThanOrEqual',
        'Equal',
        'NotEqual',
      ]);
    });

    it('offers every engine timeframe for HTF when the strategy timeframe is unknown', () => {
      expect(cmp.htfOptions()).toEqual(['M1', 'M5', 'M15', 'H1', 'H4', 'D1']);
    });
  });

  describe('params', () => {
    const macdLeaf = (): DslCondition => {
      cmp.load(
        JSON.stringify({
          ...JSON.parse(LLM_RULE),
          DslVersion: 2,
          EntryConditionsRoot: {
            Leaf: {
              Type: 'IndicatorThreshold',
              IndicatorThreshold: {
                Indicator: 'MacdHistogram',
                Period: 26,
                Operator: 'GreaterThan',
                Value: 0,
              },
            },
          },
        }),
      );
      return root().leaf!;
    };

    it('shows only the params that affect the indicator', () => {
      const c = macdLeaf();
      expect(cmp.paramKeys(c)).toEqual(['fastPeriod', 'slowPeriod', 'signalPeriod', 'source']);
      cmp.setField(c, 'indicator', 'Adx');
      expect(cmp.paramKeys(c)).toEqual([]);
    });

    it('writes params, drops them when cleared, and prunes irrelevant ones on indicator change', () => {
      const c = macdLeaf();
      cmp.setParam(c, 'fastPeriod', 8);
      cmp.setParam(c, 'source', 'Hlc3');
      expect(last().entryConditionsRoot.leaf.indicatorThreshold.params).toEqual({
        fastPeriod: 8,
        source: 'Hlc3',
      });
      cmp.setField(c, 'indicator', 'Ema');
      expect(last().entryConditionsRoot.leaf.indicatorThreshold.params).toEqual({ source: 'Hlc3' });
      cmp.setParam(c, 'source', '');
      expect('params' in last().entryConditionsRoot.leaf.indicatorThreshold).toBe(false);
    });
  });

  describe('tree structure', () => {
    it('wraps a root leaf, unwraps a one-child group and deletes nodes', () => {
      cmp.load(
        JSON.stringify({
          ...JSON.parse(LLM_RULE),
          EntryConditionsRoot: JSON.parse(LLM_RULE).EntryConditionsRoot.Children[0],
        }),
      );
      const leaf = root();
      cmp.wrapInGroup('entry', null, -1, leaf);
      expect(root().op).toBe('And');
      expect(root().children).toHaveLength(2);
      cmp.deleteNode('entry', root(), 1);
      expect(root().children).toHaveLength(1);
      cmp.unwrapGroup('entry', null, -1, root());
      expect(root()).toBe(leaf);
      expect(last().entryConditionsRoot.leaf.type).toBe('IndicatorThreshold');
    });

    it('adds and clears exit conditions', () => {
      cmp.load(LLM_RULE);
      cmp.addToTree('exit');
      expect(last().exitConditionsRoot.leaf.indicatorThreshold).toEqual({
        indicator: 'Rsi',
        period: 14,
        operator: 'GreaterThan',
        value: 70,
      });
      cmp.addToTree('exit');
      expect(last().exitConditionsRoot.op).toBe('And');
      cmp.clearTree('exit');
      expect(last().exitConditionsRoot).toBeUndefined();
    });

    it('reorders siblings by drag and drop — the row takes the target’s place', () => {
      cmp.load(LLM_RULE);
      const r = root();
      const [a, b] = r.children;
      const ev = {
        preventDefault() {},
        stopPropagation() {},
        dataTransfer: null,
      } as unknown as DragEvent;
      cmp.onDragStart(r, 0, ev);
      cmp.onDrop(r, 1, ev);
      expect(r.children).toEqual([b, a]);
      expect(last().entryConditionsRoot.children[0].leaf.type).toBe('CandlePattern');
    });
  });

  describe('versions', () => {
    it('starts a new rule on v2 with a valid starter condition', () => {
      cmp.startNewDoc();
      const out = last();
      expect(out.dslVersion).toBe(2);
      expect(out.entryConditionsRoot.leaf.type).toBe('IndicatorThreshold');
      expect(cmp.effectiveIssues()).toEqual([]);
    });

    it('switches a new rule to v2, turning v1 Spread into BarRange', () => {
      cmp.load(
        JSON.stringify({
          ...JSON.parse(LLM_RULE),
          EntryConditionsRoot: {
            Leaf: { Type: 'Spread', Spread: { Operator: 'LessThan', Threshold: 1, Mode: 'Pips' } },
          },
        }),
      );
      expect(cmp.version()).toBe(1);
      cmp.useV2();
      expect(cmp.version()).toBe(2);
      expect(last().entryConditionsRoot.leaf).toEqual({
        type: 'BarRange',
        barRange: { operator: 'LessThan', threshold: 1, mode: 'Pips' },
      });
      expect(cmp.notice()).toMatch(/Converted 1 Spread/);
    });
  });

  describe('issues', () => {
    it('attaches client-side issues to the node they are about', () => {
      cmp.load(LLM_RULE);
      const rsi = root().children[0];
      cmp.setField(rsi.leaf!, 'period', 1);
      expect(cmp.nodeSeverity(rsi)).toBe('error');
      expect(cmp.nodeIssues(rsi)[0].message).toMatch(/period 1 is outside/);
      expect(cmp.nodeSeverity(root().children[1])).toBeNull();
    });

    it('flags a one-child AND on the group itself', () => {
      cmp.load(LLM_RULE);
      cmp.deleteNode('entry', root(), 1);
      expect(cmp.nodeIssues(root())[0].message).toMatch(/one condition/);
    });

    it('reports top-level problems separately', () => {
      cmp.load(LLM_RULE);
      cmp.setTopField('stopLossAtrMultiplier', 20);
      expect(cmp.topSeverity('stopLossAtrMultiplier')).toBe('error');
      expect(cmp.topLevelIssues()[0].message).toMatch(/outside/);
    });
  });

  describe('undo / redo', () => {
    it('steps back and forward through builder edits', () => {
      cmp.load(LLM_RULE);
      cmp.setTopField('direction', 'Sell');
      cmp.setTopField('direction', 'Both');
      expect(cmp.canUndo()).toBe(true);
      cmp.undo();
      expect(cmp.doc()!.fields['direction']).toBe('Sell');
      cmp.redo();
      expect(cmp.doc()!.fields['direction']).toBe('Both');
    });
  });

  describe('rendering', () => {
    it('renders a row for every condition type, an unknown type and an unrecognised node', () => {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ imports: [DslBuilderComponent] });
      const fixture = TestBed.createComponent(DslBuilderComponent);
      fixture.detectChanges(); // first pass hydrates from the (empty) input
      const leaves = CONDITION_TYPES.map((t) => ({ leaf: emitCondition(newCondition(t.type)) }));
      fixture.componentInstance.load(
        JSON.stringify({
          dslVersion: 2,
          name: 'all types',
          symbol: 'EURUSD',
          timeframe: 'H1',
          direction: 'Buy',
          stopLossAtrMultiplier: 1,
          takeProfitAtrMultiplier: 2,
          entryConditionsRoot: {
            op: 'And',
            children: [...leaves, { weird: 1 }, { leaf: { type: 'Future', future: { a: 1 } } }],
          },
          exitConditionsRoot: { op: 'Not', children: [leaves[0]] },
        }),
      );
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      // 14 types + the unknown type + the unrecognised node + the exit leaf.
      expect(el.querySelectorAll('.dsl-leaf')).toHaveLength(17);
      // The two nodes the engine would reject are flagged in place.
      expect(el.querySelectorAll('.dsl-node.has-error')).toHaveLength(2);
      expect(el.textContent).toContain('Pine-exact math (v2)');
      expect(el.textContent).toContain('Exit conditions');
    });
  });

  describe('indicatorHint', () => {
    it('describes known indicators and is empty for unknown ones', () => {
      expect(cmp.indicatorHint('Rsi')).toContain('Relative Strength');
      expect(cmp.indicatorHint('Ema')).toContain('Exponential');
      expect(cmp.indicatorHint('RocPercent')).toContain('Rate of change');
      expect(cmp.indicatorHint('NotARealIndicator')).toBe('');
    });
  });
});
