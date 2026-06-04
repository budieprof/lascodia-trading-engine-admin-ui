import { Component, computed, input, output, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ThemeService } from '@core/theme/theme.service';
import { AuthService, type Role } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { HoverPreloadingStrategy } from '@core/routing/hover-preloading.strategy';

interface NavItem {
  label: string;
  route: string;
  icon: string;
  /**
   * Required policy for this item. When set, the sidebar hides it for users
   * whose token doesn't satisfy the policy. Tokens without any role claim
   * (the dev `/auth/token` path) see everything; see
   * `AuthService.hasPolicy` for the full cascade.
   */
  policy?: Role;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <aside class="sidebar" [class.collapsed]="collapsed()" aria-label="Primary navigation">
      <div class="sidebar-header">
        <div class="logo" aria-hidden="true">L</div>
        @if (!collapsed()) {
          <span class="logo-text">Lascodia</span>
        }
      </div>

      <nav class="sidebar-nav" aria-label="Primary">
        <!-- Dashboard -->
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

        @for (group of visibleGroups(); track group.label) {
          @if (!collapsed()) {
            <div class="nav-group-label" role="heading" aria-level="2">{{ group.label }}</div>
          } @else {
            <div class="nav-divider" role="separator"></div>
          }
          @for (item of group.items; track item.route) {
            <a
              [routerLink]="item.route"
              routerLinkActive="active"
              ariaCurrentWhenActive="page"
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
        <a
          class="footer-btn"
          [href]="swaggerUrl"
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
          <span class="nav-icon" aria-hidden="true">{{ collapsed() ? '▸' : '◂' }}</span>
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

      .logo {
        width: 32px;
        height: 32px;
        min-width: 32px;
        background: var(--accent);
        color: white;
        border-radius: var(--radius-sm);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        font-weight: 700;
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

  navGroups: NavGroup[] = [
    {
      label: 'Trading',
      items: [
        { label: 'Orders', route: '/orders', icon: '📋' },
        { label: 'Positions', route: '/positions', icon: '📊' },
        { label: 'Position Deltas', route: '/positions/deltas', icon: '🔄' },
        { label: 'Trade Signals', route: '/trade-signals', icon: '⚡' },
        { label: 'Signal Sensitivity', route: '/signal-sensitivity', icon: '🎛' },
        { label: 'Signal Exits', route: '/trade-signals/feedback', icon: '📨' },
        { label: 'Signal Rejections', route: '/rejections', icon: '🚫' },
        { label: 'Market Data', route: '/market-data', icon: '📈' },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { label: 'Strategies', route: '/strategies', icon: '🎯' },
        {
          label: 'Strategy Settings',
          route: '/strategies/settings',
          icon: '⚙',
          policy: 'Operator',
        },
        { label: 'Accounts', route: '/trading-accounts', icon: '🏦' },
        { label: 'Brokers', route: '/brokers', icon: '🔗' },
        { label: 'Risk Profiles', route: '/risk-profiles', icon: '🛡' },
        { label: 'Currency Pairs', route: '/currency-pairs', icon: '💱' },
        { label: 'Alerts', route: '/alerts', icon: '🔔' },
      ],
    },
    {
      label: 'ML & Optimization',
      items: [
        { label: 'ML Models', route: '/ml-models', icon: '🧠' },
        { label: 'Training Queue', route: '/ml-models/training-queue', icon: '⏳' },
        { label: 'CompositeML', route: '/composite-ml', icon: '🧩' },
        { label: 'Drift Report', route: '/drift-report', icon: '📊' },
        { label: 'Optimizations', route: '/optimizations', icon: '🧪', policy: 'Analyst' },
        { label: 'Backtesting', route: '/backtests', icon: '📈', policy: 'Analyst' },
        { label: 'Walk-Forward', route: '/walk-forward', icon: '🔄', policy: 'Analyst' },
      ],
    },
    {
      label: 'LLM',
      items: [
        { label: 'Proposals', route: '/strategies/llm-proposals', icon: '💡' },
        { label: 'Spot Analysis', route: '/spot-analysis', icon: '📊' },
        { label: 'Spot Sweep', route: '/spot-sweep', icon: '🛰' },
        { label: 'Analyser Comparison', route: '/analyser-comparison', icon: '🆚' },
        {
          label: 'Look-ahead Audit',
          route: '/analyser-comparison/audit',
          icon: '🔎',
          policy: 'Operator',
        },
        { label: 'Invocations', route: '/llm/invocations', icon: '📡' },
        { label: 'Rationales', route: '/llm/rationales', icon: '🗒' },
        { label: 'Settings', route: '/llm/settings', icon: '🔑', policy: 'Operator' },
      ],
    },
    {
      label: 'Analysis',
      items: [
        { label: 'Performance', route: '/performance', icon: '📉' },
        { label: 'Execution Quality', route: '/execution-quality', icon: '⏱' },
        { label: 'Sentiment', route: '/sentiment', icon: '📰' },
        { label: 'Ensemble', route: '/strategy-ensemble', icon: '⚖' },
        { label: 'Portfolio', route: '/strategy-portfolio', icon: '🥧' },
        { label: 'Compare', route: '/strategies/compare', icon: '🆚' },
        { label: 'Generation', route: '/strategy-generation', icon: '🧬' },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Engine Overview', route: '/engine-overview', icon: '🩺' },
        { label: 'Fleet Health', route: '/fleet-health', icon: '📊', policy: 'Operator' },
        { label: 'Health', route: '/system-health', icon: '💚' },
        { label: 'Logs', route: '/system-logs', icon: '📝' },
        { label: 'Worker Health', route: '/worker-health', icon: '⚡' },
        { label: 'EA Instances', route: '/ea-instances', icon: '🛰' },
        { label: 'Terminals', route: '/terminals', icon: '🖥', policy: 'Operator' },
        { label: 'Config', route: '/engine-config', icon: '⚙', policy: 'Operator' },
        { label: 'Audit Trail', route: '/audit-trail', icon: '📜' },
        { label: 'Drawdown', route: '/drawdown-recovery', icon: '📉' },
        { label: 'Paper Trading', route: '/paper-trading', icon: '🧪', policy: 'Operator' },
        { label: 'Economic Events', route: '/economic-events', icon: '📅' },
      ],
    },
    {
      label: 'Ops',
      items: [
        { label: 'Alert Triage', route: '/alert-triage', icon: '🚨' },
        {
          label: 'Automation Monitor',
          route: '/automation-monitor',
          icon: '🤖',
          policy: 'Operator',
        },
        { label: 'Kill Switches', route: '/kill-switches', icon: '⛔', policy: 'Operator' },
        { label: 'Dead Letters', route: '/dead-letter', icon: '✉', policy: 'Operator' },
        { label: 'Tuning', route: '/calibration', icon: '🎚' },
        { label: 'Operator Roles', route: '/operator-roles', icon: '🔐', policy: 'Admin' },
      ],
    },
  ];

  readonly swaggerUrl = `${inject(RUNTIME_CONFIG).apiBaseUrl.replace(/\/$/, '')}/swagger`;

  /**
   * Filters the nav groups down to what the current user is allowed to see.
   * Groups whose items all get filtered away are dropped entirely so empty
   * section headers don't linger in the sidebar.
   */
  readonly visibleGroups = computed<NavGroup[]>(() => {
    const groups = this.navGroups
      .map((g) => ({
        ...g,
        items: g.items.filter((item) => !item.policy || this.auth.hasPolicy(item.policy)),
      }))
      .filter((g) => g.items.length > 0);
    return groups;
  });

  onToggleTheme() {
    this.themeService.toggle();
  }
}
