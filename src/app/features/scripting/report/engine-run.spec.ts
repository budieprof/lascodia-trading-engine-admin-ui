import { describe, expect, it } from 'vitest';

import { inputDifferences, parseEngineRun } from './engine-run';

const RESULT = {
  TotalCommission: 12.5,
  TotalSwap: -3.25,
  TotalSlippage: 40.1,
  CostModel: 'Snapshot',
  CostBreakevenPipsPerTrade: 1.8,
  ExpectancyR: 0.21,
  RMultipleTradeCount: 48,
  PctReachedOneR: 55.5,
  Trades: [{ RMultiple: 1.2 }, { RMultiple: -1 }],
  report: { meta: {} },
  script: {
    costModel: 'Overlay(spread+swap)',
    costModelReason: 'Engine costs',
    operatorAdHoc: true,
    deep: false,
    barMagnifier: true,
    chartTimeframe: 'H1',
    chartSource: 'Candles',
    warmupBars: 500,
    bars: 6000,
    tradingStartUtc: '2025-01-01T00:00:00Z',
    initialCapital: 10000,
    capitalSource: 'EngineDefault',
    accountCurrency: 'USD',
    inputs: { len: 20, mode: 'fast' },
    ignoredInputs: ['gone: no input with this id'],
    sourceHash: 'ABCDEF0123456789',
    languageVersion: 6,
    compileWarnings: ['PS9002 (3:1) No stop'],
    lazyLoads: [],
    elapsedMs: 1234,
    executions: 6500,
    priceShock: { size: 0.002 },
  },
};

describe('parseEngineRun', () => {
  it('reads the trades, the cost totals and the R statistics (PascalCase)', () => {
    const run = parseEngineRun(JSON.stringify(RESULT))!;
    expect(run.trades).toHaveLength(2);
    expect(run.costs).toEqual({
      commission: 12.5,
      swap: -3.25,
      slippage: 40.1,
      model: 'Snapshot',
      breakevenPipsPerTrade: 1.8,
    });
    expect([run.expectancyR, run.rTradeCount, run.pctReachedOneR]).toEqual([0.21, 48, 55.5]);
  });

  it('reads how the run was made (the camelCase script section)', () => {
    const p = parseEngineRun(RESULT)!.provenance!;
    expect(p.sourceHash).toBe('abcdef0123456789');
    expect(p.inputs).toEqual({ len: 20, mode: 'fast' });
    expect(p.ignoredInputs).toEqual(['gone: no input with this id']);
    expect(p.compileWarnings).toEqual(['PS9002 (3:1) No stop']);
    expect([p.operatorAdHoc, p.deep, p.barMagnifier, p.priceShock]).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect([p.warmupBars, p.bars, p.initialCapital, p.elapsedMs]).toEqual([500, 6000, 10000, 1234]);
    expect(p.costModel).toBe('Overlay(spread+swap)');
  });

  it('is null for text that is not a result, and has no provenance for a rule run', () => {
    expect(parseEngineRun('not json')).toBeNull();
    expect(parseEngineRun(null)).toBeNull();
    const rule = parseEngineRun({ Trades: [], TotalCommission: 0 })!;
    expect(rule.provenance).toBeNull();
    expect(rule.costs!.commission).toBe(0);
    expect(parseEngineRun({ Trades: [] })!.costs).toBeNull();
  });
});

describe('inputDifferences', () => {
  it('lists the inputs that differ, comparing values as text', () => {
    expect(
      inputDifferences({ len: 20, mode: 'fast', src: 'close' }, { len: '20', mode: 'slow', x: 1 }),
    ).toEqual([
      { id: 'mode', run: 'fast', now: 'slow' },
      { id: 'src', run: 'close', now: null },
      { id: 'x', run: null, now: '1' },
    ]);
    expect(inputDifferences({}, {})).toEqual([]);
  });
});
