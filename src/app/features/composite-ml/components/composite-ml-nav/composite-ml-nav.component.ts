import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';

interface NavTab {
  label: string;
  path: string;
  exact: boolean;
}

/**
 * Section toolbar shared by every CompositeML page: the sibling pages as a
 * tab strip (active one highlighted from the router), an optional back link
 * for detail pages that hang off a sibling, and the Refresh action as a
 * proper secondary button.
 *
 * Replaces the per-page header clutter — seven unstyled text links plus
 * "Refresh" rendered as an eighth link, with the back-arrow pointing left on
 * one page and right on the next.
 */
@Component({
  selector: 'app-composite-ml-nav',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RefreshButtonComponent],
  template: `
    <nav class="ml-nav" aria-label="CompositeML sections">
      @if (backLink(); as back) {
        <a class="ml-back" [routerLink]="back">‹ {{ backLabel() }}</a>
      }
      <div class="ml-tabs" role="tablist">
        @for (t of tabs; track t.path) {
          <a
            class="ml-tab"
            role="tab"
            [routerLink]="t.path"
            routerLinkActive="active"
            [routerLinkActiveOptions]="{ exact: t.exact }"
            ariaCurrentWhenActive="page"
          >
            {{ t.label }}
          </a>
        }
      </div>
      @if (showRefresh()) {
        <app-refresh-button
          class="ml-refresh"
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
      /* Tabs wrap onto a second row rather than scrolling: the strip hid its
         scrollbar, so at tablet width Cold-Start and Diff were simply gone
         behind the Refresh button with nothing to say they existed. */
      .ml-nav {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2) var(--space-3);
        padding: 4px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .ml-back {
        flex-shrink: 0;
        padding: 6px 12px;
        border-right: 1px solid var(--border);
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        text-decoration: none;
        white-space: nowrap;
      }
      .ml-back:hover {
        color: var(--text-primary);
      }
      .ml-tabs {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
        min-width: 0;
        /* Basis 0: the strip takes the room beside Refresh and wraps inside it,
           rather than pushing Refresh onto a row of its own. */
        flex: 1 1 0;
      }
      .ml-tab {
        display: inline-flex;
        align-items: center;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary);
        text-decoration: none;
        white-space: nowrap;
        transition:
          background-color 0.15s ease,
          color 0.15s ease;
      }
      .ml-tab:hover:not(.active) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .ml-tab.active {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
      }
      .ml-tab:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .ml-refresh {
        margin-left: auto;
      }
    `,
  ],
})
export class CompositeMlNavComponent {
  /** Route of the parent page for detail views (snapshot, drift history); hidden when unset. */
  backLink = input<string | null>(null);
  backLabel = input<string>('Back');
  /** Pages that own a polled resource show the Refresh button. */
  showRefresh = input(false);
  /** Bind the resource's `refreshing()` — NOT `loading()`, which only covers the first paint. */
  refreshing = input(false);
  refresh = output<void>();

  readonly tabs: readonly NavTab[] = [
    { label: 'Active Policies', path: '/composite-ml', exact: true },
    { label: 'Layer Health', path: '/composite-ml/layer-health', exact: false },
    { label: 'Layer Skill', path: '/composite-ml/layer-skill', exact: false },
    { label: 'Trainer Skill', path: '/composite-ml/trainer-skill', exact: false },
    { label: 'Drift', path: '/composite-ml/drift', exact: false },
    { label: 'Gate Cutover', path: '/composite-ml/gate-cutover', exact: false },
    { label: 'Cold-Start', path: '/composite-ml/cold-start', exact: false },
    { label: 'Diff', path: '/composite-ml/diff', exact: false },
  ];
}
