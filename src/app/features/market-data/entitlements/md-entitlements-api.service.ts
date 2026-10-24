import { HttpClient, HttpContext, HttpParams, type HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService, SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { fileNameFromContentDisposition } from '@features/scripting/shared/download';
import type {
  DeclarationDecision,
  MyDeclarations,
  SubmitDeclarationBody,
  SubscriberDeclarationDto,
  GrantEntitlementBody,
  MarketDataEntitlementDto,
  MarketDataFeedCatalog,
  MarketDataUsageReport,
  UpdateEntitlementBody,
  UsageCsvFile,
} from './md-entitlements.types';

const SILENT = { silent: true } as const;

/** The envelope's data, or an `ApiError` carrying the envelope (the refusal's reason). */
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

/** The file of a CSV response (exported for testing). */
export function toUsageCsvFile(
  res: HttpResponse<Blob>,
  month: string,
  detail: string,
): UsageCsvFile {
  return {
    blob: res.body ?? new Blob([], { type: 'text/csv' }),
    fileName:
      fileNameFromContentDisposition(res.headers.get('Content-Disposition')) ??
      `lascodia-marketdata-usage-${month}-${detail}.csv`,
  };
}

/**
 * Market-data entitlements and the exchange usage report (engine C6, platform staff): grants need
 * `platform.data.manage`, the report `platform.usage.read`. Calls are silent: the pages say what went wrong.
 */
@Injectable({ providedIn: 'root' })
export class MarketDataEntitlementsApiService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  list(
    filter: { tenantId?: number | null; feedId?: string | null; includeRevoked?: boolean } = {},
  ): Observable<MarketDataEntitlementDto[]> {
    const q = new URLSearchParams();
    if (filter.tenantId) q.set('tenantId', String(filter.tenantId));
    if (filter.feedId) q.set('feedId', filter.feedId);
    if (filter.includeRevoked) q.set('includeRevoked', 'true');
    const qs = q.toString();
    return settled(
      this.api.get<ResponseData<MarketDataEntitlementDto[]>>(
        `/admin/md/entitlements${qs ? '?' + qs : ''}`,
        SILENT,
      ),
    ).pipe(map((rows) => rows ?? []));
  }

  grant(body: GrantEntitlementBody): Observable<MarketDataEntitlementDto> {
    return settled(
      this.api.post<ResponseData<MarketDataEntitlementDto>>('/admin/md/entitlements', body, SILENT),
    );
  }

  update(id: number, body: UpdateEntitlementBody): Observable<MarketDataEntitlementDto> {
    return settled(
      this.api.put<ResponseData<MarketDataEntitlementDto>>(
        `/admin/md/entitlements/${id}`,
        body,
        SILENT,
      ),
    );
  }

  revoke(id: number, reason: string): Observable<MarketDataEntitlementDto> {
    const q = new URLSearchParams({ reason });
    return settled(
      this.api.delete<ResponseData<MarketDataEntitlementDto>>(
        `/admin/md/entitlements/${id}?${q.toString()}`,
        SILENT,
      ),
    );
  }

  feeds(): Observable<MarketDataFeedCatalog> {
    return settled(this.api.get<ResponseData<MarketDataFeedCatalog>>('/admin/md/feeds', SILENT));
  }

  usage(month: string): Observable<MarketDataUsageReport> {
    return settled(
      this.api.get<ResponseData<MarketDataUsageReport>>(
        `/admin/md/usage?${new URLSearchParams({ month }).toString()}`,
        SILENT,
      ),
    );
  }

  /** The month's CSV (fetched with the session's credentials, then handed to the browser). */
  exportUsage(month: string, detail: 'tenants' | 'users' | 'exchanges'): Observable<UsageCsvFile> {
    return this.http
      .get(`${this.baseUrl}/admin/md/usage/export`, {
        params: new HttpParams().set('month', month).set('detail', detail),
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
      })
      .pipe(map((res) => toUsageCsvFile(res, month, detail)));
  }

  // ── Subscriber declarations (engine WS8 8.2) ──────────────────────────────

  /** The caller's own declarations (`marketdata.read`). */
  myDeclarations(): Observable<MyDeclarations> {
    return settled(this.api.get<ResponseData<MyDeclarations>>('/md/declarations/me', SILENT));
  }

  declare(body: SubmitDeclarationBody): Observable<SubscriberDeclarationDto> {
    return settled(
      this.api.post<ResponseData<SubscriberDeclarationDto>>('/md/declarations', body, SILENT),
    );
  }

  withdrawDeclaration(id: number): Observable<boolean> {
    return settled(this.api.delete<ResponseData<boolean>>(`/md/declarations/${id}`, SILENT));
  }

  /** Staff review queue (`platform.data.manage`). */
  declarations(
    filter: { status?: string | null; family?: string | null; includeHistory?: boolean } = {},
  ): Observable<SubscriberDeclarationDto[]> {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.family) q.set('family', filter.family);
    if (filter.includeHistory) q.set('includeHistory', 'true');
    const qs = q.toString();
    return settled(
      this.api.get<ResponseData<SubscriberDeclarationDto[]>>(
        `/admin/md/declarations${qs ? '?' + qs : ''}`,
        SILENT,
      ),
    ).pipe(map((rows) => rows ?? []));
  }

  reviewDeclaration(
    id: number,
    decision: DeclarationDecision,
    note: string,
  ): Observable<SubscriberDeclarationDto> {
    return settled(
      this.api.put<ResponseData<SubscriberDeclarationDto>>(
        `/admin/md/declarations/${id}/review`,
        { decision, note: note.trim() || null },
        SILENT,
      ),
    );
  }
}
