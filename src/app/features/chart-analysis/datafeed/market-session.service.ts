import { Injectable, inject, signal } from '@angular/core';
import { InstrumentsService } from '@core/instruments/instruments.service';
import type { SessionStateDto } from '@core/instruments/instrument.types';

/** Re-read a symbol's session state at least this often while watched (a calendar or a holiday can change). */
const MAX_REFRESH_MS = 15 * 60_000;
/** Read again this long after the engine's next open / close, so the answer is already the new one. */
const AFTER_CHANGE_MS = 2_000;
/** After a failed read, try again after this long. */
const RETRY_MS = 60_000;

/**
 * The engine's session state per symbol (`GET instruments/{symbol}/session-state`, UD08), for the chart legend and the
 * watchlist's symbol details. Read when a symbol is first watched, then again just after the next open / close the
 * engine announced (at most every {@link MAX_REFRESH_MS}) — never on a fast poll — and paused while the tab is hidden
 * (caught up when it shows). `stateOf` is a signal read: undefined until answered, null when the engine serves no
 * state for the symbol (no calendar; an engine without the endpoint).
 */
@Injectable({ providedIn: 'root' })
export class MarketSessionService {
  private readonly instruments = inject(InstrumentsService);
  private readonly states = signal<ReadonlyMap<string, SessionStateDto | null>>(new Map());
  private readonly watchers = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly due = new Map<string, number>();
  private visibilityHooked = false;

  stateOf(symbol: string): SessionStateDto | null | undefined {
    const key = symbol.trim().toUpperCase();
    const map = this.states();
    return map.has(key) ? map.get(key)! : undefined;
  }

  /** Keep `symbol`'s state fresh until the returned function is called. */
  watch(symbol: string): () => void {
    const key = symbol.trim().toUpperCase();
    if (!key) return () => undefined;
    this.hookVisibility();
    const n = (this.watchers.get(key) ?? 0) + 1;
    this.watchers.set(key, n);
    if (n === 1) void this.read(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.watchers.get(key) ?? 1) - 1;
      if (left > 0) {
        this.watchers.set(key, left);
        return;
      }
      this.watchers.delete(key);
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
      this.due.delete(key);
    };
  }

  private async read(key: string): Promise<void> {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    if (typeof document !== 'undefined' && document.hidden) {
      this.due.set(key, Date.now());
      return;
    }
    const state = await this.instruments.sessionState(key);
    if (!this.watchers.has(key)) return;
    this.states.update((m) => new Map(m).set(key, state));
    const now = Date.now();
    const next = [state?.nextOpen, state?.nextClose]
      .map((v) => (v ? Date.parse(v) : Number.NaN))
      .filter((t) => Number.isFinite(t) && t > now);
    const delay = state
      ? Math.min(MAX_REFRESH_MS, ...next.map((t) => t - now + AFTER_CHANGE_MS))
      : RETRY_MS * 5;
    this.schedule(key, Math.max(1_000, delay));
  }

  private schedule(key: string, delay: number): void {
    this.due.set(key, Date.now() + delay);
    this.timers.set(
      key,
      setTimeout(() => void this.read(key), delay),
    );
  }

  private hookVisibility(): void {
    if (this.visibilityHooked || typeof document === 'undefined') return;
    this.visibilityHooked = true;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      const now = Date.now();
      for (const [key, at] of this.due)
        if (at <= now && this.watchers.has(key)) void this.read(key);
    });
  }
}
