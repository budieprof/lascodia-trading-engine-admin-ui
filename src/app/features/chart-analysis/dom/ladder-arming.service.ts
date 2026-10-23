import { Injectable, computed, signal } from '@angular/core';

/** What one-click trading is armed for: one account, one symbol, live. */
export interface LadderArming {
  accountId: number;
  symbol: string;
  armedAt: number;
}

/**
 * One-click trading from the ladder: an explicit opt-in, per browser session (memory only — never stored, so a reload
 * or a new tab starts DISARMED), for one account and one symbol. Changing either disarms it. Default off; while armed
 * the ladder shows it and every click sends without a confirmation (the engine still runs every check).
 */
@Injectable({ providedIn: 'root' })
export class LadderArmingService {
  private readonly state = signal<LadderArming | null>(null);
  readonly arming = this.state.asReadonly();
  readonly armed = computed(() => this.state() !== null);

  arm(accountId: number, symbol: string): void {
    this.state.set({ accountId, symbol: symbol.toUpperCase(), armedAt: Date.now() });
  }

  disarm(): void {
    this.state.set(null);
  }

  /** Armed for exactly this account and symbol. */
  isArmedFor(accountId: number | null, symbol: string): boolean {
    const a = this.state();
    return !!a && accountId !== null && a.accountId === accountId && a.symbol === symbol.toUpperCase();
  }
}
