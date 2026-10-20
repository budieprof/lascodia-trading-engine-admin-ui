import { HttpClient, HttpContext, HttpParams, type HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService, SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { TenantDto } from '@features/iam/iam.types';
import { fileNameFromContentDisposition } from '@features/scripting/shared/download';
import type {
  FleetHealth,
  PlanDto,
  SavePlanBody,
  TenantUsage,
  UsageExportFile,
} from './plans.types';

const SILENT = { silent: true } as const;

/** The envelope's data, or an `ApiError` carrying the envelope (refusal reasons, `-403-quota` included). */
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

/** The file of an export response (exported for testing). */
export function toUsageExportFile(res: HttpResponse<Blob>, month: string): UsageExportFile {
  return {
    blob: res.body ?? new Blob([], { type: 'text/csv' }),
    fileName:
      fileNameFromContentDisposition(res.headers.get('Content-Disposition')) ??
      `lascodia-usage-${month}.csv`,
  };
}

/**
 * Plans, usage and fleet health (engine multi-tenancy Phase 7). Platform calls need the platform keys
 * (`platform.plans.manage`, `platform.usage.read`, `platform.fleet.read`); `myUsage` needs
 * `tenant.usage.read` in the active organisation. Calls are silent: the pages say what went wrong.
 */
@Injectable({ providedIn: 'root' })
export class PlansApiService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  // ── Plans ──
  plans(): Observable<PlanDto[]> {
    return settled(this.api.get<ResponseData<PlanDto[]>>('/platform/plans', SILENT)).pipe(
      map((rows) => rows ?? []),
    );
  }
  createPlan(body: SavePlanBody): Observable<PlanDto> {
    return settled(this.api.post<ResponseData<PlanDto>>('/platform/plans', body, SILENT));
  }
  updatePlan(id: number, body: SavePlanBody): Observable<PlanDto> {
    return settled(this.api.put<ResponseData<PlanDto>>(`/platform/plans/${id}`, body, SILENT));
  }
  deletePlan(id: number): Observable<PlanDto> {
    return settled(this.api.delete<ResponseData<PlanDto>>(`/platform/plans/${id}`, SILENT));
  }

  /** Moves an organisation to a plan. */
  assignPlan(tenantId: number, planId: number, reason: string | null): Observable<TenantDto> {
    return settled(
      this.api.put<ResponseData<TenantDto>>(
        `/platform/tenants/${tenantId}/plan`,
        { planId, reason },
        SILENT,
      ),
    );
  }

  // ── Usage ──
  /** The active organisation's plan and usage. */
  myUsage(): Observable<TenantUsage> {
    return settled(this.api.get<ResponseData<TenantUsage>>('/tenant/usage', SILENT));
  }
  /** Any organisation's (platform staff; recorded in its audit log). */
  tenantUsage(tenantId: number): Observable<TenantUsage> {
    return settled(
      this.api.get<ResponseData<TenantUsage>>(`/platform/tenants/${tenantId}/usage`, SILENT),
    );
  }
  /** The monthly CSV (fetched with the session's credentials, then handed to the browser). */
  exportUsage(month: string): Observable<UsageExportFile> {
    return this.http
      .get(`${this.baseUrl}/platform/usage/export`, {
        params: new HttpParams().set('month', month),
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
        // The page reads the refusal out of the error body itself.
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
      })
      .pipe(map((res) => toUsageExportFile(res, month)));
  }

  // ── Fleet ──
  fleet(sinceHours: number, tenantId: number | null = null): Observable<FleetHealth> {
    const q = new URLSearchParams({ sinceHours: String(sinceHours) });
    if (tenantId !== null) q.set('tenantId', String(tenantId));
    return settled(
      this.api.get<ResponseData<FleetHealth>>(`/platform/fleet?${q.toString()}`, SILENT),
    );
  }
}
