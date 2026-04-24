import { Injectable, computed, inject, signal } from '@angular/core';

import { RealtimeService } from '@core/realtime/realtime.service';

export interface PresenceEvent {
  accountId: number;
  routeKey: string;
}

/**
 * Presence tracker — who else is viewing what. Keyed by `routeKey` which
 * callers supply on enter/leave (typically the normalised route path, e.g.
 * `/strategies/42`). Populates from the hub's `presenceJoined` /
 * `presenceLeft` events and invokes `EnterRoom` / `LeaveRoom` on the hub
 * to join/leave rooms.
 *
 * The hub is the single source of truth — the store only caches what it
 * has heard. On disconnect the server broadcasts `presenceLeft` for every
 * room the connection occupied, which naturally drains the local map.
 */
@Injectable({ providedIn: 'root' })
export class PresenceService {
  private readonly realtime = inject(RealtimeService);

  private readonly rooms = signal<Record<string, Set<number>>>({});

  constructor() {
    this.realtime
      .on<PresenceEvent>('presenceJoined')
      .subscribe((ev) => this.add(ev.routeKey, ev.accountId));

    this.realtime
      .on<PresenceEvent>('presenceLeft')
      .subscribe((ev) => this.remove(ev.routeKey, ev.accountId));
  }

  /** Reactive lookup. Returns a signal of the account-ids present in a room. */
  watch(routeKey: string) {
    return computed(() => Array.from(this.rooms()[routeKey] ?? new Set<number>()));
  }

  /** Count of presence in a room as a reactive number — handy for badges. */
  watchCount(routeKey: string) {
    return computed(() => this.rooms()[routeKey]?.size ?? 0);
  }

  /**
   * Called by feature pages on mount. Invokes `EnterRoom` on the hub; soft
   * no-op if the hub is disconnected (the realtime service degrades
   * gracefully — see `RealtimeService.invoke`).
   */
  async enter(routeKey: string): Promise<void> {
    await this.realtime.invoke('EnterRoom', routeKey);
  }

  async leave(routeKey: string): Promise<void> {
    await this.realtime.invoke('LeaveRoom', routeKey);
  }

  private add(routeKey: string, accountId: number): void {
    const current = this.rooms()[routeKey] ?? new Set<number>();
    const next = new Set(current);
    next.add(accountId);
    this.rooms.update((m) => ({ ...m, [routeKey]: next }));
  }

  private remove(routeKey: string, accountId: number): void {
    const current = this.rooms()[routeKey];
    if (!current) return;
    const next = new Set(current);
    next.delete(accountId);
    this.rooms.update((m) => ({ ...m, [routeKey]: next }));
  }
}
