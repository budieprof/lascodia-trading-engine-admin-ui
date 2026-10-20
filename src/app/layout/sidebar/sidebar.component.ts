import {
  Component,
  computed,
  input,
  output,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs';
import { ThemeService } from '@core/theme/theme.service';
import { AuthService } from '@core/auth/auth.service';
import { NAV_GROUPS, type NavGroup } from './nav-items';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { HoverPreloadingStrategy } from '@core/routing/hover-preloading.strategy';
import { LogoComponent } from '@shared/components/logo/logo.component';

/**
 * Force emoji presentation on a single-code-point icon. ⚙ ⏸ 🛡 🎛 👁 … default to TEXT
 * presentation unless followed by U+FE0F, and rendered as tiny monochrome glyphs (Strategy
 * Settings read as a dot) beside full-colour neighbours. Harmless on code points that are
 * emoji by default; multi-code-point icons already carry their selector.
 */
function asEmoji(icon: string): string {
  return [...icon].length === 1 ? `${icon}️` : icon;
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, LogoComponent],
  template: `
    <aside class="sidebar" [class.collapsed]="collapsed()" aria-label="Primary navigation">
      <div class="sidebar-header">
        <app-logo [size]="32" [label]="collapsed() ? 'Lascodia' : ''" />
        @if (!collapsed()) {
          <span class="logo-text">Lascodia</span>
        }
      </div>

      <nav class="sidebar-nav" aria-label="Primary">
        <!-- Dashboard -->
        @if (canSeeDashboard()) {
          <a
            routerLink="/dashboard"
            routerLinkActive="active"
            ariaCurrentWhenActive="page"
            class="nav-item"
            [attr.aria-label]="collapsed() ? 'Dashboard' : null"
            (mouseenter)="showTip('Dashboard', $event)"
            (mouseleave)="hideTip()"
            (focus)="showTip('Dashboard', $event)"
            (blur)="hideTip()"
          >
            <span class="nav-icon" aria-hidden="true">⊞</span>
            @if (!collapsed()) {
              <span class="nav-label">Dashboard</span>
            }
          </a>
        }

        @for (group of visibleGroups(); track group.label) {
          @if (!collapsed()) {
            <div class="nav-group-label" role="heading" aria-level="2">{{ group.label }}</div>
          } @else {
            <div class="nav-divider" role="separator"></div>
          }
          @for (item of group.items; track item.route) {
            <!--
              Not routerLinkActive: its prefix match lit two items at once (Positions AND Position
              Deltas on /positions/deltas). Only the longest nav route the URL sits under is active.
            -->
            <a
              [routerLink]="item.route"
              [class.active]="activeRoute() === item.route"
              [attr.aria-current]="activeRoute() === item.route ? 'page' : null"
              class="nav-item"
              [attr.aria-label]="collapsed() ? item.label : null"
              (mouseenter)="onItemEnter(item.route, item.label, $event)"
              (mouseleave)="hideTip()"
              (focus)="onItemEnter(item.route, item.label, $event)"
              (blur)="hideTip()"
            >
              <span class="nav-icon" aria-hidden="true">{{ item.icon }}</span>
              @if (!collapsed()) {
                <span class="nav-label">{{ item.label }}</span>
              }
            </a>
          }
        }
      </nav>

      <div class="sidebar-footer">
        @if (swaggerUrl; as swagger) {
          <a
            class="footer-btn"
            [href]="swagger"
            target="_blank"
            rel="noopener noreferrer"
            [attr.aria-label]="'Open API Swagger UI in a new tab'"
            (mouseenter)="showTip('API Swagger', $event)"
            (mouseleave)="hideTip()"
            (focus)="showTip('API Swagger', $event)"
            (blur)="hideTip()"
          >
            <span class="nav-icon" aria-hidden="true">⌘</span>
            @if (!collapsed()) {
              <span class="nav-label">API Swagger</span>
            }
          </a>
        }
        <button
          type="button"
          class="footer-btn"
          (click)="onToggleTheme()"
          [attr.aria-label]="
            themeService.theme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
          "
          (mouseenter)="
            showTip(themeService.theme() === 'dark' ? 'Light mode' : 'Dark mode', $event)
          "
          (mouseleave)="hideTip()"
          (focus)="showTip(themeService.theme() === 'dark' ? 'Light mode' : 'Dark mode', $event)"
          (blur)="hideTip()"
        >
          <span class="nav-icon" aria-hidden="true">{{
            themeService.theme() === 'dark' ? '☀' : '☾'
          }}</span>
          @if (!collapsed()) {
            <span class="nav-label">{{ themeService.theme() === 'dark' ? 'Light' : 'Dark' }}</span>
          }
        </button>
        <button
          type="button"
          class="footer-btn"
          (click)="toggleCollapse.emit()"
          [attr.aria-expanded]="!collapsed()"
          [attr.aria-label]="collapsed() ? 'Expand sidebar' : 'Collapse sidebar'"
          (mouseenter)="showTip(collapsed() ? 'Expand sidebar' : 'Collapse sidebar', $event)"
          (mouseleave)="hideTip()"
          (focus)="showTip(collapsed() ? 'Expand sidebar' : 'Collapse sidebar', $event)"
          (blur)="hideTip()"
        >
          <!-- ▸ / ◂ are SMALL triangles: at 14px they rendered as a dot. -->
          <span class="nav-icon" aria-hidden="true">{{ collapsed() ? '»' : '«' }}</span>
          @if (!collapsed()) {
            <span class="nav-label">Collapse</span>
          }
        </button>
      </div>

      <!--
        Custom hover tooltip for the collapsed sidebar. Positioned with
        position:fixed so it escapes the sidebar's overflow-x:hidden
        (a CSS-only ::after wouldn't render past the right edge). Top is
        set from the hovered element's bounding rect; left tracks the
        collapsed sidebar width via CSS. We render only when the sidebar
        is collapsed AND a tip is active so we don't shadow the visible
        labels in the expanded state.
      -->
      @if (collapsed() && tooltip(); as tip) {
        <div class="nav-tooltip" role="tooltip" [style.top.px]="tip.top">
          {{ tip.label }}
        </div>
      }
    </aside>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: var(--sidebar-width);
        background: var(--bg-secondary);
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        transition: width var(--dur-slow) var(--ease-out-soft);
        z-index: 100;
        overflow-x: hidden;
        overflow-y: auto;
      }

      /* Subtle glass effect in dark mode (PRD §3.1 — Sidebar Navigation). */
      :host-context([data-theme='dark']) .sidebar {
        background: var(--bg-glass);
        backdrop-filter: var(--blur-md);
        -webkit-backdrop-filter: var(--blur-md);
      }

      .sidebar.collapsed {
        width: var(--sidebar-collapsed);
      }

      .sidebar-header {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-5) var(--space-4);
        border-bottom: 1px solid var(--border);
        min-height: 64px;
      }

      app-logo {
        flex: none;
      }

      .logo-text {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        letter-spacing: var(--tracking-tight);
        white-space: nowrap;
      }

      .sidebar-nav {
        flex: 1;
        padding: var(--space-3) var(--space-2);
        overflow-y: auto;
        /* macOS overlay scrollbars hide until scrolled, so on a 1000px-tall window the nav
         * appeared to end at "Spread-Reactive" with twenty more routes below and no cue that
         * they existed. A thin, always-present scrollbar is the cue. */
        scrollbar-width: thin;
        scrollbar-color: var(--border) transparent;
      }
      .sidebar-nav::-webkit-scrollbar {
        width: 6px;
      }
      .sidebar-nav::-webkit-scrollbar-thumb {
        background: var(--border);
        border-radius: var(--radius-full);
      }
      .sidebar-nav::-webkit-scrollbar-thumb:hover {
        background: var(--text-tertiary);
      }

      .nav-group-label {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: var(--space-4) var(--space-3) var(--space-2);
        white-space: nowrap;
      }

      .nav-divider {
        height: 1px;
        background: var(--border);
        margin: var(--space-2) var(--space-3);
      }

      .nav-item {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        height: 36px;
        padding: 0 var(--space-3);
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        text-decoration: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        transition: all 0.15s ease;
        white-space: nowrap;
        cursor: pointer;
        margin-bottom: 1px;
      }

      .nav-item:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      /*
        Tooltip rendered when the sidebar is collapsed and the operator
        hovers a nav item. position:fixed escapes the sidebar's
        overflow:hidden; left tracks the collapsed sidebar width via the
        same CSS variable; transform centres it vertically against the
        hovered element. pointer-events:none so a mouseleave on the item
        immediately fires (the tooltip itself doesn't capture hover).
      */
      .nav-tooltip {
        position: fixed;
        left: calc(var(--sidebar-collapsed) + 6px);
        transform: translateY(-50%);
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        white-space: nowrap;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
        z-index: 200;
        pointer-events: none;
      }
      :host-context([data-theme='dark']) .nav-tooltip {
        background: var(--bg-glass);
        backdrop-filter: var(--blur-md);
        -webkit-backdrop-filter: var(--blur-md);
      }
      .nav-tooltip::before {
        content: '';
        position: absolute;
        top: 50%;
        right: 100%;
        transform: translateY(-50%);
        border: 5px solid transparent;
        border-right-color: var(--border);
      }
      .nav-tooltip::after {
        content: '';
        position: absolute;
        top: 50%;
        right: 100%;
        transform: translate(1px, -50%);
        border: 5px solid transparent;
        border-right-color: var(--bg-primary);
      }

      .nav-item.active {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
      }

      .nav-item:focus-visible,
      .footer-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }

      .nav-icon {
        width: 20px;
        min-width: 20px;
        text-align: center;
        font-size: 14px;
      }

      .nav-label {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .sidebar-footer {
        padding: var(--space-3) var(--space-2);
        border-top: 1px solid var(--border);
      }

      .footer-btn {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-sm);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        white-space: nowrap;
      }

      .footer-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      @media (max-width: 1024px) {
        .sidebar {
          width: var(--sidebar-collapsed);
        }
      }

      @media (max-width: 768px) {
        .sidebar {
          transform: translateX(-100%);
        }
      }
    `,
  ],
})
export class SidebarComponent {
  collapsed = input(false);
  toggleCollapse = output();
  themeService = inject(ThemeService);
  private auth = inject(AuthService);
  private preloader = inject(HoverPreloadingStrategy);

