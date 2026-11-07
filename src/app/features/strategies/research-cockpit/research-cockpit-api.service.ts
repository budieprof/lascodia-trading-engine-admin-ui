import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';

import type {
  BacktestRunDiffDto,
  ImportLabTrialsResultDto,
  LabTrialDto,
  StartValidationPipelineRequest,
  StrategyHoldoutDto,
  ValidationPipelineDto,
} from './research-cockpit.types';

/**
 * U12 — the research cockpit's engine calls. Every call is `silent`: each card shows its own inline answer (a refusal
 * is HTTP 200 + `status: false` with the engine's sentence). Writes are only ever made from a confirm dialog, behind the
 * write's permission (`access.operator` for the pipeline, holdout and lab import; `access.analyst` for a re-run).
 *
 * The three "assumed" reads (sequential test, calibration profiles, spec history) have NO engine endpoint at
 * 2026-11-07 — the engine stores the data (lifecycle S09, runs C7, ea C6) but exposes no read. The console asks the
 * proposed routes and, on a 404, says the engine does not offer the view yet; it never shows anything it did not get.
 */
@Injectable({ providedIn: 'root' })
export class ResearchCockpitApiService {
  private readonly api = inject(ApiService);

  // ── S13 validation pipeline ─────────────────────────────────────────────
  startPipeline(
    id: number,
    body: StartValidationPipelineRequest,
  ): Observable<ResponseData<number>> {
    return this.api.post(`/strategy/${id}/validation-pipeline`, body, { silent: true });
  }
  latestPipeline(id: number): Observable<ResponseData<ValidationPipelineDto>> {
    return this.api.get(`/strategy/${id}/validation-pipeline`, { silent: true });
  }
  pipeline(id: number, pipelineId: number): Observable<ResponseData<ValidationPipelineDto>> {
    return this.api.get(`/strategy/${id}/validation-pipeline/${pipelineId}`, { silent: true });
  }
  cancelPipeline(id: number, pipelineId: number): Observable<ResponseData<boolean>> {
    return this.api.post(
      `/strategy/${id}/validation-pipeline/${pipelineId}/cancel`,
      {},
      { silent: true },
    );
  }

  // ── V03 lineage holdout ─────────────────────────────────────────────────
  holdout(id: number): Observable<ResponseData<StrategyHoldoutDto>> {
    return this.api.get(`/strategy/${id}/holdout`, { silent: true });
  }
  evaluateHoldout(id: number): Observable<ResponseData<StrategyHoldoutDto>> {
    return this.api.post(`/strategy/${id}/holdout/evaluate`, {}, { silent: true });
  }
  recarveHoldout(id: number): Observable<ResponseData<StrategyHoldoutDto>> {
    return this.api.post(`/strategy/${id}/holdout/recarve`, {}, { silent: true });
  }

  // ── V16 lab import ──────────────────────────────────────────────────────
  importLabTrials(
    id: number,
    batch: string,
    trials: LabTrialDto[],
  ): Observable<ResponseData<ImportLabTrialsResultDto>> {
    return this.api.post(
      `/strategy-feedback/${id}/trials/lab-import`,
      { batch, trials },
      { silent: true },
    );
  }

  // ── C9 re-run + diff ────────────────────────────────────────────────────
  rerun(runId: number): Observable<ResponseData<number>> {
    return this.api.post(`/backtest/${runId}/rerun`, {}, { silent: true });
  }
  diff(
    runId: number,
    otherId: number,
    maxTrades = 50,
  ): Observable<ResponseData<BacktestRunDiffDto>> {
    return this.api.get(`/backtest/${runId}/diff/${otherId}?maxTrades=${maxTrades}`, {
      silent: true,
    });
  }

  // ── Assumed reads (no engine endpoint yet — see the class comment) ───────
  /** S09 — the strategy's CUSUM state per config hash. ASSUMED route. */
  sequentialTest(id: number): Observable<ResponseData<unknown>> {
    return this.api.get(`/strategy/${id}/sequential-test`, { silent: true });
  }
  /** C7 — fitted execution-cost profiles of a symbol (newest first). ASSUMED route. */
  calibrationProfiles(symbol: string): Observable<ResponseData<unknown>> {
    return this.api.get(`/execution-quality/calibration?symbol=${encodeURIComponent(symbol)}`, {
      silent: true,
    });
  }
  /** C6 — the broker's symbol-spec history (append-on-change). ASSUMED route. */
  specHistory(symbol: string): Observable<ResponseData<unknown>> {
    return this.api.get(`/broker-symbol-spec/history?symbol=${encodeURIComponent(symbol)}`, {
      silent: true,
    });
  }
}
