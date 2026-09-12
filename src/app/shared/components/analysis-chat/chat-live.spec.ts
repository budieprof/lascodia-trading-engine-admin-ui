import { describe, expect, it } from 'vitest';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import { isPinnedToBottom, jumpLabel, mergeOptimisticTurns } from './chat-live';

describe('isPinnedToBottom', () => {
  it('is pinned at the bottom', () => {
    expect(isPinnedToBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
  });

  it('tolerates the last few pixels — a growing last line must not unpin the reader', () => {
    expect(isPinnedToBottom({ scrollTop: 570, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isPinnedToBottom({ scrollTop: 552, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
  });

  it('is NOT pinned once the reader has scrolled up to read something', () => {
    expect(isPinnedToBottom({ scrollTop: 200, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
    expect(isPinnedToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });

  it('treats a log too short to scroll as pinned', () => {
    expect(isPinnedToBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 120 })).toBe(true);
  });

  it('takes an explicit threshold', () => {
    const box = { scrollTop: 900, clientHeight: 400, scrollHeight: 1400 };
    expect(isPinnedToBottom(box, 200)).toBe(true);
    expect(isPinnedToBottom(box, 50)).toBe(false);
  });
});

describe('jumpLabel', () => {
  it('counts what the reader missed, and singularises one', () => {
    expect(jumpLabel(0)).toBe('Jump to latest');
    expect(jumpLabel(1)).toBe('1 new message ↓');
    expect(jumpLabel(7)).toBe('7 new messages ↓');
  });
});

describe('mergeOptimisticTurns', () => {
  const t = (p: Partial<SpotAnalysisFollowUpTurnDto>): SpotAnalysisFollowUpTurnDto => ({
    id: p.id ?? 1,
    llmInvocationId: 1,
    role: p.role ?? 'User',
    content: p.content ?? '',
    createdAtUtc: p.createdAtUtc ?? '2026-09-12T10:00:00Z',
    toolName: null,
    toolArgsJson: null,
    toolResultJson: null,
    actionStatus: null,
  });

  const sent = t({ id: -1757, role: 'User', content: 'look at the martingale ladder' });

  it('keeps the message the operator just sent while the server has not echoed it', () => {
    const server = [t({ id: 1, role: 'User', content: 'earlier question' })];
    const merged = mergeOptimisticTurns(server, [...server, sent]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toBe(sent); // last, and still the same object
  });

  it('drops it the moment the server has it', () => {
    const server = [
      t({ id: 1, role: 'User', content: 'earlier question' }),
      t({ id: 2, role: 'User', content: 'look at the martingale ladder' }),
    ];
    const merged = mergeOptimisticTurns(server, [...server, sent]);
    expect(merged).toHaveLength(2);
    expect(merged.every((m) => m.id > 0)).toBe(true);
  });

  it('is a plain copy when nothing is pending', () => {
    const server = [t({ id: 1 }), t({ id: 2 })];
    expect(mergeOptimisticTurns(server, server)).toEqual(server);
  });
});
