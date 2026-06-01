import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AccountScopeService } from './account-scope.service';

/**
 * Header chrome pill that drives the global account-scope selection.
 * Visible on every page — flipping it reshapes orders, positions,
 * drawdown, and the dashboard tiles in lockstep.
 *
 * Renders nothing when the operator has 0 or 1 live accounts (no
 * choice to make).
 */
@Component({
  selector: 'app-account-scope-pill',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (live().length > 1) {
      <label
        class="scope-pill"
        title="Scope every list and metric in the admin console to a specific trading account or aggregate across the operator's live accounts."
      >
        <span class="scope-label">Account:</span>
        <select
          class="scope-select"
          [value]="String(scope.selected())"
          (change)="onChange($any($event.target).value)"
        >
          <option [value]="AGG_REAL">All real ({{ realCount() }} · aggregated)</option>
          @if (paperCount() > 0) {
            <option [value]="AGG_ALL">All live ({{ live().length }} · incl. paper)</option>
          }
          @for (acc of live(); track acc.id) {
            <option [value]="acc.id">
              {{ acc.accountName ?? acc.accountId }}{{ acc.isPaper ? ' · paper' : '' }} ·
              {{ acc.currency }}
            </option>
          }
        </select>
      </label>
    } @else if (live().length === 1) {
      <span
        class="scope-pill scope-pill-static"
        title="Only one live trading account — scope is implicit."
      >
        <span class="scope-label">Account:</span>
        <span class="scope-value">
          {{ live()[0].accountName ?? live()[0].accountId
          }}{{ live()[0].isPaper ? ' · paper' : '' }} · {{ live()[0].currency }}
        </span>
      </span>
    }
  `,
  styles: [
    `
      .scope-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
      }
      .scope-pill-static {
        cursor: default;
      }
      .scope-label {
        opacity: 0.7;
        font-size: 11px;
      }
      .scope-value {
        font-weight: 500;
        color: var(--text-primary);
      }
      .scope-select {
        appearance: none;
        background: transparent;
        border: 0;
        color: inherit;
        font: inherit;
        font-size: 12px;
        padding: 0 14px 0 2px;
        cursor: pointer;
        background-image:
          linear-gradient(45deg, transparent 50%, currentColor 50%),
          linear-gradient(135deg, currentColor 50%, transparent 50%);
        background-position:
          calc(100% - 8px) 50%,
          calc(100% - 4px) 50%;
        background-size:
          4px 4px,
          4px 4px;
        background-repeat: no-repeat;
      }
      .scope-select:focus {
        outline: 1px solid var(--accent);
        outline-offset: 2px;
        border-radius: 2px;
      }
    `,
  ],
})
export class AccountScopePillComponent {
  protected readonly scope = inject(AccountScopeService);
  protected readonly AGG_REAL = AccountScopeService.SCOPE_AGGREGATE_REAL;
  protected readonly AGG_ALL = AccountScopeService.SCOPE_AGGREGATE_ALL;
  // Expose String for template-side cast (`<select [value]>` expects string).
  protected readonly String = String;

  protected readonly live = this.scope.liveAccounts;
  protected readonly realCount = computed(() => this.scope.liveRealAccounts().length);
  protected readonly paperCount = computed(
    () => this.scope.liveAccounts().length - this.scope.liveRealAccounts().length,
  );

  protected onChange(raw: string): void {
    // Sentinel strings pass through verbatim; numeric ids parse.
    if (raw === this.AGG_REAL || raw === this.AGG_ALL) {
      this.scope.select(raw);
      return;
    }
    const n = Number(raw);
    this.scope.select(Number.isFinite(n) ? n : this.AGG_REAL);
  }
}
