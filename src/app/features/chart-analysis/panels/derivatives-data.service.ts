import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import type { COTReportDto, ResponseData } from '@core/api/api.types';
import type { CmeBasis } from '@core/realtime/marketdata.types';
import type { EquityFundamentals, FuturesTermStructure } from '@features/venues/venues.types';
import type { ScheduledMarketEventRow } from '@features/news-intel/news-intel.types';

/**
 * The engine's derivatives and market-event reads the chart's panes and marks draw from (UA01, UA03). Every call is
 * read-only and silent; a refusal or an empty answer comes back with the engine's own message so the pane can say why
 * it is empty instead of drawing zeros.
 */

/** One minute of `GET md/crypto/derivatives` (`CryptoDerivativesMinute`). */
export interface DerivativesMinute {
  t: number;
  mark: number | null;
  index: number | null;
  /** Funding rate as a fraction per interval (0.0001 = 0.01 %). */
  funding: number | null;
  nextFundingT: number | null;
  /** Open interest in the venue's unit (contracts / base coin). */
  oi: number | null;
  samples: number;
  liqBuyQty: number;
  liqBuyNotional: number;
  liqSellQty: number;
  liqSellNotional: number;
  liqCount: number;
}

export interface DerivativesLatest {
  mark: number | null;
  index: number | null;
  funding: number | null;
  nextFundingMs: number | null;
  openInterest: number | null;
  updatedMs: number | null;
}

/** `GET md/crypto/derivatives?symbol=&sourceId=&from=&to=` (≤ 7 days a read). */
export interface CryptoDerivatives {
  sourceId: string;
  symbol: string;
  latest: DerivativesLatest | null;
  latestAgeMs: number | null;
  minutes: DerivativesMinute[];
}

/** A read and what the engine said with it. */
export interface Answer<T> {
  data: T | null;
  /** The engine's message ("No derivatives data for … in the window.") or the failure. */
  message: string;
  ok: boolean;
}

/** `GET futures/statistics` row (`FutureDailyStatistic`). */
export interface FutureStatistic {
  sourceId: string;
  contract: string;
  root: string;
  tradeDate: string;
  settlement: number | null;
  settlementFinal: boolean | null;
  openInterest: number | null;
  clearedVolume: number | null;
  close: number | null;
}

/** One COT report row (`sentiment/cot/list`). */
export type CotRow = COTReportDto;

const DAY = 86_400_000;
/** The engine's per-read cap on derivatives and basis windows. */
export const DERIVATIVES_READ_MS = 7 * DAY;
/** How far back the panes read derivatives history (four reads). */
export const DERIVATIVES_HISTORY_MS = 28 * DAY;
/** The scheduled-events endpoint's window cap. */
export const SCHEDULED_EVENTS_WINDOW_MS = 120 * DAY;

/** `[from, to]` cut into consecutive reads of at most `maxMs`, newest first. */
export function readWindows(
  from: number,
  to: number,
  maxMs: number,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let end = to; end > from; end -= maxMs)
    out.push({ from: Math.max(from, end - maxMs), to: end });
  return out;
}

@Injectable({ providedIn: 'root' })
export class DerivativesDataService {
  private readonly api = inject(ApiService);

  private async read<T>(path: string): Promise<Answer<T>> {
    try {
      const res = await firstValueFrom(this.api.get<ResponseData<T>>(path, { silent: true }));
      if (!res) return { data: null, ok: false, message: 'No answer from the engine.' };
      return { data: res.data ?? null, ok: !!res.status, message: res.message ?? '' };
    } catch (e) {
      return {
        data: null,
        ok: false,
        message: e instanceof Error ? e.message : 'The engine could not be reached.',
      };
    }
  }

