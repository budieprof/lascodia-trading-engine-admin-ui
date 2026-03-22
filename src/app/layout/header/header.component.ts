import { Component, inject } from '@angular/core';
import { AuthService } from '@core/auth/auth.service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-header',
  standalone: true,
  template: `
    <header class="header">
      <div class="header-left">
        <h2 class="header-title">Admin Console</h2>
      </div>

      <div class="header-center">
        <button class="search-trigger" (click)="onSearch()">
          <span class="search-icon">⌕</span>
          <span class="search-text">Search...</span>
          <span class="search-shortcut">⌘K</span>
        </button>
      </div>

      <div class="header-right">
        @if (auth.user(); as user) {
          <div class="user-pill">
            <div class="user-avatar">{{ user.firstName.charAt(0) }}{{ user.lastName.charAt(0) }}</div>
            <span class="user-name">{{ user.firstName }}</span>
          </div>
        }
        <button class="logout-btn" (click)="onLogout()" title="Logout">⏻</button>
      </div>
    </header>
  `,
  styles: [`
    .header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 var(--space-6);
      border-bottom: 1px solid var(--border);
      background: var(--bg-primary);
      position: sticky;
      top: 0;
      z-index: 50;
    }

    .header-left {
      flex: 1;
    }

    .header-title {
      font-size: var(--text-base);
      font-weight: var(--font-semibold);
      color: var(--text-primary);
      margin: 0;
    }

    .header-center {
      flex: 1;
      display: flex;
      justify-content: center;
    }

    .search-trigger {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      height: 36px;
      padding: 0 var(--space-4);
      border: 1px solid var(--border);
      border-radius: var(--radius-full);
      background: var(--bg-secondary);
      color: var(--text-tertiary);
      font-size: var(--text-sm);
      font-family: inherit;
      cursor: pointer;
      min-width: 240px;
      transition: all 0.15s ease;
    }

    .search-trigger:hover {
      border-color: var(--accent);
      background: var(--bg-primary);
    }

    .search-icon {
      font-size: 16px;
    }

    .search-text {
      flex: 1;
      text-align: left;
    }

    .search-shortcut {
      font-size: 11px;
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: 4px;
      color: var(--text-secondary);
    }

    .header-right {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-3);
    }

    .user-pill {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      padding: 4px 12px 4px 4px;
      border-radius: var(--radius-full);
      background: var(--bg-secondary);
    }

    .user-avatar {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--accent);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: var(--font-semibold);
    }

    .user-name {
      font-size: var(--text-sm);
      font-weight: var(--font-medium);
      color: var(--text-primary);
    }

    .logout-btn {
      width: 36px;
      height: 36px;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: var(--text-secondary);
      font-size: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }

    .logout-btn:hover {
      background: var(--bg-tertiary);
      color: var(--loss);
    }

    @media (max-width: 768px) {
      .search-trigger {
        min-width: auto;
      }
      .search-text, .search-shortcut {
        display: none;
      }
    }
  `],
})
export class HeaderComponent {
  auth = inject(AuthService);
  private router = inject(Router);

  onSearch() {
    // TODO: Implement global search modal (Cmd+K)
  }

  onLogout() {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
