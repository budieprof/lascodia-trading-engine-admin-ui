import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type {
  ActivePolicyDto,
  CatalogueDriftHistoryDto,
  CatalogueDriftSummaryDto,
  CompositeMLLayerHealthDto,
  CompositeMLOptionsDiagnosticDto,
  GateCutoverStatusDto,
  LayerSkillSnapshotDto,
  PolicyLineageDto,
  PolicySnapshotDiffDto,
  ResponseData,
  SetGateCutoverRequest,
  SetLayerSkillManualOverrideRequest,
  SetTrainerSkillManualOverrideRequest,
  Timeframe,
  TrainerSkillSnapshotDto,
} from '@core/api/api.types';

/**
 * Read endpoints for the CompositeML operator console (PRD §5.1). The
 * controller surfaces 15 endpoints total; this service wires the two that
 * Phase 1 ships (Active Policies + Layer Health) with the same envelope
 * pattern every other feature service uses. Diff / lineage / skill /
 * drift / cold-start / gate-cutover methods will land alongside their
 * pages in subsequent commits.
 */
@Injectable({ providedIn: 'root' })
export class CompositeMLService {
  private readonly api = inject(ApiService);

  /** GET /composite-ml/active-policies — ordered most-recent activation first. */
  listActivePolicies(): Observable<ResponseData<ActivePolicyDto[]>> {
    return this.api.get<ResponseData<ActivePolicyDto[]>>('/composite-ml/active-policies');
  }

  /**
   * GET /composite-ml/layer-health — per-layer rolling health over the
   * lookback window. Engine clamps `lookbackDays` to [1, 90].
   */
  getLayerHealth(lookbackDays = 7): Observable<ResponseData<CompositeMLLayerHealthDto[]>> {
    return this.api.get<ResponseData<CompositeMLLayerHealthDto[]>>(
      `/composite-ml/layer-health?lookbackDays=${lookbackDays}`,
    );
  }

  /**
   * GET /composite-ml/policy-lineage/{id} — ancestry walk via priorSnapshotId.
   * Engine clamps `maxDepth` to [1, 100]; default 10 is enough for ops work.
   */
  getPolicyLineage(id: number, maxDepth = 10): Observable<ResponseData<PolicyLineageDto>> {
    return this.api.get<ResponseData<PolicyLineageDto>>(
      `/composite-ml/policy-lineage/${id}?maxDepth=${maxDepth}`,
    );
  }

  /**
   * GET /composite-ml/policy-snapshots/diff — per-knob diff between two
   * snapshots. `from` is typically the prior Active that got rolled back to,
   * `to` is the current Active (or vice versa for "what would I be undoing").
   */
  diffPolicySnapshots(
    fromId: number,
    toId: number,
  ): Observable<ResponseData<PolicySnapshotDiffDto>> {
    return this.api.get<ResponseData<PolicySnapshotDiffDto>>(
      `/composite-ml/policy-snapshots/diff?fromId=${fromId}&toId=${toId}`,
    );
  }

  /**
   * GET /composite-ml/layer-skill-snapshots — active per-(layer, partition tier)
   * skill snapshots driving the auto-arbitration weight. All filters are
   * optional; passing none returns the full set across global / per-symbol /
   * per-pair tiers.
   */
  listLayerSkillSnapshots(
    filter: { symbol?: string | null; timeframe?: Timeframe | null; layerId?: string | null } = {},
  ): Observable<ResponseData<LayerSkillSnapshotDto[]>> {
    return this.api.get<ResponseData<LayerSkillSnapshotDto[]>>(
      `/composite-ml/layer-skill-snapshots${buildSkillFilterQuery(filter, 'layerId')}`,
    );
  }

  /** POST /composite-ml/layer-skill-manual-override — hot-reloads next cycle. */
  setLayerSkillOverride(
    payload: SetLayerSkillManualOverrideRequest,
  ): Observable<ResponseData<boolean>> {
    return this.api.post<ResponseData<boolean>>(
      '/composite-ml/layer-skill-manual-override',
      payload,
    );
  }

  /** GET /composite-ml/trainer-skill-snapshots — symmetric to listLayerSkillSnapshots for trainers. */
  listTrainerSkillSnapshots(
    filter: {
      symbol?: string | null;
      timeframe?: Timeframe | null;
      trainerId?: string | null;
    } = {},
  ): Observable<ResponseData<TrainerSkillSnapshotDto[]>> {
    return this.api.get<ResponseData<TrainerSkillSnapshotDto[]>>(
      `/composite-ml/trainer-skill-snapshots${buildSkillFilterQuery(filter, 'trainerId')}`,
    );
  }

