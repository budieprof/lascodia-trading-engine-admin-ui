import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import { futuresSymbolOf } from '@core/realtime/cme-spot';
import { MarketDataApiService } from '@core/realtime/marketdata-api.service';
import { sourceLabel } from '@core/realtime/marketdata.types';
import { cryptoCarries } from '../orderflow/flow-source';
import { availableMetrics, type DerivativesSample, type MetricAvailability } from './metric-alerts';

/** `GET md/crypto/derivatives` (engine `CryptoDerivativesDto`): the latest values + the per-minute rows. */
export interface CryptoDerivativesDto {
  sourceId: string;
  symbol: string;
  latest: {
    mark?: number | null;
    index?: number | null;
    funding?: number | null;
    openInterest?: number | null;
  } | null;
  latestAgeMs: number | null;
  minutes: {
    t: number;
    mark: number | null;
    index: number | null;
    funding: number | null;
    oi: number | null;
  }[];
}

/** How far back a symbol's derivatives are sampled to decide what it offers. */
const SAMPLE_MS = 30 * 60_000;
/** A symbol's answer is reused this long. */
const CACHE_MS = 60_000;
/** A live value older than this does not count (the engine ignores values older than 15 min). */
const MAX_LIVE_AGE_MS = 15 * 60_000;

/** One source's answer → what it holds for the symbol (newest live value, else the newest stored minute). */
export function sampleOf(dto: CryptoDerivativesDto, label: string): DerivativesSample {
  const fresh = dto.latest && (dto.latestAgeMs ?? Infinity) <= MAX_LIVE_AGE_MS ? dto.latest : null;
  const rows = [...(dto.minutes ?? [])].reverse();
  const newest = (pick: (m: CryptoDerivativesDto['minutes'][number]) => number | null) => {
    for (const m of rows) {
      const v = pick(m);
      if (v !== null && v !== undefined && Number.isFinite(v)) return v;
    }
    return null;
  };
  const markIndex = fresh?.mark != null && fresh?.index != null ? { mark: fresh.mark, index: fresh.index } : null;
  const rowMarkIndex = rows.find((m) => m.mark != null && m.index != null) ?? null;
  return {
    sourceId: dto.sourceId,
    label,
    funding: fresh?.funding ?? newest((m) => m.funding),
    mark: markIndex?.mark ?? rowMarkIndex?.mark ?? null,
    index: markIndex?.index ?? rowMarkIndex?.index ?? null,
    openInterest: fresh?.openInterest ?? newest((m) => m.oi),
    minutes: rows.length,
    oiMinutes: rows.filter((m) => m.oi != null).length,
  };
}

/**
 * UF04: which derivatives alerts a symbol can carry — read from the data the engine holds for it (each crypto
 * exchange streaming it: `md/crypto/derivatives`; a CME source mapping it: `md/basis`). Read-only, cached a minute.
 */
@Injectable({ providedIn: 'root' })
export class MetricAvailabilityService {
  private readonly api = inject(ApiService);
  private readonly mdApi = inject(MarketDataApiService);
  private readonly cache = new Map<string, { at: number; value: Promise<MetricAvailability[]> }>();

  forSymbol(symbol: string): Promise<MetricAvailability[]> {
    const key = symbol.toUpperCase();
    const now = Date.now();
    const held = this.cache.get(key);
    if (held && now - held.at < CACHE_MS) return held.value;
    const value = this.read(key, now);
    this.cache.set(key, { at: now, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  private async read(symbol: string, now: number): Promise<MetricAvailability[]> {
    const sources = await this.mdApi.sources().catch(() => []);
    const crypto = sources.filter((s) => cryptoCarries(s, symbol));
    const samples = (
      await Promise.all(
        crypto.map((s) =>
          this.derivatives(symbol, s.sourceId, now - SAMPLE_MS, now).then(
            (d) => (d ? sampleOf(d, sourceLabel(s)) : null),
            () => null,
          ),
        ),
      )
    ).filter((s): s is DerivativesSample => s !== null);
    let cmeBasis: { sourceId: string; label: string; percent: number | null } | null = null;
    const cme = sources.find((s) => futuresSymbolOf(s, symbol) !== null);
    if (cme) {
      const b = await this.mdApi.basis(symbol, cme.sourceId).catch(() => null);
      if (b?.latest && !b.stale && (b.latest.rolling ?? b.latest.basis) != null)
        cmeBasis = { sourceId: cme.sourceId, label: sourceLabel(cme), percent: null };
    }
    return availableMetrics(samples, cmeBasis);
  }

  private async derivatives(symbol: string, sourceId: string, from: number, to: number): Promise<CryptoDerivativesDto | null> {
    const q = new URLSearchParams({
      symbol,
      sourceId,
      from: String(Math.floor(from)),
      to: String(Math.floor(to)),
    });
    const data = await firstValueFrom(
      this.api.getEnvelope<CryptoDerivativesDto>(`/md/crypto/derivatives?${q.toString()}`, { silent: true }),
    );
    return data ?? null;
  }
}
