import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { EconomicEventsService } from '@core/services/economic-events.service';
import { DerivativesDataService } from '../panels/derivatives-data.service';
import type { EventRelevance } from '../panels/event-relevance';
import { corporateActionMarks, expiryMark, fundingMarks, marketMarkOf } from './market-event-marks';
import {
  markOf,
  type BlackoutWindow,
  type EconomicEventRow,
  type EventImpact,
  type EventMark,
} from './chart-events';

/** Rows per request, and how many requests one window may take (newest first). */
const PAGE = 500;
const MAX_PAGES = 6;

/**
 * The chart's economic events and the news blackout window (contract C3).
 *
 * The events are asked for with the pair's currencies and the chart's minimum importance filtered
 * on the ENGINE (`economic-event/list`, filter `currencies` + `minImpact`): it used to read the 500
 * newest events of every currency, 14 days ahead included, and filter them in the browser — so on a
 * long window most of the pair's own events never arrived (SP-08).
 */
@Injectable({ providedIn: 'root' })
export class ChartEventsService {
  private readonly events = inject(EconomicEventsService);
  private readonly api = inject(ApiService);
  private readonly data = inject(DerivativesDataService);

  /**
   * Events of `currencies` at `minImpact` and above between `from` and `to` (UTC ms), newest first,
   * every page up to {@link MAX_PAGES}. Null when the engine refused or could not be reached — the
   * caller keeps what it has rather than wiping the layer.
   */
  async load(opts: {
    currencies: readonly string[];
    minImpact: EventImpact;
    from: number;
    to: number;
    /** UA01: what else concerns the symbol (market events, expiry, funding); absent = economic releases only. */
    relevance?: EventRelevance | null;
    symbol?: string;
    /** The chart's candle source (C1 `source.id`): the venue a perpetual's funding is read from. */
    sourceId?: string | null;
  }): Promise<EventMark[] | null> {
    const extras = opts.relevance ? this.loadExtras(opts) : Promise.resolve([]);
    // No currency concerns the symbol: no economic release is asked for (an empty filter used to mean EVERY currency).
    const economic = opts.currencies.length ? await this.loadEconomic(opts) : [];
    if (economic === null) return null;
    const more = await extras;
    // Economic releases alone keep the engine's order (FX unchanged); with other marks, one time order.
    return more.length
      ? [...economic, ...more].sort((a, b) => a.time - b.time || a.id - b.id)
      : economic;
  }

  private async loadEconomic(opts: {
    currencies: readonly string[];
    minImpact: EventImpact;
    from: number;
    to: number;
  }): Promise<EventMark[] | null> {
    const out: EventMark[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await firstValueFrom(
        this.events.list({
          currentPage: page,
          itemCountPerPage: PAGE,
          // sortBy/sortDirection are EXPLICIT. The handler's default is ascending, so a capped
          // window would hold the OLDEST events — the chart showed 9-18 Sep, the API returned 5-20 Aug.
          sortBy: 'scheduledAt',
          sortDirection: 'desc',
          filter: {
            from: new Date(opts.from).toISOString(),
            to: new Date(opts.to).toISOString(),
            currencies: opts.currencies.join(','),
            minImpact: opts.minImpact,
          },
        }),
      ).catch(() => null);
      if (!res?.status || !res.data) return page === 1 ? null : out;
      const rows = (res.data.data ?? []) as EconomicEventRow[];
      for (const row of rows) {
        const mark = markOf(row);
        if (mark) out.push(mark);
      }
      if (rows.length < PAGE) break;
    }
    return out;
  }

  /**
   * The symbol's non-economic marks in the window (UA01), each from a real row: scheduled market events of its
   * exposure keys, a future's last trading day, a perpetual's funding times, an equity's dividends and splits. A read
   * that fails contributes nothing (the economic layer still draws).
   */
  private async loadExtras(opts: {
    from: number;
    to: number;
    relevance?: EventRelevance | null;
    symbol?: string;
    sourceId?: string | null;
  }): Promise<EventMark[]> {
    const r = opts.relevance!;
    const symbol = (opts.symbol ?? '').toUpperCase();
    const reads: Promise<EventMark[]>[] = [];
    if (r.marketKeys.length) {
      reads.push(
        this.data
          .scheduledEvents(r.marketKeys, opts.from, opts.to)
          .then((a) => (a.data ?? []).map(marketMarkOf).filter((m): m is EventMark => m !== null)),
      );
    }
    if (r.expiryMs !== null && r.expiryMs >= opts.from && r.expiryMs <= opts.to)
      reads.push(Promise.resolve([expiryMark(symbol, r.expiryMs)]));
    if (r.funding && opts.sourceId && symbol) {
      const to = Math.min(opts.to, Date.now());
      reads.push(
        this.data
          .derivatives(symbol, opts.sourceId, opts.from, to)
          .then((a) =>
            a.data
              ? fundingMarks(symbol, a.data.minutes, a.data.latest?.nextFundingMs ?? null)
              : [],
          ),
      );
    }
    if (r.kind === 'equity' && symbol) {
      reads.push(
        this.data
          .equity(symbol)
          .then((a) =>
            corporateActionMarks(symbol, a.data?.actions ?? []).filter(
              (m) => m.time >= opts.from && m.time <= opts.to,
            ),
          ),
      );
    }
    const all = await Promise.all(reads.map((p) => p.catch(() => [] as EventMark[])));
    return all.flat();
  }

  /** The news blackout live applies now (`economic-event/news-blackout`); null when unknown. */
  async blackout(): Promise<BlackoutWindow | null> {
    try {
      const w = await firstValueFrom(
        this.api.getEnvelope<BlackoutWindow>('/economic-event/news-blackout', { silent: true }),
      );
      return w && typeof w.active === 'boolean' ? w : null;
    } catch {
      return null;
    }
  }
}
