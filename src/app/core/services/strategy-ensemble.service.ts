import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  StrategyAllocationDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class StrategyEnsembleService {
  private readonly api = inject(ApiService);

  rebalance(): Observable<ResponseData<StrategyAllocationDto[]>> {
    return this.api.post(`/strategy-ensemble/rebalance`);
  }

  getAllocations(): Observable<ResponseData<StrategyAllocationDto[]>> {
    return this.api.get(`/strategy-ensemble/allocations`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<StrategyAllocationDto>>> {
    return this.api.post(`/strategy-ensemble/list`, params);
  }
}
