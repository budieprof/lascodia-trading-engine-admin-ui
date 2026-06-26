import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiService } from '@core/api/api.service';
import { PositionSlChangeLog, SlAuditQuery } from '@features/sl-audit/sl-audit.types';

/**
 * Engine `Pager + data` envelope as returned by paged queries (see
 * `Lascodia.Trading.Engine.SharedLibrary.PagedData<T>`).  The lowercase
 * field names match what the engine emits over the wire.
 */
export interface PagedEnvelope<T> {
  data: T[];
  pager: {
    TotalItemCount: number;
    CurrentPage: number;
    ItemCountPerPage: number;
    /** May be present depending on the engine's serializer settings. */
    PageNo?: number;
    /** Computed property — may or may not be serialized. */
    PageSize?: number;
  };
}

/**
 * Data access for the SL Audit page + drill-in.  Engine endpoints under
 * `/position/sl-history/*` (see PositionController).
 */
@Injectable({ providedIn: 'root' })
export class SlAuditService {
  private readonly api = inject(ApiService);

  /**
   * Fleet-wide paged audit feed.  Omit filters for the firehose
   * (newest-first).  Pass `positionId` to scope to one position from the
   * drill-in surface.
   */
  list(query: SlAuditQuery): Observable<PagedEnvelope<PositionSlChangeLog>> {
    return this.api.postEnvelope<PagedEnvelope<PositionSlChangeLog>>(
      '/position/sl-history/list',
      query,
    );
  }

  /** Drill-in convenience — GET endpoint with positionId on the path. */
  listForPosition(
    positionId: number,
    pageNumber = 1,
    pageSize = 50,
  ): Observable<PagedEnvelope<PositionSlChangeLog>> {
    return this.api.getEnvelope<PagedEnvelope<PositionSlChangeLog>>(
      `/position/${positionId}/sl-history?pageNumber=${pageNumber}&pageSize=${pageSize}`,
    );
  }
}
