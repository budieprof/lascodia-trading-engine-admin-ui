import { describe, expect, it } from 'vitest';

import type { ConfigOverrides, EffectiveConfigEntry } from './organisation.types';
import {
  canonicalValue,
  compareTightness,
  governanceText,
  groupEntries,
  isLoosening,
  outcomeMessage,
  ownOverride,
  pendingFor,
  planRemove,
  planSet,
  scopeLayer,
  tightenOnlyProblem,
  valueProblem,
  valueText,
} from './settings.logic';

function entry(over: Partial<EffectiveConfigEntry> = {}): EffectiveConfigEntry {
  return {
    key: 'TenantRisk:MaxOpenPositions',
    family: 'TenantRisk:MaxOpenPositions',
    description: 'Most open positions.',
    value: '10',
    source: 'Tenant',
    allowedLayers: ['Platform', 'Tenant'],
    valueKind: 'Int',
    allowedValues: [],
    min: 0,
    max: 100000,
    tightenOnly: true,
    riskSensitive: true,
    tightness: 'LowerIsTighterZeroUnlimited',
    inheritedValue: '0',
    secret: false,
    layers: [],
    ...over,
  };
}

describe('values', () => {
  it('checks each kind and the range', () => {
    expect(valueProblem(entry(), '')).toBe('Enter a value.');
    expect(valueProblem(entry(), '1.5')).toBe('Enter a whole number.');
    expect(valueProblem(entry(), '-1')).toBe('The lowest allowed value is 0.');
    expect(valueProblem(entry(), '100001')).toBe('The highest allowed value is 100000.');
    expect(valueProblem(entry(), ' 25 ')).toBeNull();
    expect(valueProblem(entry({ valueKind: 'Decimal', min: null, max: null }), '0.75')).toBeNull();
    expect(valueProblem(entry({ valueKind: 'Decimal' }), '1,5')).toContain('number');
    expect(valueProblem(entry({ valueKind: 'Bool' }), 'TRUE')).toBeNull();
    expect(valueProblem(entry({ valueKind: 'Bool' }), 'yes')).toBe('Choose true or false.');
    const en = entry({ valueKind: 'Enum', allowedValues: ['Market', 'Limit'] });
    expect(valueProblem(en, 'limit')).toBeNull();
    expect(valueProblem(en, 'Stop')).toBe('Choose one of: Market, Limit.');
    expect(valueProblem(entry({ valueKind: 'Json' }), '{"a":1}')).toBeNull();
    expect(valueProblem(entry({ valueKind: 'Json' }), '{a:1}')).toBe('Enter valid JSON.');
  });

  it('sends bools in lower case and allowed values in their listed spelling', () => {
    expect(canonicalValue(entry({ valueKind: 'Bool' }), ' True ')).toBe('true');
    expect(
      canonicalValue(entry({ valueKind: 'Enum', allowedValues: ['Market', 'Limit'] }), 'limit'),
    ).toBe('Limit');
  });

  it('shows a zero cap as no limit', () => {
    expect(valueText(entry(), '0')).toBe('No limit');
    expect(valueText(entry(), '5')).toBe('5');
    expect(valueText(entry({ tightness: 'LowerIsTighter' }), '0')).toBe('0');
    expect(valueText(entry(), null)).toBe('—');
  });

  it('edits the account layer only with an account', () => {
    expect(scopeLayer(null)).toBe('Tenant');
    expect(scopeLayer(7)).toBe('Account');
  });
});

describe('tightness (mirror of the engine)', () => {
  it('compares each direction', () => {
    const cap = entry();
    expect(compareTightness(cap, '5', '10')).toBe(-1);
    expect(compareTightness(cap, '5', '0')).toBe(-1); // any cap is tighter than none
    expect(compareTightness(cap, '0', '5')).toBe(1);
    expect(compareTightness(cap, '0', '0')).toBe(0);
    expect(compareTightness(entry({ tightness: 'HigherIsTighter' }), '5', '10')).toBe(1);
    expect(compareTightness(entry({ tightness: 'FalseIsTighter' }), 'false', 'true')).toBe(-1);
    expect(compareTightness(entry({ tightness: 'TrueIsTighter' }), 'false', 'true')).toBe(1);
    const ordered = entry({
      tightness: 'OrderedTightestFirst',
      allowedValues: ['Enforce', 'Advisory', 'Off'],
    });
    expect(compareTightness(ordered, 'off', 'Enforce')).toBe(1);
    expect(compareTightness(cap, 'x', '5')).toBeNull();
    expect(compareTightness(entry({ tightness: 'None' }), '1', '2')).toBeNull();
  });

  it('calls a change loosening when it goes looser or cannot be judged; unknown on an older engine', () => {
    const cap = entry();
    expect(isLoosening(cap, '10', '5')).toBe(false);
    expect(isLoosening(cap, '10', '20')).toBe(true);
    expect(isLoosening(cap, '10', '0')).toBe(true); // zeroing a cap removes the limit
    expect(isLoosening(cap, '10', '10')).toBe(false);
    expect(isLoosening(entry({ tightness: 'None' }), 'a', 'b')).toBe(true);
    expect(isLoosening(entry({ tightness: undefined }), '10', '20')).toBeNull();
  });

  it('refuses a looser value on a tighten-only key, in the engine’s terms', () => {
    const cap = entry({ inheritedValue: '50' });
    expect(tightenOnlyProblem(cap, '60', 'Tenant')).toBe(
      'This key may only be tightened below the platform: this organisation inherits 50, and 60 is looser.',
    );
    expect(tightenOnlyProblem(cap, '40', 'Tenant')).toBeNull();
    expect(tightenOnlyProblem(cap, '0', 'Account')).toContain('below the organisation');
    expect(tightenOnlyProblem(entry({ tightenOnly: false }), '60', 'Tenant')).toBeNull();
    expect(tightenOnlyProblem(entry({ inheritedValue: undefined }), '60', 'Tenant')).toBeNull();
  });
});

