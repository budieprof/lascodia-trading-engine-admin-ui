import { describe, expect, it } from 'vitest';

import { assistProposal, conversionProposal, portProposal, versionOf } from './pine-proposal';

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

describe('AI fixes as proposals (PE-I6)', () => {
  const before = '//@version=6\nindicator("x")\nplot(close\n';
  const base = { mode: 'fix' as const, llmInvocationId: 7, model: 'm', warnings: [] as string[] };

  it('a proposed script is a proposal; its warnings and new compile errors come first', () => {
    const { proposal } = assistProposal(
      before,
      {
        ...base,
        explanation: 'Closed the bracket.',
        source: '//@version=6\nindicator("x")\nplot(close)\nx = y\n',
        warnings: ['The proposed script has a new error on line 4: Undeclared identifier y.'],
        compile: {
          success: false,
          diagnostics: [
            { severity: 'error', line: 4, message: 'Undeclared identifier y.' },
            { severity: 'error', line: 9, message: 'Library problem.', unit: 'a/b/1' },
          ],
        } as never,
      },
      'line 3',
    );
    expect(proposal?.title).toBe('AI fix: line 3');
    expect(proposal?.notes).toEqual(['Closed the bracket.']);
    expect(proposal?.warnings).toEqual([
      'The proposed script has a new error on line 4: Undeclared identifier y.',
    ]);
  });

  it('no change is the AI’s answer, not a proposal', () => {
    expect(assistProposal(before, { ...base, explanation: 'Nothing to fix.' }, 'x')).toEqual({
      proposal: null,
      problem: 'Nothing to fix.',
    });
    expect(assistProposal(before, { ...base, explanation: '', source: before }, 'x').problem).toBe(
      'The AI did not propose a change.',
    );
  });
});

describe('Port from TradingView as a proposal (PE-I6)', () => {
  it('lists conversion changes as notes and open checklist lines as warnings, problems first', () => {
    const p = portProposal('', {
      source: '//@version=6\nstrategy("tv")\n',
      conversion: {
        fromVersion: 4,
        toVersion: 6,
        changes: [{ line: 2, what: 'study → x' }],
        refusals: [],
      },
      compile: { success: true, diagnostics: [] } as never,
      checklist: [
        { id: 'version', status: 'ok', title: 'Converted', detail: '' },
        { id: 'margin', status: 'check', title: 'No margin set', detail: 'Backtest assumes 100%.' },
        {
          id: 'stops',
          status: 'problem',
          title: 'No protective stop',
          detail: 'Add one.',
          line: 4,
        },
      ],
    });
    expect(p.title).toBe('Port from TradingView (converted from v4)');
    expect(p.notes).toEqual(['Line 2: study → x']);
    expect(p.warnings).toEqual([
      'Fix — No protective stop (line 4): Add one.',
      'Check — No margin set: Backtest assumes 100%.',
    ]);
  });
});
