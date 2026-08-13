import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import type {
  CmeStatusDto,
  CmeExperimentRunDto,
  CmeHistoricAnalyticsDto,
  CmeOrderflowExperimentResultDto,
  GenerateSyntheticCmeRequest,
  RunCmeOrderflowExperimentRequest,
  SeedCmeContractsRequest,
  SyntheticCmeGenerationResultDto,
} from '@features/cme-microstructure/cme-microstructure.types';

/**
 * CME microstructure operator surface (engine ADR-0021/0022). Status is read-only; the three
 * mutations are all operator-gated engine-side. Raw `ResponseData<T>` is returned (not the envelope
 * helpers) because the panel surfaces `message` on both success and failure — a seed/back-adjust
 * returning "0 written" is a meaningful operator answer, not an error.
 */
@Injectable({ providedIn: 'root' })
export class CmeMicrostructureService {
  private readonly api = inject(ApiService);
  private readonly base = '/experiment';

  /** Seeded contracts + front month, ingested tape/book/bar counts, recent shadow would-haves. */
  getStatus(recentShadowLimit = 20): Observable<ResponseData<CmeStatusDto>> {
    return this.api.get<ResponseData<CmeStatusDto>>(
      `${this.base}/cme-status?recentShadowLimit=${recentShadowLimit}`,
    );
  }

  /** Seed a root's quarterly calendar (e.g. 6E → EURUSD). Idempotent; returns rows written. */
  seedContracts(body: SeedCmeContractsRequest): Observable<ResponseData<number>> {
    return this.api.post<ResponseData<number>>(`${this.base}/cme-contracts/seed`, body);
  }

  /** Compute + persist back-adjustment offsets so a multi-quarter series is continuous across rolls. */
  backAdjust(rootSymbol: string): Observable<ResponseData<number>> {
    return this.api.post<ResponseData<number>>(`${this.base}/cme-contracts/back-adjust`, {
      rootSymbol,
    });
  }

  /**
   * Generate SYNTHETIC tape + depth to exercise the pipeline before a real slice exists. Rows are
   * stamped Source="Synthetic" and prior synthetic rows are purged; real data is never touched.
   * Proves the pipeline and the harness — never proves an edge.
   */
  generateSynthetic(
    body: GenerateSyntheticCmeRequest,
  ): Observable<ResponseData<SyntheticCmeGenerationResultDto>> {
    return this.api.post<ResponseData<SyntheticCmeGenerationResultDto>>(
      `${this.base}/cme-synthetic`,
      body,
    );
  }

  /**
   * Per-session analytics over the imported historic slice — tape volume, aggressor balance and
   * coverage, session range, and which sessions are missing their book.
   *
   * Server-side this reads the trade tape only and characterises the book from its on-disk
   * footprint, so a 79-session sweep stays inside a request; results are memoised per session
   * because imported history is immutable. The FIRST call on a cold cache can take ~20s.
   */
  getHistoricAnalytics(
    rootSymbol = '6E',
    contract?: string,
  ): Observable<ResponseData<CmeHistoricAnalyticsDto>> {
    const query = new URLSearchParams({ rootSymbol });
    if (contract) query.set('contract', contract);
    return this.api.get<ResponseData<CmeHistoricAnalyticsDto>>(
      `${this.base}/cme-historic-analytics?${query.toString()}`,
    );
  }

  /** THE decisive experiment: real aggressor delta vs the tick-rule proxy, out-of-sample. */
  runExperiment(
    body: RunCmeOrderflowExperimentRequest,
  ): Observable<ResponseData<CmeOrderflowExperimentResultDto>> {
    return this.api.post<ResponseData<CmeOrderflowExperimentResultDto>>(
      `${this.base}/cme-orderflow`,
      body,
    );
  }

  /**
   * Recorded verdict history, newest first. Includes SKIPPED runs — a `no_data` outcome says the
   * window an operator believed was ingested isn't there, which is itself worth seeing.
   */
  getExperimentRuns(
    contract?: string,
    limit = 50,
  ): Observable<ResponseData<CmeExperimentRunDto[]>> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (contract) query.set('contract', contract);
    return this.api.get<ResponseData<CmeExperimentRunDto[]>>(
      `${this.base}/cme-orderflow/runs?${query.toString()}`,
    );
  }
}
