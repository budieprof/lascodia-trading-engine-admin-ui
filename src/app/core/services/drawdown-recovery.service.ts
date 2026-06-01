import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  DrawdownSnapshotDto,
  DrawdownSnapshotQueryFilter,
  PagedData,
  PagerRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class DrawdownRecoveryService {
  private readonly api = inject(ApiService);

  record(data: any): Observable<ResponseData<DrawdownSnapshotDto>> {
    return this.api.post(`/drawdown-recovery`, data);
  }

  /**
   * Pass `accountIds` to scope the response.  When omitted the engine
   * rolls up across every active trading account (legacy fleet
   * behaviour, retained so callers that don't yet pass scope keep
   * working).  A single id returns that account's latest verbatim;
   * multiple ids return an aggregate (sums equity/peak, picks the
   * worst recovery mode across the set).
   */
  getLatest(accountIds?: ReadonlyArray<number>): Observable<ResponseData<DrawdownSnapshotDto>> {
    const qs = accountIds && accountIds.length > 0 ? `?accountIds=${accountIds.join(',')}` : '';
    return this.api.get(`/drawdown-recovery/latest${qs}`);
  }

  listHistory(
    query: PagerRequest & { filter?: DrawdownSnapshotQueryFilter },
  ): Observable<ResponseData<PagedData<DrawdownSnapshotDto>>> {
    return this.api.post(`/drawdown-recovery/history`, query);
  }
}
