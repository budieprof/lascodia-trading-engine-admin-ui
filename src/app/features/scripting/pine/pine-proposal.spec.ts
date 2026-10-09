import { describe, expect, it } from 'vitest';

import { conversionProposal, versionOf } from './pine-proposal';

describe('converter results as proposals (PR-I10)', () => {
  const before = '//@version=4\nstudy("x")\nplot(sma(close, 3))\n';

  it('a conversion to v6 is a proposal with every change listed', () => {
    const { proposal, problem } = conversionProposal(before, {
      source: '//@version=6\nindicator("x")\nplot(ta.sma(close, 3))\n',
      fromVersion: 4,
      toVersion: 6,
      changes: [
        { line: 2, what: 'study() → indicator().' },
        { line: 3, what: 'sma() → ta.sma().' },
      ],
      refusals: [],
      compile: { success: true, diagnostics: [] } as never,
    });
    expect(problem).toBeNull();
    expect(proposal?.title).toBe('Convert Pine v4 to v6');
    expect(proposal?.notes).toEqual([
      'Line 2: study() → indicator().',
      'Line 3: sma() → ta.sma().',
    ]);
    expect(proposal?.warnings).toEqual([]);
    expect(proposal?.acceptLabel).toBe('Use the v6 script');
  });

  it('a script kept on v5 says why, and nothing at all is a problem, not a proposal', () => {
    const kept = conversionProposal(before, {
      source: before.replace('sma(', 'ta.sma('),
      fromVersion: 4,
      toVersion: 5,
      changes: [{ line: 3, what: 'sma() → ta.sma().' }],
      refusals: [{ line: 4, construct: 'timeframe.period', why: 'Its text changed.' }],
    });
    expect(kept.proposal?.title).toContain('stays on v5');
    expect(kept.proposal?.warnings).toEqual(['Line 4 — timeframe.period: Its text changed.']);
    expect(
      conversionProposal(before, {
        source: before,
        fromVersion: null,
        toVersion: null,
        changes: [],
        refusals: [],
        problem: 'No version.',
      }),
    ).toEqual({ proposal: null, problem: 'No version.' });
  });

  it('reads the script version', () => {
    expect(versionOf(before)).toBe(4);
    expect(versionOf('indicator("x")')).toBeNull();
  });
});