describe('change plans', () => {
  it('a tighter cap is applied without governance', () => {
    expect(planSet(entry(), '5', 'Tenant')).toMatchObject({
      refusal: null,
      loosening: false,
      governed: false,
      after: '5',
    });
  });

  it('raising an organisation cap is governed', () => {
    // inherits 0 (no limit), own 10 → 20 is looser than 10 but still tighter than none.
    const plan = planSet(entry(), '20', 'Tenant');
    expect(plan).toMatchObject({ refusal: null, loosening: true, governed: true });
    expect(governanceText(entry(), plan)).toContain('This loosens a risk setting (10 → 20)');
  });

  it('an invalid value is refused before anything else', () => {
    expect(planSet(entry(), 'ten', 'Tenant').refusal).toBe('Enter a whole number.');
  });

  it('a risk key on an older engine is treated as possibly loosening', () => {
    const plan = planSet(entry({ tightness: undefined, inheritedValue: undefined }), '5', 'Tenant');
    expect(plan).toMatchObject({ loosening: null, governed: true, refusal: null });
    expect(governanceText(entry(), plan)).toContain('if the change loosens it');
  });

  it('a non-risk key is never governed', () => {
    const fill = entry({
      key: 'EA:FillMode',
      valueKind: 'Enum',
      allowedValues: ['Market', 'Limit'],
      value: 'Market',
      riskSensitive: false,
      tightenOnly: false,
      tightness: 'None',
      min: null,
      max: null,
    });
    expect(planSet(fill, 'limit', 'Account')).toMatchObject({ after: 'Limit', governed: false });
  });

  it('removing a tighter own value is governed; removing to the same value is not', () => {
    expect(planRemove(entry())).toMatchObject({ after: '0', loosening: true, governed: true });
    expect(planRemove(entry({ value: '0' }))).toMatchObject({ loosening: false, governed: false });
  });
});

describe('own values and queued changes', () => {
  const o: ConfigOverrides = {
    overrides: [
      {
        id: 1,
        scopeType: 'Tenant',
        tradingAccountId: null,
        key: 'K',
        value: '1',
        updatedBy: 'a',
        updatedAtUtc: '',
        reason: null,
      },
      {
        id: 2,
        scopeType: 'Account',
        tradingAccountId: 7,
        key: 'K',
        value: '2',
        updatedBy: 'a',
        updatedAtUtc: '',
        reason: null,
      },
    ],
    pending: [
      {
        id: 9,
        scopeType: 'Account',
        tradingAccountId: 7,
        key: 'K',
        remove: false,
        newValue: '3',
        oldValue: '2',
        reason: 'r',
        requestedAt: '',
        effectiveAt: '',
      },
    ],
  };

  it('finds the value set at the scope shown', () => {
    expect(ownOverride(o, 'K', 'Tenant', null)?.id).toBe(1);
    expect(ownOverride(o, 'K', 'Account', 7)?.id).toBe(2);
    expect(ownOverride(o, 'K', 'Account', 8)).toBeUndefined();
    expect(pendingFor(o, 'K', 'Account', 7).map((p) => p.id)).toEqual([9]);
    expect(pendingFor(o, 'K', 'Tenant', null)).toEqual([]);
  });

  it('groups by the first key segment and filters by key or description', () => {
    const groups = groupEntries([
      entry({ key: 'TenantRisk:B' }),
      entry({ key: 'EA:FillMode', description: 'How orders fill' }),
      entry({ key: 'TenantRisk:A' }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['EA', 'TenantRisk']);
    expect(groups[1].entries.map((e) => e.key)).toEqual(['TenantRisk:A', 'TenantRisk:B']);
    expect(
      groupEntries([entry({ key: 'EA:FillMode', description: 'How orders fill' })], 'fill'),
    ).toHaveLength(1);
    expect(groupEntries([entry()], 'nothing')).toEqual([]);
  });
});

describe('outcome messages', () => {
  const base = {
    id: 1,
    effectiveAt: null,
    pendingChangeId: null,
    breakGlass: false,
    message: null,
  };
  it('says what happened', () => {
    expect(outcomeMessage('K', { ...base, outcome: 'Applied' })).toBe('K saved.');
    expect(outcomeMessage('K', { ...base, outcome: 'Unchanged' })).toBe(
      'K already had that value.',
    );
    expect(outcomeMessage('K', { ...base, outcome: 'Removed' })).toBe(
      'K removed: it inherits again.',
    );
    expect(outcomeMessage('K', { ...base, outcome: 'Applied', breakGlass: true })).toContain(
      'break-glass',
    );
    expect(
      outcomeMessage('K', {
        ...base,
        outcome: 'QueuedForCoolingOff',
        effectiveAt: '2026-10-21T10:00:00Z',
      }),
    ).toContain('queued and takes effect at');
  });
});
