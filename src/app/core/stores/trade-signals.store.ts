import { computed, inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState } from '@ngrx/signals';
import { catchError, map, of, take } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { TradeSignalsService } from '@core/services/trade-signals.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { TradeSignalDto, PagerRequest } from '@core/api/api.types';

export interface TradeSignalsState {
  entities: TradeSignalDto[];
  totalCount: number;
  lastRefreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

const initialState: TradeSignalsState = {
  entities: [],
  totalCount: 0,
  lastRefreshedAt: null,
  loading: false,
  error: null,
};

/**
 * Shared trade-signal state. Same rationale as orders.store / positions.store —
 * dashboard "pending signals" tile, signals list, and any inline-approve
 * widget all read from here. SignalR `tradeSignalCreated` pushes trigger
 * refresh so a freshly-published signal appears everywhere simultaneously.
 */
export const TradeSignalsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((state) => ({
    isEmpty: computed(() => state.entities().length === 0 && !state.loading()),
    pendingCount: computed(() => state.entities().filter((s) => s.status === 'Pending').length),
  })),
  withMethods((state) => {
    const signalsService = inject(TradeSignalsService);
    const realtime = inject(RealtimeService);

    function loadPage(params: PagerRequest): void {
      patchState(state, { loading: true, error: null });
      signalsService
        .list(params)
        .pipe(
          take(1),
          map((res) => res.data ?? null),
          catchError((err: unknown) => {
            patchState(state, {
              loading: false,
              error: err instanceof Error ? err.message : 'Failed to load signals',
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

    function upsert(signal: TradeSignalDto): void {
      const idx = state.entities().findIndex((s) => s.id === signal.id);
      const next = [...state.entities()];
      if (idx >= 0) next[idx] = signal;
      else next.unshift(signal);
      patchState(state, { entities: next });
    }

    function bindRealtime(): void {
      realtime
        .on('tradeSignalCreated')
        .pipe(takeUntilDestroyed())
        .subscribe(() => markStale());
    }

    function markStale(): void {
      patchState(state, { lastRefreshedAt: Date.now() - 999_999 });
    }

    return { loadPage, upsert, bindRealtime };
  }),
);
