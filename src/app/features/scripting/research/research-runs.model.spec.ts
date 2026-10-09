import { describe, expect, it } from 'vitest';

import {
  defaultLauncher,
  evidenceRows,
  foldEstimate,
  holdoutText,
  isActiveRun,
  launchRequest,
  objectiveLabel,
  parseHoldout,
  runStageText,
} from './research-runs.model';
import type { OptimizationSelectionDto } from './research.types';

describe('research run helpers (PE-I4, BT-I4, BT-I5)', () => {
  it('knows which runs are still going and what they ranked by', () => {
    expect(isActiveRun('Queued')).toBe(true);
    expect(isActiveRun('Running')).toBe(true);
    expect(isActiveRun('Completed')).toBe(false);
    expect(objectiveLabel(null)).toBe('Health score');
    expect(objectiveLabel('{"ranges":{},"locked":{},"objective":"ExpectancyR"}')).toBe(
      'Expectancy (R per trade)',
    );
    expect(objectiveLabel('not json')).toBe('Health score');
  });

  it('puts a run’s stage and failure in words', () => {
    expect(
      runStageText({
        status: 'Running',
        executionStage: 'Search',
        executionStageMessage: '12 of 40 evaluations',
      }),
    ).toBe('Running — Search: 12 of 40 evaluations');
    expect(
      runStageText({
        status: 'Failed',
        failureCategory: 'ConfigError',
        errorMessage: 'the spec no longer fits',
      }),
    ).toBe('Failed (ConfigError): the spec no longer fits');
    expect(
      runStageText({
        status: 'Queued',
        deferralReason: 'DrawdownRecovery',
        deferredUntilUtc: '2026-10-09T12:00:00Z',
      }),
    ).toBe('Queued — deferred (DrawdownRecovery) until 2026-10-09 12:00 UTC');
    expect(runStageText({ status: 'Completed', executionStage: 'Completed' })).toBe('Completed');
  });

  it('reads the holdout once scored, and says it is locked until then', () => {
    const json = JSON.stringify({
      WalkForwardRunId: 9,
      SharpeRatio: 0.8,
      TotalTrades: 14,
      ExpectancyR: 0.12,
      FoldsAverageSharpe: 1.1,
      Unscorable: false,
    });
    expect(parseHoldout(json)).toMatchObject({
      walkForwardRunId: 9,
      sharpeRatio: 0.8,
      totalTrades: 14,
      unscorable: false,
    });
    expect(parseHoldout('bad')).toBeNull();

    expect(
      holdoutText({ status: 'Completed', terminalHoldoutFromUtc: '2026-08-01T00:00:00Z' }),
    ).toContain('Locked');
    expect(
      holdoutText({
        status: 'Completed',
        holdoutScoredAt: '2026-10-01T00:00:00Z',
        holdoutResultJson: json,
      }),
    ).toBe(
      'Scored once at approval: Sharpe 0.80 over 14 trades, 0.120 R per trade (folds averaged 1.10).',
    );
    expect(
      holdoutText({
        status: 'Completed',
        holdoutScoredAt: 'x',
        holdoutResultJson: JSON.stringify({ Unscorable: true }),
      }),
    ).toContain('too short');
  });

  it('checks a walk-forward launch before sending it', () => {
    const strategy = { id: 7, symbol: 'EURUSD', timeframe: 'H1' };
    const d = defaultLauncher(new Date(Date.UTC(2026, 9, 9)));
    const req = launchRequest(d, strategy);
    expect(req).toMatchObject({
      strategyId: 7,
      symbol: 'EURUSD',
      timeframe: 'H1',
      inSampleDays: 90,
      outOfSampleDays: 30,
      reOptimizePerFold: true,
      windowMode: 'Anchored',
      fromDate: '2025-10-09T00:00:00.000Z',
    });
    expect(foldEstimate(d)).toBe(7); // (365 × 0.9 − 90) / 30

    expect(launchRequest({ ...d, toDate: d.fromDate }, strategy)).toBe(
      'The end date must be after the start date.',
    );
    expect(launchRequest({ ...d, inSampleDays: '0' }, strategy)).toContain('In-sample days');
    expect(
      launchRequest({ ...d, inSampleDays: '300', outOfSampleDays: '100' }, strategy),
    ).toContain('longer than the date range');
    expect(launchRequest(d, { ...strategy, symbol: null })).toContain('no symbol');
  });

  it('lays the engine’s overfitting numbers out against the promotion limits', () => {
    const s: OptimizationSelectionDto = {
      selectedParametersJson: '{}',
      selectedIsWinner: true,
      selectedSharpeR: 0.2,
      selectedRTrades: 120,
      runTrials: 60,
      ledgerTrials: 300,
      peerStrategies: 31,
      effectiveTrials: 300,
      deflatedSharpeRun: 1.4,
      deflatedSharpeEffective: 0.6,
      minDsr: 1,
      pbo: 0.45,
      pboBlocks: 5,
      pboCombinations: 10,
      pboMedianLogit: -0.2,
      pboWhyNot: null,
      maxPbo: 0.3,
      degradationSlope: -0.8,
      warnings: [],
    };
    const rows = evidenceRows(s);
    expect(rows.map((r) => [r.label, r.value, r.ok])).toEqual([
      ['Deflated Sharpe (effective trials)', '0.60', false],
      ['Deflated Sharpe (this run)', '1.40', true],
      ['Probability of backtest overfitting', '45%', false],
      ['Out-of-sample vs in-sample slope', '−0.80', false],
    ]);
    const unmeasured = evidenceRows({
      ...s,
      pbo: null,
      pboWhyNot: '3 fold(s) with trades, fewer than 4',
      degradationSlope: null,
    });
    expect(unmeasured[2]).toMatchObject({
      value: 'not measurable',
      ok: null,
      note: '3 fold(s) with trades, fewer than 4',
    });
    expect(unmeasured[3].ok).toBeNull();
  });
});
