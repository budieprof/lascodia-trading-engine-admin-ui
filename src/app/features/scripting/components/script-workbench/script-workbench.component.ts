import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { ScriptCompileResult, ScriptDiagnostic } from '@core/api/scripting.types';
import {
  ScriptingService,
  normaliseCompile,
  toScriptingError,
} from '@core/services/scripting.service';
import { downloadTextFile, readTextFile } from '@shared/utils/download';
import { PineEditorComponent } from '../pine-editor/pine-editor.component';
import {
  ProblemsPanelComponent,
  type ProblemFix,
} from '../problems-panel/problems-panel.component';
import {
  ScriptStatusBarComponent,
  type CompileState,
} from '../script-status-bar/script-status-bar.component';
import { conversionProposal, versionOf, type ScriptProposal } from '../../pine/pine-proposal';
import { flattenOutline } from '../../pine/pine-semantic';
import { ScriptDiffComponent } from '../../shared/script-diff.component';
import { SCRIPTING_UI_STYLES } from '../scripting-ui.styles';

/** Delay between the last keystroke and the background compile. */
export const COMPILE_DEBOUNCE_MS = 700;

/**
 * The Pine editor with everything around it: a toolbar (Validate, open a `.pine` file,
 * download), the status bar and the Problems panel. Edits are compiled in the background
 * (debounced) through `POST scripting/compile`; the diagnostics land in the editor as lint
 * markers and in the Problems panel.
 */
