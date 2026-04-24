import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, map, of } from 'rxjs';

import { OrdersService } from '@core/services/orders.service';
import { StrategiesService } from '@core/services/strategies.service';
import { TradeSignalsService } from '@core/services/trade-signals.service';

export interface GlobalSearchResult {
  kind: 'order' | 'strategy' | 'signal';
  id: number;
  label: string;
  sublabel?: string;
  route: string;
}

/**
 * Client-driven global search. Fans out the query to the entity-list endpoints
 * that already support `filter.search` (orders, strategies, trade signals)
 * and merges the top hits.
 *
 * This is deliberately a client-side fan-out — a proper engine-side search
 * index would be better (single round trip, faster scoring, relevance tuning)
 * but the existing endpoints are enough to be useful and this ships today.
 * Upgrade path: add `POST /search` on the engine, keep this service's public
 * API, swap the implementation.
 */
@Injectable({ providedIn: 'root' })
export class GlobalSearchService {
  private readonly ordersService = inject(OrdersService);
  private readonly strategiesService = inject(StrategiesService);
  private readonly signalsService = inject(TradeSignalsService);

  /**
   * Returns up to 5 results per entity-type (capped for palette render
   * performance). Blank query yields an empty stream without hitting the API.
   */
  search(query: string): Observable<GlobalSearchResult[]> {
    const q = query.trim();
    if (!q) return of([]);

    const orders = this.ordersService
      .list({ currentPage: 1, itemCountPerPage: 5, filter: { search: q } })
      .pipe(
        map((res) =>
          (res?.data?.data ?? []).map<GlobalSearchResult>((o) => ({
            kind: 'order',
            id: o.id,
            label: `Order #${o.id} — ${o.symbol} ${o.orderType}`,
            sublabel: o.status,
            route: `/orders/${o.id}`,
          })),
        ),
      );

    const strategies = this.strategiesService
      .list({ currentPage: 1, itemCountPerPage: 5, filter: { search: q } })
      .pipe(
        map((res) =>
          (res?.data?.data ?? []).map<GlobalSearchResult>((s) => ({
            kind: 'strategy',
            id: s.id,
            label: s.name ?? `Strategy #${s.id}`,
            sublabel: `${s.symbol ?? ''} · ${s.status ?? ''}`,
            route: `/strategies/${s.id}`,
          })),
        ),
      );

    const signals = this.signalsService
      .list({ currentPage: 1, itemCountPerPage: 5, filter: { search: q } })
      .pipe(
        map((res) =>
          (res?.data?.data ?? []).map<GlobalSearchResult>((sig) => ({
            kind: 'signal',
            id: sig.id,
            label: `Signal #${sig.id} — ${sig.symbol} ${sig.direction}`,
            sublabel: sig.status,
            route: `/trade-signals/${sig.id}`,
          })),
        ),
      );

    return combineLatest([orders, strategies, signals]).pipe(
      map(([o, s, sig]) => [...o, ...s, ...sig]),
    );
  }
}
