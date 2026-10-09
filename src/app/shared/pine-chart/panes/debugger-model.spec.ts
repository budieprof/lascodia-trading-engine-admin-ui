import { describe, expect, it } from 'vitest';

import { normalizeDebugResult } from '../model/normalize';
import { debugProblems, debugRequest, emptyDraft, groupByScope, kindBadge } from './debugger-model';

describe('Pine debugger (PR-I11)', () => {
  it('names what the engine would refuse before a run', () => {
    expect(debugProblems(emptyDraft())).toEqual(['Add a watch expression or a condition.']);
    expect(debugProblems({ ...emptyDraft(), condition: 'close > open' })).toEqual([]);
    expect(debugProblems({ ...emptyDraft(), watches: Array(11).fill('close') })).toContain(
      'At most 10 watch expressions.',
    );
    expect(debugProblems({ ...emptyDraft(), watches: ['x'.repeat(501)] })).toContain(
      'Watch 1 is longer than 500 characters.',
    );
    expect(
      debugProblems({ watches: ['close'], condition: '', fromBar: '-3', toBar: '' }),
    ).toContain('"From bar" must be a whole number of 0 or more.');
    expect(
      debugProblems({ watches: ['close'], condition: '', fromBar: '50', toBar: '10' }),
    ).toContain('"To bar" comes before "From bar".');
  });

  it('builds the §3e request from the draft', () => {
    expect(
      debugRequest({ watches: [' fast ', '', 'slow'], condition: '  ', fromBar: '', toBar: '' }),
    ).toEqual({
      watches: ['fast', 'slow'],
      condition: null,
      fromBar: 0,
      toBar: null,
      maxHits: 200,
      stateAtBar: null,
    });
    expect(
      debugRequest({ watches: [], condition: 'ta.cross(a, b)', fromBar: '10', toBar: '90' }, 42),
    ).toMatchObject({
      condition: 'ta.cross(a, b)',
      fromBar: 10,
      toBar: 90,
      stateAtBar: 42,
    });
  });

  it('groups the variables by scope, global first, and filters by name', () => {
    const vars = [
      { scope: 'global', name: 'fast', type: 'float', kind: 'value', value: '1.1' },
      { scope: 'f(), call 1', name: 'acc', type: 'float', kind: 'var', value: '3' },
      { scope: 'global', name: 'crosses', type: 'int', kind: 'var', value: '2' },
    ];
    expect(groupByScope(vars).map((g) => [g.scope, g.variables.map((v) => v.name)])).toEqual([
      ['global', ['fast', 'crosses']],
      ['f(), call 1', ['acc']],
    ]);
    expect(groupByScope(vars, 'CROSS').map((g) => g.scope)).toEqual(['global']);
    expect([kindBadge('var'), kindBadge('varip'), kindBadge('value')]).toEqual([
      'var',
      'varip',
      '',
    ]);
  });

  it('reads the engine’s debug answer defensively', () => {
    const r = normalizeDebugResult({
      status: true,
      data: {
        compile: { success: true },
        debug: {
          watches: ['fast'],
          condition: 'c',
          hits: [{ barIndex: 7, time: 1000, watches: ['1.5', null] }],
          hitsTotal: 3,
          fromBar: 0,
          toBar: 99,
          stateBar: 7,
          stateTime: 1000,
          state: [{ scope: 'global', name: 'fast', type: 'float', kind: 'value', value: '1.5' }],
        },
      },
    })!;
    expect(r.hits).toEqual([{ barIndex: 7, time: 1000, watches: ['1.5', 'na'] }]);
    expect(r.hitsTotal).toBe(3);
    expect(r.state[0].name).toBe('fast');
    expect(r.runtimeError).toBeNull();
    expect(normalizeDebugResult({ compile: {} })).toBeNull();
  });
});
