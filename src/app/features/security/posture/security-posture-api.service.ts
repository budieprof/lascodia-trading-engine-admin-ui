import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';

import type { SecurityPosture } from './security-posture.types';

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

/** Engine `platform/security/*` posture (gaps program security). Budgets are saved through `PUT /config`. */
@Injectable({ providedIn: 'root' })
export class SecurityPostureApiService {
  private readonly api = inject(ApiService);

  posture(): Observable<SecurityPosture> {
    return settled(
      this.api.get<ResponseData<SecurityPosture>>('/platform/security/posture', SILENT),
    );
  }

  /** Makes the engine re-read the stored budgets now instead of within 30 s. */
  refreshBudgets(): Observable<string> {
    return settled(
      this.api.post<ResponseData<string>>('/platform/security/rate-limits/refresh', {}, SILENT),
    );
  }
}
