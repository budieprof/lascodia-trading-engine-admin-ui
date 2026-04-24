import { Injectable } from '@angular/core';
import { PreloadingStrategy, Route } from '@angular/router';
import { Observable, Subject, filter, map, of } from 'rxjs';

/**
 * Custom preloading strategy — doesn't preload anything on boot. Instead,
 * exposes a `prime(path)` method that feature-layout components call on link
 * hover / focus. The matched route is queued; Angular evaluates that set on
 * the next navigation cycle and starts fetching the lazy chunks.
 *
 * Why not `PreloadAllModules`? The app has ~30 lazy chunks; preloading all of
 * them on boot adds MBs of requests and masks real usage patterns. Hover
 * intent is a better signal.
 *
 * Why not `provideRouter(..., withPreloading(PreloadAllModules))` behind a
 * feature flag? That still costs the whole prefetch up-front. Hover gets us
 * "feels instant the second time" at a fraction of the cost.
 */
@Injectable({ providedIn: 'root' })
export class HoverPreloadingStrategy implements PreloadingStrategy {
  private readonly primed = new Set<string>();
  private readonly prime$ = new Subject<string>();

  preload(route: Route, load: () => Observable<unknown>): Observable<unknown> {
    const path = route.path ?? '';
    // Fast path: if the route was already primed before the strategy saw it,
    // preload immediately.
    if (this.primed.has(path)) return load();

    // Otherwise wait for a future prime matching this path. Use a snapshot-
    // only subscription so GC eventually clears the subject subscription.
    return this.prime$.pipe(
      filter((p) => p === path),
      map(() => undefined),
      // Trigger the real load as soon as we hear a matching prime.
      // We return the inner observable so Angular's preloader awaits it.
      map(() => load()),
      // If never primed, this observable simply never emits — that's fine;
      // the chunk will load on-demand when the user navigates.
    ) as Observable<unknown>;
  }

  /**
   * Called by sidebar / link components on hover or focus. A hit starts the
   * route chunk downloading; a miss is harmless.
   */
  prime(path: string): void {
    const normalized = path.replace(/^\//, '').split('/')[0];
    if (!normalized || this.primed.has(normalized)) return;
    this.primed.add(normalized);
    this.prime$.next(normalized);
  }
}

// Convenience re-export for the rare caller that wants to just fire and
// forget without injecting. Rare because preloading is tied to the router.
export function noop(): Observable<unknown> {
  return of(undefined);
}
