import { describe, expect, it } from 'vitest';

import {
  controlKind,
  effective,
  emptyGroup,
  fairnessSum,
  groupProblems,
  keyGroup,
  keyLabel,
  progressPct,
  relative,
  routerSuggested,
  slippageText,
  statusTone,
  ticketAlgoFields,
  toggleMember,
  valueProblem,
} from './execution.logic';
import type { BlockOrder, ExecutionKey } from './execution.types';

const key = (k: string, dataType: ExecutionKey['dataType'], value: string | null, def: string): ExecutionKey => ({
  key: k, dataType, value, default: def, description: '', lastChangedAtUtc: null, lastChangedBy: null,
});

describe('execution logic (gaps program, execution)', () => {
  it('shows fill progress and slippage in plain words', () => {
    expect(progressPct({ filledQuantity: 1.5, totalQuantity: 3 })).toBe(50);
    expect(progressPct({ filledQuantity: 0, totalQuantity: 0 })).toBe(0);
    expect(slippageText(2)).toContain('worse');
    expect(slippageText(-1.5)).toContain('better');
    expect(slippageText(null)).toBe('—');
    expect(statusTone('Failed')).toBe('bad');
    expect(statusTone('Paused')).toBe('warn');
  });

  it('types each setting and checks drafts against the engine bounds', () => {
    const enabled = key('Execution:Algo:Enabled', 3, null, 'false');
    const mode = key('Execution:SmartRouter:Mode', 'String', 'Suggest', 'Suggest');
    const ttl = key('Execution:Algo:ChildTtlSeconds', 1, '120', '120');
    expect(controlKind(enabled)).toBe('bool');
    expect(controlKind(mode)).toBe('mode');
    expect(controlKind(ttl)).toBe('number');
    expect(effective(enabled)).toBe('false');
    expect(valueProblem(mode, 'Auto')).toBeNull();
    expect(valueProblem(mode, 'Yes')).not.toBeNull();
    expect(valueProblem(ttl, '10')).toContain('between 30');
    expect(valueProblem(ttl, '1.5')).toBe('a whole number');
    expect(valueProblem(ttl, '300')).toBeNull();
    expect(keyLabel('Execution:Algo:ChildTtlSeconds')).toBe('Child ttl seconds');
    expect(keyGroup('Execution:SmartRouter:Mode')).toBe('Smart router');
    expect(keyGroup('Execution:Allocation:Enabled')).toBe('Block allocation');
  });

  it('reads the router decision and relative times', () => {
    expect(routerSuggested({ id: 1, kind: 'RouterSuggestion', message: '', orderId: null, tradeSignalId: 5, data: { suggested: 'TWAP' }, occurredAtUtc: '' })).toBe('TWAP');
    expect(routerSuggested({ id: 1, kind: 'RouterSuggestion', message: '', orderId: null, tradeSignalId: 5, data: null, occurredAtUtc: '' })).toBeNull();
    const now = new Date('2026-11-02T10:00:00Z');
    expect(relative('2026-11-02T09:57:00Z', now)).toBe('3 min ago');
    expect(relative('2026-11-02T10:00:30Z', now)).toBe('in 30 s');
    expect(relative(null, now)).toBe('never');
  });

  it('validates an allocation group', () => {
    const g = emptyGroup();
    expect(groupProblems(g).length).toBeGreaterThan(0);
    const ok = { ...g, name: 'MAM', strategyId: 7, members: toggleMember([], 101) };
    expect(groupProblems(ok)).toEqual([]);
    expect(toggleMember(ok.members, 101)).toEqual([]);
    expect(groupProblems({ ...ok, method: 'EqualRisk', riskFraction: 0.5 })[0]).toContain('10 %');
  });

  it('sums the fairness of a block (zero-sum when allocated)', () => {
    const b = { allocations: [{ fairnessAmount: -30 }, { fairnessAmount: 30 }, { fairnessAmount: null }] } as unknown as BlockOrder;
    expect(fairnessSum(b)).toBe(0);
  });

  it('adds algorithm fields only to a live ticket that chose one', () => {
    expect(ticketAlgoFields('Paper', 'TWAP', 15, 5, null)).toEqual({});
    expect(ticketAlgoFields('Live', 'Direct', 15, 5, null)).toEqual({});
    expect(ticketAlgoFields('Live', 'TWAP', 15, 5, null)).toEqual({
      executionAlgorithm: 'TWAP', algoDurationSeconds: 900, algoSlices: 5, algoDisplayQuantity: null,
    });
    expect(ticketAlgoFields('Live', 'Iceberg', 30, 5, 0.5)).toEqual({
      executionAlgorithm: 'Iceberg', algoDurationSeconds: 1800, algoSlices: null, algoDisplayQuantity: 0.5,
    });
  });
});
