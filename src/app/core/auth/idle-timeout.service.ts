import { Injectable, inject } from '@angular/core';

import { NotificationService } from '@core/notifications/notification.service';
import { appStorage } from '@core/storage/app-storage';

/**
 * Last activity in ANY tab of this browser (epoch ms). The BFF session cookie is shared by every
 * tab, so signing out for inactivity in one tab signs all of them out — idleness must therefore be
 * judged across tabs, not per tab. Global (not per person): see `GLOBAL_STORAGE_KEYS`.
 */
export const IDLE_ACTIVITY_KEY = 'lascodia.idle.lastActivity';

/** How often idleness is checked. */
export const IDLE_CHECK_MS = 15_000;
/** Activity is written to storage at most this often. */
const WRITE_THROTTLE_MS = 15_000;
/** Warn this long before signing out. */
export const IDLE_WARNING_MS = 60_000;

/**
 * Signs the console out after the organisation's idle timeout (`/bff/session` →
 * `idleTimeoutSeconds`, from its security policy) without pointer, keyboard, scroll or touch
 * activity. On only with `bffAuth`; the legacy session keeps its own (disabled) watcher.
 *
 * Background polling does not count as activity — that is the point: the engine's own idle check
 * sees the console's pollers as traffic and never fires while a tab is open, so the person-level
 * timeout has to live here.
 */
@Injectable({ providedIn: 'root' })
export class IdleTimeoutService {
  private readonly notify = inject(NotificationService);

  private timeoutMs = 0;
  private onIdle: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastLocal = Date.now();
  private lastWritten = 0;
  private warned = false;
  private listenersBound = false;

  private readonly onActivity = (): void => {
    if (this.timer === null) return;
    this.touch(Date.now());
  };

  private readonly onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') this.onActivity();
  };

  /** Starts (or re-arms) the watcher. Idempotent. */
  start(timeoutSeconds: number, onIdle: () => void): void {
    if (!(timeoutSeconds > 0)) {
      this.stop();
      return;
    }
    this.timeoutMs = timeoutSeconds * 1000;
    this.onIdle = onIdle;
    this.warned = false;
    this.bindListeners();
    this.touch(Date.now(), true);
    if (this.timer === null) this.timer = setInterval(() => this.check(), IDLE_CHECK_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onIdle = null;
    this.warned = false;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** One check (exposed for tests; the interval calls it). */
  check(now = Date.now()): void {
    if (this.timer === null || !this.onIdle) return;
    const last = Math.max(this.lastLocal, this.sharedLastActivity());
    const idleFor = now - last;
    if (idleFor >= this.timeoutMs) {
      const onIdle = this.onIdle;
      this.stop();
      onIdle();
      return;
    }
    if (!this.warned && idleFor >= this.timeoutMs - IDLE_WARNING_MS) {
      this.warned = true;
      this.notify.warning(
        'You will be signed out in about a minute because of inactivity. Move the mouse or press a key to stay signed in.',
      );
    }
  }

  private touch(now: number, force = false): void {
    this.lastLocal = now;
    this.warned = false;
    if (!force && now - this.lastWritten < WRITE_THROTTLE_MS) return;
    this.lastWritten = now;
    try {
      appStorage.setItem(IDLE_ACTIVITY_KEY, String(now));
    } catch {
      /* storage blocked: this tab's own clock still applies */
    }
  }

  private sharedLastActivity(): number {
    const v = Number(appStorage.getItem(IDLE_ACTIVITY_KEY));
    return Number.isFinite(v) ? v : 0;
  }

  private bindListeners(): void {
    if (this.listenersBound || typeof window === 'undefined') return;
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(ev, this.onActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    this.listenersBound = true;
  }
}
