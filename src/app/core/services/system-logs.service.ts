import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { ResponseData, EngineLogPageDto } from '@core/api/api.types';

@Injectable({ providedIn: 'root' })
export class SystemLogsService {
  private readonly api = inject(ApiService);

  /**
   * Tail of the engine's recent log stream. All filters are server-side:
   *  - level: minimum log level (Trace..Critical). Omit for everything captured.
   *  - category: case-insensitive substring on logger category (e.g. "Worker").
   *  - search: case-insensitive substring on message OR exception text.
   *  - limit: max entries to return; clamped to buffer capacity (5000 today).
   */
  getRecent(
    params: {
      level?: string;
      category?: string;
      search?: string;
      limit?: number;
    } = {},
  ): Observable<ResponseData<EngineLogPageDto>> {
    const qs = new URLSearchParams();
    if (params.level) qs.set('level', params.level);
    if (params.category) qs.set('category', params.category);
    if (params.search) qs.set('search', params.search);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    const suffix = qs.toString();
    return this.api.get(`/system/logs${suffix ? `?${suffix}` : ''}`);
  }
}