  /** POST /composite-ml/trainer-skill-manual-override — hot-reloads next cycle. */
  setTrainerSkillOverride(
    payload: SetTrainerSkillManualOverrideRequest,
  ): Observable<ResponseData<boolean>> {
    return this.api.post<ResponseData<boolean>>(
      '/composite-ml/trainer-skill-manual-override',
      payload,
    );
  }

  /**
   * GET /composite-ml/catalogue-drift/summary — latest-vs-prior summary across
   * all (layerKey, scope) entries. `isDropAlert` flags rows where the latest
   * observed count fell by ≥ `dropAlertRelativeThreshold` over the comparison
   * window and the prior count was ≥ `dropAlertMinPriorCount`. Engine
   * computes the alert; UI just renders.
   */
  getCatalogueDriftSummary(
    opts: {
      compareWindowDays?: number;
      symbol?: string | null;
      timeframe?: Timeframe | null;
      dropAlertRelativeThreshold?: number;
      dropAlertMinPriorCount?: number;
    } = {},
  ): Observable<ResponseData<CatalogueDriftSummaryDto>> {
    const params = new URLSearchParams();
    if (opts.compareWindowDays !== undefined)
      params.set('compareWindowDays', String(opts.compareWindowDays));
    if (opts.symbol) params.set('symbol', opts.symbol);
    if (opts.timeframe) params.set('timeframe', String(opts.timeframe));
    if (opts.dropAlertRelativeThreshold !== undefined)
      params.set('dropAlertRelativeThreshold', String(opts.dropAlertRelativeThreshold));
    if (opts.dropAlertMinPriorCount !== undefined)
      params.set('dropAlertMinPriorCount', String(opts.dropAlertMinPriorCount));
    const q = params.toString();
    return this.api.get<ResponseData<CatalogueDriftSummaryDto>>(
      `/composite-ml/catalogue-drift/summary${q ? `?${q}` : ''}`,
    );
  }

  /**
   * GET /composite-ml/catalogue-drift/history — time-series of one
   * (layerKey, scope). Layer-key is required. Engine clamps `lookbackDays`
   * to [1, 365]; default 30.
   */
  getCatalogueDriftHistory(opts: {
    layerKey: string;
    symbol?: string | null;
    timeframe?: Timeframe | null;
    lookbackDays?: number;
  }): Observable<ResponseData<CatalogueDriftHistoryDto>> {
    const params = new URLSearchParams();
    params.set('layerKey', opts.layerKey);
    if (opts.symbol) params.set('symbol', opts.symbol);
    if (opts.timeframe) params.set('timeframe', String(opts.timeframe));
    if (opts.lookbackDays !== undefined) params.set('lookbackDays', String(opts.lookbackDays));
    return this.api.get<ResponseData<CatalogueDriftHistoryDto>>(
      `/composite-ml/catalogue-drift/history?${params.toString()}`,
    );
  }

  /**
   * GET /composite-ml/gate-cutover/status — one row per catalogue entry with
   * description, covered knob, current returnLedgerCount flag, and the last
   * timestamp the flag flipped. Drives the cutover-management table.
   */
  getGateCutoverStatus(): Observable<ResponseData<GateCutoverStatusDto>> {
    return this.api.get<ResponseData<GateCutoverStatusDto>>('/composite-ml/gate-cutover/status');
  }

  /** POST /composite-ml/gate-cutover — hot-reloads on the next gate invocation. */
  setGateCutover(payload: SetGateCutoverRequest): Observable<ResponseData<boolean>> {
    return this.api.post<ResponseData<boolean>>('/composite-ml/gate-cutover', payload);
  }

  /**
   * GET /composite-ml/options-health — cross-knob audit findings. Empty
   * array = clean configuration; non-empty = at least one known-bad combo
   * (e.g. all RiskAdjustmentLambda* at max, Drawdown↔Calmar double-count).
   */
  getOptionsHealth(): Observable<ResponseData<CompositeMLOptionsDiagnosticDto[]>> {
    return this.api.get<ResponseData<CompositeMLOptionsDiagnosticDto[]>>(
      '/composite-ml/options-health',
    );
  }
}

/** Build `?symbol=&timeframe=&{idKey}=` query string from optional filter. */
function buildSkillFilterQuery(
  filter: { symbol?: string | null; timeframe?: Timeframe | null } & Record<string, unknown>,
  idKey: 'layerId' | 'trainerId',
): string {
  const params = new URLSearchParams();
  if (filter.symbol) params.set('symbol', filter.symbol);
  if (filter.timeframe) params.set('timeframe', String(filter.timeframe));
  const idValue = filter[idKey];
  if (typeof idValue === 'string' && idValue) params.set(idKey, idValue);
  const q = params.toString();
  return q ? `?${q}` : '';
}
