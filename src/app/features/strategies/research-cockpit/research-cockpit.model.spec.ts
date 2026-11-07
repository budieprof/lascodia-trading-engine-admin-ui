import { describe, expect, it } from 'vitest';

import { configHashColumn } from '../util/config-hash-column';
import {
  execQualitySummary,
  hashRelation,
  holdoutView,
  isNotOffered,
  isPipelineActive,
  parseLabImport,
  pipelineSteps,
  readCalibration,
  readSequential,
  readSpecHistory,
  shortHash,
  stitchedRows,
} from './research-cockpit.model';
import type { StrategyHoldoutDto, ValidationPipelineDto } from './research-cockpit.types';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

describe('C1 hash', () => {
  it('shortens a real hash and refuses anything else', () => {
    expect(shortHash(H1)).toBe('aaaaaaaa');
    expect(shortHash('not-a-hash')).toBe('');
    expect(shortHash(null)).toBe('');
  });
  it('says current / older only when both are known', () => {
    expect(hashRelation(H1, H1)).toBe('current');
    expect(hashRelation(H1, H2)).toBe('older');
    expect(hashRelation(H1, null)).toBe('unknown');
  });
  it('grid column formats a stamp and leaves legacy rows as a dash', () => {
    const col = configHashColumn(() => H2);
    const fmt = col.valueFormatter as (p: { value: unknown }) => string;
    expect(fmt({ value: H1 })).toBe('aaaaaaaa (older)');
    expect(fmt({ value: H2 })).toBe('bbbbbbbb');
    expect(fmt({ value: null })).toBe('—');
  });
});

describe('validation pipeline stepper (S13)', () => {
  const p: ValidationPipelineDto = {
    id: 3,
    strategyId: 9,
    status: 'Running',
    currentStep: 'WalkForward',
    backtestRunId: 812,
    walkForwardRunId: 77,
    steps: [
      { name: 'Backtest', status: 'Completed', runId: 812, outcome: 'backtest 812 completed' },
      { name: 'WalkForward', status: 'Running', runId: 77 },
    ],
  };

  it('lays out the four steps in order with links to their runs', () => {
    const steps = pipelineSteps(p);
    expect(steps.map((s) => s.name)).toEqual(['Backtest', 'WalkForward', 'Gates', 'Paper']);
    expect(steps[0].tone).toBe('done');
    expect(steps[0].link).toEqual(['/backtests', 812]);
    expect(steps[1].tone).toBe('running');
    expect(steps[1].link).toEqual(['/walk-forward', 77]);
    expect(steps[2].statusText).toBe('Waiting');
    expect(steps[3].link).toBeNull();
  });

  it('is active only while queued or running', () => {
    expect(isPipelineActive(p)).toBe(true);
    expect(isPipelineActive({ status: 'Completed' })).toBe(false);
    expect(isPipelineActive(null)).toBe(false);
  });
});

describe('lineage holdout (V03)', () => {
  const base: StrategyHoldoutDto = {
    id: 1,
    lineageRootStrategyId: 5,
    fromUtc: '2026-05-01T00:00:00',
    toUtc: '2026-11-01T00:00:00',
    status: 'Locked',
    mode: 'Enforce',
  };

  it('offers evaluate on a locked holdout and re-carve on a spent one', () => {
    expect(holdoutView(base).canEvaluate).toBe(true);
    expect(holdoutView(base).canRecarve).toBe(false);
    const spent = holdoutView({
      ...base,
      status: 'Spent',
      spentAtUtc: '2026-11-05T10:00:00',
      spentOnCurrentConfiguration: false,
      result: {
        expectancyR: 0.12,
        totalTrades: 40,
        rTrades: 38,
        winRate: 0.55,
        profitFactor: 9999,
        maxDrawdownPct: 4.2,
        touchedByRuns: 2,
      },
    });
    expect(spent.canEvaluate).toBe(false);
    expect(spent.canRecarve).toBe(true);
    expect(spent.statusLine).toContain('ANOTHER configuration');
    const v = Object.fromEntries(spent.result.map((r) => [r.label, r.value]));
    expect(v['Win rate']).toBe('55.0%'); // fraction → percent
    expect(v['Profit factor']).toBe('∞'); // 9999 sentinel
    expect(v['Max drawdown']).toBe('4.20%'); // already percent
    expect(v['Contamination']).toContain('2 lineage run');
  });

  it('says Record mode with the engine’s reason', () => {
    expect(
      holdoutView({ ...base, mode: 'Record', modeReason: 'lineage has live members' }).modeLine,
    ).toContain('lineage has live members');
  });
});

describe('stitched OOS (C10)', () => {
  it('reads the stitched fields and the t-statistic', () => {
    const rows = stitchedRows({
      id: 1,
      oosExpectancyR: 0.15,
      oosSharpeR: 0.2,
      oosRTrades: 100,
      oosTrades: 104,
      walkForwardEfficiency: 0.62,
      parameterDriftScore: 0.3,
      foldCount: 9,
      zeroTradeFolds: 1,
    });
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by['Out-of-sample expectancy'].value).toBe('+0.150 R');
    expect(by['Sharpe in R (per trade)'].note).toContain('t-statistic 2.00');
    expect(by['Walk-forward efficiency'].value).toBe('62%');
    expect(by['Folds'].value).toBe('9 (1 without a trade)');
  });
});

