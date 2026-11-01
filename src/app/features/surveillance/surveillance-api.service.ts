import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';

import type {
  JobStatus,
  SurveillanceAlertDetail,
  SurveillanceAlertFilter,
  SurveillanceAlertPage,
  SurveillanceConfiguration,
  SurveillanceOperations,
  TransitionBody,
} from './surveillance.types';

const SILENT = { silent: true } as const;

/** `?a=1&b=x` from the set values (exported for testing). */
export function surveillanceQuery(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The envelope's data, or an {@link ApiError} carrying the envelope. */
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

/** Trade surveillance (engine `surveillance/*`). Observe only: nothing here changes a trade. */
@Injectable({ providedIn: 'root' })
export class SurveillanceApiService {
  private readonly api = inject(ApiService);

  alerts(filter: SurveillanceAlertFilter): Observable<SurveillanceAlertPage> {
    return settled(
      this.api.get<ResponseData<SurveillanceAlertPage>>(
        `/surveillance/alerts${surveillanceQuery({ ...filter })}`,
        SILENT,
      ),
    );
  }

  alert(id: number): Observable<SurveillanceAlertDetail> {
    return settled(
      this.api.get<ResponseData<SurveillanceAlertDetail>>(`/surveillance/alerts/${id}`, SILENT),
    );
  }

  transition(id: number, body: TransitionBody): Observable<SurveillanceAlertDetail> {
    return settled(
      this.api.post<ResponseData<SurveillanceAlertDetail>>(
        `/surveillance/alerts/${id}/transition`,
        body,
        SILENT,
      ),
    );
  }

  assign(
    id: number,
    body: { adminUserId?: number | null; unassign?: boolean },
  ): Observable<SurveillanceAlertDetail> {
    return settled(
      this.api.post<ResponseData<SurveillanceAlertDetail>>(
        `/surveillance/alerts/${id}/assign`,
        body,
        SILENT,
      ),
    );
  }

  note(id: number, note: string): Observable<SurveillanceAlertDetail> {
    return settled(
      this.api.post<ResponseData<SurveillanceAlertDetail>>(
        `/surveillance/alerts/${id}/notes`,
        { note },
        SILENT,
      ),
    );
  }

  configuration(): Observable<SurveillanceConfiguration> {
    return settled(
      this.api.get<ResponseData<SurveillanceConfiguration>>('/surveillance/detectors', SILENT),
    );
  }

  operations(): Observable<SurveillanceOperations> {
    return settled(
      this.api.get<ResponseData<SurveillanceOperations>>('/surveillance/operations', SILENT),
    );
  }

  runNow(job: 'scan' | 'anchors'): Observable<JobStatus> {
    return settled(
      this.api.post<ResponseData<JobStatus>>(`/surveillance/operations/${job}/run-now`, {}, SILENT),
    );
  }
}
