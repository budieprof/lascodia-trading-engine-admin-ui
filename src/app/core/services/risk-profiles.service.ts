import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  RiskProfileDto,
  CreateRiskProfileRequest,
  UpdateRiskProfileRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class RiskProfilesService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<RiskProfileDto>> {
    return this.api.get(`/risk-profile/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<RiskProfileDto>>> {
    return this.api.post(`/risk-profile/list`, params);
  }

  create(data: CreateRiskProfileRequest): Observable<ResponseData<RiskProfileDto>> {
    return this.api.post(`/risk-profile`, data);
  }

  update(id: number, data: UpdateRiskProfileRequest): Observable<ResponseData<RiskProfileDto>> {
    return this.api.put(`/risk-profile/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/risk-profile/${id}`);
  }
}
