import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  InjectionToken,
  NgZone,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { ScriptDiagnostic } from '@core/api/scripting.types';
import { ThemeService } from '@core/theme/theme.service';
import { PineCatalogService } from '../../services/pine-catalog.service';
import type { PineEditorHandle } from '../../editor/pine-editor-setup';

type PineEditorModule = typeof import('../../editor/pine-editor-setup');

/**
 * Loads the CodeMirror editor chunk. A token so specs can supply a stand-in: the real chunk is
 * only ever fetched when an editor is on screen.
 */
export const PINE_EDITOR_LOADER = new InjectionToken<() => Promise<PineEditorModule>>(
  'PINE_EDITOR_LOADER',
  {
    providedIn: 'root',
    factory: () => () => import('../../editor/pine-editor-setup'),
  },
);

/**
 * The Pine v6 code editor: CodeMirror 6 with the Pine language mode, catalog-driven completion,
 * signature help and hover docs, lint markers for the engine's diagnostics, colour swatches,
 * folding, search/replace and multi-cursor editing.
 *
 * CodeMirror runs outside Angular's zone (its measuring and pointer tracking would otherwise
 * drive change detection on every frame); only edits, cursor moves and Mod-S come back in. If
 * the editor chunk cannot load, a plain textarea keeps the source editable.
 */
@Component({
  selector: 'app-pine-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="pine-editor"
      [class.is-readonly]="readOnly()"
      [style.height]="height()"
      [attr.data-state]="state()"
    >
      <div #host class="pine-editor-host" [hidden]="state() === 'failed'"></div>
      @if (state() === 'loading') {
        <div class="pine-editor-loading" aria-live="polite">Loading editor…</div>
      }
      @if (state() === 'failed') {
        <textarea
          class="pine-editor-fallback"
          spellcheck="false"
          [attr.aria-label]="ariaLabel()"
          [readOnly]="readOnly()"
          [value]="value()"
          (input)="value.set($any($event.target).value)"
        ></textarea>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .pine-editor {
        position: relative;
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
        background: var(--bg-primary);
      }
      .pine-editor-host {
        height: 100%;
      }
      .pine-editor-loading {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-tertiary);
        font-size: 12px;
      }
      .pine-editor-fallback {
        width: 100%;
        height: 100%;
        box-sizing: border-box;
        border: none;
        resize: none;
        padding: 8px 12px;
        font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
        font-size: 13px;
        line-height: 1.6;
        background: var(--bg-primary);
        color: var(--text-primary);
        outline: none;
        tab-size: 4;
      }
    `,
  ],
})
export class PineEditorComponent implements AfterViewInit, OnDestroy {
  /** The source (two-way). */
  readonly value = model<string>('');
  readonly readOnly = input(false);
  /** The engine's diagnostics for the current source, shown as lint markers. */
  readonly diagnostics = input<readonly ScriptDiagnostic[]>([]);
  readonly height = input('420px');
  readonly ariaLabel = input('Pine Script editor');

  /** 1-based cursor position. */
  readonly cursorChange = output<{ line: number; column: number }>();
  /** Mod-S pressed in the editor. */
  readonly saveRequested = output<void>();
  readonly ready = output<void>();

  readonly state = signal<'loading' | 'ready' | 'failed'>('loading');

  @ViewChild('host', { static: true }) private host!: ElementRef<HTMLDivElement>;

  private readonly loader = inject(PINE_EDITOR_LOADER);
  private readonly language = inject(PineCatalogService);
  private readonly theme = inject(ThemeService);
  private readonly zone = inject(NgZone);
  private handle: PineEditorHandle | null = null;
  private destroyed = false;

  constructor() {
    effect(() => {
      const v = this.value();
      untracked(() => this.handle?.setValue(v));
    });
    effect(() => {
      const ro = this.readOnly();
      untracked(() => this.handle?.setReadOnly(ro));
    });
    effect(() => {
      const d = this.diagnostics();
      untracked(() => this.handle?.setDiagnostics(d));
    });
    effect(() => {
      const c = this.language.catalog();
      untracked(() => this.handle?.setCatalog(c));
    });
    effect(() => {
      const libs = this.language.libraries();
      untracked(() => this.handle?.setLibraries(libs));
    });
    effect(() => {
      const dark = this.theme.theme() === 'dark';
      untracked(() => this.handle?.setDark(dark));
    });
  }

  ngAfterViewInit(): void {
    this.language.ensureLoaded();
    this.language.ensureLibraries();
    this.zone.runOutsideAngular(() => {
      this.loader()
        .then((mod) => {
          if (this.destroyed) return;
          this.handle = mod.createPineEditor(this.host.nativeElement, {
            doc: this.value(),
            readOnly: this.readOnly(),
            dark: this.theme.theme() === 'dark',
            catalog: this.language.catalog(),
            libraries: this.language.libraries(),
            ariaLabel: this.ariaLabel(),
            onChange: (doc) => this.zone.run(() => this.value.set(doc)),
            onCursor: (line, column) => this.zone.run(() => this.cursorChange.emit({ line, column })),
            onSave: () => this.zone.run(() => this.saveRequested.emit()),
          });
          this.handle.setDiagnostics(this.diagnostics());
          this.zone.run(() => {
            this.state.set('ready');
            this.ready.emit();
          });
        })
        .catch(() => this.zone.run(() => this.state.set('failed')));
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.handle?.destroy();
    this.handle = null;
  }

  /** Moves the cursor to a 1-based line/column and focuses the editor. */
  revealPosition(line: number, column = 1): void {
    this.handle?.revealPosition(line, column);
  }

  focus(): void {
    this.handle?.focus();
  }

  /** The live source (the editor's own document, even mid-keystroke). */
  currentValue(): string {
    return this.handle?.getValue() ?? this.value();
  }
}
