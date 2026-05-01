import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  StrategyDto,
  StrategyAllocationWeightsDto,
  StrategyCapacityProfileDto,
  StrategyEquityCurveDto,
  StrategyPerformanceSnapshotDto,
  StrategyRejectionDistributionDto,
  StrategyVariantDto,
  PortfolioFwerReportDto,
  GetRecentStrategySnapshotsRequest,
  GetStrategyEquityCurveRequest,
  GetStrategyRejectionDistributionRequest,
  CreateStrategyRequest,
  UpdateStrategyRequest,
  AssignRiskProfileRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class StrategiesService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<StrategyDto>> {
    return this.api.get(`/strategy/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<StrategyDto>>> {
    return this.api.post(`/strategy/list`, params);
  }

  create(data: CreateStrategyRequest): Observable<ResponseData<StrategyDto>> {
    return this.api.post(`/strategy`, data);
  }

  update(id: number, data: UpdateStrategyRequest): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/strategy/${id}`);
  }

  activate(id: number): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}/activate`);
  }

  pause(id: number): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}/pause`);
  }

  assignRiskProfile(
    id: number,
    data: AssignRiskProfileRequest,
  ): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}/risk-profile`, data);
  }

  /** Lists A/B variants attached to a strategy — newest-first, soft-deleted excluded. */
  getVariants(id: number): Observable<ResponseData<StrategyVariantDto[]>> {
    return this.api.get(`/strategy/${id}/variants`);
  }

  /**
   * Promotes a variant: copies its parameter overrides onto the parent
   * strategy and flips `IsPromoted=true` + `CompletedAt`. Analyst policy.
   * Idempotent — re-calling for an already-promoted variant succeeds with
   * no further mutation.
   */
  promoteVariant(variantId: number): Observable<ResponseData<string>> {
    return this.api.post(`/strategy/variants/${variantId}/promote`, {});
  }

  /** AUM-vs-edge capacity curve. Returns null when the capacity worker hasn't profiled this strategy. */
  getCapacityProfile(id: number): Observable<ResponseData<StrategyCapacityProfileDto>> {
    return this.api.get(`/strategy/${id}/capacity-profile`);
  }

  /**
   * Bulk: returns the last N performance snapshots for a set of strategy ids
   * in one request. Powers the strategies-list sparklines so the page avoids
   * an N+1 fetch. The engine caps at 100 ids and 50 snapshots each.
   */
  getRecentSnapshots(
    body: GetRecentStrategySnapshotsRequest,
  ): Observable<ResponseData<StrategyPerformanceSnapshotDto[]>> {
    return this.api.post(`/strategy/health/recent`, body);
  }

  /**
   * Snapshot of the meta-allocator's current weights across the active
   * portfolio. `activeOnly=true` (default) hides paused/stopped strategies.
   */
  getAllocationWeights(activeOnly = true): Observable<ResponseData<StrategyAllocationWeightsDto>> {
    return this.api.get(`/strategy/allocation-weights?activeOnly=${activeOnly}`);
  }

  /** Portfolio-wide multiple-testing-tax report (FWER + BH). Operator/Admin policy. */
  getPortfolioFwerReport(): Observable<ResponseData<PortfolioFwerReportDto>> {
    return this.api.get(`/strategy-generation/portfolio/fwer-report`);
  }

  /**
   * Per-strategy aggregate of pipeline rejections, grouped by Stage → Reason
   * over an optional UTC window. Pass an empty body for the full history.
   */
  getRejectionDistribution(
    id: number,
    body: GetStrategyRejectionDistributionRequest = {},
  ): Observable<ResponseData<StrategyRejectionDistributionDto>> {
    return this.api.post(`/strategy/${id}/rejection-distribution`, body);
  }

  /**
   * Realised cumulative-PnL series for a strategy. Powers the compare page
   * overlay. Capped at 5,000 chronological points server-side.
   */
  getEquityCurve(
    id: number,
    body: GetStrategyEquityCurveRequest = {},
  ): Observable<ResponseData<StrategyEquityCurveDto>> {
    return this.api.post(`/strategy/${id}/equity-curve`, body);
  }
}