  /**
   * Derivatives minutes of a perpetual over `[from, to]` (UTC ms), at most {@link DERIVATIVES_HISTORY_MS} back from
   * `to`, read in 7-day pieces and merged ascending. `latest` is the newest read's.
   */
  async derivatives(
    symbol: string,
    sourceId: string,
    from: number,
    to: number,
  ): Promise<Answer<CryptoDerivatives>> {
    const start = Math.max(from, to - DERIVATIVES_HISTORY_MS);
    const pieces = await Promise.all(
      readWindows(start, to, DERIVATIVES_READ_MS).map((w) =>
        this.read<CryptoDerivatives>(
          `/md/crypto/derivatives?symbol=${encodeURIComponent(symbol)}&sourceId=${encodeURIComponent(sourceId)}` +
            `&from=${Math.floor(w.from)}&to=${Math.floor(w.to)}`,
        ),
      ),
    );
    const first = pieces[0];
    if (!first?.ok)
      return first ?? { data: null, ok: false, message: 'No answer from the engine.' };
    const byT = new Map<number, DerivativesMinute>();
    for (const p of pieces) for (const m of p.data?.minutes ?? []) byT.set(m.t, m);
    const minutes = [...byT.values()].sort((a, b) => a.t - b.t);
    return {
      ok: true,
      message: minutes.length
        ? first.message
        : first.message || 'No derivatives data in the window.',
      data: { ...(first.data as CryptoDerivatives), minutes },
    };
  }

  /** `GET md/basis` (CME future − spot, per minute) over the last ≤ 7 days of `[from, to]`. */
  basis(symbol: string, from: number, to: number): Promise<Answer<CmeBasis>> {
    const start = Math.max(from, to - DERIVATIVES_READ_MS);
    return this.read<CmeBasis>(
      `/md/basis?symbol=${encodeURIComponent(symbol)}&from=${Math.floor(start)}&to=${Math.floor(to)}`,
    );
  }

  /** `GET futures/statistics?root=` daily settlement / OI per contract, newest first (≤ 2 000 rows). */
  futureStatistics(root: string, from: number, to: number): Promise<Answer<FutureStatistic[]>> {
    const q = new URLSearchParams({
      root,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      take: '2000',
    });
    return this.read<FutureStatistic[]>(`/futures/statistics?${q.toString()}`);
  }

  /** `GET instrument-fundamentals/futures/{root}`: the curve with each contract's last trading day. */
  termStructure(root: string): Promise<Answer<FuturesTermStructure>> {
    return this.read<FuturesTermStructure>(
      `/instrument-fundamentals/futures/${encodeURIComponent(root)}`,
    );
  }

  /** Scheduled market events of `keys` in `[from, to]` (the endpoint's 120-day cap applied from `to` back). */
  async scheduledEvents(
    keys: readonly string[],
    from: number,
    to: number,
  ): Promise<Answer<ScheduledMarketEventRow[]>> {
    const start = Math.max(from, to - SCHEDULED_EVENTS_WINDOW_MS);
    const answers = await Promise.all(
      keys.map((key) => {
        const q = new URLSearchParams({
          key,
          from: new Date(start).toISOString(),
          to: new Date(to).toISOString(),
          take: '500',
        });
        return this.read<ScheduledMarketEventRow[]>(`/news-intel/scheduled-events?${q.toString()}`);
      }),
    );
    const failed = answers.find((a) => !a.ok);
    if (failed && answers.every((a) => !a.ok)) return failed;
    return { ok: true, message: failed?.message ?? '', data: answers.flatMap((a) => a.data ?? []) };
  }

  /** `GET instrument-fundamentals/equity/{symbol}` (corporate actions, dividends). */
  equity(symbol: string): Promise<Answer<EquityFundamentals>> {
    return this.read<EquityFundamentals>(
      `/instrument-fundamentals/equity/${encodeURIComponent(symbol)}`,
    );
  }

  /** COT reports of one currency, newest first (`sentiment/cot/list`, nested filter). */
  async cot(currency: string): Promise<Answer<CotRow[]>> {
    try {
      const res = await firstValueFrom(
        this.api.post<ResponseData<{ data?: CotRow[] }>>(
          '/sentiment/cot/list',
          {
            currentPage: 1,
            itemCountPerPage: 500,
            sortBy: 'reportDate',
            sortDirection: 'desc',
            // The engine filters on `symbol`'s first three letters: the currency.
            filter: { symbol: currency },
          },
          { silent: true },
        ),
      );
      return { ok: !!res?.status, message: res?.message ?? '', data: res?.data?.data ?? null };
    } catch (e) {
      return {
        data: null,
        ok: false,
        message: e instanceof Error ? e.message : 'The engine could not be reached.',
      };
    }
  }
}
