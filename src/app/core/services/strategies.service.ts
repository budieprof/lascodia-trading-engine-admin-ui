import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  StrategyDto,
  CreateStrategyRequest,
  UpdateStrategyRequest,
  AssignRiskProfileRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class StrategiesService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<StrategyDto>> {
    return this.api.get(`/strategy/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<StrategyDto>>> {
    return this.api.post(`/strategy/list`, params);
  }

  create(data: CreateStrategyRequest): Observable<ResponseData<StrategyDto>> {
    return this.api.post(`/strategy`, data);
  }

  update(id: number, data: UpdateStrategyRequest): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/strategy/${id}`);
  }

  activate(id: number): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}/activate`);
  }

  pause(id: number): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}/pause`);
  }

  assignRiskProfile(id: number, data: AssignRiskProfileRequest): Observable<ResponseData<StrategyDto>> {
    return this.api.put(`/strategy/${id}/risk-profile`, data);
  }
}
