import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';

import type { StrategyDto } from '@core/api/api.types';
import { AuthService } from '@core/auth/auth.service';
import { OPERATOR_PERMISSION } from '../shared/permissions';

import type { ExecutionPolicy, ScriptStrategyFields } from '../api/scripting-api.types';
import { executionPolicyOf, isScriptStrategy } from '../shared/script-strategy';
import { AccountBindingsEditorComponent } from './account-bindings-editor.component';
import { ExecutionPolicyCardComponent } from './execution-policy-card.component';
import { NewsBlackoutExemptionCardComponent } from './news-blackout-exemption-card.component';
import { isNewsBlackoutExempt } from './news-blackout-exemption.model';

/**
 * The strategy detail page's Execution tab (every strategy type): a standing explanation of how
 * account bindings gate live trading, the bindings editor, the execution-policy selector and — for
 * a script strategy — its audited news-blackout exemption.
 */
@Component({
  selector: 'app-strategy-execution-panel',
  standalone: true,
  imports: [
    AccountBindingsEditorComponent,
    ExecutionPolicyCardComponent,
    NewsBlackoutExemptionCardComponent,
  ],
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
          [readOnly]="!canOperate()"
          (saved)="changed.emit()"
        />

        <app-execution-policy-card
          [strategyId]="s.id"
          [policy]="policy()"
          [isScript]="isScript()"
          [readOnly]="!canOperate()"
          (policyChanged)="onPolicyChanged($event)"
        />

        <!-- Script strategies only: the engine has no per-strategy news-blackout opt-out for an
             evaluator strategy (its blackout is applied per symbol before evaluation). -->
        @if (isScript()) {
          <app-news-blackout-exemption-card
            [strategyId]="s.id"
            [strategyName]="s.name"
            [exempt]="newsBlackoutExempt()"
            [readOnly]="!canOperate()"
            (changed)="changed.emit()"
          />
        }
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
  private readonly auth = inject(AuthService);
  private readonly bindingsEditor = viewChild(AccountBindingsEditorComponent);
  private readonly exemptionCard = viewChild(NewsBlackoutExemptionCardComponent);

  readonly strategy = input<(StrategyDto & ScriptStrategyFields) | null>(null);

  /** Bindings or policy changed — the host may re-read the strategy. */
  readonly changed = output<void>();

  readonly isScript = computed(() => isScriptStrategy(this.strategy()));
  readonly policy = computed(() => executionPolicyOf(this.strategy()));
  readonly newsBlackoutExempt = computed(() => isNewsBlackoutExempt(this.strategy()));
  /** PE-I13: the engine requires operator access for every change made here. */
  readonly canOperate = computed(() => this.auth.hasPermission(OPERATOR_PERMISSION));

  /**
   * PE-14: binding changes or an exemption change not saved yet — the detail page asks before a
   * tab switch or a navigation throws them away.
   */
  hasUnsavedChanges(): boolean {
    return !!this.bindingsEditor()?.dirty() || this.exemptionCard()?.draft() != null;
  }

  onPolicyChanged(_policy: ExecutionPolicy): void {
    this.changed.emit();
  }
}
