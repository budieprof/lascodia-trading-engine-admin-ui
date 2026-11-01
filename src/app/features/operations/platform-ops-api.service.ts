import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import type {
  DeployRequest,
  HostJob,
  PlatformHostAction,
  PlatformJobQueued,
  PlatformOps,
} from './platform-ops.types';

const SILENT = { silent: true } as const;

/** The envelope's data, or an `ApiError` carrying the engine's refusal (the page shows its message). */
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
 * Operations → Platform (engine `ops/platform`, gaps program zero-downtime). Reads need
 * `platform.infrastructure.manage`; deploys need `platform.deploy` (step-up). Host work is queued for the engine host's
 * supervisor and followed through the C4 job endpoint (`admin/terminals/jobs/{jobId}`).
 */
@Injectable({ providedIn: 'root' })
export class PlatformOpsApiService {
  private readonly api = inject(ApiService);

  get(): Observable<PlatformOps> {
    return settled(this.api.get<ResponseData<PlatformOps>>('/ops/platform', SILENT));
  }

  hostJob(action: PlatformHostAction, reason?: string): Observable<PlatformJobQueued> {
    return settled(
      this.api.post<ResponseData<PlatformJobQueued>>(
        '/ops/platform/host-jobs',
        { action, reason },
        SILENT,
      ),
    );
  }

  testAlert(note?: string): Observable<string> {
    return settled(
      this.api.post<ResponseData<string>>('/ops/platform/alerts/test', { note }, SILENT),
    );
  }

  deploy(body: DeployRequest): Observable<PlatformJobQueued> {
    return settled(
      this.api.post<ResponseData<PlatformJobQueued>>('/ops/platform/deploy', body, SILENT),
    );
  }

  job(jobId: string): Observable<HostJob> {
    return settled(this.api.get<ResponseData<HostJob>>(`/admin/terminals/jobs/${jobId}`, SILENT));
  }
}
