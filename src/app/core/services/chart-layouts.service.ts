import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { ResponseData } from '@core/api/api.types';

/** One chart workspace as the engine stores it (`chart/layouts`). `state` is absent on list rows. */
export interface ChartLayoutDto {
  id: number;
  name: string;
  isActive: boolean;
  version: number;
  state?: object | null;
  lastOpenedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChartPreferenceDto {
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface UpdateChartLayoutBody {
  name?: string;
  state?: object;
  expectedVersion?: number;
}

const SILENT = { silent: true } as const;
/** Browsers cap a keepalive request body at 64 KiB in total. */
export const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * Client for `chart/layouts` and `chart/preferences` (engine `docs/api/chart-layouts-api.md`):
 * per-operator chart workspaces and cross-layout chart preferences. Every call is silent and
 * answers the raw envelope — callers need `-409` (with the current layout as data) and `-14`.
 */
@Injectable({ providedIn: 'root' })
export class ChartLayoutsService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  list(): Observable<ResponseData<ChartLayoutDto[]>> {
    return this.api.get('/chart/layouts', SILENT);
  }

  active(): Observable<ResponseData<ChartLayoutDto | null>> {
    return this.api.get('/chart/layouts/active', SILENT);
  }

  get(id: number): Observable<ResponseData<ChartLayoutDto>> {
    return this.api.get(`/chart/layouts/${id}`, SILENT);
  }

  create(body: {
    name?: string;
    state?: object | null;
    activate?: boolean;
  }): Observable<ResponseData<ChartLayoutDto>> {
    return this.api.post('/chart/layouts', body, SILENT);
  }

  update(id: number, body: UpdateChartLayoutBody): Observable<ResponseData<ChartLayoutDto>> {
    return this.api.put(`/chart/layouts/${id}`, body, SILENT);
  }

  activate(id: number): Observable<ResponseData<ChartLayoutDto>> {
    return this.api.put(`/chart/layouts/${id}/activate`, {}, SILENT);
  }

  duplicate(id: number, name?: string): Observable<ResponseData<ChartLayoutDto>> {
    return this.api.post(`/chart/layouts/${id}/duplicate`, name ? { name } : {}, SILENT);
  }

  remove(id: number): Observable<ResponseData<boolean>> {
    return this.api.delete(`/chart/layouts/${id}`, SILENT);
  }

  preferences(): Observable<ResponseData<ChartPreferenceDto[]>> {
    return this.api.get('/chart/preferences', SILENT);
  }

  setPreference(key: string, value: unknown): Observable<ResponseData<ChartPreferenceDto>> {
    return this.api.put(`/chart/preferences/${encodeURIComponent(key)}`, { value }, SILENT);
  }

  /**
   * A write able to outlive the page (`fetch` keepalive) for `pagehide`/`visibilitychange`
   * flushes. Returns false when the body is too large for keepalive — the caller keeps its local
   * cache dirty and the next load uploads it.
   */
  sendOnUnload(path: string, method: 'PUT' | 'POST', body: unknown): boolean {
    const json = JSON.stringify(body);
    if (new Blob([json]).size > KEEPALIVE_MAX_BYTES) return false;
    const token = this.auth.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token && token.split('.').length === 3) headers['Authorization'] = `Bearer ${token}`;
    void fetch(`${this.baseUrl}${path}`, {
      method,
      keepalive: true,
      credentials: 'include',
      headers,
      body: json,
    }).catch(() => undefined);
    return true;
  }
}
