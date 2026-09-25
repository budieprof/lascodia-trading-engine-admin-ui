import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiCallOptions, ApiService } from '@core/api/api.service';
import {
  CloneStrategyRequest,
  DslSummaryDto,
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
  LatestStrategyRunsDto,
  PromotionGateEvaluationDto,
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
  StrategyApprovalJobDto,
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

  /** Creates a Paused strategy; `data` is the new id. */
  create(data: CreateStrategyRequest, opts?: ApiCallOptions): Observable<ResponseData<number>> {
    return this.api.post(`/strategy`, data, opts);
  }

  /**
   * Copies a strategy — optionally onto another symbol and/or timeframe — as a
   * new Paused draft. `data` is the new strategy's id.
   */
  clone(
    id: number,
    body: CloneStrategyRequest,
    opts?: ApiCallOptions,
  ): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/${id}/clone`, body, opts);
  }

  /**
   * Moves a v1 DSL strategy to Pine-exact math (`dslVersion: 2`) and saves it;
   * `data` is the upgraded ParametersJson.
   */
  upgradeDsl(id: number, opts?: ApiCallOptions): Observable<ResponseData<string>> {
    return this.api.post(`/strategy/${id}/dsl/upgrade`, {}, opts);
  }

  // ── Strategy templates (TradingView-style presets) ──
  listTemplates(): Observable<ResponseData<StrategyTemplateDto[]>> {
    return this.api.get(`/strategy/templates`);
  }

  createTemplate(
    data: CreateStrategyTemplateRequest,
    opts?: ApiCallOptions,
  ): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/templates`, data, opts);
  }

  /** Replaces a template's fields (same body as create). */
  updateTemplate(
    id: number,
    data: CreateStrategyTemplateRequest,
    opts?: ApiCallOptions,
  ): Observable<ResponseData<unknown>> {
    return this.api.put(`/strategy/templates/${id}`, data, opts);
  }

  /** Deletes a template. Strategies already created from it are not touched. */
  deleteTemplate(id: number, opts?: ApiCallOptions): Observable<ResponseData<unknown>> {
    return this.api.delete(`/strategy/templates/${id}`, opts);
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

  /**
   * Validates DSL JSON and renders its plain-English summary. `timeframe` (the
   * strategy's own) lets the engine check higher-timeframe conditions.
   *
   * `data` is a {@link DslSummaryDto}; engines built before that shape return
   * the summary string (or null with the error in `message`), so callers go
   * through `normaliseDslCheck`. `dslJson` is the old request field, sent
   * alongside `parametersJson` so either engine build answers.
   */
  summariseDsl(
    parametersJson: string,
    timeframe?: string | null,
  ): Observable<ResponseData<DslSummaryDto | string | null>> {
    return this.api.post(
      `/strategy/dsl/summarise`,
      { parametersJson, dslJson: parametersJson, timeframe: timeframe || null },
      { silent: true },
    );
  }

  /** Engine answers `data: true`; symbol/timeframe/type changes are refused with `-11`. */
  update(
    id: number,
    data: UpdateStrategyRequest,
    opts?: ApiCallOptions,
  ): Observable<ResponseData<boolean>> {
    return this.api.put(`/strategy/${id}`, data, opts);
  }

  /**
   * Soft-delete a strategy. The engine refuses with `status: false`, `-11` a script strategy that
   * still holds positions or working orders (D131): its live session manages them.
   */
  delete(id: number, opts?: ApiCallOptions): Observable<ResponseData<void>> {
    return this.api.delete(`/strategy/${id}`, opts);
  }

  /**
   * Activate a strategy.
   * @param bypassPaperGate Operator override that skips the paper-execution
   * duration/count gate (chicken-and-egg for newly-promoted strategies that
   * have never paper-traded). Adversarial robustness + edge-posterior + CPCV
   * + TCA + correlation gates always run regardless. Default false.
   */
  activate(
    id: number,
    bypassPaperGate = false,
    opts?: ApiCallOptions,
  ): Observable<ResponseData<string>> {
    const qs = bypassPaperGate ? '?bypassPaperGate=true' : '';
    return this.api.put(`/strategy/${id}/activate${qs}`, {}, opts);
  }

  /**
   * Submit a Draft for approval (ADR-0027 DEC-10): starts evaluating every promotion gate — the
   * paper gate is bypassed, a Draft has no paper history — and answers at once with a job
   * (`status: 'running'`; the job already evaluating this strategy if there is one). Poll it with
   * {@link getApprovalJob}. A pass moves Draft → Approved, which starts paper trading. A strategy
   * that cannot be submitted is refused here (`status: false`, `-11`/`-14`, `data.jobId` null, the
   * stage in `data.result`).
   */
  submitForApproval(
    id: number,
    opts?: ApiCallOptions,
  ): Observable<ResponseData<StrategyApprovalJobDto>> {
    return this.api.post(`/strategy/${id}/submit-for-approval`, {}, opts);
  }

  /**
   * A Submit-for-approval job: `running`, `done` (`result` is the verdict) or `failed` (no verdict —
   * the evaluation timed out or failed, with an `evaluation` gate row, or an engine restart
   * interrupted it). A verdict reached before a restart is still answered.
   */
  getApprovalJob(
    id: number,
    jobId: string,
    opts?: ApiCallOptions,
  ): Observable<ResponseData<StrategyApprovalJobDto>> {
    return this.api.get(`/strategy/${id}/submit-for-approval/${encodeURIComponent(jobId)}`, opts);
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

  pause(id: number): Observable<ResponseData<string>> {
    return this.api.put(`/strategy/${id}/pause`);
  }

  /**
   * Start paper-trading a Pine script strategy before approval (Draft → PaperTrading): its live
   * session records its trades as paper executions and sends nothing to an account, so no
   * promotion gate runs. It is submitted for approval from there. Refused (`status: false`, `-11`)
   * unless it is a Paused Draft script that compiles as `strategy()` and holds no positions.
   */
  startPaperTrading(id: number, opts?: ApiCallOptions): Observable<ResponseData<string>> {
    return this.api.put(`/strategy/${id}/start-paper-trading`, {}, opts);
  }

  /** Stop a script's paper-only stage (PaperTrading → Draft); its paper executions are kept. */
  stopPaperTrading(id: number, opts?: ApiCallOptions): Observable<ResponseData<string>> {
    return this.api.put(`/strategy/${id}/stop-paper-trading`, {}, opts);
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
   * Recorded promotion-gate attempts, newest first — what the auto-promote phase
   * actually decided, as opposed to `getPromotionGates`, which re-evaluates live.
   *
   * Only this can show a budget timeout or an evidence-unchanged skip, because a
   * live re-evaluation always produces a verdict. The distinction matters: a
   * timeout means the strategy was never judged, which is a different situation
   * from a rejection and calls for a different response.
   */
  getPromotionGateHistory(
    id: number,
    limit = 25,
  ): Observable<ResponseData<PromotionGateEvaluationDto[]>> {
    return this.api.get(`/strategy/${id}/promotion-gate-history?limit=${limit}`);
  }

  /**
   * Bulk: the latest backtest, walk-forward and optimization run for each of the
   * given strategy ids, in one request.
   *
   * Replaces the strategies list's old fan-out, which pulled the most recent 500
   * rows of each run table and grouped them client-side. That was 1,500 rows to
   * decorate 25, and it did not even answer the question: "most recent 500
   * globally" is not "latest for each of these strategies", so the opt-uplift
   * column was blank for 337 of the 343 strategies that had a value. The engine
   * caps at 500 ids.
   */
  getLatestRuns(strategyIds: number[]): Observable<ResponseData<LatestStrategyRunsDto[]>> {
    return this.api.post(`/strategy/runs/latest`, { strategyIds });
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
