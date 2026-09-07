import { Injectable, signal } from '@angular/core';

/**
 * Toggles "wall mode" for display on a trading floor wall / control-room monitor.
 *
 * <p>NOTE ON SCOPE — this hides nothing. It requests browser fullscreen and auto-collapses
 * the sidebar (see `LayoutComponent`); the header, breadcrumbs and the collapsed sidebar all
 * stay on screen so the operator keeps navigation. It once hid that chrome, and this comment
 * outlived the change: it later cost a debugging session, because a screenshot showing the
 * header was read as proof that wall mode was OFF. If you narrow or widen what wall mode
 * does, correct this paragraph in the same commit.</p>
 *
 * Persisted to localStorage so a planned refresh (or accidental F5)
 * doesn't kick the screen back into windowed-app mode.
 */
@Injectable({ providedIn: 'root' })
export class WallModeService {
  private static readonly STORAGE_KEY = 'lascodia.wallMode';

  readonly enabled = signal<boolean>(this.readPersisted());

  toggle(): void {
    this.set(!this.enabled());
  }

  enable(): void {
    this.set(true);
  }

  disable(): void {
    this.set(false);
  }

  /**
   * Persist + apply browser fullscreen as a best-effort. The fullscreen
   * API is only callable from a user-gesture handler; we ignore failures
   * (some browsers block it on iframes / programmatic clicks).
   */
  private set(next: boolean): void {
    this.enabled.set(next);
    try {
      localStorage.setItem(WallModeService.STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* localStorage may be unavailable (private mode, quota) */
    }
    if (next) {
      this.requestFullscreen();
    } else {
      this.exitFullscreen();
    }
  }

  private readPersisted(): boolean {
    try {
      return localStorage.getItem(WallModeService.STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private requestFullscreen(): void {
    const el = document.documentElement;
    const req = (el as any).requestFullscreen ?? (el as any).webkitRequestFullscreen;
    if (typeof req === 'function') {
      try {
        const result = req.call(el);
        if (result?.catch) result.catch(() => {});
      } catch {
        /* ignore — wall mode still works without fullscreen */
      }
    }
  }

  private exitFullscreen(): void {
    if (!document.fullscreenElement) return;
    const exit = (document as any).exitFullscreen ?? (document as any).webkitExitFullscreen;
    if (typeof exit === 'function') {
      try {
        const result = exit.call(document);
        if (result?.catch) result.catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }
}
