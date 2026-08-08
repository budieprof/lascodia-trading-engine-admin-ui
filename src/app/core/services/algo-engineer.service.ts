import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  AlgoEngineerScorecardRowDto,
  AlgoEngineerWorkOrderResultDto,
  ResponseData,
} from '@core/api/api.types';

/** Reads the algo-engineer agent's surface (ADR-0020) — the change scorecard + launching work orders. */
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
   *  conversation id to open; further reasoning streams onto it live. */
  startWorkOrder(instruction: string): Observable<ResponseData<AlgoEngineerWorkOrderResultDto>> {
    return this.api.post<ResponseData<AlgoEngineerWorkOrderResultDto>>(
      '/algo-engineer/work-order',
      {
        instruction,
      },
    );
  }
}
