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
  StrategyTemplateDto,
  CreateStrategyTemplateRequest,
  ApplyStrategyTemplateRequest,
  ApplyStrategyTemplateResult,
  StrategyRejectionSummaryDto,
  StrategyParameterSchemaDto,
  RunBacktestPreviewRequest,
  BacktestPreviewResult,
  StrategyVersionDto,
  StrategyLineageDto,
  BulkUpdateStrategiesRequest,
  BulkUpdateStrategiesResult,
  BacktestPreviewSnapshotDto,
  SaveBacktestPreviewSnapshotRequest,
  PromotionGatesDto,
  LlmProposalDto,
  LlmProposalStatusDto,
  StrategyProposalCycleResult,
  StrategyPromotionConfigEntryDto,
  StrategyPromotionConfigUpdateEntry,
  PromotionReviewSnapshotDto,
  PromotionReviewRecommendation,
  PromotionReviewOutcome,
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

  // ── Strategy templates (TradingView-style presets) ──
  listTemplates(): Observable<ResponseData<StrategyTemplateDto[]>> {
    return this.api.get(`/strategy/templates`);
  }

  createTemplate(data: CreateStrategyTemplateRequest): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/templates`, data);
  }

  applyTemplate(
    data: ApplyStrategyTemplateRequest,
  ): Observable<ResponseData<ApplyStrategyTemplateResult>> {
    return this.api.post(`/strategy/templates/apply`, data);
  }

  getRejectionSummary(
    lookbackHours = 24,
    topN = 50,
  ): Observable<ResponseData<StrategyRejectionSummaryDto[]>> {
    return this.api.get(`/strategy/rejection-summary?lookbackHours=${lookbackHours}&topN=${topN}`);
  }

  getParameterSchema(
    strategyType: string,
  ): Observable<ResponseData<StrategyParameterSchemaDto | null>> {
    return this.api.get(`/strategy/parameter-schema/${strategyType}`);
  }

  runBacktestPreview(
    data: RunBacktestPreviewRequest,
  ): Observable<ResponseData<BacktestPreviewResult>> {
    return this.api.post(`/strategy/backtest-preview`, data);
  }

  summariseDsl(dslJson: string): Observable<ResponseData<string | null>> {
    return this.api.post(`/strategy/dsl/summarise`, { dslJson });
  }

  update(id: number, data: UpdateStrategyRequest): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/strategy/${id}`);
  }

  /**
   * Activate a strategy.
   * @param bypassPaperGate Operator override that skips the paper-execution
   * duration/count gate (chicken-and-egg for newly-promoted strategies that
   * have never paper-traded). Adversarial robustness + edge-posterior + CPCV
   * + TCA + correlation gates always run regardless. Default false.
   */
  activate(id: number, bypassPaperGate = false): Observable<ResponseData<StrategyDto>> {
    const qs = bypassPaperGate ? '?bypassPaperGate=true' : '';
    return this.api.put(`/strategy/${id}/activate${qs}`);
  }

  /**
   * Read-only evaluation of every promotion gate. Used by the strategy detail
   * page's "Promotion Readiness" card to show the breakdown before activation.
   */
  getPromotionGates(
    id: number,
    bypassPaperGate = false,
  ): Observable<ResponseData<PromotionGatesDto>> {
    const qs = bypassPaperGate ? '?bypassPaperGate=true' : '';
    return this.api.get(`/strategy/${id}/promotion-gates${qs}`);
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

  /** Captured pre-edit snapshots of a strategy, newest first. */
  getVersions(id: number, limit?: number): Observable<ResponseData<StrategyVersionDto[]>> {
    const q = limit != null ? `?limit=${limit}` : '';
    return this.api.get(`/strategy/${id}/versions${q}`);
  }

  /**
   * Restore a strategy to a captured version. Engine snapshots the current
   * state first so the rollback is itself reversible.
   */
  rollbackVersion(strategyId: number, versionId: number): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/${strategyId}/versions/${versionId}/rollback`, {});
  }

  /** Parent/child tree centred on a strategy (depths -5..+5). */
  getLineage(id: number, maxDepth?: number): Observable<ResponseData<StrategyLineageDto>> {
    const q = maxDepth != null ? `?maxDepth=${maxDepth}` : '';
    return this.api.get(`/strategy/${id}/lineage${q}`);
  }

  /** Apply Activate/Pause/SetRiskProfile/ClearRiskProfile to up to 200 ids. */
  bulkUpdate(
    data: BulkUpdateStrategiesRequest,
  ): Observable<ResponseData<BulkUpdateStrategiesResult>> {
    return this.api.post(`/strategy/bulk-update`, data);
  }

  // ── Preview snapshots (server-side persistence for cross-session compare) ──

  savePreviewSnapshot(data: SaveBacktestPreviewSnapshotRequest): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/preview-snapshots`, data);
  }

  listPreviewSnapshots(
    filter: {
      symbol?: string | null;
      timeframe?: string | null;
      strategyType?: string | null;
      limit?: number;
      /** 'mine' (default) shows the current operator's snapshots; 'all' shows everyone's. */
      scope?: 'mine' | 'all';
    } = {},
  ): Observable<ResponseData<BacktestPreviewSnapshotDto[]>> {
    const params = new URLSearchParams();
    if (filter.symbol) params.append('symbol', filter.symbol);
    if (filter.timeframe) params.append('timeframe', filter.timeframe);
    if (filter.strategyType) params.append('strategyType', filter.strategyType);
    if (filter.limit != null) params.append('limit', String(filter.limit));
    if (filter.scope) params.append('scope', filter.scope);
    const q = params.toString();
    return this.api.get(`/strategy/preview-snapshots${q ? '?' + q : ''}`);
  }

  deletePreviewSnapshot(id: number): Observable<ResponseData<boolean>> {
    return this.api.delete(`/strategy/preview-snapshots/${id}`);
  }

  /** Update the free-text notes on a saved preview snapshot. */
  updatePreviewSnapshotNotes(id: number, notes: string | null): Observable<ResponseData<boolean>> {
    return this.api.patch(`/strategy/preview-snapshots/${id}/notes`, { notes });
  }

  /** Manual capture of a strategy's current state as a versioned snapshot. */
  captureVersion(
    strategyId: number,
    changeReason?: string | null,
  ): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/${strategyId}/versions/capture`, {
      changeReason: changeReason ?? null,
    });
  }

  /** GET /strategy/llm-proposals — operator-facing review queue. */
  listLlmProposals(
    opts: {
      status?: string | null;
      limit?: number;
    } = {},
  ): Observable<ResponseData<LlmProposalDto[]>> {
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.api.get(`/strategy/llm-proposals${qs ? '?' + qs : ''}`);
  }

  /** POST /strategy/llm-proposals/{id}/promote — creates a Paused Strategy + returns its id. */
  promoteLlmProposal(id: number): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/llm-proposals/${id}/promote`, {});
  }

  /**
   * GET /strategy/llm-proposals/status — worker-config + all-time
   * aggregates + recent-activity snapshot. Feeds the proposals page
   * header so operators can self-diagnose "why no proposals?" without
   * trawling logs.
   */
  getLlmProposalStatus(): Observable<ResponseData<LlmProposalStatusDto>> {
    return this.api.get(`/strategy/llm-proposals/status`);
  }

  /**
   * POST /strategy/llm-proposals/run — operator-initiated cycle. Same
   * pipeline the scheduled worker uses (generate / validate / dedup /
   * persist), just on demand. Returns per-status counts the page can
   * surface inline.
   */
  triggerLlmProposalRun(): Observable<ResponseData<StrategyProposalCycleResult>> {
    return this.api.post(`/strategy/llm-proposals/run`, {});
  }

  /**
   * GET /strategy/promotion-settings — catalog-merged StrategyPromotion:*
   * EngineConfig rows. Drives the Strategy Settings page.
   */
  getPromotionSettings(): Observable<ResponseData<StrategyPromotionConfigEntryDto[]>> {
    return this.api.get(`/strategy/promotion-settings`);
  }

  /** PUT /strategy/promotion-settings — bulk upsert. */
  updatePromotionSettings(
    entries: StrategyPromotionConfigUpdateEntry[],
  ): Observable<ResponseData<number>> {
    return this.api.put(`/strategy/promotion-settings`, { entries });
  }

  /** GET /promotion-review/{id} — single bull/bear/judge advisory review. */
  getPromotionReview(id: number): Observable<ResponseData<PromotionReviewSnapshotDto>> {
    return this.api.get(`/promotion-review/${id}`);
  }

  /** POST /promotion-review/list — paged list with optional strategy / verdict / outcome filters. */
  listPromotionReviews(
    params: PagerRequest & {
      filter?: {
        strategyId?: number | null;
        judgeRecommendation?: PromotionReviewRecommendation | null;
        outcome?: PromotionReviewOutcome | null;
      };
    },
  ): Observable<ResponseData<PagedData<PromotionReviewSnapshotDto>>> {
    return this.api.post(`/promotion-review/list`, params);
  }
}
