import { Component, ChangeDetectionStrategy, input, output, model } from '@angular/core';

export interface TabItem {
  label: string;
  value: string;
}

@Component({
  selector: 'ui-tabs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tabs">
      <div class="tabs__bar" role="tablist">
        @for (tab of tabs(); track tab.value) {
          <button
            type="button"
            role="tab"
            class="tabs__tab"
            [class.tabs__tab--active]="activeTab() === tab.value"
            [attr.aria-selected]="activeTab() === tab.value"
            (click)="selectTab(tab.value)"
          >
            {{ tab.label }}
          </button>
        }
      </div>
      <div class="tabs__content">
        <ng-content />
      </div>
    </div>
  `,
  styles: [
    `
      /* Tabs wrap: a sideways-scrolling bar with its scrollbar hidden cut the 14th tab of a
         strategy ("Lineage") off at 1440px with nothing to say more existed. On a phone, where
         wrapping would stack many rows, it scrolls — with a visible (thin) scrollbar. */
      .tabs__bar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
        padding: 2px;
      }

      @media (max-width: 767.98px) {
        .tabs__bar {
          flex-wrap: nowrap;
          overflow-x: auto;
          scrollbar-width: thin;
        }
      }

      .tabs__tab {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-2) var(--space-3);
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-secondary);
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s ease;
        user-select: none;
        -webkit-user-select: none;
      }

      .tabs__tab:hover:not(.tabs__tab--active) {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .tabs__tab--active {
        background: rgba(0, 113, 227, 0.1);
        color: var(--accent);
      }

      .tabs__tab:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .tabs__content {
        margin-top: var(--space-4);
      }

      /*
       * The caller owns projected content via @if guards keyed on activeTab(),
       * so content enter-animations live on the caller. We polish the tab bar
       * itself: an animated underline indicator on the active tab so the
       * selection glides instead of snapping.
       */
      .tabs__tab--active {
        position: relative;
      }

      .tabs__tab--active::after {
        content: '';
        position: absolute;
        left: var(--space-3);
        right: var(--space-3);
        bottom: -2px;
        height: 2px;
        background: var(--accent);
        border-radius: 2px;
        animation: tab-underline-in 0.2s var(--ease-out-soft);
      }

      @keyframes tab-underline-in {
        from {
          transform: scaleX(0);
          opacity: 0;
        }
        to {
          transform: scaleX(1);
          opacity: 1;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .tabs__tab--active::after {
          animation: none;
        }
      }
    `,
  ],
})
export class TabsComponent {
  readonly tabs = input.required<TabItem[]>();
  readonly activeTab = model<string>('');
  readonly tabChange = output<string>();

  selectTab(value: string): void {
    this.activeTab.set(value);
    this.tabChange.emit(value);
  }
}
