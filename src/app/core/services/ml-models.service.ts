import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  MLModelDto,
  MLTrainingRunDto,
  TriggerMLTrainingRequest,
  TriggerHyperparamSearchRequest,
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

  rollback(): Observable<ResponseData<MLModelDto>> {
    return this.api.post(`/ml-model/rollback`);
  }

  triggerTraining(data: TriggerMLTrainingRequest): Observable<ResponseData<MLTrainingRunDto>> {
    return this.api.post(`/ml-model/training/trigger`, data);
  }

  triggerHyperparamSearch(data: TriggerHyperparamSearchRequest): Observable<ResponseData<MLTrainingRunDto>> {
    return this.api.post(`/ml-model/training/hyperparam-search`, data);
  }

  getTrainingRun(id: number): Observable<ResponseData<MLTrainingRunDto>> {
    return this.api.get(`/ml-model/training/${id}`);
  }

  listTrainingRuns(params: PagerRequest): Observable<ResponseData<PagedData<MLTrainingRunDto>>> {
    return this.api.post(`/ml-model/training/list`, params);
  }
}
