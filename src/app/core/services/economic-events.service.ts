import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  EconomicEventDto,
  EconomicEventExplainResult,
  CreateEconomicEventRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class EconomicEventsService {
  private readonly api = inject(ApiService);

  list(params: PagerRequest): Observable<ResponseData<PagedData<EconomicEventDto>>> {
    return this.api.post(`/economic-event/list`, params);
  }

  getById(id: number): Observable<ResponseData<EconomicEventDto>> {
    return this.api.get(`/economic-event/${id}`);
  }

  /**
   * Resolves an explainer for the event — cache hit → scrape → LLM.  When
   * `forceRegenerate` is true, bypass the cache and force a fresh LLM call
   * (operator override when the cached description is stale).
   */
  explain(
    id: number,
    forceRegenerate = false,
  ): Observable<ResponseData<EconomicEventExplainResult>> {
    const qs = forceRegenerate ? `?forceRegenerate=true` : '';
    return this.api.post(`/economic-event/${id}/explain${qs}`, {});
  }

  create(data: CreateEconomicEventRequest): Observable<ResponseData<EconomicEventDto>> {
    return this.api.post(`/economic-event`, data);
  }

  updateActual(id: number, data: unknown): Observable<ResponseData<EconomicEventDto>> {
    return this.api.put(`/economic-event/${id}/actual`, data);
  }
}
