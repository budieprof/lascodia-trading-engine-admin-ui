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
}
