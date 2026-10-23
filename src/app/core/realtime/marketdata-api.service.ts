import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import type {
  CmeBasis,
  CmeOrderFlow,
  CmeOrderFlowRequest,
  MdHistory,
  MdHistoryRequest,
  MdHistoryWire,
  MdSource,
} from './marketdata.types';

/** How long the source registry answer is reused. */
const SOURCES_TTL_MS = 5 * 60_000;

/**
 * The market-data program's reads: C5 `POST md/history` (served by the research process; read-only although it is a
 * POST) and C7 `GET md/sources` (entitlement-filtered, cached 5 min). Errors are the caller's to show (silent).
 */
@Injectable({ providedIn: 'root' })
export class MarketDataApiService {
  private readonly api = inject(ApiService);
  private sourcesCache: { at: number; value: Promise<MdSource[]> } | null = null;

  /**
   * C5. Keeps the envelope's message (missing keyframe / not entitled / truncated notes). Futures sources come back
   * mapped onto the spot symbol (`spot: true`, cme-tier2) — the live hub frames of those sources are mapped the same way
   * (`CmeSpotService`); broker sources are untouched by it.
   */
  async history(req: MdHistoryRequest): Promise<MdHistory> {
    const res = await firstValueFrom(
      this.api.post<ResponseData<MdHistoryWire>>('/md/history', { spot: true, ...req }, { silent: true }),
    );
    if (!res?.status || !res.data)
      throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'md/history failed', res);
    return {
      ...res.data,
      message: res.message && res.message !== 'Successful' ? res.message : null,
    };
  }

  /** cme-tier2 `GET md/basis`: the futures − spot basis (latest + the last 2 h by minute). */
  async basis(symbol: string, sourceId: string): Promise<CmeBasis> {
    const q = `?symbol=${encodeURIComponent(symbol)}&sourceId=${encodeURIComponent(sourceId)}`;
    const res = await firstValueFrom(this.api.get<ResponseData<CmeBasis>>(`/md/basis${q}`, { silent: true }));
    if (!res?.status || !res.data)
      throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'md/basis failed', res);
    return res.data;
  }

  /** cme-tier2 `POST md/orderflow` (research): CME delta / CVD / footprint, bubbles, large lots, sweeps, icebergs, absorption. */
  async orderFlow(req: CmeOrderFlowRequest): Promise<CmeOrderFlow> {
    const res = await firstValueFrom(
      this.api.post<ResponseData<CmeOrderFlow>>('/md/orderflow', { spot: true, ...req }, { silent: true }),
    );
    if (!res?.status || !res.data)
      throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'md/orderflow failed', res);
    return res.data;
  }

  /** C7, cached; a failed read is not cached. */
  sources(force = false): Promise<MdSource[]> {
    const now = Date.now();
    if (!force && this.sourcesCache && now - this.sourcesCache.at < SOURCES_TTL_MS)
      return this.sourcesCache.value;
    const value = firstValueFrom(
      this.api.getEnvelope<MdSource[]>('/md/sources', { silent: true }),
    ).then((list) => (list ?? []).filter((s) => s && typeof s.sourceId === 'string'));
    this.sourcesCache = { at: now, value };
    value.catch(() => {
      if (this.sourcesCache?.value === value) this.sourcesCache = null;
    });
    return value;
  }
}
