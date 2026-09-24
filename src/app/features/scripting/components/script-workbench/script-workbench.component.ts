import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { ProblemsPanelComponent } from '../problems-panel/problems-panel.component';
import {
  ScriptStatusBarComponent,
  type CompileState,
} from '../script-status-bar/script-status-bar.component';
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
  imports: [PineEditorComponent, ProblemsPanelComponent, ScriptStatusBarComponent],
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
            title="Compile now (⌘S / Ctrl-S in the editor)"
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
        (cursorChange)="cursor.set($event)"
        (saveRequested)="compileNow(true)"
      />

      <app-script-status-bar
        [result]="result()"
        [state]="compileState()"
        [failureMessage]="compileError()"
        [stale]="stale()"
        [cursor]="cursor()"
      />

      @if (showProblems()) {
        <app-problems-panel
          [diagnostics]="diagnostics()"
          [emptyLabel]="result() ? 'No problems' : 'Not compiled yet'"
          (selected)="reveal($event.line, $event.column)"
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
  readonly showProblems = input(true);

  /** Every compile result applied to the current source. */
  readonly compiled = output<ScriptCompileResult>();

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
        this.scripting.compile({ source, symbol: this.symbol(), timeframe: this.timeframe() }),
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

  focus(): void {
    this.editor?.focus();
  }

  async openFile(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    const text = await readTextFile(file);
    if (
      this.source().trim() &&
      this.source() !== text &&
      !window.confirm(`Replace the editor's contents with ${file.name}?`)
    ) {
      return;
    }
    this.source.set(text.replace(/\r\n?/g, '\n'));
  }

  download(): void {
    const name = this.fileName().endsWith('.pine') ? this.fileName() : `${this.fileName()}.pine`;
    downloadTextFile(name, this.source());
  }
}
