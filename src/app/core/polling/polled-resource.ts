import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, Subscription, fromEvent, merge, of } from 'rxjs';
import { auditTime, catchError } from 'rxjs/operators';

import { RealtimeService, type RealtimeEventName } from '@core/realtime/realtime.service';
import { structuralEqual } from '@core/signals/structural-equal';

/**
 * A live resource: first paint comes from one fetch, and everything after that
 * is driven by the engine's SignalR pushes. The interval is a safety net, not
 * the mechanism.
 *
 * Three rules keep a live page from flickering, and all three live here so the
 * ~60 call sites get them for free:
 *
 *  1. `loading` means "nothing to show yet" — it is true only until the first
 *     value lands, and never again. It used to be set on EVERY poll, so the 85
 *     templates that render a skeleton while `loading()` swapped real content
 *     for a skeleton and back on every tick. That was the flicker.
 *     `refreshing` is the separate, subtle signal for background work.
 *
 *  2. A refetch that returns the same data does not notify. The value signal
 *     carries a structural `equal`, so an unchanged payload ends the update
 *     right here instead of re-running every downstream computed and rebuilding
 *     the DOM under it.
 *
 *  3. The previous value survives both errors and in-flight refreshes. The UI
 *     never blanks; a failed refresh leaves the last good data on screen and
 *     only raises `error`.
 *
 * PRD §10 intervals (now fallback cadences — prefer `refreshOn`):
 *   Open positions P&L 15_000 · Live prices 5_000 · System health 15_000
 *   Pending signals 15_000 · Account balance 30_000 · Worker health 30_000
 *   EA heartbeat 15_000
 */
export interface PollOptions<T = unknown> {
  /**
   * Fallback cadence in milliseconds. Set `0` to go fully push-driven (nothing
   * refetches unless `refreshOn` fires or `refresh()` is called). With
   * `refreshOn` set, prefer a slow value — it is only there to heal a missed
   * push or a reconnect gap.
   */
  intervalMs: number;
  /** Optional external gate (e.g. a "tab active" signal). Polling pauses when false. Default: always true. */
  active?: Signal<boolean>;
  /** Run once immediately on start (default true). */
  runImmediately?: boolean;
  /**
   * Engine realtime events that invalidate this resource. Each one triggers a
   * refetch, coalesced by `refreshDebounceMs` so a burst of fills costs one
   * request rather than one per event.
   */
  refreshOn?: readonly RealtimeEventName[];
  /** Coalescing window for `refreshOn` bursts. Default 400 ms. */
  refreshDebounceMs?: number;
  /**
   * Equality used to decide whether a fetched value is actually new. Defaults
   * to a structural compare, which is what stops same-data refetches from
   * repainting the page. Pass a cheaper one for very large payloads.
   */
  equal?: (a: T | null, b: T | null) => boolean;
}

export interface PolledResource<T> {
  readonly value: Signal<T | null>;
  /** True only until the first value arrives. Gate skeletons on this. */
  readonly loading: Signal<boolean>;
  /** True while a background refresh is in flight, after the first paint. */
  readonly refreshing: Signal<boolean>;
  readonly error: Signal<unknown | null>;
  /** Timestamp of the last successful fetch, for "updated 3s ago" chrome. */
  readonly lastUpdated: Signal<number | null>;
  /** Trigger an extra fetch now. Does not reset the interval. */
  refresh(): void;
  /** Stop polling. Resource remains readable. */
  stop(): void;
}

/**
 * Component-scoped live resource. Tears down with the injecting component (via DestroyRef).
 * Pauses on `document.visibilityState === 'hidden'` and when `options.active` is false,
 * and refetches once on becoming visible again so a backgrounded tab catches up.
 * Errors are captured into `.error()`; they neither stop the resource nor clear the data.
 */
export function createPolledResource<T>(
  fetchFn: () => Observable<T>,
  options: PollOptions<T>,
): PolledResource<T> {
  const destroyRef = inject(DestroyRef);
  // Optional so the helper stays usable in tests and non-realtime contexts.
  const realtime = inject(RealtimeService, { optional: true });

  // `T | null` because the value signal starts empty; structuralEqual handles null.
  const areEqual = options.equal ?? structuralEqual<T | null>;
  const value = signal<T | null>(null, { equal: areEqual });
  /**
   * The first fetch has finished, successfully or not. Gating `loading` on
   * "settled" rather than "has a value" matters: a first fetch that fails must
   * fall through to the error branch, and gating on has-a-value would leave the
   * skeleton up forever instead.
   */
  const settled = signal(false);
  const refreshing = signal(false);
  const error = signal<unknown | null>(null);
  const lastUpdated = signal<number | null>(null);

  const manualRefresh$ = new Subject<void>();
  const visibility$ = fromEvent(document, 'visibilitychange');
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let inflight: Subscription | null = null;

  const runOnce = () => {
    if (inflight) inflight.unsubscribe();
    // Never re-raise `loading` once we have data — that is the flicker. Only
    // the subtle `refreshing` flag moves on a background fetch.
    refreshing.set(true);
    inflight = fetchFn()
      .pipe(
        catchError((err) => {
          error.set(err);
          return of(null as T | null);
        }),
      )
      .subscribe((result) => {
        if (result !== null) {
          // Identical payload → the custom `equal` makes this a no-op and
          // nothing downstream recomputes.
          value.set(result);
          error.set(null);
          lastUpdated.set(Date.now());
        }
        settled.set(true);
        refreshing.set(false);
      });
  };

  const shouldRun = () => {
    const visible = document.visibilityState !== 'hidden';
    const gateOpen = options.active ? options.active() : true;
    return visible && gateOpen;
  };

  const startInterval = () => {
    if (intervalId !== null || !options.intervalMs) return;
    intervalId = setInterval(() => {
      if (shouldRun()) runOnce();
    }, options.intervalMs);
  };

  const stopInterval = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  merge(visibility$, manualRefresh$)
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(() => {
      if (shouldRun()) {
        runOnce();
        startInterval();
      } else {
        stopInterval();
      }
    });

  // Push-driven invalidation. `auditTime` coalesces a burst (a flurry of fills
  // on one position) into a single refetch on the trailing edge.
  if (realtime && options.refreshOn?.length) {
    merge(...options.refreshOn.map((name) => realtime.on(name)))
      .pipe(auditTime(options.refreshDebounceMs ?? 400), takeUntilDestroyed(destroyRef))
      .subscribe(() => {
        if (shouldRun()) runOnce();
      });
  }

  if (options.runImmediately !== false && shouldRun()) {
    runOnce();
    startInterval();
  }

  destroyRef.onDestroy(() => {
    stopInterval();
    if (inflight) inflight.unsubscribe();
    manualRefresh$.complete();
  });

  return {
    value: computed(() => value()),
    // "Nothing to show yet" — not "a request is in flight".
    loading: computed(() => !settled()),
    refreshing: computed(() => refreshing()),
    error: computed(() => error()),
    lastUpdated: computed(() => lastUpdated()),
    refresh: () => manualRefresh$.next(),
    stop: () => {
      stopInterval();
      if (inflight) inflight.unsubscribe();
    },
  };
}
