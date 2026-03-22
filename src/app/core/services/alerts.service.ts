import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  AlertDto,
  CreateAlertRequest,
  UpdateAlertRequest,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly api = inject(ApiService);

  getById(id: number): Observable<ResponseData<AlertDto>> {
    return this.api.get(`/alert/${id}`);
  }

  list(params: PagerRequest): Observable<ResponseData<PagedData<AlertDto>>> {
    return this.api.post(`/alert/list`, params);
  }

  create(data: CreateAlertRequest): Observable<ResponseData<AlertDto>> {
    return this.api.post(`/alert`, data);
  }

  update(id: number, data: UpdateAlertRequest): Observable<ResponseData<AlertDto>> {
    return this.api.put(`/alert/${id}`, data);
  }

  delete(id: number): Observable<ResponseData<void>> {
    return this.api.delete(`/alert/${id}`);
  }
}
