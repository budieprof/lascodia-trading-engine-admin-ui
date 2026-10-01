import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import type { ResponseData } from '@core/api/api.types';

/** One drawing as the engine stores it. */
export interface ChartDrawingDto {
  id: number;
  clientId: string;
  symbol: string;
  resolution: string;
  kind: string;
  pointsJson: string;
  styleJson: string;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
  /** Tool settings (Fib levels, extend…), JSON. Absent on engines before feat/drawing-options. */
  optionsJson?: string;
  hidden?: boolean;
  /** Comma-separated resolutions the drawing shows on; empty = all. */
  visibleOn?: string;
  zIndex?: number;
}

export interface ChartDrawingInput {
  clientId: string;
  kind: string;
  pointsJson: string;
  styleJson: string;
  locked: boolean;
  createdAt: string;
  /** Tool settings (Fib levels, extend…), JSON. Absent on engines before feat/drawing-options. */
  optionsJson?: string;
  hidden?: boolean;
  /** Comma-separated resolutions the drawing shows on; empty = all. */
  visibleOn?: string;
  zIndex?: number;
}

/**
 * Client for `/chart-drawings` — durable, cross-device storage for chart
 * drawings.
 *
 * The write side is a whole-scope REPLACE rather than per-drawing CRUD. The
 * browser already holds every drawing for the chart it is showing, and one
 * drag produces a change per animation frame; sending the set makes the request
 * idempotent and self-correcting, where a stream of individual writes can
 * arrive out of order and a dropped delete leaves a drawing the operator
 * removed.
 */
@Injectable({ providedIn: 'root' })
export class ChartDrawingsService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  list(symbol: string, resolution: string): Observable<ResponseData<ChartDrawingDto[]>> {
    return this.api.post(`/chart-drawings/list`, { symbol, resolution });
  }

  replaceScope(
    symbol: string,
    resolution: string,
    drawings: ChartDrawingInput[],
  ): Observable<ResponseData<number>> {
    return this.api.put(`/chart-drawings/scope`, { symbol, resolution, drawings });
  }

  /**
   * Same write, but able to outlive the page: `fetch(..., { keepalive: true })` is the one request
   * the browser still delivers after a tab closes or reloads. Used only to flush unsaved edits on
   * `pagehide` — an HttpClient call started there is cancelled with the document.
   */
  replaceScopeOnUnload(symbol: string, resolution: string, drawings: ChartDrawingInput[]): void {
    const token = this.auth.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // The cookie sentinel is not a bearer token; the HttpOnly cookie travels via `credentials`.
    if (token && token.split('.').length === 3) headers['Authorization'] = `Bearer ${token}`;
    void fetch(`${this.baseUrl}/chart-drawings/scope`, {
      method: 'PUT',
      keepalive: true,
      credentials: 'include',
      headers,
      body: JSON.stringify({ symbol, resolution, drawings }),
    }).catch(() => undefined);
  }
}