@Component({
  selector: 'app-script-workbench',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PineEditorComponent,
    ProblemsPanelComponent,
    ScriptStatusBarComponent,
    ScriptDiffComponent,
  ],
  template: `
    <div class="workbench">
      <div class="toolbar">
        <span class="label">{{ label() }}</span>
        <span class="toolbar-spacer"></span>
        @if (!readOnly()) {
          <input
            #fileInput
            type="file"
            class="file-input"
            accept=".pine,.txt,text/plain"
            (change)="openFile($event)"
          />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="fileInput.click()"
            title="Load a .pine file into the editor"
          >
            Open…
          </button>
        }
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          [class.active]="outlineOpen()"
          [attr.aria-pressed]="outlineOpen()"
          (click)="outlineOpen.set(!outlineOpen())"
          title="The script's functions, types, inputs and variables (F12 goes to a definition, Shift-F12 selects its references, F2 renames)"
        >
          Outline
        </button>
        @if (!readOnly() && convertible()) {
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="convert()"
            [disabled]="converting()"
            title="Rewrite this Pine v4/v5 script for v6 — shown as a comparison you accept or reject"
          >
            {{ converting() ? 'Converting…' : 'Convert to v6' }}
          </button>
        }
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          (click)="download()"
          [disabled]="!source().trim()"
          title="Download the source as a .pine file"
        >
          Download
        </button>
        @if (showValidate()) {
          <button
            type="button"
            class="btn btn-sm"
            (click)="compileNow(true)"
            [disabled]="compileState() === 'compiling' || !source().trim()"
            [title]="
              saveShortcut() === 'save'
                ? 'Compile now (⌘S / Ctrl-S in the editor saves)'
                : 'Compile now (⌘S / Ctrl-S in the editor)'
            "
          >
            @if (compileState() === 'compiling') {
              <span class="spinner"></span>
            }
            Validate
          </button>
        }
      </div>

      <app-pine-editor
        [(value)]="source"
        [readOnly]="readOnly()"
        [diagnostics]="editorDiagnostics()"
        [height]="editorHeight()"
        [ariaLabel]="label()"
        [placeholder]="placeholder()"
        (cursorChange)="cursor.set($event)"
        (saveRequested)="onSaveShortcut()"
        [semantic]="result()?.semantic ?? null"
        [semanticSource]="resultSource()"
        (renameRequested)="openRename($event)"
        (libraryDefinition)="notice.set(libraryNotice($event))"
        (notice)="notice.set($event)"
      />
      @if (notice(); as n) {
        <p class="notice" role="status">
          {{ n }}
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            (click)="notice.set(null)"
            aria-label="Dismiss"
          >
            ×
          </button>
        </p>
      }
      @if (outlineOpen()) {
        <nav class="outline" aria-label="Outline">
          @if (outline().length === 0) {
            <p class="muted">
              {{
                result()?.semantic
                  ? 'Nothing declared yet.'
                  : 'The outline appears after the next compile.'
              }}
            </p>
          } @else {
            <ul role="list">
              @for (o of outline(); track $index) {
                <li [style.padding-left.px]="8 + o.depth * 14">
                  <button
                    type="button"
                    (click)="reveal(o.item.nameRange.line, o.item.nameRange.column)"
                  >
                    <span class="outline-kind">{{ o.item.kind }}</span>
                    <span class="outline-name">{{ o.item.name }}</span>
                    @if (o.item.detail) {
                      <span class="outline-detail">{{ o.item.detail }}</span>
                    }
                  </button>
                </li>
              }
            </ul>
          }
        </nav>
      }

      <app-script-status-bar
        [result]="result()"
        [state]="compileState()"
        [failureMessage]="compileError()"
        [stale]="stale()"
        [cursor]="cursor()"
      />

      <dialog
        #proposalBox
        class="proposal"
        aria-label="Review the change"
        (close)="proposal.set(null)"
      >
        @if (proposal(); as p) {
          <h3>{{ p.title }}</h3>
          @if (p.warnings.length) {
            <ul class="warnings" role="list">
              @for (w of p.warnings; track $index) {
                <li>{{ w }}</li>
              }
            </ul>
          }
          <app-script-diff
            [before]="p.before"
            [after]="p.after"
            beforeLabel="Now"
            afterLabel="Proposed"
            maxHeight="360px"
          />
          @if (p.notes.length) {
            <details>
              <summary>{{ p.notes.length }} change{{ p.notes.length === 1 ? '' : 's' }}</summary>
              <ul role="list">
                @for (n of p.notes; track $index) {
                  <li>{{ n }}</li>
                }
              </ul>
            </details>
          }
          @if (proposalError(); as e) {
            <p class="error" role="alert">{{ e }}</p>
          }
          <div class="actions">
            <button type="button" class="btn btn-ghost btn-sm" (click)="closeProposal()">
              Reject
            </button>
            <button type="button" class="btn btn-sm" (click)="acceptProposal()">
              {{ p.acceptLabel }}
            </button>
          </div>
        }
      </dialog>

      <dialog #renameBox class="rename" aria-label="Rename" (close)="renameTarget.set(null)">
        @if (renameTarget(); as t) {
          <form method="dialog" (submit)="$event.preventDefault(); confirmRename()">
            <label>
              Rename <code>{{ t.name }}</code> to
              <input
                #renameInput
                type="text"
                [value]="t.name"
                (input)="renameTo.set($any($event.target).value)"
                spellcheck="false"
              />
            </label>
            <p class="muted">
              Every use in this script changes, its documentation included. The engine checks the
              new name first.
            </p>
            @if (renameError(); as e) {
              <p class="error" role="alert">{{ e }}</p>
            }
            <div class="actions">
              <button type="button" class="btn btn-ghost btn-sm" (click)="closeRename()">
                Cancel
              </button>
              <button
                type="submit"
                class="btn btn-sm"
                [disabled]="renaming() || !renameTo().trim()"
              >
                {{ renaming() ? 'Checking…' : 'Rename' }}
              </button>
            </div>
          </form>
        }
      </dialog>

      @if (showProblems()) {
        <app-problems-panel
          [diagnostics]="diagnostics()"
          [emptyLabel]="result() ? 'No problems' : 'Not compiled yet'"
          [compiled]="!!result()"
          [readOnly]="readOnly() || stale()"
          (selected)="reveal($event.line, $event.column)"
          (fix)="applyFix($event)"
        />
      }
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      :host {
        display: block;
        min-width: 0;
      }
      .workbench {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 4px;
        min-height: 28px;
      }
      .label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .toolbar-spacer {
        flex: 1;
      }
      .file-input {
        display: none;
      }
      .notice {
        margin: 0;
        font-size: 12px;
        color: var(--text-secondary);
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .outline {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        max-height: 220px;
        overflow-y: auto;
        font-size: 12px;
      }
      .outline ul {
        list-style: none;
        margin: 0;
        padding: 4px 0;
      }
      .outline li button {
        width: 100%;
        display: flex;
        gap: 8px;
        align-items: baseline;
        border: none;
        background: transparent;
        color: var(--text-primary);
        font: inherit;
        text-align: left;
        padding: 2px 8px;
        cursor: pointer;
      }
      .outline li button:hover,
      .outline li button:focus-visible {
        background: var(--bg-tertiary);
        outline: none;
      }
      .outline-kind {
        color: var(--text-tertiary);
        font-size: 11px;
        min-width: 64px;
      }
      .outline-detail {
        color: var(--text-tertiary);
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .muted {
        color: var(--text-tertiary);
        margin: 6px 8px;
      }
      .rename {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: 16px;
        min-width: 320px;
      }
      .rename input {
        display: block;
        width: 100%;
        margin-top: 6px;
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      }
      .rename .error {
        color: var(--loss);
      }
      .proposal {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: 16px;
        width: min(960px, 92vw);
      }
      .proposal h3 {
        margin: 0 0 8px;
        font-size: 14px;
      }
      .proposal .warnings {
        margin: 0 0 8px;
        padding-left: 18px;
        color: var(--warning);
        font-size: 12px;
      }
      .proposal details {
        font-size: 12px;
        margin: 8px 0;
      }
      .proposal .error {
        color: var(--loss);
      }
      .proposal .actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }
      .rename .actions {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
      }
    `,
  ],
})
export class ScriptWorkbenchComponent {
  /** The source (two-way). */
  readonly source = model<string>('');
  readonly readOnly = input(false);
  /** Refines compile warnings (e.g. a higher-timeframe request that is not higher). */
  readonly symbol = input<string | null>(null);
  readonly timeframe = input<string | null>(null);
  readonly editorHeight = input('440px');
  readonly label = input('Pine Script v6');
  /** Default name for Download. */
  readonly fileName = input('script.pine');
  /** Compile in the background as the source changes. */
  readonly autoCompile = input(true);
  readonly showValidate = input(true);
  /** Shown while the editor is empty. */
  readonly placeholder = input<string | null>(null);
  readonly showProblems = input(true);
  /**
   * What ⌘S / Ctrl-S does in the editor (PE-14): `save` asks the host to save (the host's Save
   * button path — it compiles first), `validate` compiles now. Hosts with a Save use `save`, so the
   * shortcut means the same in every Pine editor of the console.
   */
  readonly saveShortcut = input<'save' | 'validate'>('validate');

