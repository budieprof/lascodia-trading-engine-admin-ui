import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  EconomicEventDto,
  CreateEconomicEventRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class EconomicEventsService {
  private readonly api = inject(ApiService);

  list(params: PagerRequest): Observable<ResponseData<PagedData<EconomicEventDto>>> {
    return this.api.post(`/economic-event/list`, params);
  }

  create(data: CreateEconomicEventRequest): Observable<ResponseData<EconomicEventDto>> {
    return this.api.post(`/economic-event`, data);
  }

  updateActual(id: number, data: any): Observable<ResponseData<EconomicEventDto>> {
    return this.api.put(`/economic-event/${id}/actual`, data);
  }
}
