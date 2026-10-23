import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { ApiError, type ResponseData } from '@core/api/api.types';
import type {
  MdDispersionWire,
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

  /** C5. Keeps the envelope's message (missing keyframe / not entitled / truncated notes). */
  async history(req: MdHistoryRequest): Promise<MdHistory> {
    const res = await firstValueFrom(
      this.api.post<ResponseData<MdHistoryWire>>('/md/history', req, { silent: true }),
    );
    if (!res?.status || !res.data)
      throw new ApiError(res?.responseCode ?? 'UNKNOWN', res?.message ?? 'md/history failed', res);
    return {
      ...res.data,
      message: res.message && res.message !== 'Successful' ? res.message : null,
    };
  }

  /** Multibook: per-minute quote dispersion across sources in [from, to) (epoch ms, ≤ 7 days; entitled sources only). */
  async dispersion(symbol: string, from: number, to: number): Promise<MdDispersionWire> {
    const q = `symbol=${encodeURIComponent(symbol)}&from=${Math.floor(from)}&to=${Math.floor(to)}`;
    const data = await firstValueFrom(
      this.api.getEnvelope<MdDispersionWire>(`/md/dispersion?${q}`, { silent: true }),
    );
    return data ?? { symbol, minutes: [], denied: [] };
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