  /** Every compile result applied to the current source. */
  readonly compiled = output<ScriptCompileResult>();
  /** ⌘S / Ctrl-S with `saveShortcut = save`. */
  readonly saveRequested = output<void>();

  readonly result = signal<ScriptCompileResult | null>(null);
  /** The source the result was computed for. */
  readonly resultSource = signal<string | null>(null);
  readonly compileState = signal<CompileState>('idle');
  readonly compileError = signal<string | null>(null);
  readonly cursor = signal<{ line: number; column: number } | null>(null);

  readonly stale = computed(() => this.result() !== null && this.resultSource() !== this.source());
  readonly diagnostics = computed<readonly ScriptDiagnostic[]>(
    () => this.result()?.diagnostics ?? [],
  );
  /** Markers only for the text they were computed on; edits since are mapped by the editor. */
  readonly editorDiagnostics = computed<readonly ScriptDiagnostic[]>(() =>
    this.resultSource() === null ? [] : this.diagnostics(),
  );

  @ViewChild(PineEditorComponent) private editor?: PineEditorComponent;
  @ViewChild('renameBox') private renameBox?: ElementRef<HTMLDialogElement>;

  // ── Outline, notices, rename (PR-I8 / PE-I5) ──
  readonly outlineOpen = signal(false);
  readonly outline = computed(() => flattenOutline(this.result()?.semantic?.outline ?? []));
  /** What a semantic command could not do, or where a library definition is. */
  readonly notice = signal<string | null>(null);
  readonly renameTarget = signal<{ offset: number; name: string; source: string } | null>(null);
  readonly renameTo = signal('');
  readonly renaming = signal(false);
  readonly renameError = signal<string | null>(null);

