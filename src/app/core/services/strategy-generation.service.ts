import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  PagedData,
  PagerRequest,
  ResponseData,
  StrategyGenerationCycleRunDto,
} from '@core/api/api.types';

/**
 * Wraps `/strategy-generation/*` — manual cycle trigger and the paged cycle-run
 * timeline that powers the generation-pipeline visualizer.
 */
@Injectable({ providedIn: 'root' })
export class StrategyGenerationService {
  private readonly api = inject(ApiService);

  /** Manually trigger a generation cycle. Operator policy. */
  triggerCycle(): Observable<ResponseData<string>> {
    return this.api.post(`/strategy-generation/cycles/trigger`, {});
  }

  /**
   * Paged cycle-run history. Pass `filter.status` to scope to a specific
   * status (`Running`, `Completed`, `Failed`); omit for all.
   */
  listCycles(
    params: PagerRequest,
  ): Observable<ResponseData<PagedData<StrategyGenerationCycleRunDto>>> {
    return this.api.post(`/strategy-generation/cycles/list`, params);
  }
}
