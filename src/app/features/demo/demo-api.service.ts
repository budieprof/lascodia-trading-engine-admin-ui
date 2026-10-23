import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

import { SUPPRESS_ERROR_TOAST } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import { SKIP_SESSION_HANDLING } from '@core/auth/http-context';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { DemoBook, DemoCandles, DemoStatus, DemoTicks } from './demo.types';

/**
 * The public demo's engine calls (anonymous `demo/*`). Plain HttpClient on purpose: a visitor has no
 * session, and the console's session handling (sign-in redirects, CSRF) must not act on these calls.
 * Off, the engine answers a bare 404 — the page then says the demo is not available.
 */
@Injectable({ providedIn: 'root' })
export class DemoApiService {
  private readonly http = inject(HttpClient);
  private readonly base = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine/demo`;

  status(): Observable<DemoStatus> {
    return this.read<DemoStatus>('');
  }

  candles(symbol: string, minutes: number): Observable<DemoCandles> {
    return this.read<DemoCandles>(`/candles?symbol=${encodeURIComponent(symbol)}&minutes=${minutes}`);
  }

  ticks(symbol: string, afterMs: number | null): Observable<DemoTicks> {
    const after = afterMs === null ? '' : `&afterMs=${afterMs}`;
    return this.read<DemoTicks>(`/ticks?symbol=${encodeURIComponent(symbol)}${after}`);
  }

  book(symbol: string): Observable<DemoBook> {
    return this.read<DemoBook>(`/book?symbol=${encodeURIComponent(symbol)}`);
  }

  private read<T>(path: string): Observable<T> {
    return this.http.get<ResponseData<T>>(`${this.base}${path}`, {
      withCredentials: false,
      // A visitor has no session: no sign-in redirect, no toast — the page shows what went wrong.
      context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true).set(SKIP_SESSION_HANDLING, true),
    }).pipe(
      map((res) => {
        if (!res || res.status !== true)
          throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'Request failed', res);
        return res.data as T;
      }),
    );
  }
}
