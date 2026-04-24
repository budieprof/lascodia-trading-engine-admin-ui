import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  StrategyPerformanceSnapshotDto,
  OptimizationRunDto,
  OptimizationDryRunDto,
  OptimizationValidationDto,
  TriggerOptimizationRequest,
  ValidateOptimizationRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class StrategyFeedbackService {
  private readonly api = inject(ApiService);

  getPerformance(strategyId: number): Observable<ResponseData<StrategyPerformanceSnapshotDto>> {
    return this.api.get(`/strategy-feedback/${strategyId}/performance`);
  }

  triggerOptimization(
    data: TriggerOptimizationRequest,
  ): Observable<ResponseData<OptimizationRunDto>> {
    return this.api.post(`/strategy-feedback/optimization/trigger`, data);
  }

  validateOptimizationConfig(
    data: ValidateOptimizationRequest,
  ): Observable<ResponseData<OptimizationValidationDto>> {
    return this.api.post(`/strategy-feedback/optimization/config/validate`, data);
  }

  getOptimizationDryRun(strategyId: number): Observable<ResponseData<OptimizationDryRunDto>> {
    return this.api.get(`/strategy-feedback/optimization/${strategyId}/dry-run`);
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

  listOptimizationRuns(
    params: PagerRequest,
  ): Observable<ResponseData<PagedData<OptimizationRunDto>>> {
    return this.api.post(`/strategy-feedback/optimization/list`, params);
  }
}
