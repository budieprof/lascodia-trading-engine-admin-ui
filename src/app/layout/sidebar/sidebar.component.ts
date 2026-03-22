import { Component, input, output, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ThemeService } from '@core/theme/theme.service';
import { AuthService } from '@core/auth/auth.service';

interface NavItem {
  label: string;
  route: string;
  icon: string;
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
    <aside class="sidebar" [class.collapsed]="collapsed()">
      <div class="sidebar-header">
        <div class="logo">L</div>
        @if (!collapsed()) {
          <span class="logo-text">Lascodia</span>
        }
      </div>

      <nav class="sidebar-nav">
        <!-- Dashboard -->
        <a
          routerLink="/dashboard"
          routerLinkActive="active"
          class="nav-item"
          [title]="collapsed() ? 'Dashboard' : ''"
        >
          <span class="nav-icon">⊞</span>
          @if (!collapsed()) {
            <span class="nav-label">Dashboard</span>
          }
        </a>

        @for (group of navGroups; track group.label) {
          @if (!collapsed()) {
            <div class="nav-group-label">{{ group.label }}</div>
          } @else {
            <div class="nav-divider"></div>
          }
          @for (item of group.items; track item.route) {
            <a
              [routerLink]="item.route"
              routerLinkActive="active"
              class="nav-item"
              [title]="collapsed() ? item.label : ''"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              @if (!collapsed()) {
                <span class="nav-label">{{ item.label }}</span>
              }
            </a>
          }
        }
      </nav>

      <div class="sidebar-footer">
        <button class="footer-btn" (click)="onToggleTheme()" [title]="themeService.theme() === 'dark' ? 'Light mode' : 'Dark mode'">
          <span class="nav-icon">{{ themeService.theme() === 'dark' ? '☀' : '☾' }}</span>
          @if (!collapsed()) {
            <span class="nav-label">{{ themeService.theme() === 'dark' ? 'Light' : 'Dark' }}</span>
          }
        </button>
        <button class="footer-btn" (click)="toggleCollapse.emit()" title="Toggle sidebar">
          <span class="nav-icon">{{ collapsed() ? '▸' : '◂' }}</span>
          @if (!collapsed()) {
            <span class="nav-label">Collapse</span>
          }
        </button>
      </div>
    </aside>
  `,
  styles: [`
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
      transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 100;
      overflow-x: hidden;
      overflow-y: auto;
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

    .nav-item.active {
      background: rgba(0, 113, 227, 0.1);
      color: var(--accent);
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
  `],
})
export class SidebarComponent {
  collapsed = input(false);
  toggleCollapse = output();
  themeService = inject(ThemeService);
  private auth = inject(AuthService);

  navGroups: NavGroup[] = [
    {
      label: 'Trading',
      items: [
        { label: 'Orders', route: '/orders', icon: '📋' },
        { label: 'Positions', route: '/positions', icon: '📊' },
        { label: 'Trade Signals', route: '/trade-signals', icon: '⚡' },
        { label: 'Market Data', route: '/market-data', icon: '📈' },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { label: 'Strategies', route: '/strategies', icon: '🎯' },
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
        { label: 'Backtesting', route: '/backtests', icon: '📈' },
        { label: 'Walk-Forward', route: '/walk-forward', icon: '🔄' },
      ],
    },
    {
      label: 'Analysis',
      items: [
        { label: 'Performance', route: '/performance', icon: '📉' },
        { label: 'Execution Quality', route: '/execution-quality', icon: '⏱' },
        { label: 'Sentiment', route: '/sentiment', icon: '📰' },
        { label: 'Ensemble', route: '/strategy-ensemble', icon: '⚖' },
      ],
    },
    {
      label: 'System',
      items: [
        { label: 'Health', route: '/system-health', icon: '💚' },
        { label: 'Config', route: '/engine-config', icon: '⚙' },
        { label: 'Audit Trail', route: '/audit-trail', icon: '📜' },
        { label: 'Drawdown', route: '/drawdown-recovery', icon: '📉' },
        { label: 'Paper Trading', route: '/paper-trading', icon: '📝' },
      ],
    },
  ];

  onToggleTheme() {
    this.themeService.toggle();
  }
}
