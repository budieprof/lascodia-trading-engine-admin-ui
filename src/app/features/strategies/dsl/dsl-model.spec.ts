import { describe, it, expect } from 'vitest';

import {
  CONDITION_TYPES,
  DslDoc,
  DslNode,
  checkMathExpression,
  emitDsl,
  higherTimeframes,
  indexIssues,
  newDoc,
  parseDsl,
  patchDslFields,
  relevantParamKeys,
  resolveIssuePath,
  upgradeDocToV2,
  validateDsl,
  validateDslJson,
} from './dsl-model';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** How the LLM writes a proposal: PascalCase keys everywhere, null payloads for the other types. */
const PASCAL = {
  Name: 'RSI dip in uptrend',
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
          PriceVsMa: null,
        },
      },
      {
        Leaf: {
          Type: 'PriceVsMa',
          PriceVsMa: { MaPeriod: 200, Operator: 'GreaterThan' },
        },
      },
      {
        Leaf: {
          Type: 'BarsSince',
          BarsSince: {
            Inner: {
              Type: 'IndicatorCrossover',
              IndicatorCrossover: {
                LeftIndicator: 'Ema',
                LeftPeriod: 20,
                RightIndicator: 'Ema',
                RightPeriod: 50,
              },
            },
            MaxLookback: 50,
            Operator: 'LessThanOrEqual',
            Value: 10,
          },
        },
      },
    ],
  },
  StopLossAtrMultiplier: 1.5,
  TakeProfitAtrMultiplier: 2.5,
  AtrPeriod: 14,
  BaseConfidence: 0.6,
};

/** The same rule, all camelCase — what this console emits. */
const CAMEL = {
  name: 'RSI dip in uptrend',
  symbol: 'EURUSD',
  timeframe: 'H1',
  direction: 'Buy',
  entryConditionsRoot: {
    op: 'And',
    children: [
      {
        leaf: {
          type: 'IndicatorThreshold',
          indicatorThreshold: { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 },
        },
      },
      { leaf: { type: 'PriceVsMa', priceVsMa: { maPeriod: 200, operator: 'GreaterThan' } } },
      {
        leaf: {
          type: 'BarsSince',
          barsSince: {
            inner: {
              type: 'IndicatorCrossover',
              indicatorCrossover: {
                leftIndicator: 'Ema',
                leftPeriod: 20,
                rightIndicator: 'Ema',
                rightPeriod: 50,
              },
            },
            maxLookback: 50,
            operator: 'LessThanOrEqual',
            value: 10,
          },
        },
      },
    ],
  },
  stopLossAtrMultiplier: 1.5,
  takeProfitAtrMultiplier: 2.5,
  atrPeriod: 14,
  baseConfidence: 0.6,
};

/** What earlier builds of this console wrote: PascalCase structure, camelCase payloads. */
const OLD_CONSOLE = {
  Name: 'RSI dip in uptrend',
  Symbol: 'EURUSD',
  Timeframe: 'H1',
  Direction: 'Buy',
  EntryConditionsRoot: {
    Op: 'And',
    Children: [
      {
        Leaf: {
          Type: 'IndicatorThreshold',
          indicatorThreshold: { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 },
        },
      },
      { Leaf: { Type: 'PriceVsMa', priceVsMa: { maPeriod: 200, operator: 'GreaterThan' } } },
      {
        Leaf: {
          Type: 'BarsSince',
          barsSince: {
            inner: {
              type: 'IndicatorCrossover',
              indicatorCrossover: {
                leftIndicator: 'Ema',
                leftPeriod: 20,
                rightIndicator: 'Ema',
                rightPeriod: 50,
              },
            },
            maxLookback: 50,
            operator: 'LessThanOrEqual',
            value: 10,
          },
        },
      },
    ],
  },
  StopLossAtrMultiplier: 1.5,
  TakeProfitAtrMultiplier: 2.5,
  AtrPeriod: 14,
  BaseConfidence: 0.6,
};

function parse(obj: unknown): DslDoc {
  const r = parseDsl(JSON.stringify(obj));
  if (!r.ok) throw new Error(r.error);
  return r.doc;
}

