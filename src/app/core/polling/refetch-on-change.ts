import { effect, untracked } from '@angular/core';

/**
 * Refetch a polled resource when the inputs its fetcher reads change (a lookback pill, a scope,
 * a filter) — but NOT on the effect's first run.
 *
 * The ML and CompositeML pages each had `effect(() => { this.lookback(); this.resource.refresh(); })`.
 * An effect always runs once at start-up, and `createPolledResource` has already fired its own
 * immediate fetch by then, so every page load cancelled its first request and sent it again: the
 * crawler's "FAILED …" entries were those aborts, and the 3 s cold-start report paid for it twice.
 *
 * `debounceMs` coalesces typing in a text filter into one request after the operator pauses.
 * Must be called in an injection context (a constructor or field initializer).
 */
export function refetchOnChange(deps: () => unknown, refresh: () => void, debounceMs = 0): void {
  let first = true;
  effect((onCleanup) => {
    deps();
    if (first) {
      first = false;
      return;
    }
    if (debounceMs <= 0) {
      untracked(refresh);
      return;
    }
    const timer = setTimeout(() => untracked(refresh), debounceMs);
    onCleanup(() => clearTimeout(timer));
  });
}
