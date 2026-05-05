import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import {
  ResponseData,
  PagedData,
  PagerRequest,
  AlertDto,
  AlertChannelStatusDto,
  CreateAlertRequest,
  UpdateAlertRequest,
  TestAlertChannelRequest,
  TestAlertChannelResultDto,
  SetAlertChannelEnabledRequest,
  SetAlertChannelEnabledResultDto,
} from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly api = inject(ApiService);

  // ── Alert rules ──────────────────────────────────────────────────────

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

  delete(id: number): Observable<ResponseData<string>> {
    return this.api.delete(`/alert/${id}`);
  }

  // ── Channel configuration ───────────────────────────────────────────

  getChannelStatus(): Observable<ResponseData<AlertChannelStatusDto[]>> {
    return this.api.get(`/alert/channel/status`);
  }

  testChannel(data: TestAlertChannelRequest): Observable<ResponseData<TestAlertChannelResultDto>> {
    return this.api.post(`/alert/channel/test`, data);
  }

  setChannelEnabled(
    data: SetAlertChannelEnabledRequest,
  ): Observable<ResponseData<SetAlertChannelEnabledResultDto>> {
    return this.api.post(`/alert/channel/enabled`, data);
  }
}
