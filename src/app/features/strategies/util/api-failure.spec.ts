import { describe, it, expect } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';

import { failureMessage, failureMessages, isOk } from './api-failure';

describe('failureMessages', () => {
  it('reads a 200 envelope that reports failure', () => {
    expect(
      failureMessages(
        { status: false, message: 'Symbol cannot be changed', responseCode: '-11', data: false },
        'fallback',
      ),
    ).toEqual(['Symbol cannot be changed']);
  });

  it('reads a 400 envelope from the validation middleware', () => {
    const err = new HttpErrorResponse({
      status: 400,
      error: { status: false, message: 'Name cannot be empty', responseCode: '-01', data: '0' },
    });
    expect(failureMessage(err, 'fallback')).toBe('Name cannot be empty');
  });

  it('flattens a ProblemDetails errors dictionary', () => {
    const err = new HttpErrorResponse({
      status: 400,
      error: {
        title: 'Validation Failed',
        errors: { Name: ['required', 'too long'], Symbol: ['bad'] },
      },
    });
    expect(failureMessages(err, 'fallback')).toEqual([
      'Name: required',
      'Name: too long',
      'Symbol: bad',
    ]);
  });

  it('flattens DSL issue lists with their paths', () => {
    expect(
      failureMessages(
        { errors: [{ path: 'entryConditionsRoot.leaf', message: 'bad period' }] },
        'fallback',
      ),
    ).toEqual(['entryConditionsRoot.leaf: bad period']);
  });

  it('falls back when nothing usable came back', () => {
    expect(
      failureMessages(new HttpErrorResponse({ status: 500, error: null }), 'Update failed'),
    ).toEqual(['Update failed']);
    expect(failureMessages(new HttpErrorResponse({ status: 0 }), 'x')[0]).toMatch(
      /could not be reached/,
    );
    expect(failureMessages(undefined, 'fallback')).toEqual(['fallback']);
  });
});

describe('isOk', () => {
  it('is true only for status: true', () => {
    expect(isOk({ status: true })).toBe(true);
    expect(isOk({ status: false })).toBe(false);
    expect(isOk(null)).toBe(false);
  });
});
