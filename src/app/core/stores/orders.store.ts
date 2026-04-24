import { computed, inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState } from '@ngrx/signals';
import { catchError, map, of, take } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { OrdersService } from '@core/services/orders.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { OrderDto, PagerRequest } from '@core/api/api.types';

/**
 * Shared signal store for order state. Every page that shows orders — the
 * orders list, the dashboard exposure panel, and future cross-cutting widgets
 * — reads from this single source. Push events from SignalR invalidate it so
 * a filled order on the dashboard updates the orders list without a refetch
 * race. Polling stays as the fallback path; the store simply overwrites its
 * slice on each refresh.
 *
 * ## Adoption path
 *
 * Today's `orders-page` uses its own `fetchData` callback bound directly to
 * the `DataTableComponent`. The orders-page was recently extended with saved
 * views + batch cancel, so a full migration is deferred to its own PR to
 * avoid conflating concerns. When that PR lands:
 *
 *   1. Replace the page's `fetchData` callback with a store-backed one that
 *      calls `store.loadPage(params)` and returns `toObservable(store.entities)`
 *      mapped to the PagedData envelope the table expects.
 *   2. Call `store.bindRealtime()` from the page constructor so SignalR
 *      pushes route through the store instead of the current per-page
 *      realtime subscription.
 *   3. Point any new cross-cutting consumers (dashboard exposure tile,
 *      presence-aware detail panels) at the store directly — no re-fetch.
 *
 * The store is safe to adopt one page at a time. Existing feature-page
 * wiring keeps working; new surfaces should prefer the store.
 */
export interface OrdersState {
  /** Most recently loaded page of orders, newest-first. */
  entities: OrderDto[];
  /** Total available — used for pager display without a second request. */
  totalCount: number;
  /** When the store was last refreshed (wall-clock ms). */
  lastRefreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

const initialState: OrdersState = {
  entities: [],
  totalCount: 0,
  lastRefreshedAt: null,
  loading: false,
  error: null,
};

export const OrdersStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((state) => ({
    /** True if the store has never been loaded. UI can fall back to skeleton. */
    isEmpty: computed(() => state.entities().length === 0 && !state.loading()),
  })),
  withMethods((state) => {
    const ordersService = inject(OrdersService);
    const realtime = inject(RealtimeService);

    function loadPage(params: PagerRequest): void {
      patchState(state, { loading: true, error: null });
      ordersService
        .list(params)
        .pipe(
          take(1),
          map((res) => res.data ?? null),
          catchError((err: unknown) => {
            patchState(state, {
              loading: false,
              error: err instanceof Error ? err.message : 'Failed to load orders',
            });
            return of(null);
          }),
        )
        .subscribe((paged) => {
          if (!paged) return;
          patchState(state, {
            entities: paged.data,
            totalCount: paged.pager.totalItemCount,
            lastRefreshedAt: Date.now(),
            loading: false,
          });
        });
    }

    /**
     * Patches a single order in-place — e.g. after an optimistic cancel.
     * When the server confirms, the next `loadPage` reconciles.
     */
    function upsert(order: OrderDto): void {
      const idx = state.entities().findIndex((o) => o.id === order.id);
      const next = [...state.entities()];
      if (idx >= 0) next[idx] = order;
      else next.unshift(order);
      patchState(state, { entities: next });
    }

    /**
     * Wires SignalR push events to store refresh. Call from a component's
     * constructor to tie the subscription lifetime to that component. Not
     * auto-started because not every consumer wants the hub wired (tests,
     * read-only screens, etc.).
     */
    function bindRealtime(): void {
      realtime
        .on('orderCreated')
        .pipe(takeUntilDestroyed())
        .subscribe(() => markStale());
      realtime
        .on('orderFilled')
        .pipe(takeUntilDestroyed())
        .subscribe(() => markStale());
    }

    function markStale(): void {
      // The consumer decides how to reload — most just call loadPage with the
      // last-known pager. We don't hold the pager in the store because each
      // page has its own filter/sort context.
      patchState(state, { lastRefreshedAt: Date.now() - 999_999 });
    }

    return { loadPage, upsert, bindRealtime };
  }),
);
