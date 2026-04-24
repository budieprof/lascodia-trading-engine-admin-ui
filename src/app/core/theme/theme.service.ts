import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'lascodia.theme';

/**
 * Theme toggle with system-preference fallback and localStorage persistence.
 * Writes `data-theme` on `<html>`; SCSS tokens flip CSS custom properties,
 * [_ag-grid-apple.scss] re-themes ag-grid, and ChartCardComponent swaps
 * between the `lascodia-light` and `lascodia-dark` echarts themes registered
 * at bootstrap. Per-option hex colours inside individual chart definitions
 * still need migrating to CSS-var-driven palettes if full chart re-theming
 * is required.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _theme = signal<Theme>(this.getInitialTheme());
  readonly theme = this._theme.asReadonly();

  constructor() {
    effect(() => {
      const current = this._theme();
      document.documentElement.setAttribute('data-theme', current);
      try {
        localStorage.setItem(STORAGE_KEY, current);
      } catch {
        /* storage unavailable */
      }
    });
  }

  toggle(): void {
    this._theme.update((current) => (current === 'light' ? 'dark' : 'light'));
  }

  setTheme(theme: Theme): void {
    this._theme.set(theme);
  }

  private getInitialTheme(): Theme {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') return stored;
    } catch {
      /* storage unavailable */
    }
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }
}
