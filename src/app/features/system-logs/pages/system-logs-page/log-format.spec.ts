import { describe, expect, it } from 'vitest';

import {
  categoryNamespace,
  categoryTail,
  firstLine,
  isMultiline,
  isSameLocalDay,
  levelLabel,
  utcStamp,
} from './log-format';

describe('engine log formatting', () => {
  it('shortens .NET level names and passes unknown ones through', () => {
    expect(levelLabel('Information')).toBe('Info');
    expect(levelLabel('Warning')).toBe('Warn');
    expect(levelLabel('Error')).toBe('Error');
    expect(levelLabel('Critical')).toBe('Critical');
    expect(levelLabel('Debug')).toBe('Debug');
    expect(levelLabel('Trace')).toBe('Trace');
    expect(levelLabel('None')).toBe('None');
    expect(levelLabel(null)).toBe('');
  });

  it('splits a category into class name and namespace', () => {
    const c = 'LascodiaTradingEngine.Application.Foo.GetBarQueryHandler';
    expect(categoryTail(c)).toBe('GetBarQueryHandler');
    expect(categoryNamespace(c)).toBe('LascodiaTradingEngine.Application.Foo');
    expect(categoryTail('Worker')).toBe('Worker');
    expect(categoryNamespace('Worker')).toBe('');
    expect(categoryTail('')).toBe('');
  });

  it('cuts generic arity so the type argument does not become the name', () => {
    const c = 'Ns.Inner.RequestTimingMiddleware`1[[System.String, System.Private.CoreLib]]';
    expect(categoryTail(c)).toBe('RequestTimingMiddleware');
    expect(categoryNamespace(c)).toBe('Ns.Inner');
  });

  it('takes the first line of a message', () => {
    expect(firstLine('QTC - Request (3 ms)\nNs.Type')).toBe('QTC - Request (3 ms)');
    expect(firstLine('one line')).toBe('one line');
    expect(isMultiline('a\nb')).toBe(true);
    expect(isMultiline('a\n')).toBe(false);
    expect(isMultiline('a')).toBe(false);
  });

  it('compares local days and prints a UTC stamp', () => {
    const now = new Date(2026, 10, 1, 12, 0, 0);
    expect(isSameLocalDay(new Date(2026, 10, 1, 0, 1).toISOString(), now)).toBe(true);
    expect(isSameLocalDay(new Date(2026, 9, 31, 23, 59).toISOString(), now)).toBe(false);
    expect(isSameLocalDay('garbage', now)).toBe(true);
    expect(utcStamp('2026-11-01T10:05:44.753Z')).toBe('2026-11-01 10:05:44.753 UTC');
    expect(utcStamp('garbage')).toBe('garbage');
  });
});
