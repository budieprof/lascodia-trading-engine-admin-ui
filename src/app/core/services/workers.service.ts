import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { WorkerHealthDto, WorkerHealthSnapshot, WorkerHealthStatus } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class WorkersService {
  private readonly api = inject(ApiService);

  /**
   * Returns enriched health rows for every registered background worker.
   *
   * `/health/workers` is the only endpoint that returns a raw array instead of
   * the standard `ResponseData<T>` envelope (see SystemHealthController.cs:48),
   * and the snapshot it returns has *no* status field — status, category, error
   * rate, and staleness are derived client-side from the raw counters.
   */
  list(): Observable<WorkerHealthDto[]> {
    return this.api
      .get<WorkerHealthSnapshot[]>(`/health/workers`)
      .pipe(map((rows) => (rows ?? []).map(enrichSnapshot)));
  }
}

function enrichSnapshot(s: WorkerHealthSnapshot): WorkerHealthDto {
  const successes = s.successesLastHour ?? 0;
  const errors = s.errorsLastHour ?? 0;
  const total = successes + errors;
  const errorRate = total > 0 ? errors / total : 0;

  const captured = s.capturedAt ? new Date(s.capturedAt).getTime() : Date.now();
  const lastSuccessMs = s.lastSuccessAt ? new Date(s.lastSuccessAt).getTime() : null;
  const staleSeconds =
    lastSuccessMs !== null ? Math.max(0, Math.floor((captured - lastSuccessMs) / 1000)) : null;
  // Staleness threshold: 3× the worker's configured interval, floored at 5 min so
  // sub-minute pollers don't flap when the snapshot lags by a couple of cycles.
  const intervalSec = Math.max(1, s.configuredIntervalSeconds || 0);
  const staleThreshold = Math.max(intervalSec * 3, 300);
  const isStale = staleSeconds !== null && staleSeconds > staleThreshold;

  let status: WorkerHealthStatus;
  if (s.consecutiveFailures > 0) {
    status = 'Failed';
  } else if (s.isCompleted) {
    // One-shot workers (DB backfills, model warmups, startup orchestrators)
    // that have finished their job cleanly. The engine sets isCompleted=true
    // explicitly for this case — counting them as Idle made the wall display
    // misleading (it implied the worker was broken when it had actually
    // succeeded and exited).
    status = 'Healthy';
  } else if (!s.isRunning) {
    // Stopped but not marked completed — genuinely idle (disabled, crashed
    // without a recorded error, etc.).
    status = 'Idle';
  } else if (lastSuccessMs === null) {
    // Running but no successful cycle yet. Could be a fresh-start poll loop
    // waiting for its first piece of work (e.g. SignalOrderBridgeWorker with
    // no pending signals) or a long-cadence worker that hasn't fired yet.
    // Stay Idle until staleness pushes it elsewhere.
    status = 'Idle';
  } else if (errorRate > 0.05 || isStale) {
    status = 'Degraded';
  } else {
    status = 'Healthy';
  }

  // Category = first CamelCase segment of the worker name. e.g. "MLTrainingWorker"
  // → "ML", "StrategyHealthWorker" → "Strategy". Falls back to "Other".
  const match = s.workerName.match(/^[A-Z]+(?=[A-Z][a-z])|^[A-Z][a-z]+/);
  const category = match ? match[0] : 'Other';

  return {
    ...s,
    name: s.workerName,
    category,
    status,
    errorRate,
    staleSeconds,
    isStale,
  };
}
