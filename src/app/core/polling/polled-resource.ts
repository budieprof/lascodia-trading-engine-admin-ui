import { DestroyRef, Signal, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, Subscription, fromEvent, merge, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';

/**
 * PRD §10 polling intervals — encode these at call sites so future refactors can centralize.
 *
 *   Open positions P&L    — 15_000
 *   Live prices           —  5_000
 *   System health         — 15_000
 *   Pending signals       — 15_000
 *   Account balance       — 30_000
 *   Worker health         — 30_000
 *   EA heartbeat          — 15_000
 */
export interface PollOptions {
  /** Milliseconds between polls. */
  intervalMs: number;
  /** Optional external gate (e.g. a "tab active" signal). Polling pauses when false. Default: always true. */
  active?: Signal<boolean>;
  /** Run once immediately on start (default true). */
  runImmediately?: boolean;
}

export interface PolledResource<T> {
  readonly value: Signal<T | null>;
  readonly loading: Signal<boolean>;
  readonly error: Signal<unknown | null>;
  /** Trigger an extra fetch now. Does not reset the interval. */
  refresh(): void;
  /** Stop polling. Resource remains readable. */
  stop(): void;
}

/**
 * Component-scoped poll. Tears down with the injecting component (via DestroyRef).
 * Pauses on `document.visibilityState === 'hidden'` and when `options.active` is false.
 * Errors are captured into `.error()` signal; they do not stop the poll.
 */
export function createPolledResource<T>(
  fetchFn: () => Observable<T>,
  options: PollOptions,
): PolledResource<T> {
  const destroyRef = inject(DestroyRef);

  const value = signal<T | null>(null);
  const loading = signal(false);
  const error = signal<unknown | null>(null);

  const manualRefresh$ = new Subject<void>();
  const visibility$ = fromEvent(document, 'visibilitychange');
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let inflight: Subscription | null = null;

  const runOnce = () => {
    if (inflight) inflight.unsubscribe();
    loading.set(true);
    inflight = fetchFn()
      .pipe(
        catchError((err) => {
          error.set(err);
          return of(null as T | null);
        }),
      )
      .subscribe((result) => {
        if (result !== null) {
          value.set(result);
          error.set(null);
        }
        loading.set(false);
      });
  };

  const shouldRun = () => {
    const visible = document.visibilityState !== 'hidden';
    const gateOpen = options.active ? options.active() : true;
    return visible && gateOpen;
  };

  const startInterval = () => {
    if (intervalId !== null) return;
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

  // React to visibility and manual refresh.
  merge(visibility$, manualRefresh$)
    .pipe(
      takeUntilDestroyed(destroyRef),
      switchMap(() => {
        if (shouldRun()) {
          runOnce();
          startInterval();
        } else {
          stopInterval();
        }
        return of(null);
      }),
    )
    .subscribe();

  // Initial kick.
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
    loading: computed(() => loading()),
    error: computed(() => error()),
    refresh: () => manualRefresh$.next(),
    stop: () => {
      stopInterval();
      if (inflight) inflight.unsubscribe();
    },
  };
}
