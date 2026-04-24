import { Component, inject, output } from '@angular/core';
import { AuthService } from '@core/auth/auth.service';
import { Router } from '@angular/router';
import { CommandPaletteComponent } from '@shared/components/command-palette/command-palette.component';

@Component({
  selector: 'app-header',
  standalone: true,
  template: `
    <header class="header" role="banner">
      <div class="header-left">
        <button
          type="button"
          class="menu-btn"
          aria-label="Open navigation menu"
          (click)="openMobileNav.emit()"
        >
          <span aria-hidden="true">☰</span>
        </button>
        <h2 class="header-title">Admin Console</h2>
      </div>

      <div class="header-center">
        <button
          type="button"
          class="search-trigger"
          (click)="onSearch()"
          aria-label="Open command palette"
          aria-keyshortcuts="Meta+K Control+K"
        >
          <span class="search-icon" aria-hidden="true">⌕</span>
          <span class="search-text">Search…</span>
          <span class="search-shortcut" aria-hidden="true">⌘K</span>
        </button>
      </div>

      <div class="header-right">
        @if (auth.user(); as user) {
          <div
            class="user-pill"
            [attr.aria-label]="'Signed in as ' + user.firstName + ' ' + user.lastName"
          >
            <div class="user-avatar" aria-hidden="true">
              {{ user.firstName.charAt(0) }}{{ user.lastName.charAt(0) }}
            </div>
            <span class="user-name">{{ user.firstName }}</span>
          </div>
        }
        <button
          type="button"
          class="logout-btn"
          (click)="onLogout()"
          aria-label="Sign out"
          title="Sign out"
        >
          <span aria-hidden="true">⏻</span>
        </button>
      </div>
    </header>
  `,
  styles: [
    `
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
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }

      .menu-btn {
        display: none;
        width: 36px;
        height: 36px;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: var(--text-secondary);
        font-size: 18px;
        cursor: pointer;
        align-items: center;
        justify-content: center;
      }
      .menu-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .menu-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      @media (max-width: 768px) {
        .menu-btn {
          display: inline-flex;
        }
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
      .search-trigger:focus-visible,
      .logout-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
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
        .search-text,
        .search-shortcut {
          display: none;
        }
      }
    `,
  ],
})
export class HeaderComponent {
  auth = inject(AuthService);
  private router = inject(Router);
  private palette = inject(CommandPaletteComponent, { optional: true });

  openMobileNav = output<void>();

  onSearch() {
    // Falls through gracefully if the palette isn't mounted (e.g. in isolated previews).
    this.palette?.openPalette();
  }

  onLogout() {
    this.auth.logout();
    this.router.navigate(['/login']);
  }
}
