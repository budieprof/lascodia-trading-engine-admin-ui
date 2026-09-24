import { describe, it, expect } from 'vitest';

import { issueFromLegacyMessage, normaliseDslCheck } from './dsl-check';

describe('normaliseDslCheck', () => {
  it('reads the structured response with every error and warning', () => {
    const r = normaliseDslCheck({
      status: true,
      responseCode: '00',
      message: 'Successful',
      data: {
        summary: null,
        isValid: false,
        errors: [
          { path: 'entryConditionsRoot.children[1].leaf', message: 'Period 1 outside [2, 500]' },
        ],
        warnings: [{ path: 'timeframe', message: 'differs from the strategy' }],
      },
    });
    expect(r.isValid).toBe(false);
    expect(r.errors).toEqual([
      {
        path: 'entryConditionsRoot.children[1].leaf',
        message: 'Period 1 outside [2, 500]',
        severity: 'error',
      },
    ]);
    expect(r.warnings).toEqual([
      { path: 'timeframe', message: 'differs from the strategy', severity: 'warning' },
    ]);
  });

  it('keeps the summary of a valid structured response', () => {
    const r = normaliseDslCheck({
      status: true,
      responseCode: '00',
      message: null,
      data: { summary: 'This strategy buys…', isValid: true, errors: [], warnings: [] },
    });
    expect(r).toEqual({ summary: 'This strategy buys…', isValid: true, errors: [], warnings: [] });
  });

  it('reads the old string response', () => {
    expect(
      normaliseDslCheck({
        status: true,
        responseCode: '00',
        message: null,
        data: 'This strategy sells…',
      }),
    ).toEqual({ summary: 'This strategy sells…', isValid: true, errors: [], warnings: [] });
  });

  it('reads an old failure and recovers the node path from the prose', () => {
    const r = normaliseDslCheck({
      status: false,
      responseCode: '-11',
      message: 'EntryConditionsRoot: child #1: child #0: Indicator period 1 outside [2, 500]',
      data: null,
    });
    expect(r.isValid).toBe(false);
    expect(r.errors).toEqual([
      {
        path: 'entryConditionsRoot.children[1].children[0]',
        message: 'Indicator period 1 outside [2, 500]',
        severity: 'error',
      },
    ]);
  });
});

describe('issueFromLegacyMessage', () => {
  it('maps flat-list and exit-tree messages', () => {
    expect(issueFromLegacyMessage('Entry condition #2: RegimeMatch payload missing').path).toBe(
      'entryConditions[2]',
    );
    expect(
      issueFromLegacyMessage('ExitConditionsRoot: NOT node requires exactly one child').path,
    ).toBe('exitConditionsRoot');
    expect(issueFromLegacyMessage('Name is empty')).toEqual({
      path: '',
      message: 'Name is empty',
      severity: 'error',
    });
  });
});
