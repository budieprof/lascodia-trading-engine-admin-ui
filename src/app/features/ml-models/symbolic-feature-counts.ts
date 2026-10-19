import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData, SymbolicFeatureStatus } from '@core/api/api.types';

/** `GET /ml-model/symbolic-features/counts` — exact per-status totals (one `GROUP BY Status`). */
export interface SymbolicFeatureCountsDto {
  total: number;
  byStatus: Partial<Record<SymbolicFeatureStatus, number>>;
}

/**
 * The symbolic-feature status counts the KPI tiles read. The list endpoint caps at 500 rows and
 * carries no count, so the page used to fire one capped list query per status just to count
 * (Rejected read "200+" against 761). Feature-local until it moves into `MLModelsService`.
 */
@Injectable({ providedIn: 'root' })
export class SymbolicFeatureCountsApi {
  private readonly api = inject(ApiService);

  /** Symbol match is case-insensitive on the engine; null counts every pair. */
  counts(symbol: string | null): Observable<ResponseData<SymbolicFeatureCountsDto>> {
    const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
    return this.api.get(`/ml-model/symbolic-features/counts${qs}`, { silent: true });
  }
}
