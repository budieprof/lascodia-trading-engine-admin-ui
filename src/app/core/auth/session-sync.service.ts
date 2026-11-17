import { Injectable, OnDestroy, inject } from '@angular/core';

import { BrowserLocation } from '@core/browser/browser-location';
import { NotificationService } from '@core/notifications/notification.service';
import { BffSessionService } from './bff-session.service';
import { appStorage, LAST_TENANT_KEY } from '@core/storage/app-storage';

/** The channel every console tab of this origin listens on. */
export const SESSION_CHANNEL = 'lascodia-session';

/** How long the "reloading" notice stays on screen before the reload. */
export const TENANT_CHANGED_RELOAD_DELAY_MS = 1200;

/** What one tab tells the others about the shared (cookie) session. */
export type SessionSyncMessage =
  | { type: 'tenant-switched'; tenantId: number; userId: number | null }
  | { type: 'signed-out' };

export const TENANT_CHANGED_NOTICE = 'Your organisation changed in another tab — reloading.';

/**
 * How long after asking for the reload this tab assumes it was cancelled (the operator chose "Stay"
 * on an unsaved-changes prompt). A real reload tears the page down long before this fires.
 */
export const TENANT_RELOAD_CANCELLED_AFTER_MS = 5000;

export const TENANT_RELOAD_CANCELLED_NOTICE =
  'This tab still shows your previous organisation, so it cannot save anything. Copy any unsaved ' +
  'work, then reload the page.';

/**
 * Keeps every tab of the console on the session the cookie actually carries (BFF mode).
 *
 * The BFF session is ONE cookie shared by every tab: switching organisation (or signing out) in one
 * tab changes it for all of them, while the others still show — and would write against — the
 * previous organisation's pages. Two independent defences:
 *  1. this channel: the tab that switches or signs out tells the others, which reload (switch) or go
 *     to the sign-in page (sign-out);
 *  2. `X-Lascodia-Expected-Tenant` on every engine API call ({@link expectedTenantInterceptor}): a tab
 *     that missed the message (no BroadcastChannel, asleep) is refused by the engine with HTTP 409
 *     `-409-tenant-changed` and reloads through {@link tenantChangedElsewhere}.
 *
 * Deliberately independent of AuthService (which injects this), so the two never form a cycle.
 */
@Injectable({ providedIn: 'root' })
export class SessionSyncService implements OnDestroy {
  private readonly bff = inject(BffSessionService);
  private readonly browser = inject(BrowserLocation);
  private readonly notify = inject(NotificationService);

  private channel: BroadcastChannel | null = null;
  /** Set once a reload / sign-in navigation is under way, so a burst of signals acts once. */
  private leaving = false;

  /** Starts listening (idempotent). A browser without BroadcastChannel relies on the 409 path. */
  start(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    try {
      this.channel = new BroadcastChannel(SESSION_CHANNEL);
    } catch {
      return;
    }
    this.channel.onmessage = (e: MessageEvent) => this.receive(e.data);
  }

  /** This tab moved the session to `tenantId`; the others must not keep acting in the old one. */
  announceTenantSwitch(tenantId: number, userId: number | null): void {
    this.rememberTenant(tenantId);
    this.post({ type: 'tenant-switched', tenantId, userId });
  }

  /**
   * The session this load started with. When the browser last ran the console in a different
   * organisation, the switch happened without an announcement (a step-up sign-in finishes it on a
   * fresh load), so announce it now; tabs already in this organisation ignore it.
   */
  noteSessionAtStartup(tenantId: number, userId: number | null): void {
    let last: string | null = null;
    try {
      last = appStorage.getItem(LAST_TENANT_KEY);
    } catch {
      /* storage unavailable: the 409 path still protects the other tabs */
    }
    this.rememberTenant(tenantId);
    if (last !== null && last !== String(tenantId))
      this.post({ type: 'tenant-switched', tenantId, userId });
  }

  /**
   * This tab is leaving on purpose (it switched organisation or signed out). Its own in-flight
   * requests may come back 409 for the old organisation; that is not "changed in another tab", and a
   * reload must not race the navigation already under way (review 2026-11-17).
   */
  markLeaving(leaving = true): void {
    this.leaving = leaving;
  }

  private rememberTenant(tenantId: number): void {
    try {
      appStorage.setItem(LAST_TENANT_KEY, String(tenantId));
    } catch {
      /* best effort */
    }
  }

  /** This tab ended the session; the others go to the sign-in page. */
  announceSignOut(): void {
    this.post({ type: 'signed-out' });
  }

  /**
   * The engine refused a call because the session's organisation is no longer the one this tab
   * shows (HTTP 409 `-409-tenant-changed`). Says so, then reloads once.
   */
  tenantChangedElsewhere(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.notify.warning(TENANT_CHANGED_NOTICE);
    setTimeout(() => {
      this.browser.reload();
      // Still here: the reload was cancelled (unsaved-changes prompt → Stay). Say what that means,
      // and re-arm so the next refused write says it again instead of failing silently
      // (review 2026-11-17: `leaving` used to latch for the life of the tab).
      setTimeout(() => {
        this.leaving = false;
        this.notify.error(TENANT_RELOAD_CANCELLED_NOTICE);
      }, TENANT_RELOAD_CANCELLED_AFTER_MS);
    }, TENANT_CHANGED_RELOAD_DELAY_MS);
  }

  /** Exposed for tests: handles one message from another tab. */
  receive(data: unknown): void {
    const msg = data as Partial<SessionSyncMessage> | null;
    if (!msg || typeof msg !== 'object') return;
    const current = this.bff.session();
    if (msg.type === 'tenant-switched') {
      // Nothing to protect on a signed-out tab, and nothing to do if it already shows that one.
      if (!current || typeof msg.tenantId !== 'number') return;
      if (current.activeTenant?.id === msg.tenantId) return;
      this.tenantChangedElsewhere();
      return;
    }
    if (msg.type === 'signed-out') {
      if (!current || this.leaving) return;
      this.leaving = true;
      this.bff.clear();
      // A full navigation, not the router: nothing of the ended session may stay in memory.
      this.browser.assign('/login');
    }
  }

  ngOnDestroy(): void {
    this.channel?.close();
    this.channel = null;
  }

  private post(msg: SessionSyncMessage): void {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* channel closed: the 409 path still protects the other tabs */
    }
  }
}
