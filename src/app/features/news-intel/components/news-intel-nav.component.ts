import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

interface NavTab {
  label: string;
  path: string;
  exact: boolean;
}

/** The News Intel section tabs (news-intel program): one strip on every sub-page, active tab from the router. */
@Component({
  selector: 'app-news-intel-nav',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RefreshButtonComponent],
  template: `
    <nav class="ni-nav" aria-label="News Intelligence sections">
      <div class="ni-tabs">
        @for (t of tabs; track t.path) {
          <a
            class="ni-tab"
            [routerLink]="t.path"
            routerLinkActive="active"
            [routerLinkActiveOptions]="{ exact: t.exact }"
            ariaCurrentWhenActive="page"
            >{{ t.label }}</a
          >
        }
      </div>
      @if (showRefresh()) {
        <app-refresh-button
          variant="outline"
          [refreshing]="refreshing()"
          (refresh)="refresh.emit()"
        />
      }
    </nav>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .ni-nav {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
        padding: 3px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .ni-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
        flex: 1 1 0;
        min-width: 0;
      }
      .ni-tab {
        padding: 4px 10px;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
        text-decoration: none;
        white-space: nowrap;
      }
      .ni-tab:hover:not(.active) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .ni-tab.active {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
      }
      .ni-tab:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
    `,
  ],
})
export class NewsIntelNavComponent {
  showRefresh = input(false);
  refreshing = input(false);
  refresh = output<void>();

  readonly tabs: readonly NavTab[] = [
    { label: 'Overview', path: '/news-intel', exact: true },
    { label: 'Coverage', path: '/news-intel/coverage', exact: false },
    { label: 'Exposures', path: '/news-intel/exposures', exact: false },
    { label: 'Sources', path: '/news-intel/sources', exact: false },
    { label: 'Calendar', path: '/news-intel/calendar', exact: false },
    { label: 'Stories', path: '/news-intel/stories', exact: false },
    { label: 'Gold set & evals', path: '/news-intel/evals', exact: false },
    { label: 'Event study', path: '/news-intel/event-study', exact: false },
    { label: 'Risk use', path: '/news-intel/risk', exact: false },
    { label: 'Settings', path: '/news-intel/settings', exact: false },
  ];
}
