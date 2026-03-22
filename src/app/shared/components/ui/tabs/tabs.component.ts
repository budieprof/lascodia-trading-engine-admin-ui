import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  model,
} from '@angular/core';

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
  styles: [`
    .tabs__bar {
      display: flex;
      gap: var(--space-1);
      padding: 2px;
      overflow-x: auto;
      scrollbar-width: none;
    }

    .tabs__bar::-webkit-scrollbar {
      display: none;
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

    .tabs__content {
      margin-top: var(--space-4);
    }
  `],
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
