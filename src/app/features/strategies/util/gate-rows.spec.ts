import { describe, expect, it } from 'vitest';

import type { PromotionGateRowDto } from '@core/api/api.types';
import {
  failedGateLines,
  fmtGateNumber,
  gateLabel,
  gateOutcome,
  gateOutcomeCounts,
  gateRowViews,
  gateValueVsThreshold,
} from './gate-rows';

// The shape the engine serialises (engine master 178303b0, PromotionGateRow + DisplayName).
const ROWS: PromotionGateRowDto[] = [
  {
    gate: 'dsr',
    outcome: 'Fail',
    value: 0.812,
    threshold: 0.95,
    unit: 'probability',
    comparator: '>=',
    detail: 'PSR vs E[max] of 99 trials',
    displayName: null,
  },
  {
    gate: 'cpcv',
    outcome: 'Pass',
    value: 0.41,
    threshold: 0.2,
    unit: 'per-trade Sharpe',
    comparator: '>=',
    detail: 'p25 of 16 slices',
    displayName: 'Time-dispersion stress',
  },
  {
    gate: 'spa',
    outcome: 'Observe',
    value: 0.03,
    threshold: 0.05,
    unit: 'p-value',
    comparator: '<=',
    detail: 'would pass',
    displayName: 'Superior predictive ability (SPA)',
  },
  {
    gate: 'plateau',
    outcome: 'NotMeasurable',
    value: null,
    threshold: 0.5,
    unit: 'score',
    comparator: '>=',
    detail: 'no optimization run',
    displayName: 'Parameter plateau',
  },
  {
    gate: 'paper',
    outcome: 'Bypassed',
    value: null,
    threshold: null,
    unit: null,
    comparator: null,
    detail: 'operator override',
    displayName: 'Paper trading',
  },
  {
    gate: 'monte_carlo',
    outcome: 'Skipped',
    value: null,
    threshold: null,
    unit: null,
    comparator: null,
    detail: 'Promotion:DisableGates',
  },
];

describe('gate rows (contract C2)', () => {
  it('reads every outcome by name, ordinal or loose casing', () => {
    expect(gateOutcome('NotMeasurable')).toBe('NotMeasurable');
    expect(gateOutcome('not_measurable')).toBe('NotMeasurable');
    expect(gateOutcome(0)).toBe('Pass');
    expect(gateOutcome(5)).toBe('Observe');
    expect(gateOutcome('Whatever')).toBeNull();
    expect(gateOutcome(undefined)).toBeNull();
  });

  it('labels gates with the engine display name first', () => {
    expect(gateLabel(ROWS[1])).toBe('Time-dispersion stress');
    expect(gateLabel({ gate: 'cpcv', displayName: null })).toBe('Time-dispersion stress');
    expect(gateLabel({ gate: 'monte_carlo' })).toBe('Monte carlo');
    expect(gateLabel({ gate: 'dsr' })).toBe('Deflated Sharpe (DSR)');
  });

  it('writes value and what passing needs, never a false inequality', () => {
    expect(gateValueVsThreshold(ROWS[0])).toBe('0.812 probability (needs ≥ 0.95)');
    expect(gateValueVsThreshold(ROWS[2])).toBe('0.03 p-value (needs ≤ 0.05)');
    expect(gateValueVsThreshold(ROWS[3])).toBe('needs ≥ 0.5 score');
    expect(gateValueVsThreshold(ROWS[4])).toBe('—');
    expect(gateValueVsThreshold({ value: 12.5, threshold: 10, unit: '%', comparator: '<=' })).toBe(
      '12.5% (needs ≤ 10%)',
    );
  });

  it('formats gate numbers', () => {
    expect(fmtGateNumber(1234.567)).toBe('1234.6');
    expect(fmtGateNumber(1.23456)).toBe('1.23');
    expect(fmtGateNumber(0.000012)).toBe('1.20e-5');
    expect(fmtGateNumber(null)).toBe('—');
  });

  it('maps rows to views with tones, and NotMeasurable is never a pass', () => {
    const v = gateRowViews(ROWS);
    expect(v.map((x) => x.tone)).toEqual(['fail', 'pass', 'warn', 'warn', 'bypass', 'skip']);
    expect(v.map((x) => x.outcomeLabel)).toEqual([
      'Fail',
      'Pass',
      'Observe',
      'Not measurable',
      'Bypassed',
      'Skipped',
    ]);
    expect(v[3].hint).toMatch(/not a pass/);
    expect(gateRowViews(null)).toEqual([]);
  });

  it('counts outcomes and lists failures', () => {
    const v = gateRowViews(ROWS);
    expect(gateOutcomeCounts(v)).toBe(
      '1 pass · 1 fail · 1 skipped · 1 not measurable · 1 bypassed · 1 observe',
    );
    expect(failedGateLines(v)).toEqual([
      'Deflated Sharpe (DSR): 0.812 probability (needs ≥ 0.95) — PSR vs E[max] of 99 trials',
    ]);
  });
});
