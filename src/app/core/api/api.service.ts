import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { map, Observable } from 'rxjs';
import { RUNTIME_CONFIG } from '../config/runtime-config';
import { ApiError, ResponseData } from './api.types';

/**
 * Every request carries `withCredentials: true` so the HttpOnly
 * `lascodia-auth` cookie (set by `POST /auth/login` when `loginSource=web`)
 * rides along on same-origin + allowed-origin CORS calls. EA + bearer-token
 * callers keep working because the Authorization header still takes priority
 * over the cookie on the engine side.
 */
const WITH_CREDENTIALS = { withCredentials: true } as const;

/**
 * Set on a request whose caller renders its own error state. The error
 * interceptor still handles 401 refresh and session teardown, but it will
 * not raise a toast for the failure — a page with twenty-three tiles that
 * each own a "Failed to load — retry" cell must not also stack twenty-three
 * identical red toasts over the header (the watchlist M30 tab did exactly
 * that when the candle endpoint refused the timeframe).
 */
export const SUPPRESS_ERROR_TOAST = new HttpContextToken<boolean>(() => false);

/** Per-call options accepted by every ApiService method. */
export interface ApiCallOptions {
  /** True to suppress the interceptor's error toast; the caller shows the error itself. */
  silent?: boolean;
}

function requestOptions(opts?: ApiCallOptions) {
  if (!opts?.silent) return WITH_CREDENTIALS;
  return {
    ...WITH_CREDENTIALS,
    context: new HttpContext().set(SUPPRESS_ERROR_TOAST, true),
  };
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  get<T>(path: string, opts?: ApiCallOptions): Observable<T> {
    return this.http.get<T>(`${this.baseUrl}${path}`, requestOptions(opts));
  }

  post<T>(path: string, body?: unknown, opts?: ApiCallOptions): Observable<T> {
    return this.http.post<T>(`${this.baseUrl}${path}`, body ?? {}, requestOptions(opts));
  }

  put<T>(path: string, body?: unknown, opts?: ApiCallOptions): Observable<T> {
    return this.http.put<T>(`${this.baseUrl}${path}`, body ?? {}, requestOptions(opts));
  }

  patch<T>(path: string, body?: unknown, opts?: ApiCallOptions): Observable<T> {
    return this.http.patch<T>(`${this.baseUrl}${path}`, body ?? {}, requestOptions(opts));
  }

  delete<T>(path: string, opts?: ApiCallOptions): Observable<T> {
    return this.http.delete<T>(`${this.baseUrl}${path}`, requestOptions(opts));
  }

  // Envelope-aware variants: unwrap ResponseData<T>.data or throw ApiError.
  // Prefer these in feature services; the raw methods above remain for legacy callers.
  getEnvelope<T>(path: string, opts?: ApiCallOptions): Observable<T> {
    return this.get<ResponseData<T>>(path, opts).pipe(map((res) => unwrap(res)));
  }

  postEnvelope<T>(path: string, body?: unknown, opts?: ApiCallOptions): Observable<T> {
    return this.post<ResponseData<T>>(path, body, opts).pipe(map((res) => unwrap(res)));
  }

  putEnvelope<T>(path: string, body?: unknown, opts?: ApiCallOptions): Observable<T> {
    return this.put<ResponseData<T>>(path, body, opts).pipe(map((res) => unwrap(res)));
  }

  deleteEnvelope<T>(path: string, opts?: ApiCallOptions): Observable<T> {
    return this.delete<ResponseData<T>>(path, opts).pipe(map((res) => unwrap(res)));
  }
}

/** Unwrap an envelope or throw `ApiError`. Exported for testability. */
export function unwrapResponse<T>(res: ResponseData<T>): T {
  if (res.status && res.data !== null && res.data !== undefined) {
    return res.data;
  }
  throw new ApiError(res.responseCode ?? 'UNKNOWN', res.message ?? 'Request failed', res);
}

// Keep the internal alias so the rest of the file doesn't need to change.
const unwrap = unwrapResponse;
