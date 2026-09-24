import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { StrategyDto } from '@core/api/api.types';

import type { ExecutionPolicy, ScriptStrategyFields } from '../api/scripting-api.types';
import { executionPolicyOf, isScriptStrategy } from '../shared/script-strategy';
import { AccountBindingsEditorComponent } from './account-bindings-editor.component';
import { ExecutionPolicyCardComponent } from './execution-policy-card.component';

/**
 * The strategy detail page's Execution tab (every strategy type): a standing explanation of how
 * account bindings gate live trading, the bindings editor and the execution-policy selector.
 */
@Component({
  selector: 'app-strategy-execution-panel',
  standalone: true,
  imports: [AccountBindingsEditorComponent, ExecutionPolicyCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (strategy(); as s) {
      <div class="stack">
        <aside class="banner" role="note" aria-label="How account bindings work">
          <p class="banner-title">Live trading follows the bindings below</p>
          <ul>
            <li>
              A strategy with bound accounts trades <strong>only</strong> on its enabled bound
              accounts, each account's lots multiplied by its lot multiplier (then clamped by the
              account's RiskProfile).
            </li>
            <li>
              A script strategy with no enabled binding <strong>never trades live</strong> — it runs
              in the emulator / paper only.
            </li>
            @if (!isScript()) {
              <li>
                This strategy is not a script: with <strong>no binding at all</strong> it trades on
                every account whose EA streams {{ s.symbol || 'its symbol' }}, REAL accounts
                included.
              </li>
            }
            <li>Binding or enabling a REAL account asks you to type its account number.</li>
          </ul>
        </aside>

        <app-account-bindings-editor
          [strategyId]="s.id"
          [isScript]="isScript()"
          [symbol]="s.symbol"
          [strategyName]="s.name"
          (saved)="changed.emit()"
        />

        <app-execution-policy-card
          [strategyId]="s.id"
          [policy]="policy()"
          [isScript]="isScript()"
          (policyChanged)="onPolicyChanged($event)"
        />
      </div>
    }
  `,
  styles: [
    `
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .banner {
        padding: var(--space-4) var(--space-5);
        border-radius: var(--radius-md);
        border: 1px solid rgba(255, 149, 0, 0.4);
        background: rgba(255, 149, 0, 0.08);
        font-size: var(--text-sm);
        line-height: 1.5;
        color: var(--text-primary);
      }
      .banner-title {
        margin: 0 0 var(--space-1);
        font-weight: var(--font-semibold);
      }
      .banner ul {
        list-style: disc;
        margin: 0;
        padding-left: var(--space-5);
      }
    `,
  ],
})
export class StrategyExecutionPanelComponent {
  readonly strategy = input<(StrategyDto & ScriptStrategyFields) | null>(null);

  /** Bindings or policy changed — the host may re-read the strategy. */
  readonly changed = output<void>();

  readonly isScript = computed(() => isScriptStrategy(this.strategy()));
  readonly policy = computed(() => executionPolicyOf(this.strategy()));

  onPolicyChanged(_policy: ExecutionPolicy): void {
    this.changed.emit();
  }
}
