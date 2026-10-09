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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';

import { PineEditorComponent } from '@features/scripting/components/pine-editor/pine-editor.component';
import type {
  ChartScriptVersionDto,
  ScriptCompileResult,
  ScriptDiagnostic,
} from '@core/api/scripting.types';
import { toScriptingError, type ScriptingApiError } from '@core/services/scripting.service';
import {
  DraftAutosaver,
  clearDraft,
  draftAge,
  draftKey,
  readDraft,
  type ScriptDraftRecord,
} from '@features/scripting/shared/draft-store';
import { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { warnBeforeUnload } from '@features/scripting/shared/unsaved-changes';
import { ChartScriptService, type SavedChartScript } from './chart-script.service';
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

/** A TradingView import not saved yet: recorded with the script when it is (SS-I8). */
interface ImportOrigin {
  sourceUrl: string;
  licence: string;
  author: string | null;
  notice: string | null;
}

const ACTION_TEXT: Record<string, string> = {
  Created: 'Created',
  Saved: 'Saved',
  Restored: 'Restored',
  Imported: 'Imported from TradingView',
  Baseline: 'As saved before history was kept',
};

/**
 * Pine editor pane for the chart: the console's CodeMirror Pine editor (imported from
 * `@features/scripting`), Compile with diagnostics, "Add to chart", and "Save" to "My scripts"
 * in the engine.
 *
 * <p>The buffer is bound to the saved script it was loaded from (PE-07, contract C4): Save
 * updates that script from the revision the edit started on — a newer saved state is never
 * overwritten silently, the operator compares the two first — and a script that is not saved yet
 * never overwrites another one that merely shares its name. Every save is a version: History
 * lists, compares and restores them. A script can be shared with every operator (they run and copy
 * it; only its owner changes it), and an open-source TradingView script can be imported as an
 * unsaved draft (SS-I8). An edit not saved yet is kept in this browser and offered back (PE-I3).</p>
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
          maxlength="120"
          [value]="name()"
          (input)="name.set($any($event.target).value)"
        />
        @if (dirty()) {
          <span class="editor__dirty" title="Not saved yet — kept in this browser until you save"
            >● unsaved</span
          >
        }
        @if (bound(); as b) {
          @if (b.ownedByMe === false) {
            <span class="editor__chip" [title]="'Shared by ' + (b.createdBy || 'another operator')"
              >shared by {{ b.createdBy || 'another operator' }}</span
            >
          } @else if (b.visibility === 'Shared') {
            <span class="editor__chip" title="Every operator can see and run it">shared</span>
          }
        }
        <span class="editor__spacer"></span>
        <button type="button" (click)="importFromTradingView()" [disabled]="importing()">
          {{ importing() ? 'Importing…' : 'Import…' }}
        </button>
        @if (bound()) {
          <button
            type="button"
            [class.is-on]="historyOpen()"
            [attr.aria-expanded]="historyOpen()"
            (click)="toggleHistory()"
          >
            History
          </button>
          @if (bound()!.ownedByMe !== false) {
            <button
              type="button"
              [disabled]="sharing()"
              (click)="toggleShare()"
              [title]="
                bound()!.visibility === 'Shared'
                  ? 'Every operator can see and run it — make it private again'
                  : 'Let every operator see, run and copy it (only you change it)'
              "
            >
              {{ bound()!.visibility === 'Shared' ? 'Unshare' : 'Share' }}
            </button>
          }
        }
        <button type="button" (click)="compile()" [disabled]="compiling()">
          {{ compiling() ? 'Compiling…' : 'Compile' }}
        </button>
        <button type="button" (click)="save()" [disabled]="saving()" [title]="saveTitle()">
          {{ saving() ? 'Saving…' : saveLabel() }}
        </button>
        @if (strategyId() !== null) {
          <a
            class="editor__link"
            [href]="'/strategies/' + strategyId() + '/edit'"
            target="_blank"
            rel="noopener"
            title="Saving there changes the engine strategy"
            >Open in strategy editor</a
          >
        }
        <button
          type="button"
          class="primary"
          (click)="addToChart()"
          [disabled]="!source().trim() || loading()"
        >
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
      @if (restorable(); as r) {
        <div class="editor__restore" role="status">
          <span>An unsaved edit from {{ age(r.savedAt) }} is kept in this browser.</span>
          <button type="button" (click)="restoreLocalDraft()">Restore it</button>
          <button type="button" (click)="discardLocalDraft()">Discard</button>
        </div>
      }
      @if (historyOpen()) {
        <div class="editor__history" aria-label="Version history">
          @if (historyLoading()) {
            <p class="muted">Loading versions…</p>
          } @else if (historyError(); as e) {
            <p class="err">{{ e }}</p>
          } @else if ((versions() ?? []).length === 0) {
            <p class="muted">
              No versions yet: this script was saved before history was kept. Its next save starts
              the history.
            </p>
          } @else {
            <ul>
              @for (v of versions(); track v.id) {
                <li>
                  <span class="mono">v{{ v.versionNumber }}</span>
                  <span>{{ actionText(v.action) }}</span>
                  <span class="muted">{{ v.createdBy || '—' }} · {{ when(v.createdAt) }}</span>
                  @if (v.isCurrent) {
                    <span class="editor__chip">current</span>
                  }
                  @if (v.note) {
                    <span class="muted note" [title]="v.note">{{ v.note }}</span>
                  }
                  <button type="button" (click)="viewVersion(v)">Compare…</button>
                </li>
              }
            </ul>
          }
        </div>
      }
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
        @if (origin(); as o) {
          <span class="info"
            >Imported from TradingView — {{ o.licence }}{{ o.author ? ', by ' + o.author : '' }}.
            {{ o.notice }} Not saved yet: Save adds it to My scripts with its source and licence
            recorded.</span
          >
        }
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
        flex-wrap: wrap;
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
      .editor__dirty {
        color: var(--text-muted);
        font-size: 11px;
        white-space: nowrap;
      }
      .editor__chip {
        padding: 0 6px;
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 10.5px;
        color: var(--text-muted);
        white-space: nowrap;
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
      button.is-on {
        border-color: var(--accent);
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
      .editor__restore {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
        background: rgba(41, 98, 255, 0.08);
      }
      .editor__history {
        max-height: 190px;
        overflow: auto;
        padding: 4px 8px;
        border-bottom: 1px solid var(--border);
      }
      .editor__history ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .editor__history li {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 0;
        min-width: 0;
      }
      .editor__history .note {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .editor__history li button {
        margin-left: auto;
        padding: 1px 8px;
      }
      .mono {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
      }
      .muted {
        color: var(--text-muted);
        margin: 0;
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
      .info {
        color: var(--text-muted);
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
  private readonly dialogs = inject(ScriptDialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly autosaver = new DraftAutosaver();
  private readonly editorRef = viewChild(PineEditorComponent);

  /** Source to load (e.g. "edit" on a saved script); null keeps the starter. */
  readonly initialSource = input<string | null>(null);
  readonly initialName = input<string | null>(null);
  /**
   * The chart script the page shows here (`mine:<id>` for a saved one). Optional: without it the
   * panel finds the saved script whose source it was given.
   */
  readonly scriptKey = input<string | null>(null);
  /** The chart's symbol / resolution — refine compile warnings. */
  readonly symbol = input<string | null>(null);
  readonly resolution = input<string | null>(null);
  /** The editor is showing a script that is on the chart: "Add" becomes "Update on chart". */
  readonly onChart = input(false);
  /** The chart script's source is still being fetched from the engine. */
  readonly loading = input(false);
  /** An engine strategy: link to its editor, where saving changes the live strategy. */
  readonly strategyId = input<number | null>(null);

  /**
   * Text written into the editor from outside (the assistant's `pine.*` commands). A new `seq`
   * replaces the buffer as if typed, so the operator sees it at once and can keep editing.
   */
  readonly externalSource = input<{ text: string; seq: number } | null>(null);

  readonly add = output<ScriptEditorSubmit>();
  /** Every change to the buffer — typed, loaded or written from outside. */
  readonly sourceChange = output<string>();
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

  /** The saved script the buffer belongs to; null for a script not in My scripts yet. */
  readonly bound = signal<SavedChartScript | null>(null);
  /** What the buffer held when it was last loaded or saved — "unsaved" means edited since. */
  private readonly loaded = signal<{ source: string; name: string }>({
    source: STARTER,
    name: 'My script',
  });
  /** An imported script not saved yet. */
  readonly origin = signal<ImportOrigin | null>(null);
  readonly restorable = signal<ScriptDraftRecord | null>(null);
  readonly importing = signal(false);
  readonly sharing = signal(false);
  readonly historyOpen = signal(false);
  readonly historyLoading = signal(false);
  readonly historyError = signal<string | null>(null);
  readonly versions = signal<ChartScriptVersionDto[] | null>(null);

  /** The buffer was edited since it was loaded or saved. */
  readonly dirty = computed(() => {
    const l = this.loaded();
    return this.source() !== l.source || this.name().trim() !== l.name.trim();
  });
  readonly saveLabel = computed(() => (this.bound()?.ownedByMe === false ? 'Save a copy' : 'Save'));
  readonly saveTitle = computed(() => {
    const b = this.bound();
    if (!b) return 'Save to My scripts (⌘S)';
    return b.ownedByMe === false
      ? 'This script is shared by another operator: save your own copy of it'
      : `Save as the next version of “${b.name}” (⌘S)`;
  });

  constructor() {
    effect(() => {
      const src = this.initialSource();
      const name = this.initialName();
      const key = this.scriptKey();
      untracked(() => this.load(src, name, key));
    });
    let appliedSeq = -1;
    effect(() => {
      const ext = this.externalSource();
      if (!ext || ext.seq === appliedSeq) return;
      appliedSeq = ext.seq;
      untracked(() => {
        this.source.set(ext.text);
        this.result.set(null);
        this.savedNote.set(null);
        this.sourceChange.emit(ext.text);
      });
    });
    // PE-I3: an edit not saved yet is kept in this browser (and forgotten once saved or undone).
    effect(() => {
      const source = this.source();
      const name = this.name();
      const dirty = this.dirty();
      untracked(() => {
        const key = this.localKey();
        if (dirty) {
          this.autosaver.schedule(key, {
            source,
            name,
            baseRevision: this.bound()?.revision ?? null,
            savedAt: Date.now(),
          });
        } else {
          this.autosaver.cancel();
          // A kept draft on offer stays stored until the operator restores or discards it.
          if (!this.restorable()) clearDraft(key);
        }
      });
    });
    this.destroyRef.onDestroy(() => this.autosaver.flush());
    warnBeforeUnload(() => this.dirty(), this.destroyRef);
  }

  private loadedOnce = false;

  /**
   * Loads what the page points the editor at and binds it to the saved script it is (by key, else
   * by its source). The page echoing the editor's own text back (after "Update on chart") is not a
   * load: the binding and the edit stay.
   */
  private load(src: string | null, name: string | null, key: string | null): void {
    if (this.loadedOnce && src !== null && src === this.source()) return;
    this.loadedOnce = true;
    if (src !== null) this.source.set(src);
    const b = src === null ? null : this.findBinding(src, name, key);
    this.bound.set(b);
    this.origin.set(null);
    this.historyOpen.set(false);
    this.versions.set(null);
    if (b) this.name.set(b.name);
    else if (name) this.name.set(name);
    this.loaded.set({ source: b?.source ?? this.source(), name: this.name() });
    this.result.set(null);
    this.sourceChange.emit(this.source());
    this.offerLocalDraft();
  }

  private findBinding(
    src: string,
    name: string | null,
    key: string | null,
  ): SavedChartScript | null {
    const list = this.scripts.savedScripts?.() ?? [];
    const id = key?.startsWith('mine:') ? key.slice('mine:'.length) : null;
    if (id && /^\d+$/.test(id)) {
      const byKey = list.find((s) => s.id === id);
      if (byKey) return byKey;
    }
    const same = list.filter((s) => /^\d+$/.test(s.id) && s.source === src);
    if (same.length === 0) return null;
    return same.find((s) => s.name.trim() === (name ?? '').trim()) ?? same[0];
  }

  protected onEdit(v: string): void {
    this.source.set(v);
    this.savedNote.set(null);
    this.sourceChange.emit(v);
  }

  /** Show a compile result produced elsewhere (the assistant's `pine.compile`). */
  showCompile(r: ScriptCompileResult): void {
    this.result.set(r);
    this.error.set(null);
  }

  /** Bring a source position into view and put the cursor there (a chip's failure "Line N"). */
  revealLine(line: number, column = 1): void {
    this.editorRef()?.revealPosition(line, column);
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

  protected readonly saving = signal(false);

  /**
   * Save (button, ⌘S): the bound script's next version when it is the operator's own; otherwise a
   * new script — asking first when the operator already has a script of that name.
   */
  async save(): Promise<void> {
    if (this.saving()) return;
    this.error.set(null);
    const name = this.name().trim() || 'Untitled script';
    const b = this.bound();
    this.saving.set(true);
    try {
      if (b && b.ownedByMe !== false) {
        await this.update(b, name);
        return;
      }
      const taken = this.scripts.findOwnByName(name);
      if (taken) {
        const r = await this.dialogs.ask({
          title: `“${name}” is already in My scripts`,
          message:
            `You already have a script called “${name}” (saved ${draftAge(taken.updatedAt)}). ` +
            'Saving under the same name would replace it. Save this one under another name, or ' +
            'replace that one — it keeps its history, so it can be restored.',
          compare: {
            before: taken.source,
            after: this.source(),
            beforeLabel: `“${taken.name}” as saved`,
            afterLabel: 'This editor',
          },
          field: { label: 'New name', value: this.scripts.freeName(name), maxLength: 120 },
          choices: [
            { id: 'rename', label: 'Save under the new name', tone: 'primary', needsText: true },
            { id: 'overwrite', label: `Replace “${name}”`, tone: 'danger' },
          ],
        });
        if (r.choice === 'rename') await this.create(r.text.trim());
        else if (r.choice === 'overwrite') {
          const latest = await firstValueFrom(this.scripts.latest(taken.id));
          await this.update(latest, name);
        }
        return;
      }
      await this.create(name);
    } catch (e) {
      this.fail(toScriptingError(e, 'Saving the script failed.'));
    } finally {
      this.saving.set(false);
    }
  }

  private async create(name: string): Promise<void> {
    const o = this.origin();
    try {
      const s = await firstValueFrom(
        this.scripts.saveScript({
          name,
          source: this.source(),
          origin: o ? { sourceUrl: o.sourceUrl, licence: o.licence, author: o.author } : null,
        }),
      );
      // The draft kept for the unsaved script is now the saved one.
      clearDraft(this.localKey());
      this.origin.set(null);
      this.afterSave(s, `Saved “${s.name}” to My scripts.`);
    } catch (e) {
      this.fail(toScriptingError(e, 'Saving the script failed.'));
    }
  }

  /**
   * The next version of `target`, from the revision the edit started on (or, after a conflict, the
   * revision the operator chose to save over). A newer saved state asks first.
   */
  private async update(
    target: SavedChartScript,
    name: string,
    overRevision?: string | null,
  ): Promise<void> {
    try {
      const s = await firstValueFrom(
        this.scripts.saveScript({
          name,
          source: this.source(),
          target: {
            id: target.id,
            revision: overRevision !== undefined ? overRevision : (target.revision ?? null),
            inputs: target.inputs,
          },
        }),
      );
      this.afterSave(
        s,
        s.latestVersion ? `Saved “${s.name}” (v${s.latestVersion}).` : `Saved “${s.name}”.`,
      );
    } catch (e) {
      const err = toScriptingError(e, 'Saving the script failed.');
      if (err.isConflict && overRevision === undefined) await this.resolveConflict(target, name);
      else this.fail(err);
    }
  }

  /** The saved script changed after this edit started: compare, then the operator decides. */
  private async resolveConflict(target: SavedChartScript, name: string): Promise<void> {
    let theirs: SavedChartScript;
    try {
      theirs = await firstValueFrom(this.scripts.latest(target.id));
    } catch (e) {
      this.fail(toScriptingError(e, 'The saved script changed and could not be read to compare.'));
      return;
    }
    const r = await this.dialogs.ask({
      title: `“${theirs.name}” changed since you opened it`,
      message:
        'It was saved again elsewhere (another tab, window or device) after this edit started. ' +
        'Compare the two before deciding — nothing is overwritten unless you choose to.',
      compare: {
        before: theirs.source,
        after: this.source(),
        beforeLabel: 'Saved now',
        afterLabel: 'Your edit',
        beforeName: theirs.name,
        afterName: name,
      },
      choices: [
        { id: 'copy', label: 'Save mine as a copy' },
        { id: 'reload', label: 'Discard mine and load the saved one' },
        { id: 'overwrite', label: 'Save mine over it', tone: 'danger' },
      ],
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
    switch (r.choice) {
      case 'overwrite':
        await this.update(theirs, name, theirs.revision ?? null);
        return;
      case 'reload':
        this.replaceBuffer(theirs.source);
        this.bindTo(theirs);
        this.savedNote.set('Loaded the saved script. Your edit was discarded.');
        return;
      case 'copy':
        await this.create(this.scripts.freeName(`${name} (copy)`));
        return;
      default:
        this.error.set(
          'Not saved: the script changed since you opened it. Compare, then save again.',
        );
    }
  }

  private afterSave(s: SavedChartScript, note: string): void {
    this.bindTo(s);
    this.result.set(null);
    this.savedNote.set(note);
    this.saved.emit(s.id);
    if (this.historyOpen()) void this.loadHistory();
  }

  private bindTo(s: SavedChartScript): void {
    this.autosaver.cancel();
    clearDraft(this.localKey());
    this.bound.set(s);
    this.name.set(s.name);
    this.loaded.set({ source: s.source, name: s.name });
    this.restorable.set(null);
  }

  private fail(err: ScriptingApiError): void {
    // A compile refusal carries the compile response: mark every diagnostic in the editor.
    if (err.compile) this.result.set(err.compile);
    this.error.set(err.message || 'Saving the script failed.');
  }

  /** Replaces the buffer as an edit the operator can undo (Ctrl/Cmd-Z). */
  private replaceBuffer(text: string): void {
    this.editorRef()?.replaceSource(text);
    this.source.set(text);
    this.sourceChange.emit(text);
  }

  // ── History (C4) ──────────────────────────────────────────────────────────

  async toggleHistory(): Promise<void> {
    const open = !this.historyOpen();
    this.historyOpen.set(open);
    if (open) await this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    const b = this.bound();
    if (!b) return;
    this.historyLoading.set(true);
    this.historyError.set(null);
    try {
      this.versions.set(await firstValueFrom(this.scripts.versions(b.id)));
    } catch (e) {
      this.historyError.set(
        toScriptingError(e, 'The version history could not be loaded.').message,
      );
    } finally {
      this.historyLoading.set(false);
    }
  }

  /** Compares a version with the editor; from there it opens in the editor or is restored. */
  async viewVersion(v: ChartScriptVersionDto): Promise<void> {
    const b = this.bound();
    if (!b) return;
    let detail;
    try {
      detail = await firstValueFrom(this.scripts.version(b.id, v.id));
    } catch (e) {
      this.historyError.set(toScriptingError(e, 'The version could not be loaded.').message);
      return;
    }
    const owner = b.ownedByMe !== false;
    const choices: { id: 'open' | 'restore'; label: string; tone?: 'primary' }[] = [
      { id: 'open', label: 'Open it in the editor' },
    ];
    if (owner && !v.isCurrent) {
      choices.push({ id: 'restore', label: `Restore v${v.versionNumber}`, tone: 'primary' });
    }
    const r = await this.dialogs.ask({
      title: `v${v.versionNumber} of “${b.name}”`,
      message:
        `${this.actionText(v.action)} by ${v.createdBy || 'an unknown operator'}, ${this.when(v.createdAt)}.` +
        (v.note ? ` ${v.note}.` : '') +
        (owner && !v.isCurrent
          ? ' Restoring saves it as the next version — the current one stays in the history.'
          : ''),
      compare: {
        before: detail.pineSource,
        after: this.source(),
        beforeLabel: `v${v.versionNumber}`,
        afterLabel: 'Editor now',
        beforeName: detail.name,
        afterName: this.name(),
      },
      choices,
      cancelLabel: 'Close',
    });
    if (r.choice === 'open') {
      this.replaceBuffer(detail.pineSource);
      this.savedNote.set(
        `Opened v${v.versionNumber} in the editor (not saved). Save makes it the next version; Ctrl/Cmd-Z undoes.`,
      );
    } else if (r.choice === 'restore') {
      await this.restoreVersion(v);
    }
  }

  private async restoreVersion(v: ChartScriptVersionDto): Promise<void> {
    const b = this.bound();
    if (!b) return;
    if (
      this.dirty() &&
      !(await this.dialogs.confirm({
        title: `Restore v${v.versionNumber}?`,
        message: 'The editor has an unsaved edit; restoring replaces it with the restored version.',
        confirmLabel: 'Restore',
        tone: 'danger',
      }))
    ) {
      return;
    }
    try {
      const s = await firstValueFrom(this.scripts.restore(b.id, v.id, b.revision ?? null));
      this.replaceBuffer(s.source);
      this.afterSave(s, `Restored v${v.versionNumber} (saved as v${s.latestVersion ?? '?'}).`);
    } catch (e) {
      const err = toScriptingError(e, 'Restoring the version failed.');
      this.error.set(
        err.isConflict
          ? 'Not restored: the script was saved elsewhere since you opened it. Reopen it from My scripts, then restore.'
          : err.message,
      );
    }
  }

  // ── Sharing (C4) ──────────────────────────────────────────────────────────

  async toggleShare(): Promise<void> {
    const b = this.bound();
    if (!b || b.ownedByMe === false || this.sharing()) return;
    const next = b.visibility === 'Shared' ? 'Private' : 'Shared';
    if (
      next === 'Shared' &&
      !(await this.dialogs.confirm({
        title: `Share “${b.name}”?`,
        message:
          'Every operator will see it in My scripts and can run it and save a copy. Only you can change, restore or delete it.',
        confirmLabel: 'Share it',
      }))
    ) {
      return;
    }
    this.sharing.set(true);
    try {
      const s = await firstValueFrom(this.scripts.setVisibility(b.id, next));
      this.bound.set({ ...b, visibility: s.visibility, revision: s.revision ?? b.revision });
      this.savedNote.set(
        next === 'Shared' ? `“${b.name}” is shared.` : `“${b.name}” is private again.`,
      );
    } catch (e) {
      this.error.set(toScriptingError(e, 'Changing who can see the script failed.').message);
    } finally {
      this.sharing.set(false);
    }
  }

  // ── Import from TradingView (SS-I8) ───────────────────────────────────────

  async importFromTradingView(): Promise<void> {
    const r = await this.dialogs.ask({
      title: 'Import from TradingView',
      message:
        'Paste the address of an open-source script on TradingView. The engine fetches its source and the editor opens it as an unsaved draft to review, run and save.',
      details: [
        'Protected and invite-only scripts keep their source private and cannot be imported.',
        'A script whose licence forbids commercial use is refused: this engine trades real money.',
      ],
      field: {
        label: 'Script address',
        value: '',
        placeholder: 'https://www.tradingview.com/script/…',
        maxLength: 600,
      },
      choices: [{ id: 'import', label: 'Import', tone: 'primary', needsText: true }],
    });
    if (r.choice !== 'import') return;
    this.importing.set(true);
    this.error.set(null);
    try {
      const d = await firstValueFrom(this.scripts.importFromTradingView(r.text));
      if (d.kind === 'library') {
        this.error.set(
          `“${d.name}” is a library, which a chart cannot run. Publish it from Strategies → Pine libraries.`,
        );
        return;
      }
      // Whatever was unsaved stays in this browser (autosave); the import starts a new script.
      this.autosaver.flush();
      this.bound.set(null);
      this.historyOpen.set(false);
      this.replaceBuffer(d.pineSource.replace(/\r\n?/g, '\n'));
      this.name.set(this.scripts.freeName(d.name));
      this.loaded.set({ source: this.source(), name: this.name() });
      this.origin.set({
        sourceUrl: d.sourceUrl,
        licence: d.licence?.name || 'Not stated',
        author: d.author ?? null,
        notice: d.licence?.notice ?? null,
      });
      this.result.set(null);
      this.savedNote.set(null);
    } catch (e) {
      this.error.set(toScriptingError(e, 'Importing from TradingView failed.').message);
    } finally {
      this.importing.set(false);
    }
  }

  // ── Local draft (PE-I3) ───────────────────────────────────────────────────

  private localKey(): string {
    return draftKey('chart', this.bound()?.id ?? null);
  }

  private offerLocalDraft(): void {
    const key = this.localKey();
    const d = readDraft(key);
    if (d && d.source !== this.source()) this.restorable.set(d);
    else {
      this.restorable.set(null);
      if (d) clearDraft(key);
    }
  }

  restoreLocalDraft(): void {
    const d = this.restorable();
    if (!d) return;
    this.restorable.set(null);
    this.replaceBuffer(d.source);
    if (d.name) this.name.set(d.name);
  }

  discardLocalDraft(): void {
    this.restorable.set(null);
    clearDraft(this.localKey());
  }

  protected age(savedAt: number): string {
    return draftAge(savedAt);
  }

  protected actionText(action: string): string {
    return ACTION_TEXT[action] ?? action;
  }

  protected when(iso: string): string {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? draftAge(t) : iso;
  }

  protected addToChart(): void {
    this.add.emit({
      source: this.source(),
      kind: detectScriptKind(this.source()),
      name: this.name(),
    });
  }
}
