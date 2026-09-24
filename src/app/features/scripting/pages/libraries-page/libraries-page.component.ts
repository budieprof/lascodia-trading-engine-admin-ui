import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type {
  ScriptCompileResult,
  ScriptExportDto,
  ScriptLibraryDetailDto,
  ScriptLibraryDto,
  ScriptLibraryVisibility,
} from '@core/api/scripting.types';
import { ScriptingService, toScriptingError } from '@core/services/scripting.service';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { PineEditorComponent } from '../../components/pine-editor/pine-editor.component';
import { ScriptWorkbenchComponent } from '../../components/script-workbench/script-workbench.component';
import { SCRIPTING_UI_STYLES } from '../../components/scripting-ui.styles';
import { readDeclarationHeader } from '../../pine/pine-scan';
import { PineCatalogService } from '../../services/pine-catalog.service';

/** The engine's built-in library publisher (`lascodia/std/1`). */
export const BUILTIN_PUBLISHER = 'lascodia';

export const NEW_LIBRARY_TEMPLATE = `//@version=6
// @description Utility functions shared by my strategies.
library("MyLibrary")

// @function Returns the midpoint of two values.
// @param a First value.
// @param b Second value.
// @returns The midpoint of a and b.
export midpoint(float a, float b) =>
    (a + b) / 2
`;

/** `import publisher/name/version as alias` for a library. */
export function importLine(lib: Pick<ScriptLibraryDto, 'publisher' | 'name' | 'version'>): string {
  return `import ${lib.publisher}/${lib.name}/${lib.version} as ${aliasFor(lib.name)}`;
}

/** A valid Pine identifier derived from a library name. */
export function aliasFor(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'lib';
  return /^[0-9]/.test(cleaned) ? `lib_${cleaned}` : cleaned;
}

export function isBuiltin(lib: Pick<ScriptLibraryDto, 'publisher'>): boolean {
  return lib.publisher.toLowerCase() === BUILTIN_PUBLISHER;
}

interface LibraryDraft {
  /** Set when publishing a new version of an existing library (name fixed). */
  baseId: number | null;
  name: string;
  description: string;
  visibility: ScriptLibraryVisibility;
  source: string;
}

/**
 * Pine libraries (`scripting/libraries`): browse and filter, read a version's source and exports,
 * copy its `import` line, publish a new library or a new version (compiled on the way — the
 * source must declare `library()`), and delete a version. `lascodia/std/1` is the built-in one.
 */
