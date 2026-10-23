import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type {
  ExecutionQualityLogDto,
  OrderDto,
  PagedData,
  ResponseData,
} from '@core/api/api.types';
import type { OrderBookSnapshot } from '../panels/side/chart-panels.types';
import type { OrderBookHeatmapDto, TickBarsDto, TickBarsRequest } from './orderflow.types';

/** Most fills the chart asks for in one window (newest first). */
export const MAX_FILLS = 200;
/** Pages of orders read to resolve the fills' orders in scope, at most. */
const MAX_ORDER_PAGES = 5;
const ORDER_PAGE = 200;

/**
 * The order-flow reads: C1 and C2 (`chart-flow/*`, served by the engine's research process so they never load the
 * money path), C3 (fills: `execution-quality/list`, joined to `order/list` for the account scope) and C4 (the book at
 * a moment: `market-data/order-book/recent?AsOfUtc=`). All read-only; each failure is the caller's to show, so none
 * raises the global error toast.
 */
@Injectable({ providedIn: 'root' })
export class ChartFlowService {
  private readonly api = inject(ApiService);

  /** C1: the last broker DOM snapshot in each of `buckets` equal buckets of `[fromUtc, toUtc]`. */
  heatmap(
    symbol: string,
    fromUtc: number,
    toUtc: number,
    buckets: number,
  ): Promise<OrderBookHeatmapDto> {
    const q = new URLSearchParams({
      symbol,
      from: new Date(fromUtc).toISOString(),
      to: new Date(toUtc).toISOString(),
      buckets: String(buckets),
    });
    return firstValueFrom(
      this.api.getEnvelope<OrderBookHeatmapDto>(`/chart-flow/order-book-heatmap?${q.toString()}`, {
        silent: true,
      }),
    );
  }

  /** C2: tick-rule flow per chart bar (and the footprint when asked). */
  tickBars(request: TickBarsRequest): Promise<TickBarsDto> {
    return firstValueFrom(
      this.api.postEnvelope<TickBarsDto>('/chart-flow/tick-bars', request, { silent: true }),
    );
  }

  /** C4: the newest snapshot captured at or before `asOfUtc`; null when there is none. */
  async bookAsOf(symbol: string, asOfUtc: number): Promise<OrderBookSnapshot | null> {
    const q = new URLSearchParams({
      symbol,
      limit: '1',
      AsOfUtc: new Date(asOfUtc).toISOString(),
    });
    const rows = await firstValueFrom(
      this.api.getEnvelope<OrderBookSnapshot[]>(`/market-data/order-book/recent?${q.toString()}`, {
        silent: true,
      }),
    );
    return rows?.[0] ?? null;
  }

  /**
   * C3: the symbol's fills in `[fromUtc, toUtc]` (newest {@link MAX_FILLS}) and the orders of `accountIds` they
   * belong to. The log has no account of its own, so the orders are what scope it. An empty scope reads nothing.
   */
  async fills(
    symbol: string,
    fromUtc: number,
    toUtc: number,
    accountIds: readonly number[],
  ): Promise<{ logs: ExecutionQualityLogDto[]; orders: OrderDto[]; truncated: boolean }> {
    if (accountIds.length === 0) return { logs: [], orders: [], truncated: false };
    const res = await firstValueFrom(
      this.api.post<ResponseData<PagedData<ExecutionQualityLogDto>>>(
        '/execution-quality/list',
        {
          currentPage: 1,
          itemCountPerPage: MAX_FILLS,
          filter: {
            symbol,
            from: new Date(fromUtc).toISOString(),
            to: new Date(toUtc).toISOString(),
          },
          sortBy: 'recordedAt',
          sortDirection: 'desc',
        },
        { silent: true },
      ),
    );
    if (!res?.status) throw new Error(res?.message ?? 'Fills could not be read');
    const logs = res.data?.data ?? [];
    if (logs.length === 0) return { logs, orders: [], truncated: false };
    const wanted = new Set(logs.map((l) => l.orderId));
    const orders: OrderDto[] = [];
    // The orders list has no id filter: read the scope's orders of the symbol newest first until every fill's order
    // is found or the orders are older than the window.
    for (let page = 1; page <= MAX_ORDER_PAGES && wanted.size > 0; page++) {
      const o = await firstValueFrom(
        this.api.post<ResponseData<PagedData<OrderDto>>>(
          '/order/list',
          {
            currentPage: page,
            itemCountPerPage: ORDER_PAGE,
            filter: { search: symbol, tradingAccountIds: [...accountIds] },
            sortBy: 'createdAt',
            sortDirection: 'desc',
          },
          { silent: true },
        ),
      );
      if (!o?.status) throw new Error(o?.message ?? 'Orders could not be read');
      const rows = o.data?.data ?? [];
      for (const row of rows) {
        if (wanted.delete(row.id)) orders.push(row);
      }
      const oldest = Date.parse(rows.at(-1)?.createdAt ?? '');
      if (rows.length < ORDER_PAGE || (Number.isFinite(oldest) && oldest < fromUtc - 86_400_000))
        break;
    }
    return { logs, orders, truncated: logs.length >= MAX_FILLS };
  }
}
