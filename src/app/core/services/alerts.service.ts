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
import type { AlertDispatchLogDto, ScriptAlertDeliveryDto } from '@core/api/alerts.types';

@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly api = inject(ApiService);

  // ── Alert rules ──────────────────────────────────────────────────────

  /** `silent`: no error toast (a link to an alert that may have been deleted handles the "not found" itself). */
  getById(id: number, opts?: { silent?: boolean }): Observable<ResponseData<AlertDto>> {
    return this.api.get(`/alert/${id}`, opts?.silent ? { silent: true } : undefined);
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

  /** What happened on each channel every time an alert was sent, newest first (Sent / Skipped / Failed). */
  dispatchLog(id: number, limit = 50): Observable<ResponseData<AlertDispatchLogDto[]>> {
    return this.api.get(`/alert/${id}/dispatch-log?limit=${limit}`, { silent: true });
  }

  /** A script strategy's alert deliveries (outbox rows), newest first. */
  scriptDeliveries(
    strategyId: number,
    limit = 50,
  ): Observable<ResponseData<ScriptAlertDeliveryDto[]>> {
    return this.api.get(`/alert/script-deliveries?strategyId=${strategyId}&limit=${limit}`, {
      silent: true,
    });
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
