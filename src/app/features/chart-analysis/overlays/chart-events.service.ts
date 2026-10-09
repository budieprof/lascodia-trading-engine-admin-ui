import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '@core/api/api.service';
import { EconomicEventsService } from '@core/services/economic-events.service';
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
