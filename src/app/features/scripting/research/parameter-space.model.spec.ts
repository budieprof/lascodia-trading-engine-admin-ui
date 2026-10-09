import { describe, expect, it } from 'vitest';

import {
  buildSpec,
  draftFromSpace,
  parseLockText,
  specSummary,
  type SpecDraft,
} from './parameter-space.model';
import type { ParameterSpaceDto } from './research.types';

function space(): ParameterSpaceDto {
  return {
    strategyId: 7,
    spaceId: 1,
    searched: [
      {
        id: 'Length',
        title: 'Length',
        group: null,
        tooltip: null,
        inputKind: 'int',
        kind: 'integer',
        min: 2,
        max: 50,
        step: 2,
        choices: null,
        options: null,
        current: 20,
        default: 14,
        rangeSource: 'declared',
        declaredMin: 2,
        declaredMax: 50,
        declaredStep: 2,
      },
      {
        id: 'Mult',
        title: 'ATR multiple',
        group: null,
        tooltip: null,
        inputKind: 'float',
        kind: 'float',
        min: 1,
        max: 4,
        step: null,
        choices: null,
        options: null,
        current: 2,
        default: 2,
        rangeSource: 'derived',
        declaredMin: null,
        declaredMax: null,
        declaredStep: null,
      },
      {
        id: 'Mode',
        title: 'Mode',
        group: null,
        tooltip: null,
        inputKind: 'string',
        kind: 'choice',
        min: null,
        max: null,
        step: null,
        choices: ['Slow', 'Fast', 'Adaptive'],
        options: ['Slow', 'Fast', 'Adaptive'],
        current: 'Slow',
        default: 'Slow',
        rangeSource: 'options',
        declaredMin: null,
        declaredMax: null,
        declaredStep: null,
      },
    ],
    skipped: [
      {
        id: 'Note',
        title: 'Note',
        inputKind: 'string',
        reason: 'string inputs are not searched',
        locked: false,
        lockedValue: null,
        current: 'hello',
      },
    ],
    initialCandidates: 64,
    maxInitialCandidates: 64,
    objectives: ['HealthScore', 'ExpectancyR'],
    constraints: ['minTrades'],
    searchSpec: null,
    problems: [],
  };
}

function draft(): SpecDraft {
  return draftFromSpace(space());
}

describe('parameter-space model (PE-I4)', () => {
  it('starts from the engine’s own space, so an untouched draft is an ordinary run', () => {
    const d = draft();
    expect(d.dimensions.map((x) => [x.id, x.mode, x.min, x.max, x.step])).toEqual([
      ['Length', 'search', '2', '50', '2'],
      ['Mult', 'search', '1', '4', ''],
      ['Mode', 'search', '', '', ''],
    ]);
    expect(d.skipped[0].lockValue).toBe('hello');
    const built = buildSpec(d);
    expect(built.isDefault).toBe(true);
    expect(built.problems).toEqual([]);
    expect(built.spec).toEqual({ ranges: {}, locked: {}, objective: 'HealthScore' });
  });

  it('sends only what the operator changed: a narrower range, a lock, a subset of options', () => {
    const d = draft();
    d.dimensions[0] = { ...d.dimensions[0], min: '10', max: '30' };
    d.dimensions[1] = { ...d.dimensions[1], mode: 'lock', lockValue: '2.5' };
    d.dimensions[2] = { ...d.dimensions[2], chosen: ['Fast', 'Adaptive'] };
    d.skipped[0] = { ...d.skipped[0], locked: true, lockValue: 'x' };
    d.objective = 'ExpectancyR';

    const built = buildSpec(d);

    expect(built.problems).toEqual([]);
    expect(built.isDefault).toBe(false);
    expect(built.spec).toEqual({
      ranges: { Length: { min: 10, max: 30, step: 2 }, Mode: { choices: ['Fast', 'Adaptive'] } },
      locked: { Mult: 2.5, Note: 'x' },
      objective: 'ExpectancyR',
    });
  });

  it('turns constraints into the engine’s units (win rate as a fraction)', () => {
    const d = draft();
    d.constraints = {
      minTrades: '30',
      maxDrawdownPct: '15',
      minWinRatePct: '45',
      minProfitFactor: '1.1',
      minExpectancyR: '0.05',
    };

    const built = buildSpec(d);

    expect(built.spec.constraints).toEqual({
      minTrades: 30,
      maxDrawdownPct: 15,
      minWinRate: 0.45,
      minProfitFactor: 1.1,
      minExpectancyR: 0.05,
    });
    expect(built.isDefault).toBe(false);
    expect(draftFromSpace({ ...space(), searchSpec: built.spec }).constraints.minWinRatePct).toBe(
      '45',
    );
  });

  it('says what is wrong before asking the engine', () => {
    const d = draft();
    d.dimensions[0] = { ...d.dimensions[0], min: '30', max: '10' };
    d.dimensions[1] = { ...d.dimensions[1], min: 'abc' };
    d.dimensions[2] = { ...d.dimensions[2], chosen: ['Fast'] };
    d.constraints = { ...d.constraints, minTrades: '0', maxDrawdownPct: '120' };

    const problems = buildSpec(d).problems;

    expect(problems).toEqual([
      'Length: the lowest value must be below the highest.',
      'ATR multiple: enter a number for the lowest and highest value.',
      'Mode: search at least two options, or hold it at one.',
      'Minimum trades: a whole number of at least 1.',
      'Maximum drawdown: a percent above 0 and below 100.',
    ]);
  });

  it('keeps whole-number inputs whole', () => {
    const d = draft();
    d.dimensions[0] = { ...d.dimensions[0], min: '2.5', max: '10' };
    expect(buildSpec(d).problems).toEqual([
      'Length: a whole-number input needs whole-number bounds.',
    ]);
    d.dimensions[0] = { ...d.dimensions[0], min: '2', max: '10', step: '0.5' };
    expect(buildSpec(d).problems[0]).toContain('step of at least 1');
    d.dimensions[0] = { ...d.dimensions[0], mode: 'lock', lockValue: '7.5' };
    expect(buildSpec(d).problems).toEqual(['Length: the value must be a whole number.']);
  });

  it('reads typed lock values as JSON where they are numbers or booleans', () => {
    expect(parseLockText('true')).toBe(true);
    expect(parseLockText('12')).toBe(12);
    expect(parseLockText('close')).toBe('close');
  });

  it('summarises a spec in plain words', () => {
    const lines = specSummary(
      {
        ranges: { Length: { min: 10, max: 30, step: 2 }, Mode: { choices: ['Fast', 'Adaptive'] } },
        locked: { Note: 'x' },
        objective: 'ExpectancyR',
        constraints: { minWinRate: 0.45, maxDrawdownPct: 15 },
      },
      space(),
    );
    expect(lines).toEqual([
      'Length: search 10 to 30 in steps of 2',
      'Mode: search Fast, Adaptive',
      'Note: held at x',
      'Ranks candidates by Expectancy (R per trade)',
      'Drawdown at most 15 %',
      'Win rate at least 45 %',
    ]);
  });
});