@Component({
  selector: 'app-libraries-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    PageHeaderComponent,
    ConfirmDialogComponent,
    RelativeTimePipe,
    PineEditorComponent,
    ScriptWorkbenchComponent,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Pine libraries"
        subtitle="Reusable Pine Script v6 code. Publish versions, then import them into script strategies."
      >
        <a routerLink="/strategies" class="btn">← Strategies</a>
        <button type="button" class="btn btn-primary" (click)="startNew()">+ New library</button>
      </app-page-header>

      <div class="filters">
        <input
          class="field-input"
          type="search"
          placeholder="Publisher"
          [value]="publisherFilter()"
          (change)="publisherFilter.set($any($event.target).value.trim()); load()"
          aria-label="Filter by publisher"
        />
        <input
          class="field-input"
          type="search"
          placeholder="Name"
          [value]="nameFilter()"
          (change)="nameFilter.set($any($event.target).value.trim()); load()"
          aria-label="Filter by name"
        />
        @if (myPublisher(); as me) {
          <button
            type="button"
            class="btn btn-sm"
            [class.btn-primary]="publisherFilter() === me"
            (click)="toggleMine(me)"
            [title]="'Only libraries published as ' + me"
          >
            Mine
          </button>
        }
        <span class="grow"></span>
        <button type="button" class="btn btn-ghost btn-sm" (click)="load()" [disabled]="loading()">
          Refresh
        </button>
      </div>

      <div class="layout">
        <section class="list" aria-label="Libraries">
          @if (loading() && libraries().length === 0) {
            <p class="muted small pad">Loading libraries…</p>
          } @else if (listError(); as e) {
            <div class="error-box">{{ e }}</div>
          } @else if (libraries().length === 0) {
            <p class="muted small pad">No libraries match. Publish one with “New library”.</p>
          }
          @for (lib of libraries(); track lib.id) {
            <button
              type="button"
              class="lib-row"
              [class.is-selected]="selectedId() === lib.id"
              (click)="select(lib.id)"
            >
              <span class="lib-path mono">{{ lib.publisher }}/{{ lib.name }}</span>
              <span class="lib-meta">
                <span class="chip">v{{ lib.version }}</span>
                @if (isBuiltin(lib)) {
                  <span class="chip chip-accent">Built-in</span>
                } @else {
                  <span class="chip" [class.chip-ok]="lib.visibility === 'Shared'">{{ lib.visibility }}</span>
                }
                @if (lib.exports?.length) {
                  <span class="muted small">{{ lib.exports!.length }} exports</span>
                }
              </span>
              @if (lib.description) {
                <span class="lib-desc">{{ lib.description }}</span>
              }
              @if (lib.updatedAt) {
                <span class="muted small">{{ lib.updatedAt | relativeTime }}</span>
              }
            </button>
          }
        </section>

        <section class="detail">
          @if (draft(); as d) {
            <div class="panel">
              <h3 class="panel-title">
                {{ d.baseId ? 'New version of ' + d.name : 'New library' }}
              </h3>
              <div class="draft-fields">
                <label class="field">
                  <span>Name <span class="required">*</span></span>
                  <input
                    class="field-input"
                    type="text"
                    maxlength="100"
                    [disabled]="!!d.baseId"
                    [value]="d.name"
                    [placeholder]="suggestedName() || 'MyLibrary'"
                    (input)="patchDraft({ name: $any($event.target).value })"
                  />
                </label>
                <label class="field">
                  <span>Visibility</span>
                  <select
                    class="field-input"
                    (change)="patchDraft({ visibility: $any($event.target).value })"
                  >
                    <option value="Private" [selected]="d.visibility === 'Private'">Private — only me</option>
                    <option value="Shared" [selected]="d.visibility === 'Shared'">Shared — every operator</option>
                  </select>
                </label>
                <label class="field wide">
                  <span>Description</span>
                  <input
                    class="field-input"
                    type="text"
                    maxlength="500"
                    [value]="d.description"
                    (input)="patchDraft({ description: $any($event.target).value })"
                  />
                </label>
              </div>
              <app-script-workbench
                [source]="d.source"
                (sourceChange)="patchDraft({ source: $event })"
                [fileName]="(d.name || 'library') + '.pine'"
                label="Library source"
                editorHeight="420px"
                (compiled)="draftCompile.set($event)"
              />
              @if (draftCompile()?.exports?.length) {
                <div class="exports-preview">
                  <span class="muted small">Exports:</span>
                  @for (e of draftCompile()!.exports!; track e.name) {
                    <span class="chip" [title]="e.signature ?? e.kind">{{ e.kind }} {{ e.name }}</span>
                  }
                </div>
              }
              @if (draftKindWarning(); as w) {
                <p class="warn">{{ w }}</p>
              }
              @if (publishError(); as e) {
                <div class="error-box" role="alert">{{ e }}</div>
              }
              <div class="actions">
                <button type="button" class="btn" (click)="cancelDraft()" [disabled]="publishing()">
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  (click)="publish()"
                  [disabled]="publishing() || !canPublish()"
                  [title]="publishBlockedReason() ?? ''"
                >
                  @if (publishing()) {
                    <span class="spinner"></span>
                  }
                  {{ d.baseId ? 'Publish new version' : 'Publish' }}
                </button>
              </div>
            </div>
          } @else if (selected(); as lib) {
            <div class="panel">
              <div class="detail-head">
                <h3 class="panel-title mono">{{ lib.publisher }}/{{ lib.name }}</h3>
                <span class="chip">v{{ lib.version }}</span>
                @if (isBuiltin(lib)) {
                  <span class="chip chip-accent">Built-in</span>
                } @else {
                  <span class="chip">{{ lib.visibility }}</span>
                }
                <span class="grow"></span>
                @if (!isBuiltin(lib)) {
                  <button type="button" class="btn btn-sm" (click)="startNewVersion(lib)">New version</button>
                  <button type="button" class="btn btn-danger btn-sm" (click)="askDelete(lib)">Delete</button>
                }
              </div>
              @if (lib.description) {
                <p class="desc">{{ lib.description }}</p>
              }
              <div class="import-line">
                <code class="mono">{{ importLine(lib) }}</code>
                <button type="button" class="btn btn-ghost btn-sm" (click)="copyImport(lib)">Copy</button>
              </div>
              <div class="detail-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  class="detail-tab"
                  [class.is-active]="detailTab() === 'source'"
                  (click)="detailTab.set('source')"
                >
                  Source
                </button>
                <button
                  type="button"
                  role="tab"
                  class="detail-tab"
                  [class.is-active]="detailTab() === 'exports'"
                  (click)="detailTab.set('exports')"
                >
                  Exports ({{ exportsOf(lib).length }})
                </button>
              </div>
              @if (detailTab() === 'source') {
                @if (loadingDetail()) {
                  <p class="muted small">Loading source…</p>
                } @else {
                  <app-pine-editor [value]="detail()?.source ?? ''" [readOnly]="true" height="480px" />
                }
              } @else {
                @if (exportsOf(lib).length === 0) {
                  <p class="muted small">No exports listed.</p>
                } @else {
                  <table class="exports">
                    <thead>
                      <tr>
                        <th>Kind</th>
                        <th>Name</th>
                        <th>Signature</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (e of exportsOf(lib); track e.name) {
                        <tr>
                          <td class="muted small">{{ e.kind }}</td>
                          <td class="mono">{{ e.name }}</td>
                          <td>
                            <span class="mono small">{{ e.signature ?? '—' }}</span>
                            @if (e.doc) {
                              <div class="muted small">{{ e.doc }}</div>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              }
              @if (detailError(); as e) {
                <div class="error-box">{{ e }}</div>
              }
            </div>
          } @else {
            <div class="panel empty">
              <p>Select a library to read its source and exports, or publish a new one.</p>
              <p class="muted small">
                Scripts import a version with <code class="mono">import publisher/name/version as alias</code>.
              </p>
            </div>
          }
        </section>
      </div>

      <app-confirm-dialog
        [open]="deleteTarget() !== null"
        title="Delete library version"
        [message]="deleteMessage()"
        [confirmLabel]="deleteConflict() ? 'Delete anyway' : 'Delete'"
        confirmVariant="destructive"
        [loading]="deleting()"
        (confirm)="confirmDelete()"
        (cancelled)="cancelDelete()"
      >
        @if (deleteError(); as e) {
          <p class="error-box">{{ e }}</p>
        }
      </app-confirm-dialog>
    </div>
  `,
  styles: [
    SCRIPTING_UI_STYLES,
    `
      .page {
        padding: var(--space-2) 0;
      }
      .filters {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .filters .field-input {
        width: 200px;
      }
      .grow {
        flex: 1;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }
      @media (max-width: 960px) {
        .layout {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: calc(100vh - 220px);
        overflow-y: auto;
      }
      .pad {
        padding: 8px;
      }
      .lib-row {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 10px 12px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .lib-row:hover {
        background: var(--bg-secondary);
      }
      .lib-row.is-selected {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.12);
      }
      .lib-path {
        font-size: 13px;
        font-weight: 600;
      }
      .lib-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .lib-desc {
        font-size: 12px;
        color: var(--text-secondary);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .panel {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 12px);
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .panel.empty {
        color: var(--text-secondary);
        font-size: 13px;
      }
      .panel.empty p {
        margin: 0;
      }
      .panel-title {
        margin: 0;
        font-size: 15px;
        font-weight: 600;
      }
      .detail-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .desc {
        margin: 0;
        font-size: 13px;
        color: var(--text-secondary);
      }
      .import-line {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 8px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
      }
      .import-line code {
        flex: 1;
        font-size: 12.5px;
        overflow-x: auto;
        white-space: nowrap;
      }
      .detail-tabs {
        display: flex;
        gap: 2px;
        border-bottom: 1px solid var(--border);
      }
      .detail-tab {
        padding: 6px 12px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .detail-tab.is-active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
      .exports {
        width: 100%;
        border-collapse: collapse;
        font-size: 12.5px;
      }
      .exports th,
      .exports td {
        text-align: left;
        padding: 6px 8px;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      .exports th {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary);
      }
      .draft-fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-secondary);
      }
      .field.wide {
        grid-column: 1 / -1;
      }
      .required {
        color: var(--loss);
      }
      .exports-preview {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .warn {
        margin: 0;
        font-size: 12px;
        color: #b25e00;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      a.btn {
        text-decoration: none;
      }
    `,
  ],
})
export class LibrariesPageComponent implements OnInit {
  private readonly scripting = inject(ScriptingService);
  private readonly language = inject(PineCatalogService);
  private readonly notifications = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly libraries = signal<ScriptLibraryDto[]>([]);
  readonly loading = signal(false);
  readonly listError = signal<string | null>(null);
  readonly publisherFilter = signal('');
  readonly nameFilter = signal('');
  readonly myPublisher = signal<string | null>(null);

  readonly selectedId = signal<number | null>(null);
  readonly selected = computed(() => this.libraries().find((l) => l.id === this.selectedId()) ?? null);
  readonly detail = signal<ScriptLibraryDetailDto | null>(null);
  readonly loadingDetail = signal(false);
  readonly detailError = signal<string | null>(null);
  readonly detailTab = signal<'source' | 'exports'>('source');

  readonly draft = signal<LibraryDraft | null>(null);
  readonly draftCompile = signal<ScriptCompileResult | null>(null);
  readonly publishing = signal(false);
  readonly publishError = signal<string | null>(null);

  readonly deleteTarget = signal<ScriptLibraryDto | null>(null);
  readonly deleting = signal(false);
  readonly deleteConflict = signal(false);
  readonly deleteError = signal<string | null>(null);

  readonly isBuiltin = isBuiltin;
  readonly importLine = importLine;

  readonly suggestedName = computed(() => readDeclarationHeader(this.draft()?.source ?? '')?.title ?? '');
  readonly draftKindWarning = computed(() => {
    const kind = this.draftCompile()?.declaration?.kind;
    return kind && kind !== 'library'
      ? `A library must declare library() — this script declares ${kind}().`
      : null;
  });
  readonly publishBlockedReason = computed<string | null>(() => {
    const d = this.draft();
    if (!d) return 'Nothing to publish';
    if (!(d.name.trim() || this.suggestedName())) return 'Give the library a name';
    if (!d.source.trim()) return 'Write the library source';
    const c = this.draftCompile();
    if (c && c.diagnostics.some((x) => x.severity === 'error')) return 'Fix the compile errors first';
    if (this.draftKindWarning()) return 'The script must declare library()';
    return null;
  });
  readonly canPublish = computed(() => this.publishBlockedReason() === null);
  readonly deleteMessage = computed(() => {
    const t = this.deleteTarget();
    if (!t) return '';
    return this.deleteConflict()
      ? `A live strategy imports ${t.publisher}/${t.name}/${t.version}. Deleting it anyway breaks that strategy at its next compile.`
      : `Delete ${t.publisher}/${t.name}/${t.version}? Strategies that import this version will no longer compile.`;
  });

  ngOnInit(): void {
    this.scripting.getMyPublisher().subscribe((p) => this.myPublisher.set(p));
    const initial = Number(this.route.snapshot?.queryParamMap?.get('id'));
    void this.load().then(() => {
      if (Number.isFinite(initial) && initial > 0) this.select(initial);
    });
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.listError.set(null);
    try {
      const list = await firstValueFrom(
        this.scripting.listLibraries({ publisher: this.publisherFilter(), name: this.nameFilter() }),
      );
      // Built-in first, then by publisher / name / newest version.
      list.sort(
        (a, b) =>
          Number(isBuiltin(b)) - Number(isBuiltin(a)) ||
          a.publisher.localeCompare(b.publisher) ||
          a.name.localeCompare(b.name) ||
          b.version - a.version,
      );
      this.libraries.set(list);
    } catch (err) {
      this.listError.set(toScriptingError(err, 'The libraries could not be loaded.').message);
    } finally {
      this.loading.set(false);
    }
  }

  toggleMine(me: string): void {
    this.publisherFilter.set(this.publisherFilter() === me ? '' : me);
    void this.load();
  }

  async select(id: number): Promise<void> {
    this.draft.set(null);
    this.selectedId.set(id);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailTab.set('source');
    void this.router.navigate([], { queryParams: { id }, replaceUrl: true, queryParamsHandling: 'merge' });
    this.loadingDetail.set(true);
    try {
      const d = await firstValueFrom(this.scripting.getLibrary(id));
      if (this.selectedId() === id) this.detail.set(d);
    } catch (err) {
      this.detailError.set(toScriptingError(err, 'The library could not be loaded.').message);
    } finally {
      this.loadingDetail.set(false);
    }
  }

  exportsOf(lib: ScriptLibraryDto): ScriptExportDto[] {
    const d = this.detail();
    return (d && d.id === lib.id ? d.exports : lib.exports) ?? lib.exports ?? [];
  }

  async copyImport(lib: ScriptLibraryDto): Promise<void> {
    try {
      await navigator.clipboard.writeText(importLine(lib));
      this.notifications.success('Import line copied');
    } catch {
      this.notifications.error('The clipboard is not available here');
    }
  }

  // ── Publishing ─────────────────────────────────────────────────────────

  startNew(): void {
    this.selectedId.set(null);
    this.publishError.set(null);
    this.draftCompile.set(null);
    this.draft.set({
      baseId: null,
      name: '',
      description: '',
      visibility: 'Private',
      source: NEW_LIBRARY_TEMPLATE,
    });
  }

  startNewVersion(lib: ScriptLibraryDto): void {
    const detail = this.detail();
    this.publishError.set(null);
    this.draftCompile.set(null);
    this.draft.set({
      baseId: lib.id,
      name: lib.name,
      description: lib.description ?? '',
      visibility: lib.visibility === 'Shared' ? 'Shared' : 'Private',
      source: detail?.id === lib.id ? detail.source : '',
    });
  }

  patchDraft(patch: Partial<LibraryDraft>): void {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d, ...patch });
  }

  cancelDraft(): void {
    const baseId = this.draft()?.baseId ?? null;
    this.draft.set(null);
    this.publishError.set(null);
    if (baseId) this.selectedId.set(baseId);
  }

  async publish(): Promise<void> {
    const d = this.draft();
    if (!d || !this.canPublish() || this.publishing()) return;
    this.publishing.set(true);
    this.publishError.set(null);
    try {
      const lib = await firstValueFrom(
        this.scripting.createLibrary({
          name: (d.name.trim() || this.suggestedName()).trim(),
          description: d.description.trim() || null,
          visibility: d.visibility,
          source: d.source,
        }),
      );
      this.notifications.success(`Published ${lib.publisher}/${lib.name}/${lib.version}`);
      this.draft.set(null);
      await this.load();
      void this.language.refreshLibraries();
      void this.select(lib.id);
    } catch (err) {
      const e = toScriptingError(err, 'Publishing the library failed.');
      if (e.compile) this.draftCompile.set(e.compile);
      this.publishError.set(e.message);
    } finally {
      this.publishing.set(false);
    }
  }

  // ── Deleting ───────────────────────────────────────────────────────────

  askDelete(lib: ScriptLibraryDto): void {
    this.deleteConflict.set(false);
    this.deleteError.set(null);
    this.deleteTarget.set(lib);
  }

  cancelDelete(): void {
    if (this.deleting()) return;
    this.deleteTarget.set(null);
  }

  async confirmDelete(): Promise<void> {
    const target = this.deleteTarget();
    if (!target || this.deleting()) return;
    this.deleting.set(true);
    this.deleteError.set(null);
    try {
      await firstValueFrom(this.scripting.deleteLibrary(target.id, this.deleteConflict()));
      this.notifications.success(`Deleted ${target.publisher}/${target.name}/${target.version}`);
      this.deleteTarget.set(null);
      if (this.selectedId() === target.id) {
        this.selectedId.set(null);
        this.detail.set(null);
      }
      await this.load();
      void this.language.refreshLibraries();
    } catch (err) {
      const e = toScriptingError(err, 'Deleting the library failed.');
      if (e.isConflict && !this.deleteConflict()) {
        // A live strategy imports it: explain, and offer the forced delete.
        this.deleteConflict.set(true);
      } else {
        this.deleteError.set(e.message);
      }
    } finally {
      this.deleting.set(false);
    }
  }
}