/** The model without the synthetic uids, for structural comparison. */
function shape(doc: DslDoc): unknown {
  const strip = (n: DslNode | null): unknown =>
    n === null ? null : { ...n, uid: undefined, children: n.children.map(strip) };
  return { ...doc, entryRoot: strip(doc.entryRoot), exitRoot: strip(doc.exitRoot) };
}

/** Every key in `value` (recursively), for casing assertions. */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allKeys(v, out);
    }
  }
  return out;
}

const rsiLeaf = (n: DslNode) => n.children[0].leaf!;

// ── Parsing ─────────────────────────────────────────────────────────────────

describe('parseDsl — both casings', () => {
  it('reads an all-PascalCase (LLM-written) rule with every payload intact', () => {
    const doc = parse(PASCAL);
    const root = doc.entryRoot!;
    expect(root.op).toBe('And');
    expect(root.children).toHaveLength(3);
    expect(rsiLeaf(root)).toEqual({
      type: 'IndicatorThreshold',
      config: { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 },
    });
    expect(root.children[1].leaf!.config).toEqual({ maPeriod: 200, operator: 'GreaterThan' });
    const inner = root.children[2].leaf!.config['inner'];
    expect(inner.type).toBe('IndicatorCrossover');
    expect(inner.config).toEqual({
      leftIndicator: 'Ema',
      leftPeriod: 20,
      rightIndicator: 'Ema',
      rightPeriod: 50,
    });
    expect(doc.fields['stopLossAtrMultiplier']).toBe(1.5);
    expect(doc.fields['direction']).toBe('Buy');
  });

  it('reads an all-camelCase rule — it used to load as an empty AND', () => {
    const doc = parse(CAMEL);
    expect(doc.entryRoot!.children).toHaveLength(3);
    expect(rsiLeaf(doc.entryRoot!).config['value']).toBe(30);
  });

  it('reads PascalCase, camelCase and the old console shape into the same model', () => {
    const a = shape(parse(PASCAL));
    expect(shape(parse(CAMEL))).toEqual(a);
    expect(shape(parse(OLD_CONSOLE))).toEqual(a);
  });

  it('canonicalises enum spellings the engine accepts case-insensitively', () => {
    const doc = parse({
      ...CAMEL,
      direction: 'sell',
      timeframe: 'h4',
      entryConditionsRoot: {
        op: 'or',
        children: [
          {
            leaf: {
              type: 'indicatorthreshold',
              indicatorThreshold: { indicator: 'rsi', period: 14, operator: 'lessthan', value: 30 },
            },
          },
          {
            leaf: {
              type: 'Spread',
              spread: { operator: 'LessThan', threshold: 2, mode: 'pips' },
            },
          },
          {
            leaf: { type: 'RegimeMatch', regimeMatch: { allowedRegimes: ['trending', 'crisis'] } },
          },
        ],
      },
    });
    const root = doc.entryRoot!;
    expect(doc.fields['direction']).toBe('Sell');
    expect(doc.fields['timeframe']).toBe('H4');
    expect(root.op).toBe('Or');
    expect(root.children[0].leaf!.type).toBe('IndicatorThreshold');
    expect(root.children[0].leaf!.config).toMatchObject({ indicator: 'Rsi', operator: 'LessThan' });
    expect(root.children[1].leaf!.config['mode']).toBe('Pips');
    expect(root.children[2].leaf!.config['allowedRegimes']).toEqual(['Trending', 'Crisis']);
  });

  it('turns the legacy flat entryConditions list into an AND root', () => {
    const doc = parse({
      ...CAMEL,
      entryConditionsRoot: undefined,
      EntryConditions: [
        {
          Type: 'IndicatorThreshold',
          IndicatorThreshold: { Indicator: 'Rsi', Period: 14, Operator: 'LessThan', Value: 30 },
        },
        { Type: 'PriceVsMa', PriceVsMa: { MaPeriod: 200, Operator: 'GreaterThan' } },
      ],
    });
    expect(doc.entryFromLegacyList).toBe(true);
    expect(doc.entryRoot!.op).toBe('And');
    expect(doc.entryRoot!.children.map((c) => c.leaf!.type)).toEqual([
      'IndicatorThreshold',
      'PriceVsMa',
    ]);
    const emitted = JSON.parse(emitDsl(doc));
    expect(emitted.entryConditions).toBeUndefined();
    expect(emitted.entryConditionsRoot.op).toBe('And');
  });

  it('makes a one-condition legacy list the root leaf (the engine rejects a one-child AND)', () => {
    const doc = parse({
      ...CAMEL,
      entryConditionsRoot: undefined,
      entryConditions: [
        { type: 'PriceVsMa', priceVsMa: { maPeriod: 50, operator: 'GreaterThan' } },
      ],
    });
    expect(doc.entryRoot!.op).toBeNull();
    expect(doc.entryRoot!.leaf!.type).toBe('PriceVsMa');
    expect(validateDsl(doc).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('reports JSON syntax errors instead of throwing', () => {
    const r = parseDsl('{ "name": ');
    expect(r.ok).toBe(false);
    expect(parseDsl('[1,2]').ok).toBe(false);
    expect(parseDsl('').ok).toBe(false);
  });
});

// ── Emission ────────────────────────────────────────────────────────────────

describe('emitDsl', () => {
  it('writes camelCase keys whatever casing came in', () => {
    const emitted = JSON.parse(emitDsl(parse(PASCAL)));
    const keys = allKeys(emitted);
    expect(keys.filter((k) => /^[A-Z]/.test(k))).toEqual([]);
    expect(emitted.entryConditionsRoot.children[0]).toEqual({
      leaf: {
        type: 'IndicatorThreshold',
        indicatorThreshold: { indicator: 'Rsi', period: 14, operator: 'LessThan', value: 30 },
      },
    });
    expect(emitted.entryConditionsRoot.children[2].leaf.barsSince.inner).toEqual({
      type: 'IndicatorCrossover',
      indicatorCrossover: {
        leftIndicator: 'Ema',
        leftPeriod: 20,
        rightIndicator: 'Ema',
        rightPeriod: 50,
      },
    });
  });

  it('drops the null payloads of other condition types', () => {
    const emitted = JSON.parse(emitDsl(parse(PASCAL)));
    expect(emitted.entryConditionsRoot.children[0].leaf.PriceVsMa).toBeUndefined();
    expect(emitted.entryConditionsRoot.children[0].leaf.priceVsMa).toBeUndefined();
  });

  it('preserves unknown fields at every level, verbatim', () => {
    const src = {
      ...PASCAL,
      Rationale: 'fade the dip',
      EntryConditionsRoot: {
        ...PASCAL.EntryConditionsRoot,
        Comment: 'group note',
        Children: [
          {
            Note: 'node note',
            Leaf: {
              Type: 'IndicatorThreshold',
              IndicatorThreshold: {
                Indicator: 'Rsi',
                Period: 14,
                Operator: 'LessThan',
                Value: 30,
                CustomKnob: 7,
              },
              Why: 'leaf note',
            },
          },
          PASCAL.EntryConditionsRoot.Children[1],
        ],
      },
    };
    const emitted = JSON.parse(emitDsl(parse(src)));
    expect(emitted.Rationale).toBe('fade the dip');
    expect(emitted.entryConditionsRoot.Comment).toBe('group note');
    expect(emitted.entryConditionsRoot.children[0].Note).toBe('node note');
    expect(emitted.entryConditionsRoot.children[0].leaf.Why).toBe('leaf note');
    expect(emitted.entryConditionsRoot.children[0].leaf.indicatorThreshold.CustomKnob).toBe(7);
  });

  it('never blanks a leaf it does not understand', () => {
    const future = { Type: 'OrderFlowImbalance', OrderFlowImbalance: { Window: 20, Ratio: 1.4 } };
    const oddNode = { weird: true };
    const src = {
      ...CAMEL,
      entryConditionsRoot: { op: 'And', children: [{ leaf: future }, oddNode] },
    };
    const doc = parse(src);
    expect(doc.entryRoot!.children[0].leaf!.type).toBe('OrderFlowImbalance');
    expect(doc.entryRoot!.children[1].raw).toEqual(oddNode);
    const emitted = JSON.parse(emitDsl(doc));
    expect(emitted.entryConditionsRoot.children[0].leaf).toEqual({
      type: 'OrderFlowImbalance',
      orderFlowImbalance: { Window: 20, Ratio: 1.4 },
    });
    expect(emitted.entryConditionsRoot.children[1]).toEqual(oddNode);
  });

  it('keeps the exit tree', () => {
    const src = {
      ...CAMEL,
      ExitConditionsRoot: {
        Leaf: {
          Type: 'IndicatorThreshold',
          IndicatorThreshold: { Indicator: 'Rsi', Period: 14, Operator: 'GreaterThan', Value: 70 },
        },
      },
    };
    const emitted = JSON.parse(emitDsl(parse(src)));
    expect(emitted.exitConditionsRoot.leaf.indicatorThreshold.value).toBe(70);
  });
});

describe('round trip', () => {
  for (const [label, src] of [
    ['PascalCase', PASCAL],
    ['camelCase', CAMEL],
    ['old console shape', OLD_CONSOLE],
  ] as const) {
    it(`parse → emit → parse is lossless for ${label}`, () => {
      const first = parse(src);
      const emitted = emitDsl(first);
      const second = parse(JSON.parse(emitted));
      expect(shape(second)).toEqual(shape(first));
      // And emission is a fixed point.
      expect(emitDsl(second)).toBe(emitted);
    });
  }

  it('a rule with params, exit tree and every condition type survives the round trip', () => {
    const doc = newDoc({ name: 'All types', symbol: 'GBPUSD', timeframe: 'H1' });
    doc.entryRoot = {
      uid: 'r',
      op: 'And',
      children: CONDITION_TYPES.map((t, i) => ({
        uid: `c${i}`,
        op: null,
        children: [],
        leaf: {
          type: t.type,
          config:
            t.type === 'IndicatorThreshold'
              ? {
                  indicator: 'Macd',
                  period: 26,
                  operator: 'GreaterThan',
                  value: 0,
                  params: { fastPeriod: 12, slowPeriod: 26, source: 'Close' },
                }
              : { a: i },
        },
      })),
    };
    doc.exitRoot = {
      uid: 'x',
      op: 'Not',
      children: [
        {
          uid: 'y',
          op: null,
          children: [],
          leaf: { type: 'HourWindow', config: { startHourUtc: 1, endHourUtc: 5 } },
        },
      ],
    };
    const once = emitDsl(doc);
    const again = emitDsl(parse(JSON.parse(once)));
    expect(again).toBe(once);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('validateDsl', () => {
  const errors = (doc: DslDoc, ctx = {}) =>
    validateDsl(doc, ctx).filter((i) => i.severity === 'error');
  const warnings = (doc: DslDoc, ctx = {}) =>
    validateDsl(doc, ctx).filter((i) => i.severity === 'warning');

  it('accepts a well-formed rule', () => {
    expect(validateDsl(parse(CAMEL), { timeframe: 'H1', symbol: 'EURUSD' })).toEqual([]);
  });

  it('a new document is valid and v2', () => {
    const doc = newDoc({ name: 'x', symbol: 'EURUSD', timeframe: 'H1' });
    expect(doc.fields['dslVersion']).toBe(2);
    expect(validateDsl(doc, { timeframe: 'H1' })).toEqual([]);
  });

  it('rejects an AND/OR with one child, an empty group and a NOT with two', () => {
    const leaf = CAMEL.entryConditionsRoot.children[0];
    expect(
      errors(parse({ ...CAMEL, entryConditionsRoot: { op: 'And', children: [leaf] } }))[0].message,
    ).toMatch(/one condition/);
    expect(
      errors(parse({ ...CAMEL, entryConditionsRoot: { op: 'Or', children: [] } }))[0].message,
    ).toMatch(/Empty OR/);
    expect(
      errors(parse({ ...CAMEL, entryConditionsRoot: { op: 'Not', children: [leaf, leaf] } }))[0]
        .message,
    ).toMatch(/exactly one/);
  });

  it('requires the fields the engine cannot default', () => {
    const doc = parse({ entryConditionsRoot: CAMEL.entryConditionsRoot });
    const paths = errors(doc).map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'name',
        'symbol',
        'timeframe',
        'direction',
        'stopLossAtrMultiplier',
        'takeProfitAtrMultiplier',
      ]),
    );
  });

  it('flags a higher timeframe that is not higher than the strategy', () => {
    const htf = (tf: string) =>
      parse({
        ...CAMEL,
        entryConditionsRoot: {
          leaf: {
            type: 'HtfIndicatorThreshold',
            htfIndicatorThreshold: {
              higherTimeframe: tf,
              indicator: 'Rsi',
              period: 14,
              operator: 'GreaterThan',
              value: 50,
            },
          },
        },
      });
    expect(errors(htf('D1'), { timeframe: 'H1' })).toEqual([]);
    const bad = errors(htf('H1'), { timeframe: 'H4' });
    expect(bad[0].path).toBe('entryConditionsRoot.leaf.htfIndicatorThreshold.higherTimeframe');
    expect(errors(htf('W1'), { timeframe: 'H1' })[0].message).toMatch(/not one of/);
  });

  it('rejects regimes the engine does not have', () => {
    const doc = parse({
      ...CAMEL,
      entryConditionsRoot: {
        leaf: { type: 'RegimeMatch', regimeMatch: { allowedRegimes: ['Volatile'] } },
      },
    });
    expect(errors(doc)[0].message).toMatch(/Unknown regime 'Volatile'/);
  });

  it('rejects a BarsSince inside a BarsSince and a missing inner condition', () => {
    const nested = parse({
      ...CAMEL,
      entryConditionsRoot: {
        leaf: {
          type: 'BarsSince',
          barsSince: {
            inner: {
              type: 'BarsSince',
              barsSince: { maxLookback: 5, operator: 'LessThan', value: 1 },
            },
            maxLookback: 10,
            operator: 'LessThan',
            value: 3,
          },
        },
      },
    });
    expect(errors(nested).map((i) => i.message)).toContain(
      'BarsSince cannot be nested inside another BarsSince',
    );
    const noInner = parse({
      ...CAMEL,
      entryConditionsRoot: {
        leaf: { type: 'BarsSince', barsSince: { maxLookback: 10, operator: 'LessThan', value: 3 } },
      },
    });
    expect(errors(noInner)[0].message).toMatch(/inner condition/);
  });

  it('flags the always/never-true rules the shipped examples used to contain', () => {
    const emaAboveZero = parse({
      ...CAMEL,
      entryConditionsRoot: {
        leaf: {
          type: 'HtfIndicatorThreshold',
          htfIndicatorThreshold: {
            higherTimeframe: 'D1',
            indicator: 'Ema',
            period: 200,
            operator: 'GreaterThan',
            value: 0,
          },
        },
      },
    });
    expect(warnings(emaAboveZero, { timeframe: 'H1' })[0].message).toMatch(/always true/);

    const upperBelowMiddle = parse({
      ...CAMEL,
      entryConditionsRoot: {
        leaf: {
          type: 'IndicatorComparison',
          indicatorComparison: {
            leftIndicator: 'BollingerBandUpper',
            leftPeriod: 20,
            rightIndicator: 'Sma',
            rightPeriod: 20,
            operator: 'LessThan',
          },
        },
      },
    });
    expect(warnings(upperBelowMiddle)[0].message).toMatch(/never true/);
  });

  it('flags out-of-range numbers', () => {
    const doc = parse({
      ...CAMEL,
      stopLossAtrMultiplier: 0,
      entryConditionsRoot: {
        op: 'And',
        children: [
          {
            leaf: {
              type: 'IndicatorThreshold',
              indicatorThreshold: { indicator: 'Rsi', period: 1, operator: 'LessThan', value: 30 },
            },
          },
          {
            leaf: { type: 'Spread', spread: { operator: 'LessThan', threshold: 0, mode: 'Pips' } },
          },
        ],
      },
    });
    const paths = errors(doc).map((i) => i.path);
    expect(paths).toContain('stopLossAtrMultiplier');
    expect(paths).toContain('entryConditionsRoot.children[0].leaf.indicatorThreshold.period');
    expect(paths).toContain('entryConditionsRoot.children[1].leaf.spread.threshold');
  });

  it('checks math expressions like the engine parser', () => {
    expect(checkMathExpression('(High - Low) / Atr(14)')).toBeNull();
    expect(checkMathExpression('Close - BollingerBandUpper(20)')).toBeNull();
    expect(checkMathExpression('-Close + 2 * (Open)')).toBeNull();
    expect(checkMathExpression('(High - Low')).toMatch(/closing/);
    expect(checkMathExpression('Price - Low')).toMatch(/unknown bar field/);
    expect(checkMathExpression('Foo(3)')).toMatch(/unknown indicator/);
    expect(checkMathExpression('Rsi()')).toMatch(/numeric period/);
    expect(checkMathExpression('High % 2')).toMatch(/unexpected character/);
  });

  it('warns about params that do nothing for the selected indicator', () => {
    const doc = parse({
      ...CAMEL,
      dslVersion: 2,
      entryConditionsRoot: {
        leaf: {
          type: 'IndicatorThreshold',
          indicatorThreshold: {
            indicator: 'Rsi',
            period: 14,
            operator: 'LessThan',
            value: 30,
            params: { multiplier: 2 },
          },
        },
      },
    });
    expect(warnings(doc)[0].message).toMatch(/no effect/);
  });

  it('every issue path resolves to a node or a top-level field', () => {
    const doc = parse({
      name: '',
      entryConditionsRoot: {
        op: 'And',
        children: [
          {
            leaf: {
              type: 'IndicatorThreshold',
              indicatorThreshold: { indicator: 'Nope', period: 0 },
            },
          },
          {
            op: 'Or',
            children: [
              { leaf: { type: 'HourWindow', hourWindow: { startHourUtc: 30, endHourUtc: 2 } } },
            ],
          },
        ],
      },
    });
    const issues = validateDsl(doc);
    expect(issues.length).toBeGreaterThan(3);
    const index = indexIssues(doc, issues);
    expect(index.unplaced).toEqual([]);
  });
});

describe('validateDslJson', () => {
  it('reports invalid JSON as a path-less error', () => {
    expect(validateDslJson('{')).toEqual([
      expect.objectContaining({ path: '', severity: 'error' }),
    ]);
  });
});

// ── Issue paths ─────────────────────────────────────────────────────────────

describe('resolveIssuePath', () => {
  const doc = parse({
    ...CAMEL,
    entryConditionsRoot: {
      op: 'And',
      children: [
        CAMEL.entryConditionsRoot.children[0],
        {
          op: 'Or',
          children: [CAMEL.entryConditionsRoot.children[1], CAMEL.entryConditionsRoot.children[0]],
        },
      ],
    },
    exitConditionsRoot: CAMEL.entryConditionsRoot.children[0],
  });

  it('walks children indices to the node', () => {
    const t = resolveIssuePath(doc, 'entryConditionsRoot.children[1].children[0].leaf');
    expect(t.node).toBe(doc.entryRoot!.children[1].children[0]);
    expect(t.tree).toBe('entry');
    expect(t.field).toBeNull();
  });

  it('is case-insensitive and keeps the field remainder', () => {
    const t = resolveIssuePath(
      doc,
      'EntryConditionsRoot.Children[1].Children[0].Leaf.PriceVsMa.MaPeriod',
    );
    expect(t.node).toBe(doc.entryRoot!.children[1].children[0]);
    expect(t.field).toBe('pricevsma.maperiod');
  });

  it('resolves the exit tree, group nodes and top-level fields', () => {
    expect(resolveIssuePath(doc, 'exitConditionsRoot.leaf').node).toBe(doc.exitRoot);
    expect(resolveIssuePath(doc, 'entryConditionsRoot.children[1]').node).toBe(
      doc.entryRoot!.children[1],
    );
    expect(resolveIssuePath(doc, 'StopLossAtrMultiplier').topField).toBe('stopLossAtrMultiplier');
  });

  it('stops at the deepest node that exists', () => {
    expect(resolveIssuePath(doc, 'entryConditionsRoot.children[9].leaf').node).toBe(doc.entryRoot);
  });

  it('maps legacy entryConditions[i] paths onto the derived tree', () => {
    const legacy = parse({
      ...CAMEL,
      entryConditionsRoot: undefined,
      entryConditions: [
        { type: 'PriceVsMa', priceVsMa: { maPeriod: 50, operator: 'GreaterThan' } },
        { type: 'HourWindow', hourWindow: { startHourUtc: 7, endHourUtc: 16 } },
      ],
    });
    expect(resolveIssuePath(legacy, 'entryConditions[1].hourWindow.startHourUtc').node).toBe(
      legacy.entryRoot!.children[1],
    );
  });
});

// ── Transforms and helpers ──────────────────────────────────────────────────

describe('upgradeDocToV2', () => {
  it('turns v1 Spread (bar range) into BarRange everywhere and stamps v2', () => {
    const doc = parse({
      ...CAMEL,
      entryConditionsRoot: {
        op: 'And',
        children: [
          {
            leaf: {
              type: 'Spread',
              spread: { operator: 'LessThan', threshold: 0.5, mode: 'AtrFraction', atrPeriod: 14 },
            },
          },
          {
            leaf: {
              type: 'BarsSince',
              barsSince: {
                inner: {
                  type: 'Spread',
                  spread: { operator: 'GreaterThan', threshold: 2, mode: 'Pips' },
                },
                maxLookback: 20,
                operator: 'LessThanOrEqual',
                value: 3,
              },
            },
          },
        ],
      },
    });
    expect(upgradeDocToV2(doc)).toBe(2);
    const emitted = JSON.parse(emitDsl(doc));
    expect(emitted.dslVersion).toBe(2);
    expect(emitted.entryConditionsRoot.children[0].leaf).toEqual({
      type: 'BarRange',
      barRange: { operator: 'LessThan', threshold: 0.5, mode: 'AtrFraction', atrPeriod: 14 },
    });
    expect(emitted.entryConditionsRoot.children[1].leaf.barsSince.inner.type).toBe('BarRange');
  });
});

describe('helpers', () => {
  it('patchDslFields rewrites top-level fields and returns null for bad JSON', () => {
    const out = JSON.parse(
      patchDslFields(JSON.stringify(PASCAL), { symbol: 'GBPUSD', timeframe: 'H4' })!,
    );
    expect(out.symbol).toBe('GBPUSD');
    expect(out.timeframe).toBe('H4');
    expect(out.Symbol).toBeUndefined();
    expect(patchDslFields('{', { symbol: 'X' })).toBeNull();
  });

  it('higherTimeframes lists only strictly higher engine timeframes', () => {
    expect(higherTimeframes('H4')).toEqual(['D1']);
    expect(higherTimeframes('D1')).toEqual([]);
    expect(higherTimeframes('M15')).toEqual(['H1', 'H4', 'D1']);
    expect(higherTimeframes(null)).toEqual(['M1', 'M5', 'M15', 'H1', 'H4', 'D1']);
  });

  it('relevantParamKeys follows the indicator(s) of the condition', () => {
    expect(
      relevantParamKeys({ type: 'IndicatorThreshold', config: { indicator: 'MacdHistogram' } }),
    ).toEqual(['fastPeriod', 'slowPeriod', 'signalPeriod', 'source']);
    expect(relevantParamKeys({ type: 'IndicatorThreshold', config: { indicator: 'Adx' } })).toEqual(
      [],
    );
    expect(
      relevantParamKeys({
        type: 'IndicatorCrossover',
        config: { leftIndicator: 'StochasticK', rightIndicator: 'StochasticD' },
      }),
    ).toEqual(['smoothK', 'smoothD']);
    expect(relevantParamKeys({ type: 'PriceVsMa', config: {} })).toEqual([]);
  });

  it('lists the fourteen condition types', () => {
    expect(CONDITION_TYPES.map((t) => t.type)).toEqual([
      'IndicatorThreshold',
      'PriceVsMa',
      'RegimeMatch',
      'HourWindow',
      'IndicatorComparison',
      'IndicatorCrossover',
      'IndicatorCrossunder',
      'VolumeRatio',
      'BarsSince',
      'Spread',
      'CandlePattern',
      'MathExpression',
      'HtfIndicatorThreshold',
      'BarRange',
    ]);
  });
});
