import { describe, expect, it } from 'vitest';
import type { AssistantTaskDto } from '@core/assistant/assistant.service';
import { taskBarVisible, taskProgress } from './assistant-task-bar.component';

const task = (over: Partial<AssistantTaskDto> = {}): AssistantTaskDto => ({
  id: 1,
  sessionLlmInvocationId: 9,
  goal: 'Find the best script',
  status: 'Active',
  todos: [
    { id: '1', text: 'Backtest', status: 'done' },
    { id: '2', text: 'Walk-forward', status: 'in_progress' },
    { id: '3', text: 'Skip me', status: 'skipped' },
    { id: '4', text: 'Report', status: 'pending' },
  ],
  activity: [],
  wakeCount: 2,
  maxWakes: 30,
  budgetUsd: 0,
  spentUsd: 0,
  waitingOnMonitorIds: [],
  createdAtUtc: '2026-09-26T10:00:00Z',
  updatedAtUtc: '2026-09-26T10:00:00Z',
  ...over,
});

describe('assistant task bar', () => {
  it('counts done and skipped steps as progress', () => {
    expect(taskProgress(task())).toEqual({ done: 2, total: 4, pct: 50 });
  });

  it('shows a live task, and an ended one only for a while', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    expect(taskBarVisible(task({ status: 'Waiting' }), now)).toBe(true);
    expect(taskBarVisible(task({ status: 'Done', endedAtUtc: '2026-09-26T11:45:00Z' }), now)).toBe(
      true,
    );
    expect(taskBarVisible(task({ status: 'Done', endedAtUtc: '2026-09-26T10:00:00Z' }), now)).toBe(
      false,
    );
    expect(taskBarVisible(null, now)).toBe(false);
  });
});
