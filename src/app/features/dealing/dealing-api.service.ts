import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type {
  CurveDimension,
  DealingAbBookReport,
  DealingAlert,
  DealingClientDetail,
  DealingClients,
  DealingCurves,
  DealingFeed,
  DealingLpAnalytics,
  DealingWindow,
  UpsertDealingFeedBody,
} from './dealing.types';

const SILENT = { silent: true } as const;

function settled<T>(source: Observable<ResponseData<T>>): Observable<T> {
  return source.pipe(
    map((res) => {
      if (!res || res.status !== true) {
        throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
      }
      return res.data as T;
    }),
  );
}

/**
 * The broker dealing desk (engine `dealing/*`, research process). Reads need `dealing.read`; feed changes
 * `dealing.manage`. Every call can answer `-403-quota` (feature `brokerModule`) when the organisation's plan does not
 * include the module — the page shows an upgrade notice for that, not an error.
 */
@Injectable({ providedIn: 'root' })
export class DealingApiService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly base = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  clients(
    w: DealingWindow,
    extra: { search?: string; sortBy?: string; limit?: number } = {},
  ): Observable<DealingClients> {
    return settled(
      this.api.post<ResponseData<DealingClients>>('/dealing/clients', { ...w, ...extra }, SILENT),
    );
  }

  clientDetail(w: DealingWindow, feedId: string, login: string): Observable<DealingClientDetail> {
    return settled(
      this.api.post<ResponseData<DealingClientDetail>>(
        '/dealing/clients/detail',
        { ...w, feedId, login },
        SILENT,
      ),
    );
  }

  curves(w: DealingWindow, dimension: CurveDimension, top = 10): Observable<DealingCurves> {
    return settled(
      this.api.post<ResponseData<DealingCurves>>(
        '/dealing/markouts',
        { ...w, dimension, top },
        SILENT,
      ),
    );
  }

  abBookReport(w: DealingWindow): Observable<DealingAbBookReport> {
    return settled(
      this.api.post<ResponseData<DealingAbBookReport>>('/dealing/ab-book-report', w, SILENT),
    );
  }

  /** The advisory report as the engine's CSV (formula-safe cells, ADVISORY header line). */
  abBookReportCsv(w: DealingWindow): Observable<Blob> {
    return this.http.post(`${this.base}/dealing/ab-book-report/export`, w, {
      responseType: 'blob',
      withCredentials: true,
    });
  }

  alerts(w: DealingWindow, netExposureLots?: number | null): Observable<DealingAlert[]> {
    return settled(
      this.api.post<ResponseData<DealingAlert[]>>(
        '/dealing/alerts',
        { ...w, ...(netExposureLots != null ? { netExposureLots } : {}) },
        SILENT,
      ),
    ).pipe(map((rows) => rows ?? []));
  }

  lpAnalytics(body: {
    symbol: string;
    from: number;
    to: number;
    sourceIds?: string[];
    sampleMs?: number;
    staleMs?: number;
  }): Observable<DealingLpAnalytics> {
    return settled(
      this.api.post<ResponseData<DealingLpAnalytics>>('/dealing/lp-analytics', body, SILENT),
    );
  }

  feeds(): Observable<DealingFeed[]> {
    return settled(this.api.get<ResponseData<DealingFeed[]>>('/dealing/feeds', SILENT)).pipe(
      map((rows) => rows ?? []),
    );
  }

  createFeed(body: UpsertDealingFeedBody): Observable<DealingFeed> {
    return settled(this.api.post<ResponseData<DealingFeed>>('/dealing/feeds', body, SILENT));
  }

  updateFeed(body: UpsertDealingFeedBody): Observable<DealingFeed> {
    return settled(this.api.put<ResponseData<DealingFeed>>('/dealing/feeds', body, SILENT));
  }
}
