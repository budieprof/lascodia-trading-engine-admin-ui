import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
  computed,
  inject,
  OnInit,
  OnChanges,
  SimpleChanges,
  ViewChild,
  viewChild,
} from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { StrategyPreviewPanelComponent } from '../strategy-preview-panel/strategy-preview-panel.component';
import {
  CLASSIC_PINE_LIBRARY_HINT,
  CREATABLE_STRATEGY_TYPES,
  EVENT_PINE_HINT,
  isRetiredStrategyType,
  StrategyDto,
  StrategyType,
  Timeframe,
  CreateStrategyRequest,
  UpdateStrategyRequest,
  StrategyTemplateDto,
  CreateStrategyTemplateRequest,
  StrategyParameterSchemaDto,
  StrategyParameterFieldDto,
  RiskProfileDto,
  CurrencyPairDto,
} from '@core/api/api.types';
// ── Pine script authoring — see the "Pine script authoring" block at the end of the class.
import { ScriptAuthoringComponent } from '@features/scripting/components/script-authoring/script-authoring.component';
import {
  linkedAuthoringMode,
  linkedScriptDraft,
} from '@features/scripting/components/script-authoring/authoring-mode';
import { parseSavedInputs } from '@features/scripting/pine/pine-saved-inputs';
import {
  ScriptDialogService,
  confirmDiscard,
} from '@features/scripting/shared/script-dialog.service';
import { warnBeforeUnload } from '@features/scripting/shared/unsaved-changes';
import { StrategiesService } from '@core/services/strategies.service';
import { RiskProfilesService } from '@core/services/risk-profiles.service';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { NotificationService } from '@core/notifications/notification.service';
import { CloneStrategyDialogComponent } from '../clone-strategy-dialog/clone-strategy-dialog.component';
import { StrategyVersionHistoryComponent } from '../strategy-version-history/strategy-version-history.component';
import { failureMessage } from '../../util/api-failure';
import type { StrategyVersionFields } from '../../util/version-diff';
import { SUB_CONFIG_SCHEMAS } from '../../util/sub-config-schema';
import { SubConfigEditorComponent } from '../sub-config-editor/sub-config-editor.component';

/**
 * Strategy types authored as Pine v6 scripts. Their Parameters JSON used to hold the retired JSON
 * rules DSL: a saved row without a script is legacy and never runs.
 */
const PINE_STRATEGY_TYPES: readonly string[] = ['RuleBased', 'LlmProposal'];

const STRATEGY_TYPES: readonly StrategyType[] = CREATABLE_STRATEGY_TYPES;

/** Templates that can still seed a strategy — never a legacy JSON-rules (Pine type) one. */
function loadableTemplates(list: StrategyTemplateDto[] | null | undefined): StrategyTemplateDto[] {
  return (list ?? []).filter((t) => !PINE_STRATEGY_TYPES.includes(t.strategyType));
}

// Placeholders shown in each sub-config tab so operators see a working schema example
// before they fill anything in. Pulled out as a const so the template stays readable
// and so the same shapes are auto-suggested in any future template editor.
const SUB_CONFIG_PLACEHOLDERS = {
  riskOverrides:
    '{"slMode":"Atr","slMultiplier":1.5,"tpMode":"Atr","tpMultiplier":2.5,"trailingStopAtrMultiplier":1.0}',
  sizing: '{"mode":"PercentEquity","value":0.01}',
  sessionFilter: '{"sessionStartUtc":"08:00","sessionEndUtc":"17:00","tradeWeekends":false}',
  regimeGate: '{"allowedRegimes":["Trending","Breakout"]}',
  multiTimeframeGate: '{"timeframe":"D1","indicator":"EMA","period":200,"comparator":"PriceAbove"}',
} as const;

type FormTab = 'inputs' | 'risk' | 'sizing' | 'filters' | 'gates';

const TIMEFRAMES: Timeframe[] = ['M1', 'M5', 'M15', 'H1', 'H4', 'D1'];

const TIMEFRAME_LABELS: Record<string, string> = {
  M1: '1 Min',
  M5: '5 Min',
  M15: '15 Min',
  H1: '1 Hour',
  H4: '4 Hours',
  D1: 'Daily',
};

