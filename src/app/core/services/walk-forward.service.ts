import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  WalkForwardRunDto,
  CreateWalkForwardRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class WalkForwardService {
  private readonly api = inject(ApiService);

  /** Queues a run; the engine answers with the new run's id (`ResponseData<long>`), not the run. */
  create(data: CreateWalkForwardRequest): Observable<ResponseData<number>> {
    return this.api.post(`/walk-forward`, data);
  }

  getById(id: number): Observable<ResponseData<WalkForwardRunDto>> {
    return this.api.get(`/walk-forward/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<WalkForwardRunDto>>> {
    return this.api.post(`/walk-forward/list`, params);
  }
}
