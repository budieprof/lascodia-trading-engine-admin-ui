import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { appStorage } from '@core/storage/app-storage';

/** What one-click trading is armed for: one account, one symbol, live. */
export interface LadderArming {
  accountId: number;
  symbol: string;
  armedAt: number;
  /** The last ladder interaction (a click, a key, a send) while armed; the idle timeout counts from here. */
  lastActivityAt: number;
}

/** Why one-click was disarmed without the operator asking (shown on the ladder until it is armed again). */
export interface LadderDisarm {
  reason: string;
  at: number;
}

/** UF05: the idle timeout's choices (minutes) and default. */
export const ARM_IDLE_CHOICES: readonly number[] = [1, 2, 5, 10, 15];
export const DEFAULT_ARM_IDLE_MINUTES = 5;
/** Per-person setting (`appStorage` namespaces it by organisation + user). */
export const ARM_IDLE_STORAGE_KEY = 'lascodia.chart.ladderArmIdleMinutes.v1';

/** The ladder lost the account's orders / positions for this long: what it would trade against is stale. */
export const ARM_STRIP_STALE_MS = 30_000;
/** The ladder's book has been gone (no stream, no poll) for this long: its prices are stale. */
export const ARM_BOOK_STALE_MS = 15_000;

/** A stored idle setting, validated: one of {@link ARM_IDLE_CHOICES}, else the default. */
export function restoredIdleMinutes(raw: string | null | undefined): number {
  const n = Number(raw);
  return raw != null && ARM_IDLE_CHOICES.includes(n) ? n : DEFAULT_ARM_IDLE_MINUTES;
}

/** The instant an armed state expires for idleness. */
export function armingExpiresAt(a: Pick<LadderArming, 'lastActivityAt'>, idleMinutes: number): number {
  return a.lastActivityAt + idleMinutes * 60_000;
}

/** What the ladder knows about the armed account and its book (for {@link armingStaleReason}). */
export interface ArmingHealth {
  /** The account is still one with an Active EA (the scope's live accounts) — false once its EA stops. */
  accountLive: boolean;
  /** The account row still says active (`isActive`); null when the row is not known. */
  accountActive: boolean | null;
  /** When the ladder last read the account's orders / positions successfully (ms); null = never since arming. */
  lastStripOkAt: number | null;
  /** Since when the ladder has had no book (no stream, no poll); null = it has one. */
  bookLostSince: number | null;
}

/**
 * UF05: why an armed ladder must disarm now because what it trades against went stale, or null. An armed click
 * sends a LIVE order without a confirmation, so it is only allowed while the account is live and current and the book
 * the click prices from is there.
 */
export function armingStaleReason(a: LadderArming, h: ArmingHealth, now: number): string | null {
  if (h.accountActive === false) return 'the account was deactivated';
  if (!h.accountLive) return 'the account has no active EA any more';
  const lastOk = Math.max(h.lastStripOkAt ?? a.armedAt, a.armedAt);
  if (now - lastOk >= ARM_STRIP_STALE_MS)
    return `the account's orders and positions could not be read for ${Math.round((now - lastOk) / 1000)} s`;
  if (h.bookLostSince !== null && now - h.bookLostSince >= ARM_BOOK_STALE_MS)
    return `the ladder has had no live book for ${Math.round((now - h.bookLostSince) / 1000)} s`;
  return null;
}

/**
 * One-click trading from the ladder: an explicit opt-in, per browser session (memory only — never stored, so a reload
 * or a new tab starts DISARMED), for one account and one symbol. Changing either disarms it. Default off; while armed
 * the ladder shows it and every click sends without a confirmation (the engine still runs every check).
 *
 * UF05: arming EXPIRES — after the idle timeout without a ladder interaction (operator setting, default 5 min), the
 * moment the tab is hidden, and (checked by the ladder, {@link armingStaleReason}) when the account or the book goes
 * stale. The reason of an automatic disarm is kept in {@link lastDisarm} so the ladder can say why.
 */
@Injectable({ providedIn: 'root' })
export class LadderArmingService {
  private readonly doc = inject(DOCUMENT, { optional: true });
  private readonly state = signal<LadderArming | null>(null);
  readonly arming = this.state.asReadonly();
  readonly armed = computed(() => this.state() !== null);
  private readonly disarmed = signal<LadderDisarm | null>(null);
  readonly lastDisarm = this.disarmed.asReadonly();
  private readonly idle = signal(restoredIdleMinutes(readStored()));
  /** The idle timeout in minutes. */
  readonly idleMinutes = this.idle.asReadonly();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const doc = this.doc;
    const onHidden = () => {
      if (doc?.visibilityState === 'hidden') this.expire('the tab was hidden');
    };
    doc?.addEventListener?.('visibilitychange', onHidden);
    inject(DestroyRef).onDestroy(() => {
      doc?.removeEventListener?.('visibilitychange', onHidden);
      clearTimeout(this.timer);
    });
  }

  arm(accountId: number, symbol: string, now = Date.now()): void {
    this.disarmed.set(null);
    this.state.set({ accountId, symbol: symbol.toUpperCase(), armedAt: now, lastActivityAt: now });
    this.schedule(now);
  }

  /** The operator disarmed (or changed account / symbol / mode): no reason is shown. */
  disarm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state.set(null);
  }

  /** Disarm without the operator asking, remembering why. No-op when not armed. */
  expire(reason: string, now = Date.now()): void {
    if (!this.state()) return;
    this.disarm();
    this.disarmed.set({ reason, at: now });
  }

  /** A ladder interaction: restarts the idle timeout (no-op when not armed). */
  touch(now = Date.now()): void {
    const a = this.state();
    if (!a) return;
    this.state.set({ ...a, lastActivityAt: now });
    this.schedule(now);
  }

  /** Expire for idleness if due (also what the timer runs). */
  checkIdle(now = Date.now()): void {
    const a = this.state();
    if (a && now >= armingExpiresAt(a, this.idle()))
      this.expire(`no ladder activity for ${this.idle()} min`, now);
  }

  setIdleMinutes(minutes: number): void {
    const m = restoredIdleMinutes(String(minutes));
    this.idle.set(m);
    try {
      appStorage.setItem(ARM_IDLE_STORAGE_KEY, String(m));
    } catch {
      /* storage full / unavailable: the setting holds for this session */
    }
    const now = Date.now();
    this.checkIdle(now);
    this.schedule(now);
  }

  /** Armed for exactly this account and symbol. */
  isArmedFor(accountId: number | null, symbol: string): boolean {
    const a = this.state();
    return !!a && accountId !== null && a.accountId === accountId && a.symbol === symbol.toUpperCase();
  }

  private schedule(now: number): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const a = this.state();
    if (!a) return;
    const wait = Math.max(0, armingExpiresAt(a, this.idle()) - now);
    this.timer = setTimeout(() => this.checkIdle(), wait + 50);
  }
}

function readStored(): string | null {
  try {
    return appStorage.getItem(ARM_IDLE_STORAGE_KEY);
  } catch {
    return null;
  }
}
