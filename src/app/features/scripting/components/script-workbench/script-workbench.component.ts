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

import type {
  ScriptAssistRequest,
  ScriptCompileResult,
  ScriptPortResult,
  ScriptDiagnostic,
} from '@core/api/scripting.types';
import {
  ScriptingService,
  normaliseCompile,
  toScriptingError,
} from '@core/services/scripting.service';
import { downloadTextFile, readTextFile } from '@shared/utils/download';
import { PineEditorComponent } from '../pine-editor/pine-editor.component';
import {
  ProblemsPanelComponent,
  type ProblemAsk,
  type ProblemFix,
} from '../problems-panel/problems-panel.component';
import {
  ScriptStatusBarComponent,
  type CompileState,
} from '../script-status-bar/script-status-bar.component';
import {
  assistProposal,
  conversionProposal,
  portProposal,
  versionOf,
  type ScriptProposal,
} from '../../pine/pine-proposal';
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
        @if (!readOnly()) {
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="format()"
            [disabled]="formatting() || !source().trim()"
            title="Format the spacing the TradingView way (Shift-Alt-F); the engine checks nothing else changes"
          >
            Format
          </button>
        }
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
        @if (!readOnly()) {
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="openPort()"
            title="Paste a TradingView script: converted to v6 if needed, compiled and checked for what differs on a broker account"
          >
            Port from TradingView
          </button>
        }
        @if (aiAssist()) {
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            (click)="openAsk()"
            [disabled]="asking() || !source().trim()"
            title="Ask the AI about the selected lines (or the whole script), or for a change you review before it is used"
          >
            {{ asking() ? 'Asking the AI…' : 'Ask AI' }}
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
        (formatRequested)="format()"
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

      @if (aiAnswer(); as a) {
        <section class="ai-answer" aria-label="The AI's answer">
          <header>
            <strong>{{ a.title }}</strong>
            <span class="muted">AI ({{ a.model }}) — check it against the script</span>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              (click)="aiAnswer.set(null)"
              aria-label="Close the answer"
            >
              ✕
            </button>
          </header>
          <p>{{ a.text }}</p>
        </section>
      }

      <dialog #askBox class="rename ask" aria-label="Ask the AI" (close)="askOpen.set(false)">
        @if (askOpen()) {
          <form method="dialog" (submit)="$event.preventDefault()">
            <p class="muted">{{ askScope() }}</p>
            <label>
              Your question or the change you want (optional for Explain)
              <textarea
                rows="3"
                maxlength="1000"
                [value]="askQuestion()"
                (input)="askQuestion.set($any($event.target).value)"
              ></textarea>
            </label>
            <p class="muted">
              A change comes back as a comparison: nothing is used until you accept it.
            </p>
            <div class="actions">
              <button type="button" class="btn btn-ghost btn-sm" (click)="closeAsk()">
                Cancel
              </button>
              <button type="button" class="btn btn-ghost btn-sm" (click)="submitAsk('explain')">
                Explain
              </button>
              <button
                type="button"
                class="btn btn-sm"
                [disabled]="readOnly() || (!askSelection() && !askQuestion().trim())"
                (click)="submitAsk('fix')"
                [title]="
                  readOnly()
                    ? 'The editor is read-only'
                    : 'Select lines or describe the change first'
                "
              >
                Propose a change
              </button>
            </div>
          </form>
        }
      </dialog>

      <dialog
        #portBox
        class="rename port"
        aria-label="Port from TradingView"
        (close)="portOpen.set(false)"
      >
        @if (portOpen()) {
          <form method="dialog" (submit)="$event.preventDefault()">
            <label>
              Paste the script from TradingView's Pine Editor
              <textarea
                rows="8"
                spellcheck="false"
                [value]="portSource()"
                (input)="portSource.set($any($event.target).value); portResult.set(null)"
              ></textarea>
            </label>
            @if (portError(); as e) {
              <p class="error" role="alert">{{ e }}</p>
            }
            @if (portResult(); as r) {
              <ul class="checklist" role="list">
                @for (c of r.checklist; track c.id) {
                  <li [attr.data-status]="c.status">
                    <span class="mark" aria-hidden="true">{{
                      c.status === 'ok' ? '✓' : c.status === 'problem' ? '✕' : '!'
                    }}</span>
                    <span>
                      <strong>{{ c.title }}</strong>
                      @if (c.line) {
                        <span class="muted"> (line {{ c.line }})</span>
                      }
                      <span class="detail">{{ c.detail }}</span>
                    </span>
                  </li>
                }
              </ul>
            }
            <div class="actions">
              <button type="button" class="btn btn-ghost btn-sm" (click)="closePort()">
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                [disabled]="porting() || !portSource().trim()"
                (click)="checkPort()"
              >
                {{ porting() ? 'Checking…' : 'Check' }}
              </button>
              <button
                type="button"
                class="btn btn-sm"
                [disabled]="!portResult()"
                (click)="reviewPort()"
                title="Compare with the editor's script, then accept or reject"
              >
                Review and open
              </button>
            </div>
          </form>
        }
      </dialog>

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
          [assist]="aiAssist()"
          (ask)="askAboutProblem($event)"
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
      .ai-answer {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg-secondary);
        padding: 8px 10px;
        font-size: 13px;
      }
      .ai-answer header {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .ai-answer header .muted {
        flex: 1;
        font-size: 11px;
      }
      .ai-answer p {
        margin: 6px 0 0;
        white-space: pre-wrap;
        max-height: 240px;
        overflow-y: auto;
      }
      .port textarea {
        font-family: var(--font-mono, monospace);
        font-size: 12px;
      }
      .checklist {
        list-style: none;
        margin: 8px 0;
        padding: 0;
        max-height: 260px;
        overflow-y: auto;
        font-size: 12px;
      }
      .checklist li {
        display: grid;
        grid-template-columns: 16px 1fr;
        gap: 6px;
        padding: 3px 0;
      }
      .checklist li[data-status='ok'] .mark {
        color: #1f8a3b;
      }
      .checklist li[data-status='check'] .mark {
        color: #b25e00;
      }
      .checklist li[data-status='problem'] .mark {
        color: var(--loss);
      }
      .checklist .detail {
        display: block;
        color: var(--text-secondary);
      }
      .ask textarea,
      .port textarea {
        display: block;
        width: 100%;
        margin-top: 4px;
        font: inherit;
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
  /** Offer the AI's Explain / fix (PE-I6; needs operator access on the engine). */
  readonly aiAssist = input(true);

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
  readonly formatting = signal(false);
  /** A Pine v4/v5 script (its //@version line). */
  readonly convertible = computed(() => {
    const v = versionOf(this.source());
    return v === 4 || v === 5;
  });

  // ── AI explain / fix (PE-I6) ──
  @ViewChild('askBox') private askBox?: ElementRef<HTMLDialogElement>;
  readonly asking = signal(false);
  readonly askOpen = signal(false);
  readonly askQuestion = signal('');
  readonly askSelection = signal<{ from: number; to: number } | null>(null);
  readonly aiAnswer = signal<{ title: string; text: string; model: string } | null>(null);
  /** What the Ask AI dialog is about: "line 3", "lines 3–5" or "the whole script". */
  readonly askTarget = computed(() => {
    const sel = this.askSelection();
    if (!sel) return 'the whole script';
    const text = this.source();
    const line = (o: number) => text.slice(0, o).split('\n').length;
    const a = line(sel.from);
    const b = line(Math.max(sel.from, sel.to - 1));
    return a === b ? `line ${a}` : `lines ${a}–${b}`;
  });
  readonly askScope = computed(() =>
    this.askSelection()
      ? `About ${this.askTarget()}.`
      : 'About the whole script (select lines first to ask about just those).',
  );

  // ── Port from TradingView (PE-I6) ──
  @ViewChild('portBox') private portBox?: ElementRef<HTMLDialogElement>;
  readonly portOpen = signal(false);
  readonly portSource = signal('');
  readonly portResult = signal<ScriptPortResult | null>(null);
  readonly portError = signal<string | null>(null);
  readonly porting = signal(false);

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

  /**
   * Formats the script (engine §2d, token-identical so it compiles the same) as one undoable edit —
   * only when the text is still what was sent.
   */
  async format(): Promise<void> {
    if (this.readOnly() || this.formatting()) return;
    const before = this.currentSource();
    if (!before.trim()) return;
    this.formatting.set(true);
    try {
      const r = await firstValueFrom(this.scripting.format(before));
      if (r.problem) this.notice.set(r.problem);
      else if (!r.changed) this.notice.set('Already formatted.');
      else if (this.currentSource() !== before)
        this.notice.set('The script changed while formatting — try again.');
      else {
        this.replaceSource(r.source);
        this.notice.set('Formatted (Ctrl/Cmd-Z undoes it).');
      }
    } catch (err) {
      this.notice.set(toScriptingError(err, 'The engine could not format the script.').message);
    } finally {
      this.formatting.set(false);
    }
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

  openPort(): void {
    this.portResult.set(null);
    this.portError.set(null);
    this.portOpen.set(true);
    const box = this.portBox?.nativeElement;
    if (box && !box.open) {
      if (typeof box.showModal === 'function') box.showModal();
      else box.setAttribute('open', '');
    }
  }

  closePort(): void {
    const box = this.portBox?.nativeElement;
    if (box?.open) {
      if (typeof box.close === 'function') box.close();
      else box.removeAttribute('open');
    }
    this.portOpen.set(false);
  }

  /** The engine converts (v4/v5), compiles and checks the pasted script. */
  async checkPort(): Promise<void> {
    const pasted = this.portSource().replace(/\r\n?/g, '\n');
    if (!pasted.trim() || this.porting()) return;
    this.porting.set(true);
    this.portError.set(null);
    try {
      this.portResult.set(
        await firstValueFrom(this.scripting.port(pasted, this.symbol(), this.timeframe())),
      );
    } catch (err) {
      this.portResult.set(null);
      this.portError.set(toScriptingError(err, 'The engine could not check the script.').message);
    } finally {
      this.porting.set(false);
    }
  }

  /** The ported script as a proposal over the editor's text (accept / reject). */
  reviewPort(): void {
    const r = this.portResult();
    if (!r || this.readOnly()) return;
    const proposal = portProposal(this.currentSource(), r);
    this.closePort();
    this.showProposal(proposal);
  }

  /** Opens the Ask AI dialog for the editor's selection (or the whole script). */
  openAsk(): void {
    this.askSelection.set(this.editor?.selection() ?? null);
    this.askOpen.set(true);
    const box = this.askBox?.nativeElement;
    if (box && !box.open) {
      if (typeof box.showModal === 'function') box.showModal();
      else box.setAttribute('open', '');
    }
  }

  closeAsk(): void {
    const box = this.askBox?.nativeElement;
    if (box?.open) {
      if (typeof box.close === 'function') box.close();
      else box.removeAttribute('open');
    }
    this.askOpen.set(false);
  }

  submitAsk(mode: 'explain' | 'fix'): void {
    const sel = this.askSelection();
    const question = this.askQuestion().trim();
    this.closeAsk();
    void this.askAi(
      mode,
      {
        selectionFrom: sel?.from,
        selectionTo: sel?.to,
        question: question || undefined,
      },
      this.askTarget(),
    );
  }

  /** Explain / AI fix on a Problems row. */
  askAboutProblem(a: ProblemAsk): void {
    void this.askAi(
      a.mode,
      {
        problem: {
          code: a.diagnostic.code,
          message: a.diagnostic.message,
          line: a.diagnostic.line,
        },
      },
      `${a.diagnostic.code} on line ${a.diagnostic.line}`,
    );
  }

  /**
   * PE-I6: one AI call. An explanation shows in the answer panel; a fix opens the proposal dialog
   * (diff, warnings, Reject / accept) for the exact text it was asked about.
   */
  async askAi(
    mode: 'explain' | 'fix',
    extra: Omit<ScriptAssistRequest, 'mode' | 'source'>,
    what: string,
  ): Promise<void> {
    if (this.asking()) return;
    if (mode === 'fix' && this.readOnly()) return;
    const before = this.currentSource();
    if (!before.trim()) return;
    this.asking.set(true);
    try {
      const r = await firstValueFrom(this.scripting.assist({ mode, source: before, ...extra }));
      if (mode === 'explain') {
        this.aiAnswer.set({ title: `About ${what}`, text: r.explanation, model: r.model });
        return;
      }
      const { proposal, problem } = assistProposal(before, r, what);
      if (proposal) this.showProposal(proposal);
      else
        this.aiAnswer.set({ title: `No change for ${what}`, text: problem ?? '', model: r.model });
    } catch (err) {
      this.notice.set(toScriptingError(err, 'The AI could not answer.').message);
    } finally {
      this.asking.set(false);
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
