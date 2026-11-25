import { Injectable, NgZone, inject, signal } from '@angular/core';

import type { RecExpiryDto } from '../../trade-recommendations.types';

export type RecExpiryTone = 'calm' | 'soon' | 'urgent' | 'ended';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/**
 * One 1-second clock for every countdown on the page — a list of fifty cards shares a single timer instead of
 * running fifty. Starts on first use and keeps running for the app's life (one cheap signal write a second).
 */
@Injectable({ providedIn: 'root' })
export class RecClock {
  private readonly tick = signal(Date.now());
  readonly now = this.tick.asReadonly();

  constructor() {
    inject(NgZone).runOutsideAngular(() => setInterval(() => this.tick.set(Date.now()), 1_000));
  }
}

/** "1d 4h", "3h 12m", "8m", "40s" — the short form for the later clocks and "ago". */
export function shortSpan(ms: number): string {
  const a = Math.abs(ms);
  if (a >= DAY) return `${Math.floor(a / DAY)}d ${Math.floor((a % DAY) / HOUR)}h`;
  if (a >= HOUR) return `${Math.floor(a / HOUR)}h ${Math.floor((a % HOUR) / MIN)}m`;
  if (a >= MIN) return `${Math.floor(a / MIN)}m`;
  return `${Math.max(0, Math.floor(a / 1000))}s`;
}

/** How much of the binding clock's window has gone, 0-100. */
export function expiryElapsedPct(e: RecExpiryDto, now: number): number {
  const from = Date.parse(e.binding.fromUtc);
  const span = Date.parse(e.binding.atUtc) - from;
  if (!(span > 0)) return 100;
  return Math.min(100, Math.max(0, ((now - from) / span) * 100));
}

/** calm → soon (under an hour, or a quarter of the window, left) → urgent (ten minutes) → ended. */
export function expiryTone(e: RecExpiryDto, now: number): RecExpiryTone {
  const left = Date.parse(e.binding.atUtc) - now;
  if (e.state === 'ended' || left <= 0) return 'ended';
  if (left <= 10 * MIN) return 'urgent';
  if (left <= HOUR || 100 - expiryElapsedPct(e, now) <= 25) return 'soon';
  return 'calm';
}