describe('lab import file check (V16)', () => {
  const ok = {
    windowFromUtc: '2024-01-01T00:00:00Z',
    windowToUtc: '2025-01-01T00:00:00Z',
    tradeR: [1, -1, 0.5],
    dataHash: 'd1',
    codeHash: 'c1',
    inputsByTitle: { Length: 20 },
  };

  it('accepts { batch, trials } and a bare array', () => {
    const a = parseLabImport(JSON.stringify({ batch: 'mr-v4', trials: [ok] }), '');
    expect(a.errors).toEqual([]);
    expect(a.batch).toBe('mr-v4');
    const b = parseLabImport(JSON.stringify([ok, ok]), 'form-batch');
    expect(b.errors).toEqual([]);
    expect(b.trials).toHaveLength(2);
    expect(b.batch).toBe('form-batch');
  });

  it('refuses what the engine would refuse', () => {
    expect(parseLabImport('not json', 'x').errors[0]).toContain('not JSON');
    expect(parseLabImport('[]', 'x').errors).toContain('The file has no trials.');
    expect(parseLabImport(JSON.stringify([ok]), '').errors[0]).toContain('batch name');
    const bad = parseLabImport(
      JSON.stringify([
        { ...ok, windowToUtc: '2023-01-01T00:00:00Z', dataHash: '', tradeR: [1, 'x'] },
      ]),
      'x',
    );
    expect(bad.errors.join(' ')).toContain('after windowFromUtc');
    expect(bad.errors.join(' ')).toContain('dataHash');
    expect(bad.errors.join(' ')).toContain('finite numbers');
    expect(parseLabImport(JSON.stringify(Array(501).fill(ok)), 'x').errors[0]).toContain(
      'At most 500',
    );
  });
});

describe('tolerant readers for views the engine does not expose yet', () => {
  it('treats 404 / 405 as "not offered"', () => {
    expect(isNotOffered({ status: 404 })).toBe(true);
    expect(isNotOffered({ status: 500 })).toBe(false);
  });

  it('reads sequential test state and calibration profiles', () => {
    const seq = readSequential({
      mode: 'Observe',
      states: [{ strategyConfigHash: H1, statistic: -2.5, threshold: 5, observations: 31 }],
    });
    expect(seq.mode).toBe('Observe');
    expect(seq.rows[0].statistic).toBe(-2.5);
    const cal = readCalibration([
      {
        brokerKey: 'Exness-MT5Real',
        sessionBucket: 'London',
        computedAtUtc: '2026-11-07T00:00:00',
        sampleCount: 40,
        slippagePips: { mean: 0.2, p50: 0.1, p90: 0.6 },
        latencyMs: { p50: 180, p90: 420 },
      },
    ]);
    expect(cal[0].slipP90).toBe(0.6);
    expect(cal[0].latencyP50).toBe(180);
    expect(readCalibration(null)).toEqual([]);
  });

  it('lists spec changes per broker key, newest first, with only changed fields', () => {
    const rows = readSpecHistory([
      {
        brokerKey: 'account:1',
        validFromUtc: '2026-11-01T00:00:00',
        stopsLevel: 0,
        tickSize: 0.00001,
      },
      {
        brokerKey: 'account:1',
        validFromUtc: '2026-11-03T00:00:00',
        stopsLevel: 10,
        tickSize: 0.00001,
      },
    ]);
    expect(rows[0].validFromUtc).toBe('2026-11-03T00:00:00');
    expect(rows[0].changes).toEqual([{ field: 'stopsLevel', from: '0', to: '10' }]);
    expect(rows[1].changes.map((c) => c.field)).toEqual(['stopsLevel', 'tickSize']);
  });
});

describe('execution quality summary (C4)', () => {
  it('uses the recorded pips and submit→fill latency unless the C4 fields are present', () => {
    const s = execQualitySummary([
      { session: 'London', slippagePips: 0.2, submitToFillMs: 100 },
      { session: 'London', slippagePips: 0.4, submitToFillMs: 0, wasPartialFill: true },
      { session: 'NewYork', slippagePips: 1, submitToFillMs: 300 },
    ]);
    expect(s.slippageBasis).toBe('recorded');
    expect(s.latencyBasis).toBe('submitToFill');
    const all = s.groups[0];
    expect(all.session).toBe('All');
    expect(all.fills).toBe(3);
    expect(all.partial).toBe(1);
    expect(all.latP50).toBe(200); // the 0 ms async row is "not measured"
    const c4 = execQualitySummary([
      { slippagePips: 3, engineSlippagePips: 0.3, submitToFillMs: 0, sendToFillMs: 250 },
    ]);
    expect(c4.slippageBasis).toBe('engine');
    expect(c4.groups[0].slipP50).toBe(0.3);
    expect(c4.groups[0].latP50).toBe(250);
  });
});
