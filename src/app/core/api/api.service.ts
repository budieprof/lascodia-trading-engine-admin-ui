import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
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

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  get<T>(path: string): Observable<T> {
    return this.http.get<T>(`${this.baseUrl}${path}`, WITH_CREDENTIALS);
  }

  post<T>(path: string, body?: unknown): Observable<T> {
    return this.http.post<T>(`${this.baseUrl}${path}`, body ?? {}, WITH_CREDENTIALS);
  }

  put<T>(path: string, body?: unknown): Observable<T> {
    return this.http.put<T>(`${this.baseUrl}${path}`, body ?? {}, WITH_CREDENTIALS);
  }

  delete<T>(path: string): Observable<T> {
    return this.http.delete<T>(`${this.baseUrl}${path}`, WITH_CREDENTIALS);
  }

  // Envelope-aware variants: unwrap ResponseData<T>.data or throw ApiError.
  // Prefer these in feature services; the raw methods above remain for legacy callers.
  getEnvelope<T>(path: string): Observable<T> {
    return this.get<ResponseData<T>>(path).pipe(map((res) => unwrap(res)));
  }

  postEnvelope<T>(path: string, body?: unknown): Observable<T> {
    return this.post<ResponseData<T>>(path, body).pipe(map((res) => unwrap(res)));
  }

  putEnvelope<T>(path: string, body?: unknown): Observable<T> {
    return this.put<ResponseData<T>>(path, body).pipe(map((res) => unwrap(res)));
  }

  deleteEnvelope<T>(path: string): Observable<T> {
    return this.delete<ResponseData<T>>(path).pipe(map((res) => unwrap(res)));
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
