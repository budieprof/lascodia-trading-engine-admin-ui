import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';

import type {
  PortfolioRun,
  PortfolioRunSummary,
  QueuePortfolioBacktestRequest,
} from './portfolio-backtest.types';

/**
 * Portfolio backtests (engine scripting API §8h). Every call is `silent`: the pages show their own inline error for a
 * refusal (the engine's `-11` lists every member problem at once), so the interceptor does not stack a toast on top.
 */
@Injectable({ providedIn: 'root' })
export class PortfolioBacktestApiService {
  private readonly api = inject(ApiService);

  /** The newest runs, newest first (status and headline figures, no findings). */
  list(limit = 50): Observable<ResponseData<PortfolioRunSummary[]>> {
    return this.api.get(`/portfolio-backtest?limit=${limit}`, { silent: true });
  }

  /** One run: what was queued and, once completed, its findings (`-14` for an unknown run). */
  get(id: number): Observable<ResponseData<PortfolioRun>> {
    return this.api.get(`/portfolio-backtest/${id}`, { silent: true });
  }

  /** Queue a run; `data` is its id. */
  queue(request: QueuePortfolioBacktestRequest): Observable<ResponseData<number>> {
    return this.api.post('/portfolio-backtest', request, { silent: true });
  }

  /** A queued run is cancelled at once; a running one stops at its worker's next heartbeat. */
  cancel(id: number): Observable<ResponseData<boolean>> {
    return this.api.post(`/portfolio-backtest/${id}/cancel`, {}, { silent: true });
  }

  /** Remove a finished run from the list. */
  remove(id: number): Observable<ResponseData<boolean>> {
    return this.api.delete(`/portfolio-backtest/${id}`, { silent: true });
  }
}
