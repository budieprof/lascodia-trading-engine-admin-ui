import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, PagedData, PagerRequest, PositionDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class PositionsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<PositionDto>> {
    return this.api.get(`/position/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<PositionDto>>> {
    return this.api.post(`/position/list`, params);
  }

  /**
   * Manually close (or partially close) an open position. The engine
   * updates the position record AND queues an EA command for MT5 to
   * flatten the trade. `closeLots` is optional — when omitted the engine
   * defaults to closing all open lots.
   */
  close(id: number, closePrice: number, closeLots?: number): Observable<ResponseData<string>> {
    return this.api.post(`/position/${id}/close`, {
      id,
      closePrice,
      closeLots: closeLots ?? null,
    });
  }
}
