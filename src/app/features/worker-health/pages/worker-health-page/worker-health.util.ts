import type { WorkerHealthDto } from '@core/api/api.types';

export type ReasonTone = 'bad' | 'warn' | 'info';

/** One plain-language line explaining why a worker carries the status it does. */
export interface WorkerReason {
  tone: ReasonTone;
  text: string;
}

/** Compact duration: 45 s, 12 min, 3.5 h, 2 d. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) {
    const h = seconds / 3600;
    return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
  }
  const d = seconds / 86_400;
  return `${d < 10 ? d.toFixed(1).replace(/\.0$/, '') : Math.round(d)} d`;
}

/** Milliseconds as a compact duration: 850 ms, 3.2 s, 6.5 min. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1).replace(/\.0$/, '') : Math.round(s)} s`;
  }
  return formatDuration(ms / 1000);
}

/** True for a worker the operator should look at: failed, degraded, or stale (finished one-shots excluded). */
export function needsAttention(w: WorkerHealthDto): boolean {
  return w.status === 'Failed' || w.status === 'Degraded' || (w.isStale && !w.isCompleted);
}

/**
 * The P95 cycle measured against the worker's own schedule. A 6-minute news sweep on a 15-minute
 * timer is fine; a 2-second cycle on a 1-second timer cannot keep up. Fixed 1 s / 5 s thresholds
 * painted every long-cadence sweep red on a healthy fleet.
 *  - 'bad'  : P95 is longer than the interval (cycles overrun their schedule)
 *  - 'warn' : P95 is more than half the interval
 *  - ''     : fine, or no interval to compare against
 */
export function latencyTone(w: WorkerHealthDto): '' | 'warn' | 'bad' {
  const p95 = w.cycleDurationP95Ms;
  const interval = w.configuredIntervalSeconds;
  if (!Number.isFinite(p95) || p95 <= 0 || !interval || interval <= 0 || w.isCompleted) return '';
  const ratio = p95 / (interval * 1000);
  if (ratio > 1) return 'bad';
  if (ratio > 0.5) return 'warn';
  return '';
}

/**
 * Why the worker has its status, worst first. Mirrors the derivation in WorkersService.enrichSnapshot
 * (Failed = consecutive failures; Degraded = error rate above 5 % or stale; Idle = stopped, or running
 * with no successful cycle yet) and adds the schedule-overrun check. Empty for a plain healthy worker.
 */
export function workerReasons(w: WorkerHealthDto): WorkerReason[] {
  const out: WorkerReason[] = [];
  if (w.consecutiveFailures > 0) {
    out.push({
      tone: 'bad',
      text: `${w.consecutiveFailures} failed cycle${w.consecutiveFailures === 1 ? '' : 's'} in a row`,
    });
  }
  const attempts = w.errorsLastHour + w.successesLastHour;
  if (w.errorRate > 0.05 && attempts > 0) {
    out.push({
      tone: 'bad',
      text: `${Math.round(w.errorRate * 1000) / 10}% of cycles failed in the last hour (${w.errorsLastHour} of ${attempts})`,
    });
  } else if (w.errorsLastHour > 0) {
    out.push({
      tone: 'warn',
      text: `${w.errorsLastHour} error${w.errorsLastHour === 1 ? '' : 's'} in the last hour (below the 5% degraded line)`,
    });
  }
  if (w.isStale && !w.isCompleted && w.staleSeconds !== null) {
    const interval = w.configuredIntervalSeconds > 0 ? w.configuredIntervalSeconds : 0;
    const limit = Math.max(interval * 3, 300);
    out.push({
      tone: 'warn',
      text: `No successful cycle for ${formatDuration(w.staleSeconds)} — stale after ${formatDuration(limit)}${interval > 0 ? ` (3× its ${formatDuration(interval)} interval, min 5 min)` : ''}`,
    });
  }
  if (w.status === 'Idle') {
    if (!w.isRunning) {
      out.push({ tone: 'info', text: 'Not running — stopped without being marked complete' });
    } else if (!w.lastSuccessAt) {
      out.push({
        tone: 'info',
        text: 'Running, waiting for its first successful cycle (often: no work yet)',
      });
    }
  }
  const lt = latencyTone(w);
  if (lt === 'bad') {
    out.push({
      tone: 'warn',
      text: `P95 cycle ${formatMs(w.cycleDurationP95Ms)} is longer than its ${formatDuration(w.configuredIntervalSeconds)} interval`,
    });
  }
  return out;
}

/** Rank for the attention list: failed, then degraded, then stale, then idle. */
export function attentionRank(w: WorkerHealthDto): number {
  if (w.status === 'Failed') return 0;
  if (w.status === 'Degraded') return 1;
  if (w.isStale && !w.isCompleted) return 2;
  if (w.status === 'Idle') return 3;
  return 4;
}
