import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { StrategyDto } from '@core/api/api.types';
import type {
  ScriptCompileResult,
  ScriptExecutionPolicy,
  ScriptInputValues,
  StrategyScriptRevisionField,
} from '@core/api/scripting.types';
import { ScriptingService, toScriptingError } from '@core/services/scripting.service';
import { StrategiesService } from '@core/services/strategies.service';
import { StrategyExecutionService } from '../../api/strategy-execution.service';
import { EXITS_NEVER_BLOCKED, POLICY_DESCRIPTIONS } from '../../execution/execution.model';
import {
  effectiveOverrides,
  inputOverrides,
  resolveInputValues,
  sameEffectiveInputs,
  sameInputValues,
} from '../../pine/pine-inputs';
import { isOk } from '../../shared/api-error';
import {
  DraftAutosaver,
  clearDraft,
  draftAge,
  draftKey,
  readDraft,
  type ScriptDraftRecord,
} from '../../shared/draft-store';
import { ScriptDialogService } from '../../shared/script-dialog.service';
import { DeclarationSummaryComponent } from '../declaration-summary/declaration-summary.component';
import { InputsFormComponent } from '../inputs-form/inputs-form.component';
import { ScriptPreviewComponent } from '../script-preview/script-preview.component';
import { ScriptWorkbenchComponent } from '../script-workbench/script-workbench.component';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';
import { baseFor, draftFor, type ScriptBase, type ScriptDraft } from './authoring-mode';

type SideTab = 'inputs' | 'properties';

