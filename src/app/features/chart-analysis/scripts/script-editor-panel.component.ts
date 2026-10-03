import { ChartIconComponent } from '../icons/chart-icon.component';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { PineEditorComponent } from '@features/scripting/components/pine-editor/pine-editor.component';
import type { ScriptCompileResult, ScriptDiagnostic } from '@core/api/scripting.types';
import { ChartScriptService } from './chart-script.service';
import { detectScriptKind } from './chart-script.model';

const STARTER = `//@version=6
indicator("My script", overlay = true)
len = input.int(20, "Length")
plot(ta.ema(close, len), "EMA", color = color.orange)
`;

/** What "Add to chart" hands the page. */
export interface ScriptEditorSubmit {
  source: string;
  kind: 'indicator' | 'strategy';
  name: string;
}

/**
 * Minimal Pine editor pane for the chart: the console's CodeMirror Pine editor (imported from
 * `@features/scripting`, unmodified), Compile with diagnostics, "Add to chart", and "Save" to
 * "My scripts" (browser-local — the engine has no stand-alone script store).
 */
@Component({
  selector: 'app-script-editor-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartIconComponent, PineEditorComponent],
  template: `
    <section class="editor" aria-label="Pine editor">
      <header class="editor__bar">
        <input
          class="editor__name"
          type="text"
          aria-label="Script name"
          [value]="name()"
          (input)="name.set($any($event.target).value)"
        />
        <span class="editor__spacer"></span>
        <button type="button" (click)="compile()" [disabled]="compiling()">
          {{ compiling() ? 'Compiling…' : 'Compile' }}
        </button>
        <button type="button" (click)="save()">Save</button>
        @if (strategyId() !== null) {
          <a class="editor__link" [href]="'/strategies/' + strategyId() + '/edit'" target="_blank" rel="noopener"
            title="Saving there changes the engine strategy">Open in strategy editor</a>
        }
        <button type="button" class="primary" (click)="addToChart()" [disabled]="!source().trim() || loading()">
          {{ onChart() ? 'Update on chart' : 'Add to chart' }}
        </button>
        <button
          type="button"
          class="editor__icon"
          aria-label="Close editor"
          (click)="closed.emit()"
        >
          <app-chart-icon name="close" [size]="18" />
        </button>
      </header>
      @if (loading()) {
        <div class="editor__loading">Loading the strategy's source…</div>
      }
      <app-pine-editor
        [value]="source()"
        (valueChange)="onEdit($event)"
        [diagnostics]="diagnostics()"
        height="100%"
        (saveRequested)="save()"
      />
      <footer class="editor__status" role="status">
        @if (error(); as e) {
          <span class="err">{{ e }}</span>
        } @else if (result(); as r) {
          @if (r.success) {
            <span class="ok"
              >Compiled — {{ r.declaration?.kind ?? 'script' }} “{{ r.declaration?.title }}”,
              {{ r.inputs.length }} input(s)</span
            >
          }
          @for (d of diagnostics(); track $index) {
            <span [class]="d.severity === 'error' ? 'err' : 'warn'"
              >{{ d.line }}:{{ d.column }} {{ d.message }}</span
            >
          }
        } @else if (savedNote(); as n) {
          <span class="ok">{{ n }}</span>
        }
      </footer>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 0;
        height: 100%;
      }
      .editor {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--surface);
        border-left: 1px solid var(--border);
        font-size: 12px;
      }
      .editor__bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
      }
      .editor__name {
        background: transparent;
        border: 1px solid transparent;
        color: inherit;
        font: inherit;
        font-weight: 600;
        padding: 3px 6px;
        border-radius: 4px;
        min-width: 0;
      }
      .editor__name:hover,
      .editor__name:focus {
        border-color: var(--border);
      }
      .editor__spacer {
        flex: 1;
      }
      button {
        background: none;
        border: 1px solid var(--border);
        color: inherit;
        padding: 3px 10px;
        border-radius: 4px;
        cursor: pointer;
        font: inherit;
      }
      button:hover {
        background: var(--surface-hover);
      }
      button.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .editor__icon {
        border: 0;
        font-size: 16px;
        line-height: 1;
        padding: 2px 6px;
      }
      app-pine-editor {
        flex: 1;
        min-height: 0;
        display: block;
      }
      .editor__status {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 90px;
        overflow: auto;
        padding: 4px 8px;
        border-top: 1px solid var(--border);
      }
      .ok {
        color: var(--profit);
      }
      .err {
        color: var(--loss);
      }
      .editor__link {
        font-size: 12px;
        color: var(--accent, #2962ff);
        text-decoration: none;
        align-self: center;
      }
      .editor__link:hover {
        text-decoration: underline;
      }
      .editor__loading {
        padding: 6px 12px;
        font-size: 12px;
        color: var(--text-muted, #787b86);
      }
      .warn {
        color: var(--text-muted);
      }
    `,
  ],
})
export class ScriptEditorPanelComponent {
  private readonly scripts = inject(ChartScriptService);
  private readonly destroyRef = inject(DestroyRef);

  /** Source to load (e.g. "edit" on a saved script); null keeps the starter. */
  readonly initialSource = input<string | null>(null);
  readonly initialName = input<string | null>(null);
  /** The chart's symbol / resolution — refine compile warnings. */
  readonly symbol = input<string | null>(null);
  readonly resolution = input<string | null>(null);
  /** The editor is showing a script that is on the chart: "Add" becomes "Update on chart". */
  readonly onChart = input(false);
  /** The chart script's source is still being fetched from the engine. */
  readonly loading = input(false);
  /** An engine strategy: link to its editor, where saving changes the live strategy. */
  readonly strategyId = input<number | null>(null);

  readonly add = output<ScriptEditorSubmit>();
  readonly saved = output<string>();
  readonly closed = output<void>();

  protected readonly source = signal(STARTER);
  protected readonly name = signal('My script');
  protected readonly compiling = signal(false);
  protected readonly result = signal<ScriptCompileResult | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly savedNote = signal<string | null>(null);
  protected readonly diagnostics = computed<ScriptDiagnostic[]>(
    () => this.result()?.diagnostics ?? [],
  );

  constructor() {
    effect(() => {
      const src = this.initialSource();
      const name = this.initialName();
      untracked(() => {
        if (src !== null) this.source.set(src);
        if (name) this.name.set(name);
        this.result.set(null);
      });
    });
  }

  protected onEdit(v: string): void {
    this.source.set(v);
    this.savedNote.set(null);
  }

  compile(): void {
    this.compiling.set(true);
    this.error.set(null);
    this.scripts
      .compile(this.source(), this.symbol() ?? undefined, this.resolution() ?? undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.result.set(r);
          this.compiling.set(false);
          if (r.declaration?.title && this.name() === 'My script')
            this.name.set(r.declaration.title);
        },
        error: (e: Error) => {
          this.error.set(e.message || 'Compile failed.');
          this.compiling.set(false);
        },
      });
  }

  protected save(): void {
    const s = this.scripts.saveScript(this.name(), this.source(), detectScriptKind(this.source()));
    this.savedNote.set(`Saved “${s.name}” to My scripts (this browser).`);
    this.result.set(null);
    this.saved.emit(s.id);
  }

  protected addToChart(): void {
    this.add.emit({
      source: this.source(),
      kind: detectScriptKind(this.source()),
      name: this.name(),
    });
  }
}
