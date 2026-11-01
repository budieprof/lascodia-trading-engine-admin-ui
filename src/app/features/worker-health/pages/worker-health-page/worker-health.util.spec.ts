import { describe, expect, it } from 'vitest';

import type { WorkerHealthDto } from '@core/api/api.types';
import {
  attentionRank,
  formatDuration,
  formatMs,
  latencyTone,
  needsAttention,
  workerReasons,
} from './worker-health.util';

function worker(over: Partial<WorkerHealthDto> = {}): WorkerHealthDto {
  return {
    workerName: 'TestWorker',
    name: 'TestWorker',
    category: 'Test',
    status: 'Healthy',
    isRunning: true,
    isCompleted: false,
    lastSuccessAt: '2026-11-01T10:00:00Z',
    lastErrorAt: null,
    lastErrorMessage: null,
    lastCycleDurationMs: 10,
    cycleDurationP50Ms: 10,
    cycleDurationP95Ms: 20,
    cycleDurationP99Ms: 30,
    consecutiveFailures: 0,
    errorsLastHour: 0,
    successesLastHour: 60,
    backlogDepth: 0,
    lastQueueLatencyMs: 0,
    queueLatencyP50Ms: 0,
    queueLatencyP95Ms: 0,
    lastExecutionDurationMs: 0,
    executionDurationP50Ms: 0,
    executionDurationP95Ms: 0,
    retriesLastHour: 0,
    recoveriesLastHour: 0,
    configuredIntervalSeconds: 60,
    capturedAt: '2026-11-01T10:00:30Z',
    errorRate: 0,
    staleSeconds: 30,
    isStale: false,
    ...over,
  };
}

describe('worker-health util', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(900)).toBe('15 min');
    expect(formatDuration(5400)).toBe('1.5 h');
    expect(formatDuration(86_400 * 2)).toBe('2 d');
    expect(formatMs(850)).toBe('850 ms');
    expect(formatMs(3200)).toBe('3.2 s');
    expect(formatMs(393_015)).toBe('7 min');
  });

  it('gives a plain healthy worker no reasons', () => {
    expect(workerReasons(worker())).toEqual([]);
    expect(needsAttention(worker())).toBe(false);
  });

  it('explains a failed worker first', () => {
    const r = workerReasons(
      worker({ status: 'Failed', consecutiveFailures: 3, errorsLastHour: 3, errorRate: 0.05 }),
    );
    expect(r[0]).toEqual({ tone: 'bad', text: '3 failed cycles in a row' });
    expect(attentionRank(worker({ status: 'Failed' }))).toBe(0);
  });

  it('explains a high error rate and a stale worker', () => {
    const r = workerReasons(
      worker({
        status: 'Degraded',
        errorsLastHour: 10,
        successesLastHour: 30,
        errorRate: 0.25,
        isStale: true,
        staleSeconds: 3600,
      }),
    );
    expect(r.map((x) => x.text)).toEqual([
      '25% of cycles failed in the last hour (10 of 40)',
      'No successful cycle for 1 h — stale after 5 min (3× its 1 min interval, min 5 min)',
    ]);
    expect(needsAttention(worker({ isStale: true }))).toBe(true);
    expect(needsAttention(worker({ isStale: true, isCompleted: true }))).toBe(false);
  });

  it('explains idle workers', () => {
    expect(workerReasons(worker({ status: 'Idle', isRunning: false }))[0].tone).toBe('info');
    expect(workerReasons(worker({ status: 'Idle', lastSuccessAt: null }))[0].text).toContain(
      'first successful cycle',
    );
  });

  it('measures latency against the worker schedule', () => {
    expect(
      latencyTone(worker({ cycleDurationP95Ms: 393_015, configuredIntervalSeconds: 900 })),
    ).toBe('');
    expect(latencyTone(worker({ cycleDurationP95Ms: 40_000, configuredIntervalSeconds: 60 }))).toBe(
      'warn',
    );
    expect(latencyTone(worker({ cycleDurationP95Ms: 2000, configuredIntervalSeconds: 1 }))).toBe(
      'bad',
    );
    expect(latencyTone(worker({ cycleDurationP95Ms: 2000, configuredIntervalSeconds: 0 }))).toBe(
      '',
    );
    expect(
      workerReasons(worker({ cycleDurationP95Ms: 2000, configuredIntervalSeconds: 1 }))[0].text,
    ).toBe('P95 cycle 2 s is longer than its 1 s interval');
  });
});
