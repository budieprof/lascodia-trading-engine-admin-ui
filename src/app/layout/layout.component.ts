import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SidebarComponent } from './sidebar/sidebar.component';
import { HeaderComponent } from './header/header.component';
import { BreadcrumbsComponent } from './breadcrumbs/breadcrumbs.component';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, HeaderComponent, BreadcrumbsComponent],
  template: `
    <div class="layout" [class.sidebar-collapsed]="sidebarCollapsed()">
      <app-sidebar
        [collapsed]="sidebarCollapsed()"
        (toggleCollapse)="sidebarCollapsed.set(!sidebarCollapsed())"
      />
      <div class="main-area">
        <app-header />
        <main class="content">
          <app-breadcrumbs />
          <router-outlet />
        </main>
      </div>
    </div>
  `,
  styles: [`
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
    }
  `],
})
export class LayoutComponent {
  sidebarCollapsed = signal(false);
}
