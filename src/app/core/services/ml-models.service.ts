import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  MLModelDto,
  MLModelFeatureImportanceDto,
  MLModelLifecycleLogEntryDto,
  MLModelOverfitFlagDto,
  MLTrainingRunDto,
  MLTrainingRunDiagnosticsDto,
  MLSignalAbTestResultDto,
  DriftAlertDto,
  DriftReportQueryFilter,
  TriggerMLTrainingRequest,
  TriggerHyperparamSearchRequest,
  RollbackMLModelRequest,
  SymbolicFeatureDto,
  SymbolicFeatureDecaySnapshotDto,
  V6OrderBookFeatureUtilizationDto,
  AvailableArchitecturesDto,
  PromoteSymbolicFeatureRequest,
  RetireSymbolicFeatureRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class MLModelsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<MLModelDto>> {
    return this.api.get(`/ml-model/${id}`);
  }

  /**
   * Returns the lifecycle-log timeline for a single model. Powers the
   * "Lifecycle" timeline on the model detail page so operators can read
   * the engine's transition reasoning ("Retired after 3 consecutive failed
   * retrains — edge likely gone, generate a new strategy rather than retrain").
   */
  getLifecycleLog(id: number): Observable<ResponseData<MLModelLifecycleLogEntryDto[]>> {
    return this.api.get(`/ml-model/${id}/lifecycle`);
  }

  getFeatureImportance(id: number): Observable<ResponseData<MLModelFeatureImportanceDto>> {
    return this.api.get(`/ml-model/${id}/feature-importance`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<MLModelDto>>> {
    return this.api.post(`/ml-model/list`, params);
  }

  activate(id: number): Observable<ResponseData<MLModelDto>> {
    return this.api.put(`/ml-model/${id}/activate`);
  }

  rollback(data: RollbackMLModelRequest): Observable<ResponseData<MLModelDto>> {
    return this.api.post(`/ml-model/rollback`, data);
  }

  triggerTraining(data: TriggerMLTrainingRequest): Observable<ResponseData<MLTrainingRunDto>> {
    return this.api.post(`/ml-model/training/trigger`, data);
  }

  triggerHyperparamSearch(
    data: TriggerHyperparamSearchRequest,
  ): Observable<ResponseData<MLTrainingRunDto>> {
    return this.api.post(`/ml-model/training/hyperparam-search`, data);
  }

  getTrainingRun(id: number): Observable<ResponseData<MLTrainingRunDto>> {
    return this.api.get(`/ml-model/training/${id}`);
  }

  getOverfitWatchlist(
    ratioThreshold?: number,
    minResolvedSignals?: number,
  ): Observable<ResponseData<MLModelOverfitFlagDto[]>> {
    const params = new URLSearchParams();
    if (ratioThreshold != null) params.set('ratioThreshold', String(ratioThreshold));
    if (minResolvedSignals != null) params.set('minResolvedSignals', String(minResolvedSignals));
    const qs = params.toString();
    return this.api.get(`/ml-model/overfit-watchlist${qs ? '?' + qs : ''}`);
  }

  getTrainingRunDiagnostics(id: number): Observable<ResponseData<MLTrainingRunDiagnosticsDto>> {
    return this.api.get(`/ml-model/training/${id}/diagnostics`);
  }

  listTrainingRuns(params: PagerRequest): Observable<ResponseData<PagedData<MLTrainingRunDto>>> {
    return this.api.post(`/ml-model/training/list`, params);
  }

  listDriftReport(
    params: PagerRequest & { filter?: DriftReportQueryFilter },
  ): Observable<ResponseData<PagedData<DriftAlertDto>>> {
    return this.api.post(`/ml-model/drift-report`, params);
  }

  getSignalAbTest(id: number): Observable<ResponseData<MLSignalAbTestResultDto>> {
    return this.api.get(`/ml-model/signal-ab-tests/${id}`);
  }

  listSignalAbTests(
    params: PagerRequest,
  ): Observable<ResponseData<PagedData<MLSignalAbTestResultDto>>> {
    return this.api.post(`/ml-model/signal-ab-tests/list`, params);
  }

  /** GET /ml-model/symbolic-features — list mined symbolic features, filterable by symbol + status. */
  listSymbolicFeatures(
    opts: {
      symbol?: string | null;
      status?: string | null;
      limit?: number;
    } = {},
  ): Observable<ResponseData<SymbolicFeatureDto[]>> {
    const params = new URLSearchParams();
    if (opts.symbol) params.set('symbol', opts.symbol);
    if (opts.status) params.set('status', opts.status);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.api.get(`/ml-model/symbolic-features${qs ? '?' + qs : ''}`);
  }

  /** POST /ml-model/symbolic-features/{id}/promote — Candidate → Promoted for V8 pipeline pickup. */
  promoteSymbolicFeature(
    id: number,
    payload: PromoteSymbolicFeatureRequest = {},
  ): Observable<ResponseData<boolean>> {
    return this.api.post(`/ml-model/symbolic-features/${id}/promote`, payload);
  }

  /** POST /ml-model/symbolic-features/{id}/retire — Promoted → Retired with required reason. */
  retireSymbolicFeature(
    id: number,
    payload: RetireSymbolicFeatureRequest,
  ): Observable<ResponseData<boolean>> {
    return this.api.post(`/ml-model/symbolic-features/${id}/retire`, payload);
  }

  /** GET /ml-model/symbolic-features/{id}/decay-history — per-cycle decay audit trail. */
  getSymbolicFeatureDecayHistory(
    id: number,
  ): Observable<ResponseData<SymbolicFeatureDecaySnapshotDto[]>> {
    return this.api.get(`/ml-model/symbolic-features/${id}/decay-history`);
  }

  /** GET /ml-model/v6-orderbook-feature-utilization — V6 DOB slot importance audit. */
  getV6OrderBookFeatureUtilization(): Observable<ResponseData<V6OrderBookFeatureUtilizationDto>> {
    return this.api.get(`/ml-model/v6-orderbook-feature-utilization`);
  }

  /** GET /ml-model/training/available-architectures — host-filterable architecture set. */
  getAvailableArchitectures(): Observable<ResponseData<AvailableArchitecturesDto>> {
    return this.api.get(`/ml-model/training/available-architectures`);
  }
}
