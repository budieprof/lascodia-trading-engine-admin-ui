import { DestroyRef, Injectable, OnDestroy, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';

export interface ShortcutBinding {
  /** Display label shown in the help overlay. */
  label: string;
  /** Keys combo, e.g. `g d`, `?`. */
  keys: string;
  /** Run when the shortcut fires. */
  action: () => void;
  /** Category for grouping in the help overlay. */
  group: string;
}

const G_PREFIX_TIMEOUT_MS = 900;

/**
 * Lightweight global keyboard shortcuts. Handles:
 *   - `g <letter>` two-key sequences for navigation (g d = dashboard, g o = orders, etc.)
 *   - `?` to toggle the help overlay
 *
 * Shortcuts never fire while the user is typing in an input/textarea/contenteditable.
 * ⌘K is deliberately NOT routed here — it's handled directly by CommandPaletteComponent.
 */
@Injectable({ providedIn: 'root' })
export class KeyboardShortcutsService implements OnDestroy {
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly navMap: Record<string, { route: string; label: string }> = {
    d: { route: '/dashboard', label: 'Dashboard' },
    o: { route: '/orders', label: 'Orders' },
    p: { route: '/positions', label: 'Positions' },
    s: { route: '/strategies', label: 'Strategies' },
    t: { route: '/trade-signals', label: 'Trade Signals' },
    m: { route: '/market-data', label: 'Market Data' },
    l: { route: '/ml-models', label: 'ML Models' },
    b: { route: '/backtests', label: 'Backtests' },
    w: { route: '/walk-forward', label: 'Walk-Forward' },
    e: { route: '/strategy-ensemble', label: 'Ensemble' },
    h: { route: '/system-health', label: 'System Health' },
    k: { route: '/kill-switches', label: 'Kill Switches' },
    u: { route: '/worker-health', label: 'Worker Health' },
    c: { route: '/engine-config', label: 'Engine Config' },
    a: { route: '/audit-trail', label: 'Audit Trail' },
  };

  /** Signal observed by the help overlay component. */
  readonly helpOpen = signal(false);

  private gPending = false;
  private gPendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    fromEvent<KeyboardEvent>(document, 'keydown')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handle(event));
  }

  ngOnDestroy(): void {
    this.clearGPending();
  }

  toggleHelp(): void {
    this.helpOpen.update((v) => !v);
  }
  closeHelp(): void {
    this.helpOpen.set(false);
  }

  /** All declared shortcuts, flattened for the help overlay. */
  get bindings(): ShortcutBinding[] {
    const nav: ShortcutBinding[] = Object.entries(this.navMap).map(([key, { route, label }]) => ({
      keys: `g ${key}`,
      label,
      action: () => this.router.navigateByUrl(route),
      group: 'Navigation',
    }));
    return [
      ...nav,
      {
        keys: '⌘K / Ctrl+K',
        label: 'Command palette',
        action: () => {
          /* palette owns this */
        },
        group: 'Global',
      },
      {
        keys: '?',
        label: 'Show keyboard shortcuts',
        action: () => this.toggleHelp(),
        group: 'Global',
      },
      {
        keys: 'Esc',
        label: 'Close dialogs, palette, help overlay',
        action: () => {
          /* owned by components */
        },
        group: 'Global',
      },
    ];
  }

  private handle(event: KeyboardEvent): void {
    if (shouldIgnore(event)) return;

    // `?` (Shift+/) opens the help overlay.
    if (event.key === '?') {
      event.preventDefault();
      this.toggleHelp();
      return;
    }

    if (event.key === 'Escape' && this.helpOpen()) {
      event.preventDefault();
      this.closeHelp();
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      this.clearGPending();
      return;
    }

    // Two-key `g <letter>` sequence.
    if (this.gPending) {
      const target = this.navMap[event.key.toLowerCase()];
      this.clearGPending();
      if (target) {
        event.preventDefault();
        this.router.navigateByUrl(target.route);
      }
      return;
    }

    if (event.key.toLowerCase() === 'g') {
      this.gPending = true;
      this.gPendingTimer = setTimeout(() => this.clearGPending(), G_PREFIX_TIMEOUT_MS);
    }
  }

  private clearGPending(): void {
    this.gPending = false;
    if (this.gPendingTimer !== null) {
      clearTimeout(this.gPendingTimer);
      this.gPendingTimer = null;
    }
  }
}

function shouldIgnore(event: KeyboardEvent): boolean {
  const t = event.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}
