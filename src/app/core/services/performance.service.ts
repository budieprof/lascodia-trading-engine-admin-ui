import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  StrategyPerformanceSnapshotDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class PerformanceService {
  private readonly api = inject(ApiService);

  getByStrategy(strategyId: number): Observable<ResponseData<StrategyPerformanceSnapshotDto>> {
    return this.api.get(`/performance/${strategyId}`);
  }

  getAll(): Observable<ResponseData<StrategyPerformanceSnapshotDto[]>> {
    return this.api.get(`/performance/all`);
  }
}
