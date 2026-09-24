import {
  ChangeDetectionStrategy,
  Component,
  ViewChild,
  computed,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';
import type {
  ScriptCompileResult,
  ScriptExecutionPolicy,
  ScriptInputValues,
  ScriptRunResult,
} from '@core/api/scripting.types';
import { ScriptingService, toScriptingError } from '@core/services/scripting.service';
import { inputOverrides, resolveInputValues } from '../../pine/pine-inputs';
import { DeclarationSummaryComponent } from '../declaration-summary/declaration-summary.component';
import { InputsFormComponent } from '../inputs-form/inputs-form.component';
import { ScriptPreviewComponent } from '../script-preview/script-preview.component';
import { ScriptWorkbenchComponent } from '../script-workbench/script-workbench.component';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';
import { draftFor, type ScriptDraft } from './authoring-mode';

type SideTab = 'inputs' | 'properties' | 'preview';

function sameInputs(a: ScriptInputValues, b: ScriptInputValues): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/**
 * "Script (Pine v6)" authoring for a RuleBased strategy, inside the strategy form: the editor
 * with live compile diagnostics, the declaration read from `strategy()`, the inputs settings form,
 * the execution policy and a Preview run.
 *
 * The draft lives in the parent form (two-way `draft`), so it survives the form's tab switches.
 * The form calls {@link prepareSubmit} before creating a strategy and {@link saveScript} to save
 * an existing one's script (`PUT strategy/{id}/script`).
 */
@Component({
  selector: 'app-script-authoring',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ScriptWorkbenchComponent,
    InputsFormComponent,
    DeclarationSummaryComponent,
    ScriptPreviewComponent,
  ],
  template: `
    <div class="authoring-grid">
      <div class="col-editor">
        <app-script-workbench
          [source]="draft().source"
          (sourceChange)="setSource($event)"
          [symbol]="symbol()"
          [timeframe]="timeframe()"
          [fileName]="fileName()"
          editorHeight="470px"
          (compiled)="onCompiled($event)"
        />
      </div>
      <div class="col-side">
        <div class="side-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class="side-tab"
            [class.is-active]="tab() === 'inputs'"
            [attr.aria-selected]="tab() === 'inputs'"
            (click)="tab.set('inputs')"
          >
            Inputs
            @if (inputCount()) {
              <span class="count">{{ inputCount() }}</span>
            }
          </button>
          <button
            type="button"
            role="tab"
            class="side-tab"
            [class.is-active]="tab() === 'properties'"
            [attr.aria-selected]="tab() === 'properties'"
            (click)="tab.set('properties')"
          >
            Properties
          </button>
          <button
            type="button"
            role="tab"
            class="side-tab"
            [class.is-active]="tab() === 'preview'"
            [attr.aria-selected]="tab() === 'preview'"
            (click)="tab.set('preview')"
          >
            Preview
          </button>
        </div>

        <div class="side-body">
          @switch (tab()) {
            @case ('inputs') {
              @if (showingStaleInputs()) {
                <p class="note">Showing the inputs from the last compile without errors.</p>
              }
              <app-inputs-form
                [inputs]="shown()?.inputs ?? []"
                [overrides]="draft().inputs"
                (overridesChange)="setInputs($event)"
                [emptyText]="
                  shown()
                    ? 'This script declares no inputs.'
                    : 'Inputs appear once the script compiles.'
                "
              />
            }
            @case ('properties') {
              <app-declaration-summary [declaration]="shown()?.declaration ?? null" />
              <div class="policy">
                <label class="policy-label" for="script-execution-policy">Execution policy</label>
                @if (strategy()) {
                  <span class="chip chip-accent">{{ draft().executionPolicy }}</span>
                  <span class="muted small"
                    >Changed from the strategy's bindings &amp; policy settings.</span
                  >
                } @else {
                  <select
                    id="script-execution-policy"
                    class="field-input"
                    [value]="draft().executionPolicy"
                    (change)="setPolicy($any($event.target).value)"
                  >
                    <option value="Direct" [selected]="draft().executionPolicy === 'Direct'">
                      Direct — hard safety and risk gates only
                    </option>
                    <option value="Standard" [selected]="draft().executionPolicy === 'Standard'">
                      Standard — every signal gate
                    </option>
                  </select>
                }
                <p class="muted small policy-help">
                  Direct keeps live trading equal to the backtest: only kill switches, EA safety,
                  the risk checker and account caps apply. Exits are never blocked by entry gates.
                </p>
              </div>
            }
            @case ('preview') {
              <app-script-preview
                [source]="draft().source"
                [inputs]="draft().inputs"
                [symbol]="symbol()"
                [timeframe]="timeframe()"
                [kind]="shown()?.declaration?.kind ?? null"
                (reveal)="workbench?.reveal($event.line, $event.column)"
                (result)="previewResult.emit($event)"
              >
                <ng-content select="[scriptChartOverlay]" />
              </app-script-preview>
            }
          }
        </div>

        @if (phase() !== 'idle') {
          <p class="phase muted small">
            <span class="spinner"></span>
            {{ phase() === 'validating' ? 'Compiling before saving…' : 'Saving the script…' }}
          </p>
        }
        @if (message(); as m) {
          <div class="error-box" role="alert">{{ m }}</div>
        }
      </div>
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
        margin-bottom: var(--space-4, 16px);
      }
      .authoring-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.65fr) minmax(300px, 1fr);
        gap: 16px;
        align-items: start;
      }
      @media (max-width: 1000px) {
        .authoring-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .col-side {
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
      }
      .side-tabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--border);
      }
      .side-tab {
        padding: 6px 12px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      .side-tab.is-active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
      .count {
        font-size: 10px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .side-body {
        max-height: 520px;
        overflow-y: auto;
        padding-right: 2px;
      }
      .note {
        margin: 0 0 6px;
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .policy {
        margin-top: 14px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 10px;
      }
      .policy-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
      }
      .policy-help {
        flex-basis: 100%;
        margin: 0;
      }
      .phase {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0;
      }
    `,
  ],
})
export class ScriptAuthoringComponent {
  /** The script being written (owned by the form, two-way). */
  readonly draft = model<ScriptDraft>(draftFor(null));
  /** The strategy being edited; null when creating. */
  readonly strategy = input<StrategyDto | null>(null);
  /** The strategy's symbol and timeframe — used to refine warnings and to run previews. */
  readonly symbol = input<string | null>(null);
  readonly timeframe = input<string | null>(null);
  /** Every preview run's result — for the chart overlay. */
  readonly previewResult = output<ScriptRunResult>();

