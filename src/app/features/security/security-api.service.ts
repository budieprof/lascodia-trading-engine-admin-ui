import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map } from 'rxjs';

import { SUPPRESS_ERROR_TOAST, ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { blobError, toDownloadedFile } from '@features/fund/fund-api.service';

import type {
  AccessReviewCampaign,
  AccessReviewCampaignDetail,
  EaReleaseInfo,
  EvidenceDownload,
  ReleaseComponent,
  ReleaseNote,
  RoleBuildSkew,
} from './security.types';

/** The pages show their own errors; session handling (sign-in again, step-up, CSRF) still applies. */
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

/** Security controls API (engine `docs/api/security-controls-api.md`). */
@Injectable({ providedIn: 'root' })
export class SecurityApiService {
  private readonly api = inject(ApiService);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  // ── Quarterly access reviews (the acting organisation) ──
  campaigns(): Observable<AccessReviewCampaign[]> {
    return settled(
      this.api.get<ResponseData<AccessReviewCampaign[]>>('/iam/access-review/campaigns', SILENT),
    ).pipe(map((rows) => rows ?? []));
  }

  campaign(id: number): Observable<AccessReviewCampaignDetail> {
    return settled(
      this.api.get<ResponseData<AccessReviewCampaignDetail>>(
        `/iam/access-review/campaigns/${id}`,
        SILENT,
      ),
    );
  }

  /** Takes (or, while open, retakes) this quarter's snapshot. */
  generate(): Observable<AccessReviewCampaign> {
    return settled(
      this.api.post<ResponseData<AccessReviewCampaign>>('/iam/access-review/campaigns', {}, SILENT),
    );
  }

  signOff(id: number, snapshotSha256: string, notes: string): Observable<AccessReviewCampaign> {
    return settled(
      this.api.post<ResponseData<AccessReviewCampaign>>(
        `/iam/access-review/campaigns/${id}/sign-off`,
        { snapshotSha256, notes },
        SILENT,
      ),
    );
  }

  exportCampaign(id: number, format: 'csv' | 'json'): Observable<EvidenceDownload> {
    return this.download(
      `/iam/access-review/campaigns/${id}/export?format=${format}`,
      `access-review-${id}.${format}`,
    );
  }

  // ── Release notes ──
  releaseNotes(component: ReleaseComponent | null = null, take = 50): Observable<ReleaseNote[]> {
    const q = new URLSearchParams({ take: String(take) });
    if (component) q.set('component', component);
    return settled(
      this.api.get<ResponseData<ReleaseNote[]>>(`/release-notes?${q.toString()}`, SILENT),
    ).pipe(map((rows) => rows ?? []));
  }

  // ── Published builds ──
  /** Every kept EA build, highest version first (platform staff, `platform.ea.releases.manage`). */
  eaReleases(): Observable<EaReleaseInfo[]> {
    return settled(
      this.api.get<ResponseData<EaReleaseInfo[]>>('/platform/ea/releases', SILENT),
    ).pipe(map((rows) => rows ?? []));
  }

  /** The build each engine process runs (`access.operator`). */
  engineBuilds(): Observable<RoleBuildSkew> {
    return settled(
      this.api.get<ResponseData<RoleBuildSkew>>('/admin/observability/build-skew', SILENT),
    );
  }

  // ── Evidence bundle (platform staff) ──
  evidenceBundle(fromDay: string, toDay: string): Observable<EvidenceDownload> {
    const q = new URLSearchParams({ from: `${fromDay}T00:00:00Z`, to: `${toDay}T23:59:59Z` });
    return this.download(
      `/platform/security/evidence-bundle?${q.toString()}`,
      'lascodia-security-evidence.zip',
    );
  }

  /** Bytes fetched with the session's credentials, then handed to the browser by the page. */
  private download(path: string, fallbackName: string): Observable<EvidenceDownload> {
    return this.http
      .get(`${this.baseUrl}${path}`, {
        responseType: 'blob',
        observe: 'response',
        withCredentials: true,
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
      })
      .pipe(
        map((res) => toDownloadedFile(res, fallbackName)),
        catchError(blobError),
      );
  }
}