@Component({
  selector: 'app-strategy-form',
  standalone: true,
  host: { '(document:keydown.escape)': 'onDocumentEscape($event)' },
  imports: [
    StrategyPreviewPanelComponent,
    ReactiveFormsModule,
    SubConfigEditorComponent,
    CloneStrategyDialogComponent,
    StrategyVersionHistoryComponent,
    ScriptAuthoringComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div
        class="overlay"
        [class.as-page]="isPage()"
        role="presentation"
        tabindex="-1"
        (click)="isPage() || requestClose()"
      >
        <div
          class="dialog"
          [class.as-page]="isPage()"
          [attr.role]="isPage() ? null : 'dialog'"
          [attr.aria-modal]="isPage() ? null : true"
          tabindex="-1"
          [class.dialog-wide]="isScriptAuthoring()"
          (click)="$event.stopPropagation()"
          (keydown)="onDialogKeydown($event)"
        >
          <div class="dialog-header">
            <h3 class="dialog-title">{{ strategy() ? 'Edit Strategy' : 'Create Strategy' }}</h3>
            @if (!strategy() && availableTemplates().length > 0) {
              <div class="template-loader">
                <label class="template-loader-label">Load from template</label>
                <select
                  class="form-input template-loader-select"
                  [value]="selectedTemplateId() ?? ''"
                  (change)="onTemplateSelect($any($event.target).value)"
                >
                  <option value="">— none —</option>
                  @for (t of availableTemplates(); track t.id) {
                    <option [value]="t.id">{{ t.name }}</option>
                  }
                </select>
              </div>
            }
            @if (strategy() && !isPage()) {
              <button
                type="button"
                class="btn btn-ghost btn-sm open-page"
                (click)="requestPage()"
                title="Edit on a full page — the editor, inputs and preview get the whole screen"
              >
                ⤢ Full page
              </button>
            }
            @if (!isPage()) {
              <button
                type="button"
                class="dialog-close"
                (click)="requestClose()"
                aria-label="Close"
              >
                ×
              </button>
            }
          </div>
          <form
            [formGroup]="form"
            (ngSubmit)="isScriptAuthoring() ? submitScript() : onSubmit()"
            class="dialog-body"
          >
            <!-- Tab strip — TradingView-style — splits the modal into discrete config sections -->
            <div class="tab-strip" role="tablist">
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'inputs'"
                role="tab"
                (click)="activeTab.set('inputs')"
              >
                Inputs
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'risk'"
                role="tab"
                (click)="activeTab.set('risk')"
              >
                Risk
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'sizing'"
                role="tab"
                (click)="activeTab.set('sizing')"
              >
                Sizing
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'filters'"
                role="tab"
                (click)="activeTab.set('filters')"
              >
                Filters
              </button>
              <button
                type="button"
                class="tab"
                [class.active]="activeTab() === 'gates'"
                role="tab"
                (click)="activeTab.set('gates')"
              >
                Gates
              </button>
            </div>

            <!-- ========== INPUTS TAB ========== -->
            @if (activeTab() === 'inputs') {
              <!-- Strategy metadata; laid out as a grid on the full page so the script
                   authoring below starts above the fold. -->
              <div class="meta-block">
                <div class="form-row">
                  <div class="form-group">
                    <label class="form-label">
                      Name <span class="required">*</span>
                      @if (nameAutoGenerated()) {
                        <span class="muted small"> — auto-generated</span>
                      }
                    </label>
                    <input
                      type="text"
                      formControlName="name"
                      class="form-input"
                      placeholder="e.g. EURUSD MA Crossover"
                      (input)="onNameTyped()"
                    />
                    @if (form.get('name')?.touched && form.get('name')?.hasError('required')) {
                      <span class="form-error">Name is required</span>
                    }
                  </div>
                  @if (!strategy()) {
                    <div class="form-group">
                      <label class="form-label">
                        Symbol(s) <span class="required">*</span>
                        @if (parsedSymbols().length > 1) {
                          <span class="multi-symbol-hint">
                            — {{ parsedSymbols().length }} pairs detected
                          </span>
                        }
                      </label>
                      <input
                        type="text"
                        formControlName="symbol"
                        list="strategy-form-symbols"
                        class="form-input"
                        placeholder="e.g. EURUSD or EURUSD, GBPUSD, USDJPY"
                      />
                      <datalist id="strategy-form-symbols">
                        @for (p of currencyPairs(); track p.id) {
                          @if (p.symbol) {
                            <option [value]="p.symbol">{{ p.symbol }}</option>
                          }
                        }
                      </datalist>
                      <span class="form-hint">
                        Pick from the dropdown or keep typing — comma-separate to bulk-create one
                        strategy per symbol with the same parameters.
                      </span>
                      @if (
                        form.get('symbol')?.touched && form.get('symbol')?.hasError('required')
                      ) {
                        <span class="form-error">Symbol is required</span>
                      }
                    </div>
                  }
                </div>

                @if (strategy(); as s) {
                  <!-- Symbol, timeframe and type are fixed once a strategy exists: the
                     engine rejects a change to any of them. Moving a strategy is a
                     clone. -->
                  <div class="form-group">
                    <label class="form-label">Symbol · Timeframe · Type</label>
                    <div class="readonly-identity">
                      <!-- A Custom strategy (LLM Spot Analysis) has no symbol: the line used to
                           start with a stray "·". -->
                      <span class="mono">{{ s.symbol || 'No symbol' }}</span>
                      <span>·</span>
                      <span>{{ timeframeLabels[s.timeframe] }}</span>
                      <span>·</span>
                      <span>{{ formatType(s.strategyType) }}</span>
                      <button type="button" class="btn btn-link clone-link" (click)="openClone()">
                        Clone to another symbol/timeframe…
                      </button>
                    </div>
                    <span class="form-hint">
                      Fixed for an existing strategy. Clone it to run the same configuration on
                      another symbol or timeframe — the copy starts as a Paused draft.
                    </span>
                  </div>
                } @else {
                  <div class="form-row">
                    <div class="form-group">
                      <label class="form-label">Timeframe</label>
                      <select formControlName="timeframe" class="form-input">
                        @for (tf of timeframes; track tf) {
                          <option [value]="tf">{{ timeframeLabels[tf] }}</option>
                        }
                      </select>
                    </div>
                    <div class="form-group">
                      <label class="form-label">Strategy Type</label>
                      <select formControlName="strategyType" class="form-input">
                        @for (st of strategyTypeOptions(); track st) {
                          <option [value]="st">{{ formatType(st) }}</option>
                        }
                      </select>
                      <small class="form-hint" data-testid="classic-pine-hint">{{
                        classicHint
                      }}</small>
                      <small class="form-hint" data-testid="event-pine-hint">{{ eventHint }}</small>
                    </div>
                  </div>
                }

                <div class="form-group">
                  <label class="form-label">Risk Profile</label>
                  <select formControlName="riskProfileId" class="form-input">
                    <option [ngValue]="null">— None —</option>
                    @for (p of riskProfiles(); track p.id) {
                      <option [ngValue]="p.id">
                        {{ p.name ?? '(unnamed)' }}
                        @if (p.isDefault) {
                          · default
                        }
                        · max DD {{ p.maxTotalDrawdownPct.toFixed(1) }}% · risk/trade
                        {{ p.maxRiskPerTradePct.toFixed(2) }}%
                      </option>
                    }
                  </select>
                  @if (riskProfiles().length === 0) {
                    <span class="form-hint">No risk profiles configured yet.</span>
                  }
                </div>

                <div class="form-group">
                  <label class="form-label">Description</label>
                  <textarea
                    formControlName="description"
                    class="form-input form-textarea"
                    rows="2"
                    placeholder="Strategy description..."
                  ></textarea>
                </div>
              </div>

              <!-- ── Pine script authoring ──────────────────────────────────────
                   RuleBased / LlmProposal strategies are Pine v6 scripts. A saved row
                   still on the retired JSON rules DSL is shown read-only below. -->
              @if (isLegacyRules()) {
                <div class="legacy-rules-notice" role="note" data-testid="legacy-rules-notice">
                  <strong>Legacy JSON rules — no longer runs.</strong>
                  The engine retired the JSON rules DSL: this strategy is kept as history but never
                  trades or backtests, and it cannot be saved or cloned. Rewrite it in Pine — create
                  a new RuleBased strategy with a script.
                </div>
              }
              @if (isScriptAuthoring()) {
                <app-script-authoring
                  [(draft)]="scriptDraft"
                  [strategy]="strategy()"
                  [symbol]="scriptSymbol()"
                  [timeframe]="scriptTimeframe()"
                  [spacious]="isPage()"
                  (executionRequested)="onExecutionRequested()"
                  (saveRequested)="onSaveShortcut()"
                  (scriptReloaded)="strategyChanged.emit()"
                />
              }

              <!-- Typed parameter form (v1) — drives the Parameters JSON textarea
                   below for strategy types with a registered schema. Operators on
                   types without a schema see only the textarea (legacy behaviour). -->
              @if (parameterSchema(); as schema) {
                <div class="typed-params">
                  <header class="typed-params-head">
                    <span>Typed parameters · {{ schema.fields.length }} fields</span>
                    <span class="muted small">edits sync to Parameters JSON below</span>
                  </header>
                  <div class="typed-params-grid">
                    @for (f of schema.fields; track f.name) {
                      <div class="typed-params-field">
                        <label class="form-label" [title]="f.description ?? ''">
                          {{ f.label }}
                          @if (f.description) {
                            <span class="muted small"> — {{ f.description }}</span>
                          }
                        </label>
                        @if (f.kind === 'enum' && f.enumValues; as opts) {
                          <select
                            class="form-input"
                            [value]="parameterValues()[f.name] ?? f.default"
                            (change)="setParameter(f.name, $any($event.target).value)"
                          >
                            @for (o of opts; track o) {
                              <option [value]="o">{{ o }}</option>
                            }
                          </select>
                        } @else if (f.kind === 'bool') {
                          <input
                            type="checkbox"
                            [checked]="$any(parameterValues()[f.name] ?? f.default)"
                            (change)="setParameter(f.name, $any($event.target).checked)"
                          />
                        } @else {
                          <input
                            class="form-input"
                            [type]="f.kind === 'int' || f.kind === 'decimal' ? 'number' : 'text'"
                            [min]="f.min ?? null"
                            [max]="f.max ?? null"
                            [step]="f.step ?? (f.kind === 'int' ? 1 : 0.01)"
                            [value]="parameterValues()[f.name] ?? f.default"
                            (input)="
                              setParameter(
                                f.name,
                                f.kind === 'int'
                                  ? +$any($event.target).value
                                  : f.kind === 'decimal'
                                    ? +$any($event.target).value
                                    : $any($event.target).value
                              )
                            "
                          />
                        }
                      </div>
                    }
                  </div>
                </div>
              }

              <!-- Script mode replaces the parameters block with the script panel above. -->
              @if (!isScriptAuthoring()) {
                <div class="form-group">
                  <label class="form-label">
                    {{ isLegacyRules() ? 'Legacy JSON rules (read-only)' : 'Parameters JSON' }}
                    @if (!isLegacyRules()) {
                      <span class="dsl-example-loader">
                        <button
                          type="button"
                          class="btn btn-link dsl-format-btn"
                          (click)="formatParametersJson()"
                          title="Pretty-print the JSON"
                        >
                          Format
                        </button>
                      </span>
                    }
                  </label>
                  <textarea
                    formControlName="parametersJson"
                    class="form-input form-textarea form-mono"
                    rows="8"
                    [readOnly]="isLegacyRules()"
                    placeholder='{"period": 14, "threshold": 0.5}'
                  ></textarea>
                  <span class="form-hint">
                    @if (isLegacyRules()) {
                      Kept for reference while you rewrite the strategy in Pine.
                    } @else {
                      Strategy-type-specific tuning parameters.
                    }
                  </span>
                </div>
              }
            }

            <!-- ========== RISK OVERRIDES TAB ========== -->
            @if (activeTab() === 'risk') {
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
            @if (activeTab() === 'sizing') {
              @if (isScriptAuthoring()) {
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
            @if (activeTab() === 'filters') {
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
            @if (activeTab() === 'gates') {
              <app-sub-config-editor
                formControlName="regimeGateJson"
                [schema]="schemas.regimeGate"
                [placeholder]="placeholders.regimeGate"
              />
              <app-sub-config-editor
                formControlName="multiTimeframeGateJson"
                [schema]="schemas.mtfGate"
                [strategyTimeframe]="formTimeframe()"
                [placeholder]="placeholders.multiTimeframeGate"
              />
              <span class="form-hint">
                Optional. A regime allowlist and a higher-timeframe confirmation; both blank = no
                gate.
              </span>
            }

            <!-- A script previews through its own panel (scripting/run); a legacy
                 JSON-rules row has nothing the engine can run. -->
            @if (!isScriptAuthoring() && !isLegacyRules()) {
              <!-- U13: the preview panel is its own component; it reads this form. -->
              <app-strategy-preview-panel [form]="form" />
            }

            @if (strategy(); as s) {
              <!-- U13 (fu-ui): the version-history drawer is its own component; a rollback comes back here
                   (restored) to patch the form and the script editor. -->
              <app-strategy-version-history
                [strategy]="s"
                [current]="currentVersionFields()"
                [inputDefs]="scriptPanel()?.lastGood()?.inputs ?? null"
                [isScriptEdited]="scriptEditPending"
                (restored)="applyRestoredVersion($event)"
                (changed)="strategyChanged.emit()"
              />
            }

            <!-- Sticky footer: the engine's refusal and the template-name panel
                 live here so they are visible wherever the body is scrolled. -->
            <div class="dialog-actions">
              @if (submitError(); as err) {
                <div class="submit-error" role="alert">
                  <strong>
                    {{
                      strategy()
                        ? 'The engine refused the update:'
                        : 'The engine refused to create the strategy:'
                    }}
                  </strong>
                  {{ err }}
                </div>
              }

              @if (templateNameDraft() !== null) {
                <div class="template-save-panel">
                  <label class="form-label" for="strategy-form-template-name">Template name</label>
                  <div class="template-save-row">
                    <input
                      id="strategy-form-template-name"
                      class="form-input"
                      type="text"
                      maxlength="120"
                      [value]="templateNameDraft()"
                      (input)="templateNameDraft.set($any($event.target).value)"
                      (keydown.enter)="$event.preventDefault(); confirmSaveTemplate()"
                    />
                    <button
                      type="button"
                      class="btn btn-secondary"
                      (click)="cancelSaveTemplate()"
                      [disabled]="savingTemplate()"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="btn btn-primary"
                      (click)="confirmSaveTemplate()"
                      [disabled]="savingTemplate() || !templateNameDraft()?.trim()"
                    >
                      @if (savingTemplate()) {
                        <span class="spinner"></span>
                      } @else {
                        Save template
                      }
                    </button>
                  </div>
                  @if (templateError(); as terr) {
                    <span class="form-error" role="alert">{{ terr }}</span>
                  }
                </div>
              }

              <div class="dialog-buttons">
                <!-- Templates carry no Pine script: a Pine-authored type cannot be one. -->
                @if (!strategy() && !isRuleBased() && templateNameDraft() === null) {
                  <button
                    type="button"
                    class="btn btn-link save-template-btn"
                    (click)="saveAsTemplate()"
                    [disabled]="form.invalid || savingTemplate()"
                    title="Save the current configuration as a reusable template"
                  >
                    Save as template…
                  </button>
                }
                @if (strategy()) {
                  <input
                    class="form-input change-reason"
                    type="text"
                    maxlength="200"
                    placeholder="Reason for this change (optional)"
                    title="Recorded on the version captured before this edit"
                    [value]="updateChangeReason()"
                    (input)="updateChangeReason.set($any($event.target).value)"
                  />
                }
                <button
                  type="button"
                  class="btn btn-secondary"
                  (click)="requestClose()"
                  [disabled]="busy()"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="form.invalid || busy() || saveBlocked()"
                  [title]="saveBlockedReason() ?? ''"
                >
                  @if (busy()) {
                    <span class="spinner"></span>
                  } @else {
                    {{ strategy() ? 'Update' : 'Create' }}
                  }
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    }

    <!-- Outside the modal box so their fixed overlays are never clipped by it. -->
    <app-clone-strategy-dialog
      [strategy]="cloneOpen() ? strategy() : null"
      (closed)="cloneOpen.set(false)"
      (cloned)="onCloned()"
    />
  `,
  styles: [
    `
      /* The host is a direct child of the page's \`.page\` wrapper, whose
         entry animation leaves a transform on every child. A transformed
         ancestor becomes the containing block for position: fixed, which
         pinned the overlay inside the page flow — no backdrop, clipped by
         the viewport, footer unreachable. display: contents removes the
         host box so the overlay is positioned against the viewport. */
      :host {
        display: contents;
      }

      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: var(--space-4);
        animation: fadeIn 0.15s ease;
      }

      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: 100%;
        max-width: 640px;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: scaleIn 0.2s ease-out;
      }

      .dialog-header {
        padding: var(--space-4) var(--space-6);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
      }
      .dialog-close {
        background: transparent;
        border: none;
        font-size: 1.5rem;
        line-height: 1;
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        color: var(--text-secondary);
        cursor: pointer;
        flex-shrink: 0;
      }
      .dialog-close:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      /* The form is the scroll container; the action row below it is
         sticky so Create / Cancel stay reachable on every tab. */
      .dialog-body {
        display: flex;
        flex-direction: column;
        min-height: 0;
        flex: 1 1 auto;
        overflow-y: auto;
      }
      .dialog-actions {
        position: sticky;
        bottom: 0;
        background: var(--bg-secondary);
        border-top: 1px solid var(--border);
        margin: var(--space-4) calc(-1 * var(--space-6)) calc(-1 * var(--space-5));
        padding: var(--space-3) var(--space-6);
      }

      .dialog-title {
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        margin: 0;
      }

      .dialog-body {
        padding: var(--space-4) var(--space-6) var(--space-5);
      }

      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-4);
      }

      .form-group {
        margin-bottom: var(--space-4);
      }

      .form-label {
        display: block;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
      }

      .required {
        color: var(--loss);
      }

      .form-input {
        width: 100%;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
        transition: border-color 0.15s ease;
      }

      .form-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.1);
      }

      .form-textarea {
        height: auto;
        padding: var(--space-2) var(--space-3);
        resize: vertical;
        line-height: 1.5;
      }

      .form-mono {
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 12px;
      }

      .form-error {
        display: block;
        font-size: var(--text-xs);
        color: var(--loss);
        margin-top: 2px;
      }

      .dialog-actions {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding-top: var(--space-2);
      }
      .dialog-buttons {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: var(--space-3);
      }

      .btn {
        height: 36px;
        padding: 0 var(--space-5);
        border: none;
        border-radius: var(--radius-full);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 80px;
      }

      .btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-secondary {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn-secondary:hover:not(:disabled) {
        opacity: 0.8;
      }

      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }

      .spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      @keyframes scaleIn {
        from {
          transform: scale(0.96);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }

      .template-loader {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
      .template-loader-label {
        color: var(--text-secondary, #636366);
        white-space: nowrap;
      }
      .template-loader-select {
        max-width: 200px;
        font-size: 12px;
        padding: 4px 8px;
      }

      .tab-strip {
        display: flex;
        gap: 4px;
        border-bottom: 1px solid var(--border, #e5e5ea);
        margin-bottom: 16px;
      }
      .tab {
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-secondary, #636366);
        cursor: pointer;
        transition:
          color 0.15s,
          border-color 0.15s;
      }
      .tab:hover {
        color: var(--text-primary, #1d1d1f);
      }
      .tab.active {
        color: #0071e3;
        border-bottom-color: #0071e3;
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

      .save-template-btn {
        margin-right: auto;
        font-size: 12px;
      }
      .dsl-example-loader {
        float: right;
      }
      .multi-symbol-hint {
        font-size: 11px;
        color: #0071e3;
        font-weight: normal;
      }
      .typed-params {
        background: var(--bg-tertiary, #fafafa);
        border: 1px solid var(--border, #e5e5ea);
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .typed-params-head {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #636366);
        margin-bottom: 8px;
      }
      .typed-params-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
        gap: 8px 12px;
      }
      .typed-params-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .modal-footer-hint {
        font-size: 11px;
        color: var(--text-tertiary, #8e8e93);
        background: rgba(0, 113, 227, 0.06);
        padding: 8px 12px;
        border-radius: 6px;
        margin: 12px 0;
      }
      .legacy-rules-notice {
        margin: 0 0 12px;
        padding: 10px 12px;
        background: rgba(255, 149, 0, 0.08);
        border-left: 3px solid #ff9500;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.45;
      }
      .readonly-identity {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 0 var(--space-3);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .btn.clone-link {
        margin-left: auto;
        height: 28px;
        padding: 0 10px;
        font-size: 12px;
        background: transparent;
        color: var(--accent);
      }
      .mono {
        font-family: 'SF Mono', Menlo, monospace;
      }
      .submit-error {
        padding: 8px 12px;
        background: rgba(255, 59, 48, 0.08);
        border: 1px solid rgba(255, 59, 48, 0.3);
        border-radius: 6px;
        font-size: 12px;
        color: #8e1010;
        white-space: pre-line;
        max-height: 120px;
        overflow-y: auto;
      }
      .template-save-row {
        display: flex;
        gap: 8px;
      }
      .template-save-row .form-input {
        flex: 1;
      }
      .change-reason {
        flex: 1;
        min-width: 160px;
        max-width: 280px;
        height: 32px;
        font-size: 12px;
      }
      .dsl-format-btn {
        margin-left: 8px;
        font-size: 11px;
        padding: 2px 8px;
      }
      /* Script mode needs room for the editor beside its side panel, and the preview under them. */
      .dialog.dialog-wide {
        max-width: min(1320px, 96vw);
        max-height: 94vh;
      }
      .open-page {
        margin-left: auto;
      }

      /* ── Full-page layout (layout="page") ── the same form, in the page flow at full width. */
      .overlay.as-page {
        position: static;
        display: block;
        padding: 0;
        background: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        z-index: auto;
        animation: none;
      }
      .dialog.as-page,
      .dialog.as-page.dialog-wide {
        max-width: none;
        max-height: none;
        box-shadow: none;
        overflow: visible;
        animation: none;
      }
      .dialog.as-page .dialog-body {
        overflow: visible;
      }
      /* In the page the sticky action bar reaches the viewport's bottom-right corner, where the
         floating assistant "Ask" pill sat over its last button (Update, half hidden at 1440px). */
      .dialog.as-page .dialog-actions {
        padding-right: var(--assistant-fab-clearance, 132px);
      }
      /* Name / identity / risk profile / description side by side instead of stacked. */
      .dialog.as-page .meta-block {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        column-gap: var(--space-4);
      }
      .dialog.as-page .meta-block > .form-row {
        grid-template-columns: minmax(0, 1fr);
      }
      @media (max-width: 1000px) {
        .dialog.as-page .meta-block {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `,
  ],
})
export class StrategyFormComponent implements OnInit, OnChanges {
  private readonly fb = inject(FormBuilder);
  private readonly strategiesService = inject(StrategiesService);
  private readonly riskProfilesService = inject(RiskProfilesService);
  private readonly currencyPairsService = inject(CurrencyPairsService);
  private readonly notifications = inject(NotificationService);

  /// Available risk profiles for the dropdown — lazy-loaded on first ngOnInit.
  riskProfiles = signal<RiskProfileDto[]>([]);
  /// Available active currency pairs for the symbol picker — drives the
  /// <datalist> autocomplete so operators can either pick from a list or
  /// keep typing free-form (multi-symbol comma input still works).
  currencyPairs = signal<CurrencyPairDto[]>([]);
  /// True while the operator hasn't manually edited the Name field, so
  /// auto-generation can keep updating it as they tweak symbol/strategyType.
  /// Once they type into Name we stop overwriting. Public for the template
  /// — the "auto-generated" label next to the Name field reads this.
  nameAutoGenerated = signal(true);

  open = input(false);
  strategy = input<StrategyDto | null>(null);
  /** The parent's create/update request is in flight. */
  saving = input(false);
  /** Why the parent's last create/update was refused; shown above the actions. */
  submitError = input<string | null>(null);

  submitted = output<CreateStrategyRequest | UpdateStrategyRequest>();
  cancelled = output<void>();
  /** The saved strategy changed from inside the form (script save): re-read it. */
  strategyChanged = output<void>();
  /** Edit mode: open the strategy's Execution tab (execution policy, account bindings). */
  executionRequested = output<void>();
  /** 'dialog' (modal overlay) or 'page' (inline, full width — the /strategies/:id/edit page). */
  layout = input<'dialog' | 'page'>('dialog');
  readonly isPage = computed(() => this.layout() === 'page');
  /** The operator asked to continue this edit on the full page. */
  pageRequested = output<void>();

  savingTemplate = signal(false);
  /** Name being typed for "Save as template…"; null while that panel is closed. */
  templateNameDraft = signal<string | null>(null);
  templateError = signal<string | null>(null);
  cloneOpen = signal(false);
  readonly busy = computed(() => this.saving());
  activeTab = signal<FormTab>('inputs');
  availableTemplates = signal<StrategyTemplateDto[]>([]);
  selectedTemplateId = signal<number | null>(null);

  // Live count of comma-separated symbols typed into the Symbol input —
  // used by the label and submit button to switch between single-create
  // and multi-create messaging without reading the form on every render.
  symbolInputValue = signal<string>('');
  parsedSymbols = computed<string[]>(() => {
    const raw = this.symbolInputValue();
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
  });

  // Typed parameter schema for the currently-selected StrategyType (when one
  // is registered server-side — today only CompositeML; the event / carry /
  // order-flow types that had schemas are retired). Drives the typed-input form
  // above the Parameters JSON textarea, so operators don't need to know the
  // JSON shape.
  parameterSchema = signal<StrategyParameterSchemaDto | null>(null);
  parameterValues = signal<Record<string, unknown>>({});

  // ── Form values mirrored as signals (the reactive form is not signal-based) ─
  readonly paramsJson = signal('');
  readonly strategyTypeValue = signal('RuleBased');
  readonly formTimeframe = signal<string | null>('H1');
  readonly formName = signal<string | null>(null);
  private readonly formValue = signal<Record<string, any>>({});
  /** The symbol the rules should name: the strategy's, or the first one typed. */
  readonly primarySymbol = computed<string | null>(
    () => this.strategy()?.symbol ?? this.parsedSymbols()[0] ?? null,
  );

  /// Free-text reason for the next update — stored on the auto-captured pre-edit version row so operators
  /// see why the change was made. (The version-history drawer is `app-strategy-version-history`.)
  updateChangeReason = signal('');
  /** U13 (fu-ui): the version-history drawer (rendered for an existing strategy). */
  private readonly versionHistory = viewChild(StrategyVersionHistoryComponent);
  /// The form's current values in the shape a captured version records —
  /// what the version-diff panel compares the selected version against.
  readonly currentVersionFields = computed<StrategyVersionFields>(() => {
    const v = this.formValue();
    const text = (x: unknown) => (typeof x === 'string' ? x : null);
    // PE-02: the script and its inputs as the editor holds them (inputs as they run: coerced to
    // what the script declares, defaults left out), so a script-only edit is a difference too.
    const script = this.isScriptAuthoring() ? this.scriptDraft() : null;
    return {
      name: text(v['name']),
      description: text(v['description']),
      parametersJson: text(v['parametersJson']),
      riskProfileId: typeof v['riskProfileId'] === 'number' ? v['riskProfileId'] : null,
      riskOverridesJson: text(v['riskOverridesJson']),
      sizingConfigJson: text(v['sizingConfigJson']),
      sessionFilterJson: text(v['sessionFilterJson']),
      regimeGateJson: text(v['regimeGateJson']),
      multiTimeframeGateJson: text(v['multiTimeframeGateJson']),
      scriptSource: script?.source ?? this.strategy()?.scriptSource ?? null,
      scriptInputs: script
        ? (this.scriptPanel()?.effectiveInputs() ?? script.inputs)
        : (parseSavedInputs(this.strategy()?.scriptInputs) ?? null),
    };
  });

  /** Wire units: winRate is a FRACTION, profitFactor 9999 = no losing trades. */
  readonly strategyTypes = STRATEGY_TYPES;
  readonly classicHint = CLASSIC_PINE_LIBRARY_HINT;
  readonly eventHint = EVENT_PINE_HINT;

  /** Creatable types, plus the current value when it is a retired one (historical row). */
  strategyTypeOptions(): readonly string[] {
    const current = this.strategyTypeValue();
    return !current || (STRATEGY_TYPES as readonly string[]).includes(current)
      ? STRATEGY_TYPES
      : [...STRATEGY_TYPES, current];
  }
  readonly timeframes = TIMEFRAMES;
  readonly timeframeLabels = TIMEFRAME_LABELS;
  readonly placeholders = SUB_CONFIG_PLACEHOLDERS;
  readonly schemas = SUB_CONFIG_SCHEMAS;

  form!: FormGroup;

  ngOnInit(): void {
    this.form = this.fb.group({
      name: ['', Validators.required],
      symbol: ['', Validators.required],
      timeframe: ['H1'],
      strategyType: ['RuleBased'],
      parametersJson: [''],
      riskProfileId: [null],
      description: [''],
      // Phase-1 typed sub-config fields. All optional; submitted as null when empty.
      riskOverridesJson: [''],
      sizingConfigJson: [''],
      sessionFilterJson: [''],
      regimeGateJson: [''],
      multiTimeframeGateJson: [''],
    });

    // Lazy-load template chooser the first time the modal mounts. Volume is
    // operator-curated (typically <50 templates) so a single fetch is fine.
    this.strategiesService.listTemplates().subscribe({
      next: (res) => this.availableTemplates.set(loadableTemplates(res?.data)),
      error: () => this.availableTemplates.set([]),
    });

    // Mirror the symbol field into a signal so the parsedSymbols computed
    // updates as the operator types — drives the multi-symbol label and the
    // submit button's "Create N strategies" copy.
    this.form.get('symbol')?.valueChanges.subscribe((value: string) => {
      this.symbolInputValue.set(value ?? '');
      this.refreshAutoName();
    });
    this.form.get('strategyType')?.valueChanges.subscribe((value: string) => {
      this.strategyTypeValue.set(value ?? '');
      this.refreshAutoName();
    });
    this.form.get('timeframe')?.valueChanges.subscribe((value: string) => {
      this.formTimeframe.set(value ?? null);
      this.refreshAutoName();
    });
    this.form
      .get('name')
      ?.valueChanges.subscribe((value: string) => this.formName.set(value ?? null));
    this.form.valueChanges.subscribe((value) => this.formValue.set(value ?? {}));

    // Lazy-load risk profiles + currency pairs for the Inputs-tab pickers.
    // 200-row caps are plenty for the catalogue sizes operators see in
    // practice; if either list grows past that we'd switch to a search box.
    this.riskProfilesService.list({ currentPage: 1, itemCountPerPage: 200 }).subscribe({
      next: (res) => this.riskProfiles.set(res?.data?.data ?? []),
      error: () => this.riskProfiles.set([]),
    });
    this.currencyPairsService
      .list({ currentPage: 1, itemCountPerPage: 200, filter: { isActive: true } })
      .subscribe({
        next: (res) => this.currencyPairs.set(res?.data?.data ?? []),
        error: () => this.currencyPairs.set([]),
      });

    this.form.get('parametersJson')?.valueChanges.subscribe((raw: string) => {
      this.paramsJson.set(raw ?? '');
    });

    // Re-fetch the typed parameter schema whenever the StrategyType changes.
    // Schema is registered server-side per type; null = fall back to free-form
    // JSON textarea (existing behaviour).
    this.form.get('strategyType')?.valueChanges.subscribe((value: string) => {
      if (!value) {
        this.parameterSchema.set(null);
        return;
      }
      this.strategiesService.getParameterSchema(value).subscribe({
        next: (res) => {
          this.parameterSchema.set(res?.data ?? null);
          // Hydrate typed inputs from the current ParametersJson when possible
          // so the user doesn't lose values when switching schemas.
          const raw = this.form.get('parametersJson')?.value as string;
          if (raw) {
            try {
              this.parameterValues.set(JSON.parse(raw));
            } catch {
              this.parameterValues.set({});
            }
          } else {
            this.parameterValues.set({});
          }
        },
        error: () => this.parameterSchema.set(null),
      });
    });
    // Trigger once for the initial StrategyType.
    const initialType = this.form.get('strategyType')?.value;
    if (initialType) this.form.get('strategyType')?.setValue(initialType);

    // A strategy bound before the form existed (ngOnChanges runs before
    // ngOnInit) is applied now.
    this.applyStrategy();
  }

  /** Copies the form's values into the signals the template and checks read. */
  private syncSignalsFromForm(): void {
    const v = this.form.getRawValue();
    this.paramsJson.set(v.parametersJson ?? '');
    this.strategyTypeValue.set(v.strategyType ?? '');
    this.formTimeframe.set(v.timeframe ?? null);
    this.formName.set(v.name ?? null);
    this.symbolInputValue.set(v.symbol ?? '');
    this.formValue.set(v);
  }

  /**
   * Updates a single typed parameter and pushes the merged JSON into the
   * Parameters JSON textarea — the textarea stays the source of truth so the
   * existing submit pipeline doesn't need rewiring.
   */
  setParameter(name: string, value: unknown): void {
    const merged = { ...this.parameterValues(), [name]: value };
    this.parameterValues.set(merged);
    this.form.patchValue({ parametersJson: JSON.stringify(merged, null, 2) });
  }

  parameterValueOrDefault(field: StrategyParameterFieldDto): unknown {
    const map = this.parameterValues();
    return field.name in map ? map[field.name] : field.default;
  }

  /**
   * Pretty-print the Parameters JSON via the browser's built-in JSON.parse +
   * JSON.stringify roundtrip. Two-space indentation matches the placeholders
   * placeholders; preserves field order as-is. Reverts the edit on parse
   * error so the user keeps their (possibly unfinished) original text.
   */
  formatParametersJson(): void {
    const raw = this.form.get('parametersJson')?.value as string;
    if (!raw || !raw.trim()) return;
    try {
      const parsed = JSON.parse(raw);
      this.form.patchValue({ parametersJson: JSON.stringify(parsed, null, 2) });
      this.notifications.success('Formatted');
    } catch {
      this.notifications.error('JSON parse error — fix the syntax first');
    }
  }

  /** Asked by the version-history drawer at confirm time: would a rollback replace an unsaved script edit? */
  readonly scriptEditPending = (): boolean =>
    this.isScriptAuthoring() && (this.scriptAuthoring?.isDirty() ?? false);

  /**
   * A rollback went through and the drawer re-read the strategy: patch the form fields in place so the operator sees
   * the restored values without closing and reopening the modal.
   */
  applyRestoredVersion(restored: StrategyDto): void {
    this.form.patchValue({
      name: restored.name,
      description: restored.description,
      parametersJson: restored.parametersJson ?? '',
      riskProfileId: restored.riskProfileId,
      riskOverridesJson: restored.riskOverridesJson ?? '',
      sizingConfigJson: restored.sizingConfigJson ?? '',
      sessionFilterJson: restored.sessionFilterJson ?? '',
      regimeGateJson: restored.regimeGateJson ?? '',
      multiTimeframeGateJson: restored.multiTimeframeGateJson ?? '',
    });
    // PE-03: the editor shows the restored script and saves from its revision — the
    // next save must not quietly put the rolled-back script back.
    this.scriptAuthoring?.applySaved(restored);
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Only a new strategy or the modal opening/closing re-seeds the form. The
    // parent-driven `saving` / `submitError` inputs change mid-edit, and
    // resetting then would throw away exactly the edits a refused save needs
    // the operator to fix.
    if (changes['strategy'] || changes['open']) this.applyStrategy();
    if (changes['open'] && this.open()) this.scriptSaveUnreported = false;
  }

  /** Seeds the form from the bound strategy (edit) or resets it (create). */
  private applyStrategy(): void {
    const s = this.strategy();
    // Reset version-history drawer when the focused strategy changes — stale
    // versions from a previously edited row would mislead the operator.
    this.versionHistory()?.reset();
    this.leaving = false;
    this.templateNameDraft.set(null);
    this.templateError.set(null);
    this.updateChangeReason.set('');
    this.cloneOpen.set(false);
    if (s && this.form) {
      // Edit mode: keep the strategy's existing name; auto-generation off.
      this.nameAutoGenerated.set(false);
      this.form.patchValue({
        name: s.name,
        symbol: s.symbol,
        timeframe: s.timeframe,
        strategyType: s.strategyType,
        parametersJson: s.parametersJson ?? '',
        riskProfileId: s.riskProfileId,
        description: s.description,
        riskOverridesJson: s.riskOverridesJson ?? '',
        sizingConfigJson: s.sizingConfigJson ?? '',
        sessionFilterJson: s.sessionFilterJson ?? '',
        regimeGateJson: s.regimeGateJson ?? '',
        multiTimeframeGateJson: s.multiTimeframeGateJson ?? '',
      });
    } else if (this.form) {
      // Create mode reset: re-arm auto-generation for the next operator.
      this.nameAutoGenerated.set(true);
      this.form.reset({
        name: '',
        symbol: '',
        timeframe: 'H1',
        strategyType: 'RuleBased',
        parametersJson: '',
        riskProfileId: null,
        description: '',
        riskOverridesJson: '',
        sizingConfigJson: '',
        sessionFilterJson: '',
        regimeGateJson: '',
        multiTimeframeGateJson: '',
      });
      this.activeTab.set('inputs');
      this.selectedTemplateId.set(null);
    }
    if (this.form) {
      this.form.markAsPristine();
      this.syncSignalsFromForm();
    }
  }

  formatType(type: string): string {
    const label = type.replace(/([A-Z])/g, ' $1').trim();
    return isRetiredStrategyType(type) ? `${label} (retired)` : label;
  }

  /**
   * Operator typed into the Name field — flip the auto-generated flag off so
   * subsequent symbol/strategyType/timeframe edits don't overwrite their
   * choice. Edit-mode of an existing strategy starts with auto OFF (we
   * already have a real name).
   */
  onNameTyped(): void {
    this.nameAutoGenerated.set(false);
  }

  /**
   * Recompute the auto-generated name from the current symbol/timeframe/
   * strategyType. Skipped once {@link nameAutoGenerated} is false (operator
   * has typed something) or in edit-mode (we have a real name to keep).
   * Pattern: "{firstSymbol} {timeframe} {short-type}" — e.g.
   * "EURUSD H1 MA Crossover" — readable enough for the strategies list.
   * For multi-symbol bulk-create, the first symbol is used as the seed and
   * the parent component's onCreate fan-out re-derives per-symbol names.
   */
  private refreshAutoName(): void {
    if (!this.nameAutoGenerated() || this.strategy()) return;
    const v = this.form?.value ?? {};
    const symbols = this.parsedSymbols();
    const firstSym = symbols[0] ?? '';
    if (!firstSym) return;
    const tf = String(v.timeframe ?? '');
    const typeShort = this.shortTypeLabel(String(v.strategyType ?? ''));
    const next = [firstSym, tf, typeShort].filter(Boolean).join(' ');
    this.form.patchValue({ name: next }, { emitEvent: false });
  }

  /// Compact label for auto-generated names. Maps verbose enum names to
  /// the conventional acronym ("MovingAverageCrossover" → "MA Crossover")
  /// so generated names stay readable in the strategies list.
  private shortTypeLabel(type: string): string {
    const map: Record<string, string> = {
      MovingAverageCrossover: 'MA Crossover',
      RSIReversion: 'RSI',
      BreakoutScalper: 'Breakout',
      BollingerBandReversion: 'BB Reversion',
      MACDDivergence: 'MACD',
      SessionBreakout: 'Session BO',
      MomentumTrend: 'Momentum',
      CompositeML: 'CompML',
      StatisticalArbitrage: 'StatArb',
      VwapReversion: 'VWAP',
      CalendarEffect: 'Calendar',
      NewsFade: 'News',
      CarryTrade: 'Carry',
      WeekendGapFade: 'Gap Fade',
      RoundNumberFade: 'Round#',
      WedgeBreakout: 'Wedge',
      CrossAssetLeadLag: 'LeadLag',
      OrderFlowImbalance: 'OFI',
      SubMinuteEvent: 'SubMin',
      LlmProposal: 'LLM',
      RuleBased: 'Rule',
      CmeDeepBookOrderflow: 'CME OF',
      Custom: 'Custom',
    };
    return map[type] ?? this.formatType(type);
  }

  /**
   * Hydrate the form from a template — does NOT touch Symbol or Name (those are
   * always strategy-specific). Operators usually load a template, then tweak the
   * symbol + give the new strategy a fresh name. Pre-filling those would be wrong.
   */
  onTemplateSelect(rawId: string): void {
    if (!rawId) {
      this.selectedTemplateId.set(null);
      return;
    }
    const id = Number(rawId);
    if (!Number.isFinite(id)) return;
    const t = this.availableTemplates().find((x) => x.id === id);
    if (!t) return;
    this.selectedTemplateId.set(id);
    this.form.patchValue({
      strategyType: t.strategyType,
      parametersJson: t.parametersJson ?? '',
      riskProfileId: t.riskProfileId,
      riskOverridesJson: t.riskOverridesJson ?? '',
      sizingConfigJson: t.sizingConfigJson ?? '',
      sessionFilterJson: t.sessionFilterJson ?? '',
      regimeGateJson: t.regimeGateJson ?? '',
      multiTimeframeGateJson: t.multiTimeframeGateJson ?? '',
      description: t.description ?? this.form.get('description')?.value,
    });
    this.notifications.success(`Loaded template: ${t.name}`);
  }

  /**
   * Opens the inline "Save as template" panel, pre-filled with the strategy
   * name + " template" (so "EURUSD MA Cross" proposes "EURUSD MA Cross
   * template"). The engine's verdict — e.g. a name clash — shows in the panel.
   */
  saveAsTemplate(): void {
    if (this.form.invalid) return;
    const baseName = (this.form.value.name as string)?.trim() || 'Untitled';
    this.templateError.set(null);
    this.templateNameDraft.set(`${baseName} template`);
  }

  cancelSaveTemplate(): void {
    if (this.savingTemplate()) return;
    this.templateNameDraft.set(null);
    this.templateError.set(null);
  }

  confirmSaveTemplate(): void {
    const name = this.templateNameDraft()?.trim();
    if (!name || this.savingTemplate()) return;
    const val = this.form.getRawValue();
    const data: CreateStrategyTemplateRequest = {
      name,
      description: val.description || null,
      strategyType: val.strategyType,
      parametersJson: val.parametersJson || '{}',
      riskProfileId: val.riskProfileId || null,
      riskOverridesJson: val.riskOverridesJson || null,
      sizingConfigJson: val.sizingConfigJson || null,
      sessionFilterJson: val.sessionFilterJson || null,
      regimeGateJson: val.regimeGateJson || null,
      multiTimeframeGateJson: val.multiTimeframeGateJson || null,
    };

    this.savingTemplate.set(true);
    this.templateError.set(null);
    this.strategiesService.createTemplate(data, { silent: true }).subscribe({
      next: (res) => {
        this.savingTemplate.set(false);
        if (res?.status) {
          this.notifications.success(`Template '${name}' saved`);
          this.templateNameDraft.set(null);
          // Refresh dropdown so the new template appears immediately.
          this.strategiesService.listTemplates().subscribe({
            next: (list) => this.availableTemplates.set(loadableTemplates(list?.data)),
          });
        } else {
          this.templateError.set(failureMessage(res, 'The engine did not save the template.'));
        }
      },
      error: (err) => {
        this.savingTemplate.set(false);
        this.templateError.set(failureMessage(err, 'Saving the template failed.'));
      },
    });
  }

  /**
   * True for a legacy JSON-rules row: the engine refuses to save a RuleBased / LlmProposal
   * strategy without a script, so the form stays read-only until it is rewritten in Pine.
   */
  saveBlocked(): boolean {
    return this.isLegacyRules();
  }

  /** Why Save is disabled, for its tooltip; null when it is not. */
  saveBlockedReason(): string | null {
    if (this.saveBlocked()) return 'Legacy JSON rules no longer run — rewrite the strategy in Pine';
    if (this.form?.invalid) return 'Fill in the required fields';
    return null;
  }

  /** True when the form holds edits that are not saved yet. */
  formDirty(): boolean {
    const s = this.strategy();
    if (!s || !this.form) return false;
    return this.form.dirty || this.paramsJson() !== (s.parametersJson ?? '');
  }

  onSubmit(): void {
    if (this.form.invalid || this.busy() || this.saveBlocked()) return;
    this.emitSubmit();
  }

  private emitSubmit(): void {
    const val = this.form.getRawValue();
    const s = this.strategy();
    if (s) {
      const update: UpdateStrategyRequest = {
        ...this.metadataUpdate(s),
        parametersJson: (val.parametersJson as string)?.trim() ? val.parametersJson : '{}',
      };
      this.submitted.emit(update);
      return;
    }
    // The Symbol field accepts comma-separated values; split here rather than
    // at submit time downstream so the parent can decide whether to fan-out
    // to N create calls or send a single one. The Strategy entity itself is
    // single-symbol — bulk create is N round-trips.
    const symbols = (val.symbol as string)
      .split(',')
      .map((x) => x.trim().toUpperCase())
      .filter((x) => x.length > 0);
    const data: any = {
      name: val.name,
      description: this.createDescription(),
      strategyType: val.strategyType,
      // For single-symbol back-compat the request still carries `symbol`. For
      // multi-symbol the parent component reads the new `symbols` field and
      // fans out one create call per symbol.
      symbol: symbols[0] ?? val.symbol,
      symbols,
      timeframe: val.timeframe,
      parametersJson: val.parametersJson || null,
      riskProfileId: val.riskProfileId || null,
      riskOverridesJson: val.riskOverridesJson || null,
      sizingConfigJson: val.sizingConfigJson || null,
      sessionFilterJson: val.sessionFilterJson || null,
      regimeGateJson: val.regimeGateJson || null,
      multiTimeframeGateJson: val.multiTimeframeGateJson || null,
    };
    this.submitted.emit(data);
  }

  /**
   * `PUT strategy/{id}` fields shared by the rules and script modes. Symbol, timeframe and type
   * are immutable — never sent. Null leaves a field unchanged, so the sub-configs go as strings
   * ('' clears one) and a removed risk profile goes as the engine's 0 sentinel.
   */
  private metadataUpdate(s: StrategyDto): UpdateStrategyRequest {
    const val = this.form.getRawValue();
    return {
      name: val.name,
      description: val.description ?? '',
      riskProfileId: val.riskProfileId ?? (s.riskProfileId != null ? 0 : null),
      riskOverridesJson: val.riskOverridesJson ?? '',
      sizingConfigJson: val.sizingConfigJson ?? '',
      sessionFilterJson: val.sessionFilterJson ?? '',
      regimeGateJson: val.regimeGateJson ?? '',
      multiTimeframeGateJson: val.multiTimeframeGateJson ?? '',
      changeReason: this.updateChangeReason()?.trim() || null,
    };
  }

  /** The engine requires a description on create; the name stands in for a blank one. */
  private createDescription(): string {
    const val = this.form.getRawValue();
    return (val.description as string)?.trim() || val.name;
  }

  // ── Clone ─────────────────────────────────────────────────

  openClone(): void {
    this.cloneOpen.set(true);
  }

  /** The clone dialog opened the new strategy; this modal is done. */
  onCloned(): void {
    this.cloneOpen.set(false);
    this.cancelled.emit();
  }

  /**
   * Switching to the full page re-opens the strategy there. An unsaved script edit travels — it
   * is kept in this browser and the full page offers to restore it; changes to the settings in
   * this dialog do not, so they are confirmed first.
   */
  async requestPage(): Promise<void> {
    if (this.formDirty()) {
      const scriptEdited = this.scriptAuthoring?.isDirty() ?? false;
      const ok = await this.dialogs.confirm({
        title: 'Open the full page?',
        message:
          'Changes to the strategy settings in this dialog are not carried over to the full page.' +
          (scriptEdited ? ' Your script edit is: the full page offers to restore it.' : ''),
        confirmLabel: 'Open the full page',
        cancelLabel: 'Stay here',
        tone: 'danger',
      });
      if (!ok) return;
    }
    this.leaving = true;
    this.pageRequested.emit();
  }

  // ── Unsaved changes (PE-06) ─────────────────────────────────────────────
  // Closing the dialog (×, Cancel, Escape, a click outside), leaving the edit page and closing the
  // browser tab all ask before an unsaved edit is thrown away. The script edit is also kept in this
  // browser while it is unsaved (the script panel's local draft), so even a crash loses nothing.

  /** The form closes on its own (after a save, or a confirmed discard): nothing left to ask. */
  private leaving = false;

  private readonly dialogs = inject(ScriptDialogService);

  // Closing or reloading the tab while the form holds an unsaved edit asks the browser's question.
  private readonly unloadGuard = warnBeforeUnload(() => this.hasUnsavedChanges());

  /** The form holds an edit not saved yet (settings or script). */
  hasUnsavedChanges(): boolean {
    if (!this.open() || this.leaving || !this.form) return false;
    return this.settingsEdited() || this.scriptEdited();
  }

  /** What is unsaved, in the operator's words. */
  unsavedChangesNote(): string {
    const settings = this.settingsEdited();
    const script = this.scriptEdited();
    if (settings && script) return 'The script and the strategy settings have unsaved changes';
    return script ? 'The script has unsaved changes' : 'The strategy settings have unsaved changes';
  }

  private settingsEdited(): boolean {
    return this.strategy() ? this.formDirty() : !!this.form?.dirty;
  }

  private scriptEdited(): boolean {
    return this.isScriptAuthoring() && (this.scriptAuthoring?.isDirty() ?? false);
  }

  /** True while an Escape-triggered close is asking "discard changes?" — one prompt at a time. */
  private escapePrompting = false;

  /**
   * Escape closes the dialog. The overlay's (keydown.escape) never fired: the dialog swallowed every
   * keydown, and right after opening focus is still on the button that opened it. Escape is handled
   * here (focus inside) and on the document (focus outside); an Escape an inner widget already used
   * — the editor's completion list — is left alone.
   */
  onDialogKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.defaultPrevented) void this.escapeClose();
  }

  onDocumentEscape(event: Event): void {
    if (!event.defaultPrevented) void this.escapeClose();
  }

  private async escapeClose(): Promise<void> {
    if (!this.open() || this.isPage() || this.escapePrompting) return;
    this.escapePrompting = true;
    try {
      await this.requestClose();
    } finally {
      this.escapePrompting = false;
    }
  }

  /** ×, Cancel, Escape or a click outside the dialog: asks first when something is unsaved. */
  async requestClose(): Promise<void> {
    if (this.busy()) return;
    if (this.hasUnsavedChanges()) {
      if (!(await confirmDiscard(this.dialogs, this.unsavedChangesNote()))) return;
      this.scriptAuthoring?.discardLocalDraft();
    }
    this.leaving = true;
    this.onCancel();
  }

  /** ⌘S / Ctrl-S in the script editor: the same save as the Update / Create button. */
  onSaveShortcut(): void {
    if (this.busy() || !this.form || this.form.invalid || this.saveBlocked()) return;
    if (this.isScriptAuthoring()) void this.submitScript();
  }

  onCancel(): void {
    if (this.scriptSaveUnreported) {
      // The script was saved but the metadata update after it was refused: the host still
      // shows the old script until it re-reads the strategy.
      this.scriptSaveUnreported = false;
      this.strategyChanged.emit();
    }
    this.cancelled.emit();
  }

  // ── Pine script authoring ───────────────────────────────────────────────
  // RuleBased / LlmProposal strategies are authored as Pine v6 scripts (a
  // saved row still on the retired JSON rules DSL is legacy, read-only). The
  // mode and the script draft are re-derived whenever the form
  // opens or is pointed at another strategy; the draft lives here so the
  // script panel keeps it across the form's tab switches.
  //
  // Script mode submits through submitScript(): create posts scriptSource /
  // scriptInputs / executionPolicy (contract §8) through the ordinary
  // `submitted` output; edit saves the script itself with
  // PUT strategy/{id}/script (compile + version capture + live restart) and
  // then emits the ordinary metadata update only when the form changed. An
  // existing strategy's execution policy is changed on its Execution tab.

  readonly authoringMode = linkedAuthoringMode(
    () => this.strategy(),
    () => this.open(),
  );
  readonly scriptDraft = linkedScriptDraft(
    () => this.strategy(),
    () => this.open(),
  );
  private scriptSubmitting = false;
  /** The script was saved in this edit, but the host has not re-read the strategy since. */
  private scriptSaveUnreported = false;
  @ViewChild(ScriptAuthoringComponent) private scriptAuthoring?: ScriptAuthoringComponent;
  /** The script panel as a signal query, for hosts that react to it appearing (the assistant). */
  readonly scriptPanel = viewChild(ScriptAuthoringComponent);

  /** The strategy being edited — or the type being created — is authored in Pine. */
  isRuleBased(): boolean {
    // The mirrored signal (not the form control) so an OnPush render follows a type change.
    const type = this.strategy()?.strategyType ?? this.strategyTypeValue();
    return PINE_STRATEGY_TYPES.includes(type);
  }

  /** The form is authoring a Pine script. */
  isScriptAuthoring(): boolean {
    return this.authoringMode() === 'script' && this.isRuleBased();
  }

  /** A saved RuleBased / LlmProposal row still on the retired JSON rules — read-only. */
  isLegacyRules(): boolean {
    return !!this.strategy() && this.authoringMode() === 'legacy' && this.isRuleBased();
  }

  /** The symbol the script compiles and previews against (the first one typed, when creating). */
  scriptSymbol(): string | null {
    return this.strategy()?.symbol ?? this.parsedSymbols()[0] ?? null;
  }

  scriptTimeframe(): string | null {
    return this.strategy()?.timeframe ?? this.form?.get('timeframe')?.value ?? null;
  }

  /**
   * Edit mode: the policy lives on the strategy's Execution tab (it takes effect on the next
   * signal and is confirmed there). Leaving would drop this edit, so unsaved changes stay put.
   */
  onExecutionRequested(): void {
    if (this.formDirty() || this.scriptAuthoring?.isDirty()) {
      this.notifications.info(
        "Save or cancel this edit first — the execution policy is changed on the strategy's Execution tab.",
      );
      return;
    }
    this.executionRequested.emit();
  }

  /** Submit in script mode — see the block comment above. */
  async submitScript(): Promise<void> {
    const panel = this.scriptAuthoring;
    if (!panel || this.scriptSubmitting || this.form.invalid) return;
    this.scriptSubmitting = true;
    try {
      const script = await panel.prepareSubmit();
      if (!script) return;
      const val = this.form.getRawValue();
      const existing = this.strategy();
      if (!existing) {
        const symbols = this.parsedSymbols();
        const create: CreateStrategyRequest & { symbols: string[] } = {
          name: val.name,
          description: this.createDescription(),
          riskProfileId: val.riskProfileId || null,
          riskOverridesJson: val.riskOverridesJson || null,
          sizingConfigJson: val.sizingConfigJson || null,
          sessionFilterJson: val.sessionFilterJson || null,
          regimeGateJson: val.regimeGateJson || null,
          multiTimeframeGateJson: val.multiTimeframeGateJson || null,
          strategyType: PINE_STRATEGY_TYPES.includes(val.strategyType)
            ? val.strategyType
            : 'RuleBased',
          symbol: symbols[0] ?? val.symbol,
          symbols,
          timeframe: val.timeframe,
          scriptSource: script.source,
          scriptInputs: script.inputs,
          executionPolicy: script.executionPolicy,
        };
        this.submitted.emit(create);
        return;
      }
      const scriptChanged = panel.isDirty();
      if (
        scriptChanged &&
        !(await panel.saveScript(existing.id, script, this.updateChangeReason()))
      )
        return;
      if (this.form.dirty) {
        // Metadata only: the script went through its own endpoint, and
        // parametersJson is left out so the (empty) rules stay untouched. The
        // host re-reads the strategy once the update lands (or on cancel).
        this.scriptSaveUnreported = scriptChanged;
        this.submitted.emit(this.metadataUpdate(existing));
      } else {
        if (scriptChanged) {
          this.notifications.success('Script saved — live sessions pick it up at the next bar');
          this.strategyChanged.emit();
        }
        this.leaving = true;
        this.cancelled.emit();
      }
    } finally {
      this.scriptSubmitting = false;
    }
  }

  /**
   * The assistant's `strategy.save`: records the change reason, then runs the same path as the
   * Save button ({@link submitScript}) and reports what happened.
   */
  async saveScriptForAssistant(reason: string): Promise<{ ok: boolean; message: string }> {
    this.updateChangeReason.set(reason);
    const panel = this.scriptAuthoring;
    if (!panel || !this.isScriptAuthoring())
      return { ok: false, message: 'The script editor is not open.' };
    if (this.scriptSubmitting) return { ok: false, message: 'A save is already in progress.' };
    if (this.form.invalid) {
      return {
        ok: false,
        message: 'The strategy form has invalid fields; fix them before saving.',
      };
    }
    const scriptChanged = panel.isDirty();
    if (!scriptChanged && !this.form.dirty) {
      return { ok: true, message: 'Nothing to save: the script matches the saved version.' };
    }
    await this.submitScript();
    const problem = panel.message();
    if (problem) return { ok: false, message: problem };
    return {
      ok: true,
      message: scriptChanged
        ? `Saved the script (reason: "${reason}"). Live sessions pick it up at the next bar.`
        : `Sent the strategy update (reason: "${reason}").`,
    };
  }
}
