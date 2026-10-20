import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@core/api/api.types';
import { availabilityOf, budgetLine, keyProblem, paidByLabel, tokens, usd } from './llm.logic';

describe('LLM usage figures', () => {
  it('formats money so small amounts stay visible', () => {
    expect(usd(3.2)).toBe('$3.20');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(0)).toBe('$0.00');
    expect(usd(null)).toBe('—');
    expect(tokens(950)).toBe('950');
    expect(tokens(12_345)).toBe('12.3k');
    expect(tokens(4_500_000)).toBe('4.5M');
  });

  it('judges spend against where calls stop (cap × threshold)', () => {
    expect(budgetLine(3.2, 50, 0.9)).toEqual({
      text: '$3.20 of $50.00',
      percent: 7,
      stopsAt: 45,
      tone: 'ok',
    });
    expect(budgetLine(40, 50, 0.9).tone).toBe('warn');
    expect(budgetLine(45, 50, 0.9)).toMatchObject({ percent: 100, tone: 'bad' });
    expect(budgetLine(1, null, 0.9)).toEqual({
      text: '$1.00 (no cap)',
      percent: null,
      stopsAt: null,
      tone: '',
    });
  });

  it('names who pays', () => {
    expect(paidByLabel('OwnKey')).toBe("The organisation's own key");
    expect(paidByLabel('Platform')).toBe('The platform pays');
  });
});

describe('the page’s own feature check', () => {
  it('tells a missing endpoint from a refusal and a failure', () => {
    expect(availabilityOf(new HttpErrorResponse({ status: 404, error: null }))).toBe('missing');
    expect(
      availabilityOf(
        new HttpErrorResponse({
          status: 404,
          error: { status: false, responseCode: '-14', message: 'x' },
        }),
      ),
    ).toBe('error');
    expect(availabilityOf(new HttpErrorResponse({ status: 403, error: null }))).toBe('forbidden');
    expect(
      availabilityOf(
        new ApiError('-403', 'no', {
          data: null,
          status: false,
          message: 'no',
          responseCode: '-403',
        }),
      ),
    ).toBe('forbidden');
    expect(availabilityOf(new HttpErrorResponse({ status: 500 }))).toBe('error');
  });
});

describe('own provider key', () => {
  it('checks the provider and the key as the engine does, never echoing it', () => {
    expect(keyProblem('azure', 'x'.repeat(30))).toContain('Choose the provider');
    expect(keyProblem('anthropic', 'short')).toContain('20–512');
    expect(keyProblem('anthropic', 'sk-ant ' + 'x'.repeat(30))).toContain('no spaces');
    expect(keyProblem('anthropic', 'sk-ant-' + 'é'.repeat(30))).toContain('non-ASCII');
    expect(keyProblem('openai', ' sk-' + 'a'.repeat(40) + ' ')).toBeNull();
    const msg = keyProblem('openai', 'sk- secret value that must not leak');
    expect(msg).not.toContain('secret value');
  });
});
