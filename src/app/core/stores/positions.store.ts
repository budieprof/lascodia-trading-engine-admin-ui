import { computed, inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState } from '@ngrx/signals';
import { catchError, map, of, take } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { PositionsService } from '@core/services/positions.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { PositionDto, PagerRequest } from '@core/api/api.types';

export interface PositionsState {
  entities: PositionDto[];
  totalCount: number;
  lastRefreshedAt: number | null;
  loading: boolean;
  error: string | null;
}

const initialState: PositionsState = {
  entities: [],
  totalCount: 0,
  lastRefreshedAt: null,
  loading: false,
  error: null,
};

/**
 * Shared position state. See orders.store.ts for the overall rationale — this
 * is the same pattern specialised to positions. Dashboard, positions list,
 * and per-symbol exposure panels all read from here so they can't drift out
 * of sync with one another.
 */
export const PositionsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((state) => ({
    isEmpty: computed(() => state.entities().length === 0 && !state.loading()),
    openCount: computed(() => state.entities().filter((p) => p.status === 'Open').length),
  })),
  withMethods((state) => {
    const positionsService = inject(PositionsService);
    const realtime = inject(RealtimeService);

    function loadPage(params: PagerRequest): void {
      patchState(state, { loading: true, error: null });
      positionsService
        .list(params)
        .pipe(
          take(1),
          map((res) => res.data ?? null),
          catchError((err: unknown) => {
            patchState(state, {
              loading: false,
              error: err instanceof Error ? err.message : 'Failed to load positions',
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

    function upsert(position: PositionDto): void {
      const idx = state.entities().findIndex((p) => p.id === position.id);
      const next = [...state.entities()];
      if (idx >= 0) next[idx] = position;
      else next.unshift(position);
      patchState(state, { entities: next });
    }

    function bindRealtime(): void {
      realtime
        .on('positionOpened')
        .pipe(takeUntilDestroyed())
        .subscribe(() => markStale());
      realtime
        .on('positionClosed')
        .pipe(takeUntilDestroyed())
        .subscribe(() => markStale());
    }

    function markStale(): void {
      patchState(state, { lastRefreshedAt: Date.now() - 999_999 });
    }

    return { loadPage, upsert, bindRealtime };
  }),
);
