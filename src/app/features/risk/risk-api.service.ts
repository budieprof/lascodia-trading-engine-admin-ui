import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  MarginForecastResponse,
  NettedExposure,
  Paged,
  PortfolioRiskOverview,
  PortfolioRiskSeries,
  RiskJob,
  RiskSetting,
  StressDecision,
  StressResult,
  StressScenario,
  StressScenarioWrite,
  WhatIfRequest,
  WhatIfResult,
} from './risk.types';

function query(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * The engine's portfolio-risk API (`risk/*`). Reads need `risk.read`; scenario writes and run-now
 * `risk.manage`; a platform library scenario's switch `platform.data.manage`. Settings are written
 * through the existing config paths (`ConfigService.upsert`, `OrganisationApiService.setOverride`),
 * never here.
 */
@Injectable({ providedIn: 'root' })
export class RiskApiService {
  private readonly api = inject(ApiService);

  overview(): Observable<PortfolioRiskOverview> {
    return this.api.getEnvelope('/risk/portfolio/overview');
  }

  series(tradingAccountId: number | null, fromUtc: string, maxPoints = 400): Observable<PortfolioRiskSeries> {
    return this.api.getEnvelope(`/risk/portfolio/series${query({ tradingAccountId, fromUtc, maxPoints })}`);
  }

  marginForecast(tradingAccountId: number): Observable<MarginForecastResponse> {
    return this.api.getEnvelope(`/risk/portfolio/accounts/${tradingAccountId}/margin-forecast`);
  }

  whatIf(request: WhatIfRequest): Observable<WhatIfResult> {
    return this.api.postEnvelope('/risk/portfolio/what-if', request);
  }

  exposure(tradingAccountId: number | null, includeSignals = true): Observable<NettedExposure> {
    return this.api.getEnvelope(`/risk/exposure${query({ tradingAccountId, includeSignals })}`);
  }

  scenarios(): Observable<StressScenario[]> {
    return this.api.getEnvelope('/risk/stress/scenarios');
  }

  createScenario(body: StressScenarioWrite): Observable<number> {
    return this.api.postEnvelope('/risk/stress/scenarios', body);
  }

  updateScenario(id: number, body: StressScenarioWrite): Observable<boolean> {
    return this.api.putEnvelope(`/risk/stress/scenarios/${id}`, body);
  }

  deleteScenario(id: number): Observable<boolean> {
    return this.api.deleteEnvelope(`/risk/stress/scenarios/${id}`);
  }

  setLibraryScenarioActive(id: number, isActive: boolean): Observable<boolean> {
    return this.api.putEnvelope(`/risk/stress/library/${id}/active${query({ isActive })}`);
  }

  runStress(tradingAccountId: number | null, scenarioId: number | null): Observable<StressResult[]> {
    return this.api.postEnvelope('/risk/stress/run', { tradingAccountId, scenarioId });
  }

  latestStress(tradingAccountId: number): Observable<StressResult[]> {
    return this.api.getEnvelope(`/risk/stress/latest${query({ tradingAccountId })}`);
  }

  stressResult(id: number): Observable<StressResult> {
    return this.api.getEnvelope(`/risk/stress/results/${id}`);
  }

  settings(): Observable<RiskSetting[]> {
    return this.api.getEnvelope('/risk/settings');
  }

  decisions(page: number, size: number, outcome: string | null): Observable<Paged<StressDecision>> {
    return this.api.postEnvelope('/risk/stress/decisions', {
      currentPage: page,
      itemCountPerPage: size,
      sortBy: 'CreatedAt',
      sortDirection: 'desc',
      filter: { outcome },
    });
  }

  decisionSummary(days = 7): Observable<Record<string, number>> {
    return this.api.getEnvelope(`/risk/stress/decisions/summary${query({ days })}`);
  }

  jobs(): Observable<RiskJob[]> {
    return this.api.getEnvelope('/risk/jobs');
  }

  snapshotNow(tradingAccountId: number | null): Observable<number> {
    return this.api.postEnvelope('/risk/portfolio/snapshot-now', { tradingAccountId });
  }
}
