import { describe, expect, it } from 'vitest';
import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';
import {
  isPinnedToBottom,
  jumpLabel,
  mergeOptimisticTurns,
  isTransportLoss,
  lostRequestState,
  threadTail,
} from './chat-live';

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

describe('a request lost on the way back', () => {
  const t = (over: Partial<SpotAnalysisFollowUpTurnDto>): SpotAnalysisFollowUpTurnDto => ({
    id: 1,
    llmInvocationId: 40936,
    role: 'Assistant',
    content: '',
    createdAtUtc: '2026-10-13T07:53:12Z',
    ...over,
  });
  const checkpoint = (id: number) =>
    t({ id, toolName: 'run_notice', toolResultJson: '{"kind":"checkpoint","segment":1}' });
  const isCheckpoint = (x: SpotAnalysisFollowUpTurnDto) =>
    x.toolName === 'run_notice' && !!x.toolResultJson?.includes('checkpoint');

  it('tells a dropped connection or a proxy timeout from an engine verdict', () => {
    expect(isTransportLoss({ status: 0 })).toBe(true);
    expect(isTransportLoss({ status: 524 })).toBe(true); // the tunnel gave up waiting
    expect(isTransportLoss({ status: 504 })).toBe(true);
    expect(isTransportLoss({ name: 'TimeoutError' })).toBe(true);
    expect(isTransportLoss({ status: 400 })).toBe(false);
    expect(isTransportLoss({ status: 500 })).toBe(false);
    expect(isTransportLoss(null)).toBe(false);
  });

  it('reads the tail past the plan card and the unsent optimistic turn', () => {
    const thread = [t({ id: 5 }), t({ id: 9, toolName: 'plan' }), t({ id: -1, role: 'User' })];
    expect(threadTail(thread)?.id).toBe(5);
    expect(threadTail([])).toBeNull();
  });

  it('is lost when the engine wrote nothing after the question was sent', () => {
    expect(lostRequestState([t({ id: 5 })], 5, isCheckpoint)).toBe('lost');
  });

  it('is working while the newest turn is the question, a tool result or narration', () => {
    expect(lostRequestState([t({ id: 6, role: 'User' })], 5, isCheckpoint)).toBe('working');
    expect(lostRequestState([t({ id: 7, role: 'Tool', toolName: 'sql' })], 5, isCheckpoint)).toBe(
      'working',
    );
    expect(lostRequestState([t({ id: 8, toolName: 'thought' })], 5, isCheckpoint)).toBe('working');
  });

  it('is paused at a checkpoint — conversation #40936 sat here with nobody resuming it', () => {
    expect(lostRequestState([t({ id: 8, role: 'Tool' }), checkpoint(9)], 5, isCheckpoint)).toBe(
      'paused',
    );
  });

  it('is answered by a reply, an approval card or a closing notice', () => {
    expect(lostRequestState([t({ id: 9 })], 5, isCheckpoint)).toBe('answered');
    expect(lostRequestState([t({ id: 9, role: 'ActionProposal' })], 5, isCheckpoint)).toBe(
      'answered',
    );
    expect(
      lostRequestState(
        [t({ id: 9, toolName: 'run_notice', toolResultJson: '{"kind":"interrupted"}' })],
        5,
        isCheckpoint,
      ),
    ).toBe('answered');
  });
});
