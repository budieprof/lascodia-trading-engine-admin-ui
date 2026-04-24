import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  ShadowEvaluationDto,
  StartShadowEvaluationRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class MLEvaluationService {
  private readonly api = inject(ApiService);

  startShadow(data: StartShadowEvaluationRequest): Observable<ResponseData<ShadowEvaluationDto>> {
    return this.api.post(`/ml-evaluation/shadow/start`, data);
  }

  recordOutcome(data: any): Observable<ResponseData<void>> {
    return this.api.put(`/ml-evaluation/outcome`, data);
  }

  getShadowById(id: number): Observable<ResponseData<ShadowEvaluationDto>> {
    return this.api.get(`/ml-evaluation/shadow/${id}`);
  }

  listShadow(params: PagerRequest): Observable<ResponseData<PagedData<ShadowEvaluationDto>>> {
    return this.api.post(`/ml-evaluation/shadow/list`, params);
  }
}