  // ── Proposed changes: the converter (PR-I10), the AI (PE-I6) — reviewed as a diff, never applied unasked ──
  @ViewChild('proposalBox') private proposalBox?: ElementRef<HTMLDialogElement>;
  readonly proposal = signal<ScriptProposal | null>(null);
  readonly proposalError = signal<string | null>(null);
  readonly converting = signal(false);
  /** A Pine v4/v5 script (its //@version line). */
  readonly convertible = computed(() => {
    const v = versionOf(this.source());
    return v === 4 || v === 5;
  });

  private readonly scripting = inject(ScriptingService);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    effect(() => {
      this.source();
      this.symbol();
      this.timeframe();
      const auto = this.autoCompile();
      untracked(() => {
        if (auto) this.scheduleCompile();
      });
    });
    inject(DestroyRef).onDestroy(() => this.clearTimer());
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleCompile(delay = COMPILE_DEBOUNCE_MS): void {
    this.clearTimer();
    if (!this.source().trim()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.compileNow();
    }, delay);
  }

  /**
   * Compiles the current source now (or returns the result already computed for it). Resolves
   * to null when the engine could not be reached.
   */
  async compileNow(force = false): Promise<ScriptCompileResult | null> {
    this.clearTimer();
    const source = this.source();
    if (!source.trim()) {
      this.result.set(null);
      this.resultSource.set(null);
      this.compileState.set('idle');
      return null;
    }
    if (!force && this.resultSource() === source && this.compileState() === 'done') {
      return this.result();
    }
    const seq = ++this.seq;
    this.compileState.set('compiling');
    try {
      const r = await firstValueFrom(
        this.scripting.compile({
          source,
          symbol: this.symbol(),
          timeframe: this.timeframe(),
          semantic: true,
        }),
      );
      // Apply only the newest compile, and only while it still describes the text on screen.
      if (seq === this.seq && source === this.source()) {
        this.result.set(r);
        this.resultSource.set(source);
        this.compileError.set(null);
        this.compileState.set('done');
        this.compiled.emit(r);
      } else if (seq === this.seq) {
        this.compileState.set('idle');
      }
      return r;
    } catch (err) {
      if (seq === this.seq) {
        this.compileState.set('failed');
        this.compileError.set(toScriptingError(err, 'Compile unavailable').message);
      }
      return null;
    }
  }

  /** Shows a compile result that came from elsewhere (a refused save, a run). */
  showResult(result: ScriptCompileResult): void {
    const r = normaliseCompile(result);
    this.seq++;
    this.result.set(r);
    this.resultSource.set(this.source());
    this.compileState.set('done');
    this.compileError.set(null);
    this.compiled.emit(r);
  }

  reveal(line: number, column = 1): void {
    this.editor?.revealPosition(line, column);
  }

  /** Shows a proposed change for review (Reject / accept). */
  showProposal(p: ScriptProposal): void {
    this.proposal.set(p);
    this.proposalError.set(null);
    const box = this.proposalBox?.nativeElement;
    if (box && !box.open) {
      if (typeof box.showModal === 'function') box.showModal();
      else box.setAttribute('open', '');
    }
  }

  closeProposal(): void {
    const box = this.proposalBox?.nativeElement;
    if (box?.open) {
      if (typeof box.close === 'function') box.close();
      else box.removeAttribute('open');
    }
    this.proposal.set(null);
  }

  /** Accept: the proposed script replaces the one it was made for, as an undoable edit. */
  acceptProposal(): void {
    const p = this.proposal();
    if (!p || this.readOnly()) return;
    if (this.currentSource() !== p.before) {
      this.proposalError.set(
        'The script changed since this was proposed — close it and ask again.',
      );
      return;
    }
    this.replaceSource(p.after);
    this.closeProposal();
    this.notice.set(`${p.title}: applied (Ctrl/Cmd-Z undoes it).`);
  }

  /** PR-I10: the engine converts the script; the result is a proposal. */
  async convert(): Promise<void> {
    if (this.converting()) return;
    const before = this.currentSource();
    this.converting.set(true);
    try {
      const c = await firstValueFrom(this.scripting.convert(before));
      const { proposal, problem } = conversionProposal(before, c);
      if (proposal) this.showProposal(proposal);
      else this.notice.set(problem);
    } catch (err) {
      this.notice.set(toScriptingError(err, 'The engine could not convert the script.').message);
    } finally {
      this.converting.set(false);
    }
  }

  libraryNotice(d: { unit: string; line: number; name: string }): string {
    return `'${d.name}' is declared in the library ${d.unit}, line ${d.line} — read-only here; open it on the Libraries page to see its source.`;
  }

  /** F2 in the editor: ask for the new name (a native modal). */
  openRename(at: { offset: number; name: string }): void {
    if (this.readOnly()) return;
    this.renameTarget.set({ ...at, source: this.currentSource() });
    this.renameTo.set(at.name);
    this.renameError.set(null);
    const box = this.renameBox?.nativeElement;
    if (box && !box.open) {
      if (typeof box.showModal === 'function') box.showModal();
      else box.setAttribute('open', '');
    }
  }

  closeRename(): void {
    const box = this.renameBox?.nativeElement;
    if (box?.open) {
      if (typeof box.close === 'function') box.close();
      else box.removeAttribute('open');
    }
    this.renameTarget.set(null);
  }

  /** The engine plans the rename (proven by compiling it); applied as one undoable edit. */
  async confirmRename(): Promise<void> {
    const t = this.renameTarget();
    const to = this.renameTo().trim();
    if (!t || !to || this.renaming()) return;
    this.renaming.set(true);
    this.renameError.set(null);
    try {
      const plan = await firstValueFrom(this.scripting.renameSymbol(t.source, t.offset, to));
      if (!this.editor?.applyRename(t.source, plan.edits)) {
        this.renameError.set('The text changed while the engine checked the name — try again.');
        return;
      }
      this.closeRename();
      this.notice.set(
        `Renamed '${plan.oldName}' to '${plan.newName}' in ${plan.edits.length} place${plan.edits.length === 1 ? '' : 's'} (Ctrl/Cmd-Z undoes it).`,
      );
    } catch (err) {
      this.renameError.set(toScriptingError(err, 'The engine could not rename it.').message);
    } finally {
      this.renaming.set(false);
    }
  }

  /**
   * A quick fix picked in the Problems panel, applied as an undoable edit. Only while the
   * diagnostics still describe the text on screen (the panel disables its fixes otherwise): a fix's
   * position is the compiled source's.
   */
  applyFix(picked: ProblemFix): void {
    if (this.readOnly() || this.stale()) return;
    this.editor?.applyFix(picked.fix);
  }

  /** Replaces the source as an undoable edit in the editor (see PineEditorComponent.replaceSource). */
  replaceSource(doc: string): void {
    if (this.editor) this.editor.replaceSource(doc);
    else this.source.set(doc);
  }

  /** The editor's live text (falls back to the bound source before it loads). */
  currentSource(): string {
    return this.editor?.currentValue() ?? this.source();
  }

  focus(): void {
    this.editor?.focus();
  }

  onSaveShortcut(): void {
    if (this.saveShortcut() === 'save') this.saveRequested.emit();
    else void this.compileNow(true);
  }

  /**
   * Loads a `.pine` file into the editor as an edit (PE-14): Ctrl/Cmd-Z brings back what was
   * there, so it needs no confirmation.
   */
  async openFile(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    const text = (await readTextFile(file)).replace(/\r\n?/g, '\n');
    if (text === this.source()) return;
    this.replaceSource(text);
  }

  download(): void {
    const name = this.fileName().endsWith('.pine') ? this.fileName() : `${this.fileName()}.pine`;
    downloadTextFile(name, this.source());
  }
}
