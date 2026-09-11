import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  AlgoEngineerRunStateDto,
  AlgoEngineerScorecardRowDto,
  AlgoEngineerStopResultDto,
  AlgoEngineerWorkOrderOptions,
  AlgoEngineerWorkOrderResultDto,
  ResponseData,
} from '@core/api/api.types';

/** Reads the algo-engineer agent's surface (ADR-0020) — the change scorecard, launching work orders,
 *  and a session's live run state. */
@Injectable({ providedIn: 'root' })
export class AlgoEngineerService {
  private readonly api = inject(ApiService);

  /** Predicted-vs-realised outcome per change; optionally only the in-flight (accruing) ones. */
  getScorecard(
    inFlightOnly = false,
    limit = 50,
  ): Observable<ResponseData<AlgoEngineerScorecardRowDto[]>> {
    return this.api.get<ResponseData<AlgoEngineerScorecardRowDto[]>>(
      `/algo-engineer/scorecard?inFlightOnly=${inFlightOnly}&limit=${limit}`,
    );
  }

  /** Launch a work order — the engine proxies to the host algo-engineer service, which mints the
   *  Engineer conversation and runs the OBSERVE→…→PROPOSE loop in the background. Returns the anchor
   *  conversation id to open; further reasoning streams onto it live.
   *
   *  `options` are sent only when set, so an unset budget / read-only flag leaves the host's own
   *  defaults in charge rather than overriding them with an explicit null/false. */
  startWorkOrder(
    instruction: string,
    options?: AlgoEngineerWorkOrderOptions,
  ): Observable<ResponseData<AlgoEngineerWorkOrderResultDto>> {
    const body: Record<string, unknown> = { instruction };
    if (typeof options?.maxBudgetUsd === 'number') body['maxBudgetUsd'] = options.maxBudgetUsd;
    if (options?.readOnly === true) body['readOnly'] = true;
    return this.api.post<ResponseData<AlgoEngineerWorkOrderResultDto>>(
      '/algo-engineer/work-order',
      body,
    );
  }

  /** Latest run of a session (`data = null` when it has none). Silent: it is refetched on every
   *  conversation tickle, and a failure must not stack a toast per turn — the header just keeps
   *  its last state. */
  getRunState(sessionId: number): Observable<ResponseData<AlgoEngineerRunStateDto | null>> {
    return this.api.get<ResponseData<AlgoEngineerRunStateDto | null>>(
      `/algo-engineer/session/${sessionId}/run-state`,
      { silent: true },
    );
  }

  /** Ask the host to stop the session's active run. The caller renders the returned message. */
  stopRun(sessionId: number): Observable<ResponseData<AlgoEngineerStopResultDto>> {
    return this.api.post<ResponseData<AlgoEngineerStopResultDto>>(
      `/algo-engineer/session/${sessionId}/stop`,
      {},
      { silent: true },
    );
  }
}
