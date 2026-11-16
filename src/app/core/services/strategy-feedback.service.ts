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

  /**
   * Paged history of performance snapshots for a single strategy, newest-first.
   * Powers the strategy-detail performance-history chart. The path-bound id
   * always wins server-side, so the body filter doesn't need to repeat it.
   */
  getSnapshotHistory(
    strategyId: number,
    params: PagerRequest,
  ): Observable<ResponseData<PagedData<StrategyPerformanceSnapshotDto>>> {
    return this.api.post(`/strategy-feedback/${strategyId}/snapshots`, params);
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

  /**
   * Approve a completed run. The engine answers `ResponseData<string>` (a status sentence, not the run):
   * it starts a gradual rollout of the best parameters, or defers it when the strategy is already
   * mid-rollout — `message`/`data` say which. Re-read the run with {@link getOptimizationRun}.
   */
  approveOptimization(id: number): Observable<ResponseData<string>> {
    return this.api.put(`/strategy-feedback/optimization/${id}/approve`);
  }

  /** Reject a completed run. Answers `ResponseData<string>`; re-read the run afterwards. */
  rejectOptimization(id: number): Observable<ResponseData<string>> {
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
