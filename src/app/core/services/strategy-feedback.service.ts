import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  StrategyPerformanceSnapshotDto,
  OptimizationRunDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class StrategyFeedbackService {
  private readonly api = inject(ApiService);

  getPerformance(strategyId: number): Observable<ResponseData<StrategyPerformanceSnapshotDto>> {
    return this.api.get(`/strategy-feedback/${strategyId}/performance`);
  }

  triggerOptimization(data: any): Observable<ResponseData<OptimizationRunDto>> {
    return this.api.post(`/strategy-feedback/optimization/trigger`, data);
  }

  approveOptimization(id: number): Observable<ResponseData<OptimizationRunDto>> {
    return this.api.put(`/strategy-feedback/optimization/${id}/approve`);
  }

  rejectOptimization(id: number): Observable<ResponseData<OptimizationRunDto>> {
    return this.api.put(`/strategy-feedback/optimization/${id}/reject`);
  }

  getOptimizationRun(id: number): Observable<ResponseData<OptimizationRunDto>> {
    return this.api.get(`/strategy-feedback/optimization/${id}`);
  }

  listOptimizationRuns(params: PagerRequest): Observable<ResponseData<PagedData<OptimizationRunDto>>> {
    return this.api.post(`/strategy-feedback/optimization/list`, params);
  }
}
