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
  /** The resolution the drawing was CREATED on; it shows wherever `visibleOn` allows (DR-I2). */
  resolution: string;
  kind: string;
  pointsJson: string;
  styleJson: string;
  locked: boolean;
  createdAt: string;
  /** The drawing's version, to the millisecond: what a write names as its `baseUpdatedAt`. */
  updatedAt: string;
  /** Tool settings (Fib levels, extend…), JSON. Absent on engines before feat/drawing-options. */
  optionsJson?: string;
  hidden?: boolean;
  /** Comma-separated resolutions the drawing shows on; empty = every resolution of the symbol. */
  visibleOn?: string;
  zIndex?: number;
  /** 1 = a per-timeframe row from before DR-I2 (read where it showed), 2 = per symbol. */
  visibilityModel?: number;
}

/** A drawing's content in a write. */
export interface ChartDrawingUpsert {
  symbol: string;
  /** The resolution it was created on. */
  resolution: string;
  kind: string;
  pointsJson: string;
  styleJson: string;
  locked: boolean;
  optionsJson: string;
  hidden: boolean;
  visibleOn: string;
  zIndex: number;
  createdAt: string;
}

/** One write of a batch: a drawing saved or deleted against the version it was made from. */
export interface ChartDrawingOp {
  op: 'upsert' | 'delete';
  clientId: string;
  /** The server version this write was made from; null when none was ever acknowledged. */
  baseUpdatedAt: string | null;
  /** For a delete with no base: the drawing's creation time. */
  createdAt?: string;
  drawing?: ChartDrawingUpsert;
}

/** What happened to one write: `00` applied, `-409` stale (`drawing` = the server's current row), `-11` refused. */
export interface ChartDrawingOpResult {
  clientId: string;
  code: string;
  message?: string | null;
  drawing?: ChartDrawingDto | null;
}

/** The SignalR `chartDrawingsChanged` payload: which symbols changed, and the tab that wrote. */
export interface ChartDrawingsChanged {
  symbols: string[];
  origin?: string | null;
}

/**
 * Client for `/chart-drawings` — durable, cross-device storage for chart drawings (engine
 * `docs/api/chart-drawings-api.md`).
 *
 * Drawings are read per SYMBOL and written one by one (DR-I2 / DR-I3): each write names the version it was made
 * from, so another machine's newer edit is never overwritten — the engine answers `-409` with its row instead. The
 * whole-chart replace this used before let a stale tab erase work it had never seen.
 */
@Injectable({ providedIn: 'root' })
export class ChartDrawingsService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly baseUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl}/api/v1/lascodia-trading-engine`;

  /** Every drawing the caller owns on `symbol`, with its effective visibility. */
  list(symbol: string): Observable<ResponseData<ChartDrawingDto[]>> {
    return this.api.post(`/chart-drawings/list`, { symbol });
  }

  /** Save / delete drawings one by one; `origin` (this tab) comes back in the realtime push. */
  sync(origin: string, ops: ChartDrawingOp[]): Observable<ResponseData<ChartDrawingOpResult[]>> {
    return this.api.post(`/chart-drawings/batch`, { origin, ops });
  }

  /**
   * The same write, able to outlive the page: `fetch(..., { keepalive: true })` is the one request the browser
   * still delivers after a tab closes or reloads (an HttpClient call started on `pagehide` is cancelled with the
   * document). Best effort only — the writes are also kept in this browser and sent on the next load.
   */
  syncOnUnload(origin: string, ops: ChartDrawingOp[]): void {
    const token = this.auth.getToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // The cookie sentinel is not a bearer token; the HttpOnly cookie travels via `credentials`.
    if (token && token.split('.').length === 3) headers['Authorization'] = `Bearer ${token}`;
    void fetch(`${this.baseUrl}/chart-drawings/batch`, {
      method: 'POST',
      keepalive: true,
      credentials: 'include',
      headers,
      body: JSON.stringify({ origin, ops }),
    }).catch(() => undefined);
  }
}
