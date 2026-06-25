import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  CancelPendingSignalRecRequest,
  PagedData,
  PendingSignalRecDto,
  PendingSignalRecQueryRequest,
  ResponseData,
} from '@core/api/api.types';

/**
 * Operator cockpit endpoints for the pending-signal-reval mechanic.
 * Wraps `/admin/pending-signal-recs/{query,cancel}` — both behind the
 * Operator policy on the engine.
 */
@Injectable({ providedIn: 'root' })
export class PendingSignalRecsService {
  private readonly api = inject(ApiService);
  private readonly base = '/admin/pending-signal-recs';

  /**
   * POST /admin/pending-signal-recs/query — paginated list with optional
   * state + symbol filters.  Default order: newest first by Id.
   */
  query(
    request: PendingSignalRecQueryRequest,
  ): Observable<ResponseData<PagedData<PendingSignalRecDto>>> {
    return this.api.post<ResponseData<PagedData<PendingSignalRecDto>>>(
      `${this.base}/query`,
      request,
    );
  }

  /**
   * POST /admin/pending-signal-recs/{id}/cancel — operator-initiated cancel.
   * Only Parked rows are cancellable; engine returns 409-shaped envelope
   * (status=false, message) for Revalidating / terminal states.
   */
  cancel(id: number, body: CancelPendingSignalRecRequest = {}): Observable<ResponseData<string>> {
    return this.api.post<ResponseData<string>>(`${this.base}/${id}/cancel`, body);
  }
}