/**
 * "Script (Pine v6)" authoring for a RuleBased strategy, inside the strategy form: the editor
 * with live compile diagnostics, the declaration read from `strategy()`, the inputs settings form,
 * the execution policy and, under them at full width, the Preview (chart, logs, trace, profiler,
 * Bar Replay and the Strategy report of a run).
 *
 * A new strategy's execution policy is picked here; an existing one's is changed on its detail
 * page's Execution tab (`PUT strategy/{id}/execution-policy`), which `executionRequested` asks the
 * host to open.
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
    @if (restorable(); as r) {
      <div class="restore-banner" role="status">
        <span>
          An unsaved edit of this script from {{ draftAgeText(r.savedAt) }} is kept in this browser.
          @if (restoreOverNewer()) {
            The saved script has changed since that edit started — compare before saving.
          }
        </span>
        <span class="restore-actions">
          <button type="button" class="btn btn-sm" (click)="restoreLocalDraft()">Restore it</button>
          <button type="button" class="btn btn-ghost btn-sm" (click)="discardLocalDraft()">
            Discard
          </button>
        </span>
      </div>
    }
    <div class="authoring-grid">
      <div class="col-editor">
        <app-script-workbench
          [source]="draft().source"
          (sourceChange)="setSource($event)"
          [symbol]="symbol()"
          [timeframe]="timeframe()"
          [fileName]="fileName()"
          [editorHeight]="spacious() ? 'max(620px, calc(100vh - 300px))' : '470px'"
          saveShortcut="save"
          (saveRequested)="saveRequested.emit()"
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
        </div>

        <div class="side-body" [class.is-spacious]="spacious()">
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
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    (click)="executionRequested.emit()"
                    title="The policy and the account bindings are changed on the strategy's Execution tab"
                  >
                    Change on the Execution tab…
                  </button>
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
                  {{ policyText(draft().executionPolicy) }} {{ exitsNote }}
                </p>
              </div>
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

    <!-- Preview at full width under the editor: a chart needs the room, and the inputs beside
         the editor stay in view while a run is compared against them. Deferred: the chart, the
         preview and the report are a chunk of their own, fetched once the page is idle — the
         routes that host this panel (the strategies pages) do not carry the chart. -->
    <section class="preview-section" aria-label="Preview">
      <h4 class="preview-title">Preview</h4>
      @defer (on idle) {
        <app-script-preview
          [source]="draft().source"
          [inputs]="effectiveInputs()"
          [symbol]="symbol()"
          [timeframe]="timeframe()"
          [kind]="shown()?.declaration?.kind ?? null"
          (reveal)="workbench?.reveal($event.line, $event.column)"
        />
      } @placeholder {
        <div class="preview-placeholder muted small">The preview loads here.</div>
      } @loading (minimum 150ms) {
        <div class="preview-placeholder muted small">
          <span class="spinner"></span> Loading the chart…
        </div>
      }
    </section>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
        margin-bottom: var(--space-4, 16px);
      }
      .restore-banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
        padding: 8px 12px;
        border: 1px solid rgba(0, 113, 227, 0.35);
        border-radius: 8px;
        background: rgba(0, 113, 227, 0.07);
        font-size: 12.5px;
      }
      .restore-actions {
        display: inline-flex;
        gap: 6px;
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
      .side-body.is-spacious {
        max-height: max(670px, calc(100vh - 250px));
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
      .preview-section {
        margin-top: 16px;
        padding-top: 12px;
        border-top: 1px solid var(--border);
      }
      .preview-title {
        margin: 0 0 8px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .preview-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 120px;
        border: 1px dashed var(--border);
        border-radius: 8px;
      }
    `,
  ],
})
export class ScriptAuthoringComponent {
  /** The script being written (owned by the form, two-way). */
  readonly draft = model<ScriptDraft>(draftFor(null));
  /** The strategy being edited; null when creating. */
  readonly strategy = input<(StrategyDto & StrategyScriptRevisionField) | null>(null);
  /** The strategy's symbol and timeframe — used to refine warnings and to run previews. */
  readonly symbol = input<string | null>(null);
  readonly timeframe = input<string | null>(null);
  /** Full-page host: a taller editor and inputs panel. */
  readonly spacious = input(false);
  /** Edit mode: the operator wants to change the policy (on the detail page's Execution tab). */
  readonly executionRequested = output<void>();
  /** Ctrl/Cmd-S in the editor: the host saves the strategy (the same path as its Save button). */
  readonly saveRequested = output<void>();
  /** The saved script was re-read from the engine (a conflict resolved by loading it). */
  readonly scriptReloaded = output<void>();

  @ViewChild(ScriptWorkbenchComponent) workbench?: ScriptWorkbenchComponent;
  /** The Preview, once its deferred chunk has loaded. */
  readonly preview = viewChild(ScriptPreviewComponent);

  private readonly scripting = inject(ScriptingService);
  private readonly strategies = inject(StrategiesService);
  private readonly execution = inject(StrategyExecutionService);
  private readonly dialogs = inject(ScriptDialogService);
  private readonly autosaver = new DraftAutosaver();

  /**
   * The saved script this edit started from (PE-01 / PE-05): what "unsaved" compares with, and
   * the revision a save sends so it never overwrites a newer script. Re-read with the strategy;
   * moved forward by every save of this panel.
   */
  readonly base = linkedSignal<(StrategyDto & StrategyScriptRevisionField) | null, ScriptBase>({
    source: () => this.strategy(),
    computation: (s) => baseFor(s),
  });

  /** A local draft of an earlier, unsaved edit of this script (PE-I3), offered for restore. */
  readonly restorable = signal<ScriptDraftRecord | null>(null);
  /** The restorable draft was edited from an older saved script than the one loaded now. */
  readonly restoreOverNewer = computed(() => {
    const r = this.restorable();
    const rev = this.base().revision;
    return !!r?.baseRevision && !!rev && r.baseRevision !== rev;
  });

  /**
   * The overrides the Preview runs with: the draft's, coerced to the inputs the script declares
   * now, defaults dropped. The draft itself keeps every override until the script is saved (PE-04).
   */
  readonly effectiveInputs = computed(() =>
    effectiveOverrides(this.lastGood()?.inputs ?? null, this.draft().inputs),
  );

  /** The compile of the last {@link prepareSubmit}, for the save's checks (PS9002). */
  private submitCompile: ScriptCompileResult | null = null;

  constructor() {
    // A strategy (or a new one) opened: offer a local draft of an earlier unsaved edit.
    effect(() => {
      const key = this.draftKey();
      untracked(() => this.offerLocalDraft(key));
    });
    // Autosave the edit while it differs from the saved script; forget the draft once it does not.
    effect(() => {
      const d = this.draft();
      const key = this.draftKey();
      untracked(() => {
        // A draft on offer stays restorable from memory while newer edits are autosaved.
        if (this.isDirty()) {
          this.autosaver.schedule(key, {
            source: d.source,
            inputs: d.inputs,
            baseRevision: this.base().revision,
            savedAt: Date.now(),
          });
        } else {
          this.autosaver.cancel();
          // A kept draft on offer stays stored until the operator restores or discards it.
          if (!this.restorable()) clearDraft(key);
        }
      });
    });
    inject(DestroyRef).onDestroy(() => this.autosaver.flush());
  }

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

  /** Replaces the script through the editor, so the change is undoable there. */
  replaceSource(source: string): void {
    if (this.workbench) this.workbench.replaceSource(source);
    else this.setSource(source);
  }

  /** The script as the editor holds it right now (unsaved edits included). */
  currentSource(): string {
    return this.workbench?.currentSource() ?? this.draft().source;
  }

  setInputs(inputs: ScriptInputValues): void {
    this.draft.update((d) => ({ ...d, inputs }));
  }

  readonly exitsNote = EXITS_NEVER_BLOCKED;

  policyText(policy: ScriptExecutionPolicy): string {
    return (POLICY_DESCRIPTIONS[policy] ?? POLICY_DESCRIPTIONS.Direct).summary;
  }

  setPolicy(policy: ScriptExecutionPolicy): void {
    this.draft.update((d) => ({
      ...d,
      executionPolicy: policy === 'Standard' ? 'Standard' : 'Direct',
    }));
  }

  /**
   * A background compile only updates what the panels show. It never rewrites the overrides
   * (PE-04): a compile of half-typed code — a group renamed mid-word changes every input id in it
   * — would otherwise drop or clamp tuned values. They are cleaned once, when the script is saved.
   */
  onCompiled(result: ScriptCompileResult): void {
    this.compile.set(result);
    if (!result.declaration) return;
    this.lastGood.set(result);
  }

  /**
   * The script or its inputs differ from the saved script (PE-05): the source as text, the inputs
   * by what they run — an override equal to its default and none are the same, so a stored set the
   * optimizer wrote in full does not look edited.
   */
  isDirty(): boolean {
    const b = this.base();
    const d = this.draft();
    if (d.source !== b.source) return true;
    return !sameEffectiveInputs(this.lastGood()?.inputs ?? null, d.inputs, b.inputs);
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
      this.submitCompile = result;
      // Overrides are cleaned here, at save time only (PE-04).
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
   *
   * The save carries the revision the edit started from (PE-01): when the saved script changed
   * since — another tab, a rollback, an approved optimization — the engine refuses it (`-409`) and
   * the operator compares the two and decides. A script without a protective stop (PS9002) on a
   * strategy with enabled account bindings is saved only after a confirmation (PE-09).
   */
  async saveScript(
    strategyId: number,
    draft: ScriptDraft = this.draft(),
    changeReason?: string | null,
  ): Promise<boolean> {
    this.message.set(null);
    if (!(await this.confirmNoStop(strategyId))) {
      this.message.set(
        'Not saved. Add a protective stop (strategy.exit with stop / loss / trail).',
      );
      return false;
    }
    return this.putScript(strategyId, draft, changeReason, this.base().revision, true);
  }

  private async putScript(
    strategyId: number,
    draft: ScriptDraft,
    changeReason: string | null | undefined,
    expectedRevision: string | null,
    resolveConflicts: boolean,
  ): Promise<boolean> {
    this.phase.set('saving');
    try {
      const saved = await firstValueFrom(
        this.scripting.updateStrategyScript(strategyId, {
          source: draft.source,
          inputs: draft.inputs,
          ...(changeReason?.trim() ? { changeReason: changeReason.trim() } : {}),
          ...(expectedRevision ? { expectedScriptRevision: expectedRevision } : {}),
        }),
      );
      this.base.set({
        source: draft.source,
        inputs: draft.inputs,
        revision: saved.scriptRevision ?? expectedRevision,
      });
      this.forgetLocalDraft();
      return true;
    } catch (err) {
      const e = toScriptingError(err, 'Saving the script failed.');
      if (e.isConflict && resolveConflicts) {
        this.phase.set('idle');
        return this.resolveConflict(strategyId, draft, changeReason, e.message);
      }
      if (e.compile) this.workbench?.showResult(e.compile);
      this.message.set(
        e.code || e.compile ? `The engine refused the script: ${e.message}` : e.message,
      );
      return false;
    } finally {
      this.phase.set('idle');
    }
  }

  /**
   * The saved script changed after this edit started: show both side by side and let the
   * operator keep theirs (save over it), take the saved one (discard the edit), or keep editing.
   */
  private async resolveConflict(
    strategyId: number,
    mine: ScriptDraft,
    changeReason: string | null | undefined,
    reason: string,
  ): Promise<boolean> {
    let theirs: (StrategyDto & StrategyScriptRevisionField) | null = null;
    try {
      const res = await firstValueFrom(this.strategies.getById(strategyId));
      theirs = (res?.data as (StrategyDto & StrategyScriptRevisionField) | null) ?? null;
    } catch {
      theirs = null;
    }
    if (!theirs) {
      this.message.set(
        `${reason} The saved script could not be read to compare — reload the page.`,
      );
      return false;
    }
    const saved = baseFor(theirs);
    const r = await this.dialogs.ask({
      title: 'The script changed since you opened it',
      message:
        'The engine has a newer saved script than the one this edit started from — another tab, ' +
        'a rollback or an approved optimization saved it. Saving now would replace that change.',
      compare: {
        before: saved.source,
        after: mine.source,
        beforeLabel: 'Saved now',
        afterLabel: 'Your edit',
        beforeInputs: saved.inputs,
        afterInputs: mine.inputs,
      },
      choices: [
        { id: 'reload', label: 'Discard my edit and load the saved script' },
        { id: 'overwrite', label: 'Save my edit over it', tone: 'danger' },
      ],
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
    if (r.choice === 'overwrite') {
      return this.putScript(strategyId, mine, changeReason, saved.revision, false);
    }
    if (r.choice === 'reload') {
      this.applySaved(theirs);
      this.message.set('Loaded the saved script. Your edit was discarded.');
      this.scriptReloaded.emit();
      return false;
    }
    this.message.set(
      'Not saved: the script changed since you opened it. Compare, then save again.',
    );
    return false;
  }

  /** PE-09: a stopless script on live bindings asks first. True = go ahead. */
  private async confirmNoStop(strategyId: number): Promise<boolean> {
    const compiled = this.submitCompile ?? this.compile();
    const ps9002 = compiled?.diagnostics.find((d) => d.code === 'PS9002');
    if (!ps9002) return true;
    let enabled: string[] = [];
    try {
      const res = await firstValueFrom(this.execution.getAccountBindings(strategyId));
      enabled = isOk(res)
        ? (res.data ?? [])
            .filter((b) => b.isEnabled)
            .map((b) => b.accountName || `#${b.tradingAccountId}`)
        : [];
    } catch {
      enabled = [];
    }
    if (enabled.length === 0) return true;
    return this.dialogs.confirm({
      title: 'This script sets no stop-loss',
      message:
        `Live accounts reject an entry without a protective stop, and this strategy is bound to ` +
        `${enabled.length} enabled account${enabled.length === 1 ? '' : 's'} (${enabled.join(', ')}). ` +
        'Once it is active, every entry it signals will be refused there.',
      details: [`PS9002 at line ${ps9002.line}: ${ps9002.message}`],
      confirmLabel: 'Save without a stop',
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
  }

  /**
   * Makes `strategy`'s saved script the panel's draft and base — after a rollback (PE-03) or
   * when a conflict is resolved by loading the saved script. Replaced through the editor, so the
   * operator can still undo back to what they had.
   */
  applySaved(strategy: (StrategyDto & StrategyScriptRevisionField) | null): void {
    const saved = baseFor(strategy);
    this.base.set(saved);
    if (this.currentSource() !== saved.source) this.replaceSource(saved.source);
    this.draft.update((d) => ({ ...d, source: saved.source, inputs: saved.inputs }));
    this.forgetLocalDraft();
  }

  // ── Local draft (PE-I3) ─────────────────────────────────────────────────────────────────

  private draftKey(): string {
    return draftKey('strategy', this.strategy()?.id ?? null);
  }

  private offerLocalDraft(key: string): void {
    const d = readDraft(key);
    const b = this.base();
    const differs = !!d && (d.source !== b.source || !sameInputValues(d.inputs ?? {}, b.inputs));
    this.restorable.set(differs ? d : null);
    if (d && !differs) clearDraft(key);
  }

  /** Puts the kept draft into the editor (undoable) with its inputs. */
  restoreLocalDraft(): void {
    const d = this.restorable();
    if (!d) return;
    this.restorable.set(null);
    this.replaceSource(d.source);
    this.draft.update((x) => ({ ...x, source: d.source, inputs: d.inputs ?? x.inputs }));
  }

  /** Throws the kept draft away (the operator chose the saved script). */
  discardLocalDraft(): void {
    this.restorable.set(null);
    this.forgetLocalDraft();
  }

  private forgetLocalDraft(): void {
    this.autosaver.cancel();
    clearDraft(this.draftKey());
  }

  draftAgeText(savedAt: number): string {
    return draftAge(savedAt);
  }

  /** Shows why the form's own save failed (for refusals the form hears about first). */
  showError(message: string): void {
    this.message.set(message);
  }
}
