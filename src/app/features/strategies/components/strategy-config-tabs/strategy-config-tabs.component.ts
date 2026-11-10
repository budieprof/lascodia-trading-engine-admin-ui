import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import { ControlContainer, ReactiveFormsModule } from '@angular/forms';

import { SUB_CONFIG_SCHEMAS } from '../../util/sub-config-schema';
import { SubConfigEditorComponent } from '../sub-config-editor/sub-config-editor.component';

/** The strategy form's tabs: Inputs is the form's own; the other four are this component's. */
export type StrategyFormTab = 'inputs' | 'risk' | 'sizing' | 'filters' | 'gates';

// Placeholders shown in each sub-config tab so operators see a working schema example
// before they fill anything in. Pulled out as a const so the template stays readable
// and so the same shapes are auto-suggested in any future template editor.
export const SUB_CONFIG_PLACEHOLDERS = {
  riskOverrides:
    '{"slMode":"Atr","slMultiplier":1.5,"tpMode":"Atr","tpMultiplier":2.5,"trailingStopAtrMultiplier":1.0}',
  sizing: '{"mode":"PercentEquity","value":0.01}',
  sessionFilter: '{"sessionStartUtc":"08:00","sessionEndUtc":"17:00","tradeWeekends":false}',
  regimeGate: '{"allowedRegimes":["Trending","Breakout"]}',
  multiTimeframeGate: '{"timeframe":"D1","indicator":"EMA","period":200,"comparator":"PriceAbove"}',
} as const;

/**
 * b10-ui — the strategy form's Risk / Sizing / Filters / Gates tabs (split out of StrategyFormComponent, behaviour
 * unchanged): each tab's typed sub-config editor, bound by `formControlName` to the form's own FormGroup (the
 * enclosing `[formGroup]` is this component's ControlContainer), and its hint. A Pine script sizes its own orders, so
 * the Sizing tab explains that instead of offering a sizing config (D126).
 *
 * Decorator inputs (not signal inputs): the repo's JIT component-test harness does not bind signal inputs from a
 * parent template, and the strategy form's specs render this component.
 */
@Component({
  selector: 'app-strategy-config-tabs',
  standalone: true,
  imports: [ReactiveFormsModule, SubConfigEditorComponent],
  viewProviders: [
    { provide: ControlContainer, useFactory: () => inject(ControlContainer, { skipSelf: true }) },
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- ========== RISK OVERRIDES TAB ========== -->
    @if (tab === 'risk') {
      <app-sub-config-editor
        formControlName="riskOverridesJson"
        [schema]="schemas.riskOverrides"
        [placeholder]="placeholders.riskOverrides"
      />
      <span class="form-hint">
        Optional. SL/TP/trailing-stop overrides for signals from this strategy. Leave a
        field blank to inherit from the assigned risk profile.
      </span>
    }

    <!-- ========== SIZING TAB ========== -->
    @if (tab === 'sizing') {
      @if (scriptAuthoring) {
        <!-- D126: a script sizes its own orders; the engine refuses a sizing config on one. -->
        <div class="form-group" data-testid="script-sizing-note">
          <span class="form-hint">
            A Pine script sizes its own orders: <code>default_qty_type</code> /
            <code>default_qty_value</code> in its <code>strategy()</code> call, or
            <code>qty</code> on an order — in units of the underlying, as on TradingView
            (<code>qty = 100000</code> is one EURUSD lot). Every bound account trades that
            size, clamped by its risk profile. To trade more or less on one account, set
            that binding's lot multiplier on the strategy's Execution tab.
          </span>
        </div>
      } @else {
        <app-sub-config-editor
          formControlName="sizingConfigJson"
          [schema]="schemas.sizing"
          [placeholder]="placeholders.sizing"
        />
        <span class="form-hint">
          Optional. Position-sizing model, clamped by the account's risk profile. Leave the
          mode blank to size at the risk profile's risk per trade.
        </span>
      }
    }

    <!-- ========== FILTERS TAB (session + news) ========== -->
    @if (tab === 'filters') {
      <app-sub-config-editor
        formControlName="sessionFilterJson"
        [schema]="schemas.sessionFilter"
        [placeholder]="placeholders.sessionFilter"
      />
      <span class="form-hint">
        Optional. Time-of-day window (UTC) plus optional news embargo. Leave blank to trade
        around the clock.
      </span>
    }

    <!-- ========== GATES TAB (regime + higher-TF) ========== -->
    @if (tab === 'gates') {
      <app-sub-config-editor
        formControlName="regimeGateJson"
        [schema]="schemas.regimeGate"
        [placeholder]="placeholders.regimeGate"
      />
      <app-sub-config-editor
        formControlName="multiTimeframeGateJson"
        [schema]="schemas.mtfGate"
        [strategyTimeframe]="strategyTimeframe"
        [placeholder]="placeholders.multiTimeframeGate"
      />
      <span class="form-hint">
        Optional. A regime allowlist and a higher-timeframe confirmation; both blank = no
        gate.
      </span>
    }
  `,
  styles: [
    `
      /* No box of its own: the tab's editors and hints sit in the form body as they always did. */
      :host {
        display: contents;
      }
      /* The strategy form's rules for what this markup uses (component styles do not cross into a child). */
      .form-group {
        margin-bottom: var(--space-4);
      }
      .form-hint {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        color: var(--text-tertiary, #8e8e93);
      }
      .form-hint code {
        font-family: 'SF Mono', 'Menlo', monospace;
        background: rgba(142, 142, 147, 0.12);
        padding: 1px 5px;
        border-radius: 3px;
        font-size: 10.5px;
      }
    `,
  ],
})
export class StrategyConfigTabsComponent {
  /** The form's active tab; 'inputs' renders nothing here. */
  @Input() tab: StrategyFormTab = 'inputs';
  /** The form is authoring a Pine script (the Sizing tab explains the script sizes itself). */
  @Input() scriptAuthoring = false;
  /** The strategy's own timeframe — the higher-timeframe gate must be strictly above it. */
  @Input() strategyTimeframe: string | null = null;

  readonly placeholders = SUB_CONFIG_PLACEHOLDERS;
  readonly schemas = SUB_CONFIG_SCHEMAS;
}
