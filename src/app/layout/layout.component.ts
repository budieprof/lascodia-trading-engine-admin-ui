import { Component, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { SidebarComponent } from './sidebar/sidebar.component';
import { HeaderComponent } from './header/header.component';
import { BreadcrumbsComponent } from './breadcrumbs/breadcrumbs.component';
import { OfflineBannerComponent } from '@shared/components/feedback/offline-banner.component';
import { RealtimeStatusBannerComponent } from '@shared/components/feedback/realtime-status-banner.component';
import { PaperModeBannerComponent } from '@shared/components/feedback/paper-mode-banner.component';
import { KillSwitchBannerComponent } from '@shared/components/feedback/kill-switch-banner.component';
import { RateLimitStripComponent } from '@shared/components/feedback/rate-limit-strip.component';
import { CommandPaletteComponent } from '@shared/components/command-palette/command-palette.component';
import { KeyboardHelpComponent } from '@shared/components/keyboard-help/keyboard-help.component';
import { KeyboardShortcutsService } from '@core/keyboard/keyboard-shortcuts.service';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [
    RouterOutlet,
    SidebarComponent,
    HeaderComponent,
    BreadcrumbsComponent,
    OfflineBannerComponent,
    RealtimeStatusBannerComponent,
    PaperModeBannerComponent,
    KillSwitchBannerComponent,
    RateLimitStripComponent,
    CommandPaletteComponent,
    KeyboardHelpComponent,
  ],
  template: `
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <div
      class="layout"
      [class.sidebar-collapsed]="sidebarCollapsed()"
      [class.mobile-nav-open]="mobileNavOpen()"
    >
      @if (mobileNavOpen()) {
        <button
          type="button"
          class="mobile-scrim"
          aria-label="Close navigation"
          (click)="mobileNavOpen.set(false)"
        ></button>
      }
      <app-sidebar
        [collapsed]="sidebarCollapsed()"
        (toggleCollapse)="sidebarCollapsed.set(!sidebarCollapsed())"
      />
      <div class="main-area">
        <app-offline-banner />
        <app-realtime-status-banner />
        <app-kill-switch-banner />
        <app-paper-mode-banner />
        <app-header (openMobileNav)="mobileNavOpen.set(true)" />
        <app-rate-limit-strip />
        <main id="main-content" class="content" tabindex="-1">
          <app-breadcrumbs />
          <router-outlet />
        </main>
      </div>
      <app-command-palette />
      <app-keyboard-help />
    </div>
  `,
  styles: [
    `
      .skip-link {
        position: absolute;
        top: -100px;
        left: var(--space-4);
        z-index: 2000;
        padding: 10px var(--space-4);
        background: var(--accent);
        color: white;
        border-radius: var(--radius-sm);
        font-weight: var(--font-semibold);
        text-decoration: none;
        box-shadow: var(--shadow-lg);
        transition: top 0.15s ease;
      }
      .skip-link:focus {
        top: var(--space-3);
      }

      .layout {
        display: flex;
        min-height: 100vh;
        background: var(--bg-primary);
      }

      .main-area {
        flex: 1;
        margin-left: var(--sidebar-width);
        transition: margin-left 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .sidebar-collapsed .main-area {
        margin-left: var(--sidebar-collapsed);
      }

      .content {
        flex: 1;
        padding: var(--space-6) var(--space-8);
        max-width: var(--content-max-width);
        width: 100%;
        margin: 0 auto;
      }
      .content:focus {
        outline: none;
      }

      .mobile-scrim {
        display: none;
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(2px);
        border: none;
        padding: 0;
        margin: 0;
        z-index: 95;
        cursor: pointer;
        animation: scrimIn 0.15s ease-out;
      }

      @media (max-width: 1024px) {
        .main-area {
          margin-left: var(--sidebar-collapsed);
        }
      }

      @media (max-width: 768px) {
        .main-area {
          margin-left: 0;
        }

        .content {
          padding: var(--space-4);
        }

        .mobile-nav-open .mobile-scrim {
          display: block;
        }

        :host ::ng-deep .mobile-nav-open app-sidebar .sidebar {
          transform: translateX(0);
          width: min(280px, 90vw);
          box-shadow: var(--shadow-lg);
          z-index: 100;
        }
      }

      @keyframes scrimIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
    `,
  ],
})
export class LayoutComponent {
  sidebarCollapsed = signal(false);
  mobileNavOpen = signal(false);
  // Inject eagerly so the global keydown listener starts on layout init.
  private readonly _shortcuts = inject(KeyboardShortcutsService);
  private readonly router = inject(Router);

  constructor() {
    // Close the mobile drawer on any navigation.
    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.mobileNavOpen.set(false));
  }
}
