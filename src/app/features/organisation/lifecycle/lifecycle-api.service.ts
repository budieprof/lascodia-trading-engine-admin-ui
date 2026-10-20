import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type {
  BrandingImageKind,
  CloseTenantBody,
  CloseTenantResult,
  TenantBranding,
  TenantClosure,
  TenantClosureState,
  TenantDataExport,
  TenantExportLink,
  TenantPurgePlan,
  UpdateBrandingBody,
} from './lifecycle.types';

const SILENT = { silent: true } as const;

/** The envelope's data, or an `ApiError` carrying the envelope (refusal reasons included). */
export function settled<T>(source: Observable<ResponseData<T>>): Observable<T> {
  return source.pipe(
    map((res) => {
      if (!res || res.status !== true) {
        throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
      }
      return res.data as T;
    }),
  );
}

/** Sends the browser to a URL (a download): a seam so specs can see where it went. */
export const NAVIGATE_TO = new InjectionToken<(url: string) => void>('NAVIGATE_TO', {
  providedIn: 'root',
  factory: () => (url: string) => window.location.assign(url),
});

/**
 * An organisation's life cycle (engine multi-tenancy Phase 7, c7-lifecycle): its console look
 * (`tenant.branding.*`), its data exports (`tenant.data.export`, Owner) and closing it
 * (`tenant.close`, Owner); for platform staff, closed organisations — reopening, the deletion plan
 * (dry run) and confirming the deletion (`platform.tenants.manage` / `platform.tenants.purge`). Calls are
 * silent: the pages say what went wrong.
 */
@Injectable({ providedIn: 'root' })
export class LifecycleApiService {
  private readonly api = inject(ApiService);
  private readonly apiRoot = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine/`;

  /** An engine-relative path (as DTOs carry them) as a full URL. */
  absolute(relative: string): string {
    return this.apiRoot + relative.replace(/^\/+/, '');
  }

  // ── Branding ──
  branding(): Observable<TenantBranding> {
    return settled(this.api.get<ResponseData<TenantBranding>>('/tenant/branding', SILENT));
  }
  updateBranding(body: UpdateBrandingBody): Observable<TenantBranding> {
    return settled(this.api.put<ResponseData<TenantBranding>>('/tenant/branding', body, SILENT));
  }
  uploadImage(kind: BrandingImageKind, file: File): Observable<TenantBranding> {
    const form = new FormData();
    form.append('file', file, file.name);
    return settled(
      this.api.put<ResponseData<TenantBranding>>(`/tenant/branding/${kind}`, form, SILENT),
    );
  }
  removeImage(kind: BrandingImageKind): Observable<TenantBranding> {
    return settled(
      this.api.delete<ResponseData<TenantBranding>>(`/tenant/branding/${kind}`, SILENT),
    );
  }
  resetBranding(): Observable<TenantBranding> {
    return settled(this.api.delete<ResponseData<TenantBranding>>('/tenant/branding', SILENT));
  }
  /** An image's bytes (fetched with the session's credentials: an `<img src>` cannot send a bearer header). */
  imageBlob(relativeUrl: string): Promise<Blob | null> {
    return this.api.getBlob('/' + relativeUrl.replace(/^\/+/, ''));
  }

  // ── Data export ──
  exports(): Observable<TenantDataExport[]> {
    return settled(this.api.get<ResponseData<TenantDataExport[]>>('/tenant/exports', SILENT)).pipe(
      map((rows) => rows ?? []),
    );
  }
  requestExport(): Observable<TenantDataExport> {
    return settled(this.api.post<ResponseData<TenantDataExport>>('/tenant/exports', {}, SILENT));
  }
  downloadLink(exportId: number): Observable<TenantExportLink> {
    return settled(
      this.api.post<ResponseData<TenantExportLink>>(
        `/tenant/exports/${exportId}/download-link`,
        {},
        SILENT,
      ),
    );
  }

  // ── Closing ──
  closureState(): Observable<TenantClosureState> {
    return settled(this.api.get<ResponseData<TenantClosureState>>('/tenant/closure', SILENT));
  }
  /**
   * The raw envelope: a second Owner's approval answers HTTP 202 `-202-approval` with `status:false`,
   * which is not a failure (see `closeOutcome`).
   */
  close(body: CloseTenantBody): Observable<ResponseData<CloseTenantResult>> {
    return this.api.post<ResponseData<CloseTenantResult>>('/tenant/closure', body, SILENT);
  }

  // ── Platform: closed organisations ──
  closures(): Observable<TenantClosure[]> {
    return settled(this.api.get<ResponseData<TenantClosure[]>>('/platform/closures', SILENT)).pipe(
      map((rows) => rows ?? []),
    );
  }
  closure(tenantId: number): Observable<TenantClosure> {
    return settled(
      this.api.get<ResponseData<TenantClosure>>(`/platform/closures/${tenantId}`, SILENT),
    );
  }
  reopen(tenantId: number, reason: string): Observable<TenantClosure> {
    return settled(
      this.api.post<ResponseData<TenantClosure>>(
        `/platform/closures/${tenantId}/reopen`,
        { reason },
        SILENT,
      ),
    );
  }
  planPurge(tenantId: number): Observable<TenantPurgePlan> {
    return settled(
      this.api.post<ResponseData<TenantPurgePlan>>(
        `/platform/closures/${tenantId}/purge-plan`,
        {},
        SILENT,
      ),
    );
  }
  schedulePurge(tenantId: number, confirmSlug: string): Observable<TenantClosure> {
    return settled(
      this.api.post<ResponseData<TenantClosure>>(
        `/platform/closures/${tenantId}/purge`,
        { confirmSlug },
        SILENT,
      ),
    );
  }
}
