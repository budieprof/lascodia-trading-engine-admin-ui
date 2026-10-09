import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRAFT_MAX_AGE_MS,
  DRAFT_PREFIX,
  DraftAutosaver,
  MAX_DRAFT_CHARS,
  clearDraft,
  draftAge,
  draftKey,
  readDraft,
  writeDraft,
} from './draft-store';

describe('draft-store — local autosave of unsaved Pine edits', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('keys drafts by scope and id; a script never saved is "new"', () => {
    expect(draftKey('strategy', 1201)).toBe(`${DRAFT_PREFIX}strategy:1201`);
    expect(draftKey('chart', null)).toBe(`${DRAFT_PREFIX}chart:new`);
  });

  it('writes, reads back and clears a draft', () => {
    const key = draftKey('chart', 45);
    expect(
      writeDraft(key, {
        source: 'src',
        inputs: { a: 1 },
        name: 'EMA',
        baseRevision: 'abc',
        savedAt: 1000,
      }),
    ).toBe(true);
    expect(readDraft(key)).toEqual({
      source: 'src',
      inputs: { a: 1 },
      name: 'EMA',
      baseRevision: 'abc',
      savedAt: 1000,
    });
    clearDraft(key);
    expect(readDraft(key)).toBeNull();
  });

  it('ignores garbage, refuses oversized sources and drops stale drafts on the next write', () => {
    localStorage.setItem(draftKey('chart', 1), '{not json');
    expect(readDraft(draftKey('chart', 1))).toBeNull();
    expect(
      writeDraft(draftKey('chart', 2), {
        source: 'x'.repeat(MAX_DRAFT_CHARS + 1),
        baseRevision: null,
        savedAt: 1,
      }),
    ).toBe(false);

    const now = 10 * DRAFT_MAX_AGE_MS;
    writeDraft(draftKey('chart', 3), { source: 'old', baseRevision: null, savedAt: now - DRAFT_MAX_AGE_MS - 1 });
    writeDraft(draftKey('chart', 4), { source: 'new', baseRevision: null, savedAt: now });
    expect(readDraft(draftKey('chart', 3))).toBeNull();
    expect(readDraft(draftKey('chart', 4))?.source).toBe('new');
  });

  it('the autosaver writes once after the last change, at once on flush, never after cancel', () => {
    vi.useFakeTimers();
    const saver = new DraftAutosaver(500);
    const key = draftKey('strategy', 7);
    saver.schedule(key, { source: 'a', baseRevision: 'r', savedAt: 1 });
    saver.schedule(key, { source: 'ab', baseRevision: 'r', savedAt: 2 });
    expect(readDraft(key)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(readDraft(key)?.source).toBe('ab');

    saver.schedule(key, { source: 'abc', baseRevision: 'r', savedAt: 3 });
    saver.flush();
    expect(readDraft(key)?.source).toBe('abc');

    saver.schedule(key, { source: 'abcd', baseRevision: 'r', savedAt: 4 });
    saver.cancel();
    vi.advanceTimersByTime(1000);
    expect(readDraft(key)?.source).toBe('abc');
  });

  it('says how old a draft is in plain words', () => {
    expect(draftAge(0, 30_000)).toBe('just now');
    expect(draftAge(0, 5 * 60_000)).toBe('5 min ago');
    expect(draftAge(0, 3 * 3_600_000)).toBe('3 h ago');
    expect(draftAge(0, 4 * 86_400_000)).toBe('4 days ago');
  });
});