  @ViewChild(ScriptWorkbenchComponent) workbench?: ScriptWorkbenchComponent;

  private readonly scripting = inject(ScriptingService);
  readonly tab = signal<SideTab>('inputs');
  readonly phase = signal<'idle' | 'validating' | 'saving'>('idle');
  readonly message = signal<string | null>(null);
  /** The latest compile applied to the editor's text. */
  readonly compile = signal<ScriptCompileResult | null>(null);
  /** The latest compile that produced a declaration — what the side panels show. */
  readonly lastGood = signal<ScriptCompileResult | null>(null);
  readonly shown = computed(() => this.lastGood() ?? this.compile());
  readonly showingStaleInputs = computed(
    () => !!this.lastGood() && !!this.compile() && this.compile() !== this.lastGood(),
  );
  readonly inputCount = computed(() => this.shown()?.inputs.length ?? 0);
  readonly fileName = computed(() => {
    const name = this.strategy()?.name?.trim();
    return `${(name || 'strategy').replace(/[^A-Za-z0-9_\- ]+/g, '').replace(/\s+/g, '_')}.pine`;
  });

  setSource(source: string): void {
    if (source === this.draft().source) return;
    this.draft.update((d) => ({ ...d, source }));
    this.message.set(null);
  }

  setInputs(inputs: ScriptInputValues): void {
    this.draft.update((d) => ({ ...d, inputs }));
  }

  setPolicy(policy: ScriptExecutionPolicy): void {
    this.draft.update((d) => ({
      ...d,
      executionPolicy: policy === 'Standard' ? 'Standard' : 'Direct',
    }));
  }

  onCompiled(result: ScriptCompileResult): void {
    this.compile.set(result);
    if (!result.declaration) return;
    this.lastGood.set(result);
    // Keep only overrides the compiled script still declares, coerced to its current ranges.
    const normalised = inputOverrides(
      result.inputs,
      resolveInputValues(result.inputs, this.draft().inputs),
    );
    if (!sameInputs(normalised, this.draft().inputs)) this.setInputs(normalised);
  }

  /** The script or its inputs differ from what the strategy has saved. */
  isDirty(): boolean {
    const saved = draftFor(this.strategy());
    const d = this.draft();
    return d.source !== saved.source || !sameInputs(d.inputs, saved.inputs);
  }

  /**
   * Compiles the script as it stands and returns what to save — or null, with the reason shown
   * in the panel: the engine could not compile it, it has errors, or it is not a `strategy()`.
   */
  async prepareSubmit(): Promise<ScriptDraft | null> {
    this.message.set(null);
    const wb = this.workbench;
    if (!wb) return null;
    this.phase.set('validating');
    try {
      const result = await wb.compileNow();
      if (!result) {
        this.message.set(
          'The engine could not compile the script — it may be unreachable. Try again.',
        );
        return null;
      }
      const errors = result.diagnostics.filter((d) => d.severity === 'error');
      if (errors.length) {
        const first = errors[0];
        this.message.set(
          `Fix ${errors.length} compile error${errors.length === 1 ? '' : 's'} before saving — line ${first.line}: ${first.message}`,
        );
        wb.reveal(first.line, first.column);
        return null;
      }
      if (result.declaration?.kind !== 'strategy') {
        const kind = result.declaration?.kind;
        this.message.set(
          `A strategy script must declare strategy() — this one ${kind ? `declares ${kind}()` : 'has no declaration statement'}.`,
        );
        return null;
      }
      const inputs = inputOverrides(
        result.inputs,
        resolveInputValues(result.inputs, this.draft().inputs),
      );
      return { ...this.draft(), inputs };
    } finally {
      this.phase.set('idle');
    }
  }

  /**
   * `PUT strategy/{id}/script` — the engine compiles, captures a version and restarts the live
   * session at the next bar. A compile refusal marks every diagnostic in the editor.
   */
  async saveScript(strategyId: number, draft: ScriptDraft = this.draft()): Promise<boolean> {
    this.phase.set('saving');
    this.message.set(null);
    try {
      await firstValueFrom(
        this.scripting.updateStrategyScript(strategyId, {
          source: draft.source,
          inputs: draft.inputs,
        }),
      );
      return true;
    } catch (err) {
      const e = toScriptingError(err, 'Saving the script failed.');
      if (e.compile) this.workbench?.showResult(e.compile);
      this.message.set(
        e.code || e.compile ? `The engine refused the script: ${e.message}` : e.message,
      );
      return false;
    } finally {
      this.phase.set('idle');
    }
  }

  /** Shows why the form's own save failed (for refusals the form hears about first). */
  showError(message: string): void {
    this.message.set(message);
  }
}
