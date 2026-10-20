import { Injectable } from '@angular/core';

/**
 * Full-document navigation, behind an injectable so auth flows can be tested.
 *
 * <p>The BFF flows leave the app on purpose: signing in and stepping up go to `/bff/login` (then
 * Keycloak), signing out goes to Keycloak's end-session page, and switching organisation reloads
 * the console so no state from the previous organisation survives in memory. The router cannot do
 * any of those.</p>
 */
@Injectable({ providedIn: 'root' })
export class BrowserLocation {
  /** Navigate the whole document (adds a history entry). */
  assign(url: string): void {
    window.location.assign(url);
  }

  /** The path + query + fragment the document is on. */
  currentPath(): string {
    const l = window.location;
    return `${l.pathname}${l.search}${l.hash}`;
  }
}
