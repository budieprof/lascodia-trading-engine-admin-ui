import { describe, expect, it } from 'vitest';

import {
  elapsedText,
  modelNote,
  progressLine,
  progressVisible,
  reduceProgress,
  WAITING_HIDE_MS,
  type AssistantProgressEvent,
} from './assistant-progress';

const ev = (over: Partial<AssistantProgressEvent> = {}): AssistantProgressEvent => ({
  llmInvocationId: 1,
  questionTurnId: 10,
  phase: 'reading',
  round: 2,
  tools: [{ name: 'live_price', label: 'Live price' }],
  message: 'Reading the EURUSD price',
  model: null,
  escalated: false,
  atUtc: '2026-11-10T07:00:05Z',
  ...over,
});

describe('reduceProgress', () => {
  it('ignores another conversation and no open conversation', () => {
    expect(reduceProgress(null, ev({ llmInvocationId: 2 }), 1, 0)).toBeNull();
    expect(reduceProgress(null, ev(), null, 0)).toBeNull();
  });

  it('keeps the first-seen time across events of one question', () => {
    const a = reduceProgress(null, ev(), 1, 1000)!;
    const b = reduceProgress(a, ev({ phase: 'checking', atUtc: '2026-11-10T07:00:09Z' }), 1, 5000)!;
    expect(b.event.phase).toBe('checking');
    expect(b.firstSeenMs).toBe(1000);
  });

  it('never rewinds to an older event of the same question', () => {
    const a = reduceProgress(
      null,
      ev({ atUtc: '2026-11-10T07:00:09Z', phase: 'answering' }),
      1,
      0,
    )!;
    expect(reduceProgress(a, ev({ atUtc: '2026-11-10T07:00:05Z' }), 1, 0)).toBe(a);
  });

  it('hides on done and restarts the clock for a new question', () => {
    const a = reduceProgress(null, ev(), 1, 1000)!;
    expect(
      reduceProgress(a, ev({ phase: 'done', atUtc: '2026-11-10T07:00:10Z' }), 1, 2000),
    ).toBeNull();
    const c = reduceProgress(
      a,
      ev({ questionTurnId: 11, atUtc: '2026-11-10T07:01:00Z' }),
      1,
      9000,
    )!;
    expect(c.firstSeenMs).toBe(9000);
  });
});

describe('progressLine / modelNote / elapsedText', () => {
  it('uses the engine message and tool labels', () => {
    expect(progressLine(ev())).toEqual({
      text: 'Reading the EURUSD price…',
      tools: ['Live price'],
      modelNote: null,
      round: 2,
    });
  });
  it('falls back to the phase in words and the tool name', () => {
    const l = progressLine(
      ev({ message: '', tools: [{ name: 'get_candles' }], phase: 'proposing', round: 0 }),
    );
    expect(l.text).toBe('Preparing a change for you to approve…');
    expect(l.tools).toEqual(['get_candles']);
    expect(l.round).toBeNull();
  });
  it('says which model is answering', () => {
    expect(modelNote({ model: 'sonnet', escalated: false })).toBe('using the quick model (sonnet)');
    expect(modelNote({ model: null, escalated: true })).toBe('handed to the main model');
    expect(modelNote({ model: null, escalated: false })).toBeNull();
  });
  it('formats elapsed time', () => {
    expect(elapsedText(0, 42_000)).toBe('42 s');
    expect(elapsedText(0, 185_000)).toBe('3 min 05 s');
    expect(elapsedText(null, 1)).toBe('');
  });
});

describe('progressVisible', () => {
  it('fades a waiting line (no done follows it until the cards are decided)', () => {
    const w = reduceProgress(null, ev({ phase: 'waiting' }), 1, 1000)!;
    expect(progressVisible(w, 1000 + WAITING_HIDE_MS - 1)).toBe(true);
    expect(progressVisible(w, 1000 + WAITING_HIDE_MS)).toBe(false);
    expect(progressVisible(reduceProgress(null, ev(), 1, 0), 10 ** 9)).toBe(true);
    expect(progressVisible(null, 0)).toBe(false);
  });
});
