import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';

import type {
  SaveScreenRequest,
  ScreenAlertDto,
  ScreenRunDto,
  ScreenerRequestV2,
  ScriptScreenDto,
} from './screens.types';

/**
 * The screener's engine calls (scripting API §6, §6a): an ad-hoc screener run, and the operator's saved screens — their
 * definitions, schedule, "Run now", run history and alert log. Every call is `silent`: the page shows its own inline
 * error for a refusal.
 */
@Injectable({ providedIn: 'root' })
export class ScreensApiService {
  private readonly api = inject(ApiService);

  /** §6 — one row per symbol (with extra timeframes and strategy figures when asked for). */
  runScreener(req: ScreenerRequestV2): Observable<ResponseData<unknown>> {
    return this.api.post('/scripting/screener', req, { silent: true });
  }

  list(): Observable<ResponseData<ScriptScreenDto[]>> {
    return this.api.get('/scripting/screens', { silent: true });
  }

  get(id: number): Observable<ResponseData<ScriptScreenDto>> {
    return this.api.get(`/scripting/screens/${id}`, { silent: true });
  }

  create(req: SaveScreenRequest): Observable<ResponseData<ScriptScreenDto>> {
    return this.api.post('/scripting/screens', req, { silent: true });
  }

  update(id: number, req: SaveScreenRequest): Observable<ResponseData<ScriptScreenDto>> {
    return this.api.put(`/scripting/screens/${id}`, req, { silent: true });
  }

  setSchedule(id: number, enabled: boolean): Observable<ResponseData<ScriptScreenDto>> {
    return this.api.put(`/scripting/screens/${id}/schedule`, { enabled }, { silent: true });
  }

  delete(id: number): Observable<ResponseData<boolean>> {
    return this.api.delete(`/scripting/screens/${id}`, { silent: true });
  }

  /** "Run now": a stored Manual run with its rows; never alerts. */
  run(id: number): Observable<ResponseData<ScreenRunDto>> {
    return this.api.post(`/scripting/screens/${id}/run`, {}, { silent: true });
  }

  runs(id: number, limit = 30): Observable<ResponseData<ScreenRunDto[]>> {
    return this.api.get(`/scripting/screens/${id}/runs?limit=${limit}`, { silent: true });
  }

  runDetail(id: number, runId: number): Observable<ResponseData<ScreenRunDto>> {
    return this.api.get(`/scripting/screens/${id}/runs/${runId}`, { silent: true });
  }

  alerts(id: number, limit = 100): Observable<ResponseData<ScreenAlertDto[]>> {
    return this.api.get(`/scripting/screens/${id}/alerts?limit=${limit}`, { silent: true });
  }
}
