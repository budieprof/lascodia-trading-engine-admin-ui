import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import type {
  CmeStatusDto,
  CmeOrderflowExperimentResultDto,
  RunCmeOrderflowExperimentRequest,
  SeedCmeContractsRequest,
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

  /** THE decisive experiment: real aggressor delta vs the tick-rule proxy, out-of-sample. */
  runExperiment(
    body: RunCmeOrderflowExperimentRequest,
  ): Observable<ResponseData<CmeOrderflowExperimentResultDto>> {
    return this.api.post<ResponseData<CmeOrderflowExperimentResultDto>>(
      `${this.base}/cme-orderflow`,
      body,
    );
  }
}
