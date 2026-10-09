import { describe, expect, it } from 'vitest';
import { ScriptingApiError } from '@core/services/scripting.service';
import type { ChartScriptResult } from './chart-script.model';
import {
  busyWaitMs,
  failureOfError,
  failureOfResult,
  failureTitle,
  isBusy,
  lineLabel,
} from './script-run-state';

const result = (over: Partial<ChartScriptResult>): ChartScriptResult =>
  ({
    error: null,
    errorAt: null,
    errorUnit: null,
    errorStack: [],
    ...over,
  }) as ChartScriptResult;

describe('failureOfResult', () => {
  it('names the line apart from the message (the chip shows "Line N" beside it)', () => {
    const f = failureOfResult(
      result({ error: 'Line 3: Unexpected token', errorAt: { line: 3, column: 7 } }),
      'error',
      1,
    );
    expect(f).toEqual({
      kind: 'error',
      message: 'Unexpected token',
      where: { line: 3, column: 7 },
      unit: null,
      callStack: [],
      atMs: 1,
    });
    expect(lineLabel(f)).toBe('Line 3');
    expect(
      failureOfResult(result({ error: 'Stopped (line 12)', errorAt: { line: 12, column: 1 } }), 'stale', 2)
        .message,
    ).toBe('Stopped');
  });

  it('keeps the library a runtime error is in and its call stack', () => {
    const f = failureOfResult(
      result({
        error: 'Division by zero (line 31)',
        errorAt: { line: 31, column: 9 },
        errorUnit: 'me/maths/2',
        errorStack: [{ function: 'pick', line: 12, column: 5, unit: null }],
      }),
      'error',
      0,
    );
    const title = failureTitle(f);
    expect(title).toContain('Division by zero');
    expect(title).toContain('In library me/maths/2, line 31.');
    expect(title).toContain('in pick() at line 12');
  });
});

describe('failureOfError / failureTitle', () => {
  it('a refusal or a network failure has no place in the source', () => {
    expect(failureOfError(new Error('The engine could not be reached.'), 'stale', 5)).toMatchObject({
      kind: 'stale',
      message: 'The engine could not be reached.',
      where: null,
    });
  });

  it('a stale chip says the chart shows the last run that worked, and from when', () => {
    const f = failureOfError(new Error('x'), 'stale', 0);
    expect(failureTitle(f, Date.UTC(2026, 9, 9, 7, 5, 0))).toContain(
      'The chart shows the run from 07:05:00 UTC, the last that worked.',
    );
  });
});

describe('busy refusals (C5)', () => {
  it('are told apart from script errors', () => {
    expect(isBusy(new ScriptingApiError('busy', '-429'))).toBe(true);
    expect(isBusy(new ScriptingApiError('bad', '-11'))).toBe(false);
    expect(isBusy(new Error('busy'))).toBe(false);
  });

  it('wait what the engine asks, else 2, 4, 8 … 30 s', () => {
    expect(busyWaitMs(new ScriptingApiError('b', '-429', null, 200, 1_500), 3)).toBe(1_500);
    // A wait of nothing still leaves the engine a moment.
    expect(busyWaitMs(new ScriptingApiError('b', '-429', null, 200, 0), 0)).toBe(250);
    const none = new ScriptingApiError('b', '-429');
    expect([0, 1, 2, 3, 4, 5].map((n) => busyWaitMs(none, n))).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });
});
