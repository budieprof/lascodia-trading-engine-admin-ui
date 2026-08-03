import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { AlgoEngineerScorecardRowDto, ResponseData } from '@core/api/api.types';

/** Reads the algo-engineer agent's surface (ADR-0020) — currently the change scorecard. */
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
}
