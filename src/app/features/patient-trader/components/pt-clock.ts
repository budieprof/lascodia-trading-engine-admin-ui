import { DestroyRef, Signal, inject, signal } from '@angular/core';

/**
 * A wall clock for relative times ("in 2h 10m", "5m ago") and countdowns. Ticks every
 * `intervalMs` and stops with the component. Call in an injection context.
 */
export function injectNow(intervalMs = 30_000): Signal<number> {
  const now = signal(Date.now());
  const id = setInterval(() => now.set(Date.now()), intervalMs);
  inject(DestroyRef).onDestroy(() => clearInterval(id));
  return now.asReadonly();
}
