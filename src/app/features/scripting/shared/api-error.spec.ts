import { describe, expect, it } from 'vitest';
import { HttpErrorResponse } from '@angular/common/http';

import { ApiError } from '@core/api/api.types';
import { describeFailure, isOk } from './api-error';

describe('describeFailure', () => {
  it('reads an engine refusal envelope', () => {
    expect(
      describeFailure(
        { data: null, status: false, message: 'Strategy not found', responseCode: '-14' },
        'fallback',
      ),
    ).toBe('Strategy not found');
  });

  it('reads an ApiError', () => {
    expect(
      describeFailure(new ApiError('-11', 'LotMultiplier cannot exceed 10', {} as any), 'x'),
    ).toBe('LotMultiplier cannot exceed 10');
  });

  it('reads the first validation error of a problem-details body', () => {
    const err = new HttpErrorResponse({
      status: 400,
      error: {
        title: 'One or more validation errors occurred.',
        errors: { Policy: ['Bad policy'] },
      },
    });
    expect(describeFailure(err, 'fallback')).toBe('Bad policy');
  });

  it('explains unreachable and forbidden', () => {
    expect(describeFailure(new HttpErrorResponse({ status: 0 }), 'f')).toBe(
      'The engine could not be reached.',
    );
    expect(describeFailure(new HttpErrorResponse({ status: 403 }), 'f')).toBe(
      'You do not have permission to do this.',
    );
  });

  it('never returns "Successful" or an object dump', () => {
    expect(describeFailure({ message: 'Successful' }, 'fallback')).toBe('fallback');
    expect(describeFailure({}, 'fallback')).toBe('fallback');
    expect(describeFailure(undefined, 'fallback')).toBe('fallback');
  });
});

describe('isOk', () => {
  it('is true only for status: true', () => {
    expect(isOk({ data: 1, status: true, message: null, responseCode: '00' })).toBe(true);
    expect(isOk({ data: null, status: false, message: 'no', responseCode: '-11' })).toBe(false);
    expect(isOk(null)).toBe(false);
  });
});
