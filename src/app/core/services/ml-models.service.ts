import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  MLModelDto,
  MLTrainingRunDto,
  MLTrainingRunDiagnosticsDto,
  MLSignalAbTestResultDto,
  DriftAlertDto,
  DriftReportQueryFilter,
  TriggerMLTrainingRequest,
  TriggerHyperparamSearchRequest,
  RollbackMLModelRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class MLModelsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<MLModelDto>> {
    return this.api.get(`/ml-model/${id}`);
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
}
