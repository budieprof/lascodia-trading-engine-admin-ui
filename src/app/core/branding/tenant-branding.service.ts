import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService } from '@core/api/api.service';
import type { ResponseData } from '@core/api/api.types';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import type { TenantBranding } from './branding.types';
import { lighten, readableTextOn } from './branding-colour';

/** The look the console falls back to (and that the sign-in page always keeps). */
export const DEFAULT_TITLE = 'Lascodia Trading Engine';

/**
 * Applies the acting organisation's console look after sign-in (engine multi-tenancy Phase 7, LC.4,
 * `GET /tenant/branding`, `tenant.branding.read`): its name in the sidebar, header and browser title, its
 * logo in the sidebar, its favicon, and its primary colour as the console's accent (`--accent`,
 * `--accent-hover`, `theme-color`). The console shell starts it and clears it when it goes away, so the
 * sign-in page always shows Lascodia. Switching organisation reloads the console, so one load per shell
 * is enough; the branding page calls `refresh()` after a change. Images are fetched with the session's
 * credentials and shown from object URLs (an `<img src>` cannot send a bearer header).
 */
@Injectable({ providedIn: 'root' })
export class TenantBrandingService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly document = inject(DOCUMENT);

  private readonly _branding = signal<TenantBranding | null>(null);
  private readonly _logoUrl = signal<string | null>(null);
  private faviconUrl: string | null = null;
  private originalFavicons:
    | { link: HTMLLinkElement; href: string | null; type: string | null }[]
    | null = null;
  private originalThemeColour: string | null = null;
  private generation = 0;

  /** The organisation's branding (null until loaded, or when the person may not read it). */
  readonly branding = this._branding.asReadonly();

  /** The name to show instead of "Lascodia" — only when the organisation set any branding. */
  readonly displayName = computed(() => {
    const b = this._branding();
    return b?.isCustomised ? b.displayName : null;
  });

  /** An object URL of the organisation's logo, or null for the Lascodia mark. */
  readonly logoUrl = this._logoUrl.asReadonly();

  /** Loads and applies the acting organisation's branding (no-op without `tenant.branding.read`). */
  async start(): Promise<void> {
    if (!this.auth.isAuthenticated() || !this.auth.hasPermission(Permission.TenantBrandingRead))
      return;
    await this.refresh();
  }

  /** Reads the branding again and applies it (after the branding page saved a change). */
  async refresh(): Promise<void> {
    const mine = ++this.generation;
    let branding: TenantBranding | null = null;
    try {
      const res = await firstValueFrom(
        this.api.get<ResponseData<TenantBranding>>('/tenant/branding', { silent: true }),
      );
      branding = res?.status ? (res.data ?? null) : null;
    } catch {
      branding = null; // the platform's look: a missing branding is not worth an error
    }
    if (mine !== this.generation) return;
    await this.apply(branding, mine);
  }

  /** Back to the platform's look (the shell is going away — sign-out). */
  clear(): void {
    this.generation++;
    this._branding.set(null);
    this.setLogo(null);
    this.restoreFavicon();
    this.setAccent(null);
    this.document.title = DEFAULT_TITLE;
  }

  private async apply(branding: TenantBranding | null, mine: number): Promise<void> {
    this._branding.set(branding);
    if (!branding?.isCustomised) {
      this.setLogo(null);
      this.restoreFavicon();
      this.setAccent(null);
      this.document.title = DEFAULT_TITLE;
      return;
    }

    this.document.title = branding.displayName;
    this.setAccent(branding.primaryColor);

    const logo = branding.logo ? await this.api.getBlob('/' + branding.logo.url) : null;
    if (mine !== this.generation) return;
    this.setLogo(logo);

    const favicon = branding.favicon ? await this.api.getBlob('/' + branding.favicon.url) : null;
    if (mine !== this.generation) return;
    if (favicon) this.setFavicon(favicon, branding.favicon!.contentType);
    else this.restoreFavicon();
  }

  private setLogo(blob: Blob | null): void {
    const previous = this._logoUrl();
    if (previous) URL.revokeObjectURL(previous);
    this._logoUrl.set(blob ? URL.createObjectURL(blob) : null);
  }

  private setAccent(colour: string | null): void {
    const root = this.document.documentElement.style;
    const meta = this.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta && this.originalThemeColour === null) this.originalThemeColour = meta.content;
    if (!colour) {
      root.removeProperty('--accent');
      root.removeProperty('--accent-hover');
      root.removeProperty('--accent-contrast');
      if (meta && this.originalThemeColour !== null) meta.content = this.originalThemeColour;
      return;
    }
    root.setProperty('--accent', colour);
    root.setProperty('--accent-hover', lighten(colour));
    root.setProperty('--accent-contrast', readableTextOn(colour));
    if (meta) meta.content = colour;
  }

  private setFavicon(blob: Blob, type: string): void {
    const links = Array.from(this.document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    this.originalFavicons ??= links.map((link) => ({
      link,
      href: link.getAttribute('href'),
      type: link.getAttribute('type'),
    }));
    if (this.faviconUrl) URL.revokeObjectURL(this.faviconUrl);
    this.faviconUrl = URL.createObjectURL(blob);
    for (const link of links) {
      link.href = this.faviconUrl;
      link.type = type;
    }
  }

  private restoreFavicon(): void {
    if (this.originalFavicons) {
      for (const { link, href, type } of this.originalFavicons) {
        if (href === null) link.removeAttribute('href');
        else link.setAttribute('href', href);
        if (type === null) link.removeAttribute('type');
        else link.type = type;
      }
      this.originalFavicons = null;
    }
    if (this.faviconUrl) {
      URL.revokeObjectURL(this.faviconUrl);
      this.faviconUrl = null;
    }
  }
}
