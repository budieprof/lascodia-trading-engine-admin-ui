import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { SKIP_SESSION_HANDLING } from '@core/auth/http-context';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { PlanOffer } from './billing.types';

/**
 * The plans anyone may see (`GET billing/plans/public`, anonymous) — read by the public landing page. Plain
 * HttpClient on purpose: a visitor has no session, so no sign-in redirect, CSRF or toast may act on it. With
 * self-serve billing off the engine answers only the default plan.
 */
@Injectable({ providedIn: 'root' })
export class PublicPlansApiService {
  private readonly http = inject(HttpClient);
  private readonly url = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine/billing/plans/public`;

  plans(): Observable<PlanOffer[]> {
    return this.http
      .get<ResponseData<PlanOffer[]>>(this.url, {
        withCredentials: false,
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true).set(SKIP_SESSION_HANDLING, true),
      })
      .pipe(
        map((res) => {
          if (!res || res.status !== true)
            throw new ApiError(
              res?.responseCode ?? 'UNKNOWN',
              res?.message ?? 'Request failed',
              res,
            );
          return Array.isArray(res.data) ? res.data : [];
        }),
      );
  }
}