  preload(route: string): void {
    this.preloader.prime(route);
  }

  /**
   * Custom tooltip state for the collapsed sidebar. We can't rely on a
   * CSS-only `::after` because the sidebar uses `overflow-x: hidden` and
   * any pseudo-element extending past the right edge would be clipped.
   * Instead, we capture the hovered element's bounding rect and render a
   * `position: fixed` tooltip pinned to its vertical centre.
   */
  tooltip = signal<{ label: string; top: number } | null>(null);

  showTip(label: string, ev: MouseEvent | FocusEvent) {
    if (!this.collapsed()) {
      this.tooltip.set(null);
      return;
    }
    const target = ev.currentTarget as HTMLElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    this.tooltip.set({ label, top: rect.top + rect.height / 2 });
  }

  hideTip() {
    this.tooltip.set(null);
  }

  /** Combined handler for nav items — preload the route AND surface the tooltip. */
  onItemEnter(route: string, label: string, ev: MouseEvent | FocusEvent) {
    this.preload(route);
    this.showTip(label, ev);
  }

  readonly navGroups: NavGroup[] = NAV_GROUPS;
  readonly canSeeDashboard = computed(() => this.auth.canSeePath('/dashboard'));

  /**
   * Swagger is served by the engine itself, never through Caddy. A release bakes apiBaseUrl ""
   * (same-origin), and "/swagger" then hit Caddy's SPA catch-all: the link reopened the console.
   * Same-origin, it can only resolve on the host itself (the engine's direct port, as in the
   * Caddyfile); through the tunnel there is nothing to link to, so the button is not shown.
   */
  private readonly router = inject(Router);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /**
   * The nav route the current page belongs to: the LONGEST item route the URL equals or sits
   * under (segment boundary), so /positions/deltas lights Position Deltas alone while
   * /strategies/1213 still lights Strategies.
   */
  readonly activeRoute = computed<string | null>(() => {
    const path = (this.url() ?? '').split(/[?#]/)[0];
    let best: string | null = null;
    for (const g of this.visibleGroups()) {
      for (const item of g.items) {
        const r = item.route;
        if ((path === r || path.startsWith(r + '/')) && (!best || r.length > best.length)) best = r;
      }
    }
    return best;
  });

  readonly swaggerUrl: string | null = (() => {
    const base = inject(RUNTIME_CONFIG).apiBaseUrl.replace(/\/$/, '');
    if (base) return `${base}/swagger`;
    const host = typeof location === 'undefined' ? '' : location.hostname;
    return host === 'localhost' || host === '127.0.0.1' ? 'http://localhost:5081/swagger' : null;
  })();

  /**
   * Filters the nav groups down to what the current user is allowed to see — by the route table
   * the guards use (`core/auth/route-access.ts`), so a page shown here is a page that opens.
   * Groups whose items all get filtered away are dropped entirely so empty
   * section headers don't linger in the sidebar.
   */
  readonly visibleGroups = computed<NavGroup[]>(() => {
    const groups = this.navGroups
      .map((g) => ({
        ...g,
        items: g.items
          .filter((item) => this.auth.canSeePath(item.route))
          .map((item) => ({ ...item, icon: asEmoji(item.icon) })),
      }))
      .filter((g) => g.items.length > 0);
    return groups;
  });

  onToggleTheme() {
    this.themeService.toggle();
  }
}
