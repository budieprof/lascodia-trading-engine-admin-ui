import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  OptimizationRunDto,
  PagedData,
  ResponseData,
  WalkForwardRunDto,
} from '@core/api/api.types';

import type {
  MonteCarloDto,
  MonteCarloParams,
  OptimizationCandidatesDto,
  OptimizationHeatmapDto,
  OptimizationRunExtraFields,
  ParameterSpaceDto,
  SearchSpec,
  TrialLedgerDto,
  WalkForwardAnalysisDto,
  WalkForwardLaunchRequest,
  WalkForwardRunExtraFields,
} from './research.types';

export type OptimizationRun = OptimizationRunDto & OptimizationRunExtraFields;
export type WalkForwardRun = WalkForwardRunDto & WalkForwardRunExtraFields;

/**
 * The research workbench's engine calls (scripting API §8a–§8f): the optimizer's search space and spec, the
 * optimization and walk-forward runs of a strategy, their analyses, Monte Carlo in R and the trial ledger.
 *
 * Every call is `silent`: the workbench shows its own inline error for a refusal, so the interceptor does not
 * stack a toast on top. The workbench only LAUNCHES research runs — it never approves or promotes anything.
 */
@Injectable({ providedIn: 'root' })
export class ResearchApiService {
  private readonly api = inject(ApiService);

  /** §8a — the script's declared search space (searched inputs, skipped ones and why). */
  parameterSpace(strategyId: number): Observable<ResponseData<ParameterSpaceDto>> {
    return this.api.get(`/strategy/${strategyId}/script/parameter-space`, { silent: true });
  }

  /** §8a — the space a spec shapes, with every way it does not fit the script (`problems`). Writes nothing. */
  previewSpace(strategyId: number, spec: SearchSpec): Observable<ResponseData<ParameterSpaceDto>> {
    return this.api.post(`/strategy/${strategyId}/script/parameter-space`, spec, { silent: true });
  }

  /** §8a — queue an optimization run (`data` = its id); `-409` while one is already queued or running. */
  triggerOptimization(
    strategyId: number,
    spec: SearchSpec | null,
  ): Observable<ResponseData<number>> {
    const body: Record<string, unknown> = { strategyId, triggerType: 'Manual' };
    if (spec) body['searchSpec'] = spec;
    return this.api.post('/strategy-feedback/optimization/trigger', body, { silent: true });
  }

  /** The strategy's optimization runs, newest first. */
  optimizationRuns(
    strategyId: number,
    size = 20,
  ): Observable<ResponseData<PagedData<OptimizationRun>>> {
    return this.api.post(
      '/strategy-feedback/optimization/list',
      {
        currentPage: 1,
        itemCountPerPage: size,
        filter: { strategyId },
        sortBy: 'Id',
        sortDirection: 'desc',
      },
      { silent: true },
    );
  }

  optimizationRun(id: number): Observable<ResponseData<OptimizationRun>> {
    return this.api.get(`/strategy-feedback/optimization/${id}`, { silent: true });
  }

  /** §8f — a run's candidates with the overfitting evidence (DSR, PBO, CSCV splits, warnings). */
  candidates(
    runId: number,
    sortBy = 'healthScore',
    limit = 200,
  ): Observable<ResponseData<OptimizationCandidatesDto>> {
    const q = new URLSearchParams({ sortBy, limit: String(limit) });
    return this.api.get(`/strategy-feedback/optimization/${runId}/candidates?${q}`, {
      silent: true,
    });
  }

  /** §8e — the ExpectancyR heatmap over two parameters (default: the two most varied). */
  heatmap(
    runId: number,
    x: string | null,
    y: string | null,
    bins = 10,
  ): Observable<ResponseData<OptimizationHeatmapDto>> {
    const q = new URLSearchParams({ bins: String(bins) });
    if (x) q.set('x', x);
    if (y) q.set('y', y);
    return this.api.get(`/strategy-feedback/optimization/${runId}/heatmap?${q}`, {
      silent: true,
    });
  }

  /** §8d — the lineage's multiple-testing ledger and its runs' PBO. */
  trials(strategyId: number): Observable<ResponseData<TrialLedgerDto>> {
    return this.api.get(`/strategy-feedback/${strategyId}/trials`, { silent: true });
  }

  /** The strategy's walk-forward runs, newest first. */
  walkForwardRuns(
    strategyId: number,
    size = 20,
  ): Observable<ResponseData<PagedData<WalkForwardRun>>> {
    return this.api.post(
      '/walk-forward/list',
      {
        currentPage: 1,
        itemCountPerPage: size,
        filter: { strategyId },
        sortBy: 'Id',
        sortDirection: 'desc',
      },
      { silent: true },
    );
  }

  /** §8b — queue a walk-forward run (`data` = its id). */
  launchWalkForward(req: WalkForwardLaunchRequest): Observable<ResponseData<number>> {
    return this.api.post('/walk-forward', req, { silent: true });
  }

  walkForwardRun(id: number): Observable<ResponseData<WalkForwardRun>> {
    return this.api.get(`/walk-forward/${id}`, { silent: true });
  }

  /** §8b — a completed run's stitched out-of-sample result, efficiency and parameter drift. */
  walkForwardAnalysis(id: number): Observable<ResponseData<WalkForwardAnalysisDto>> {
    return this.api.get(`/walk-forward/${id}/analysis`, { silent: true });
  }

  /** §8c — block-bootstrap Monte Carlo of a run's R multiples (a backtest, or a walk-forward's stitched OOS trades). */
  monteCarlo(
    source: { kind: 'backtest' | 'walk-forward'; id: number },
    params: MonteCarloParams,
  ): Observable<ResponseData<MonteCarloDto>> {
    const q = new URLSearchParams({
      iterations: String(params.iterations),
      riskPerTradePct: String(params.riskPerTradePct),
      ruinDrawdownPct: String(params.ruinDrawdownPct),
    });
    return this.api.get(`/${source.kind}/${source.id}/monte-carlo?${q}`, { silent: true });
  }
}
