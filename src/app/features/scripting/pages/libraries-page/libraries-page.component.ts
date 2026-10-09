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
  ScriptLibraryUsageDto,
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
import { ScriptDiffComponent } from '../../shared/script-diff.component';
import { ScriptDialogService, confirmDiscard } from '../../shared/script-dialog.service';
import { warnBeforeUnload, type HasUnsavedChanges } from '../../shared/unsaved-changes';
import { exportChanges, newestVersionOf, previousVersionOf, versionsOf } from './library-versions';

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
  /** What the draft opened with — anything else is an unsaved change (PE-14). */
  startName: string;
  startDescription: string;
  startSource: string;
  /**
   * PE-I12: the newest version the draft knew about (0 for a new library) — the engine refuses the
   * publish with `-409` when a newer one exists, instead of dropping its changes unseen.
   */
  basedOnVersion: number;
  /** The exports of that newest version: a publish that drops any asks first. */
  baseExports: ScriptExportDto[] | null;
}

type DetailTab = 'source' | 'exports' | 'changes' | 'usage';

const DRAFT_UNSAVED = 'The library draft has unsaved changes';

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
    ScriptDiffComponent,
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
                  <span class="chip" [class.chip-ok]="lib.visibility === 'Shared'">{{
                    lib.visibility
                  }}</span>
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
                    <option value="Private" [selected]="d.visibility === 'Private'">
                      Private — only me
                    </option>
                    <option value="Shared" [selected]="d.visibility === 'Shared'">
                      Shared — every operator
                    </option>
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
              @if (d.baseId) {
                <p class="muted small">
                  Starts from v{{ d.basedOnVersion }}; publishes v{{ d.basedOnVersion + 1 }}.
                  Scripts keep importing the version they name until they are moved.
                </p>
              }
              <app-script-workbench
                [source]="d.source"
                (sourceChange)="patchDraft({ source: $event })"
                [fileName]="(d.name || 'library') + '.pine'"
                label="Library source"
                editorHeight="420px"
                saveShortcut="save"
                (saveRequested)="publish()"
                (compiled)="draftCompile.set($event)"
              />
              @if (draftCompile()?.exports?.length) {
                <div class="exports-preview">
                  <span class="muted small">Exports:</span>
                  @for (e of draftCompile()!.exports!; track e.name) {
                    <span class="chip" [title]="e.signature ?? e.kind"
                      >{{ e.kind }} {{ e.name }}</span
                    >
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
                  <button type="button" class="btn btn-sm" (click)="startNewVersion(lib)">
                    New version
                  </button>
                  <button type="button" class="btn btn-danger btn-sm" (click)="askDelete(lib)">
                    Delete
                  </button>
                }
              </div>
              @if (lib.description) {
                <p class="desc">{{ lib.description }}</p>
              }
              <div class="import-line">
                <code class="mono">{{ importLine(lib) }}</code>
                <button type="button" class="btn btn-ghost btn-sm" (click)="copyImport(lib)">
                  Copy
                </button>
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
                <button
                  type="button"
                  role="tab"
                  class="detail-tab"
                  [class.is-active]="detailTab() === 'changes'"
                  (click)="openChanges(lib)"
                >
                  Changes
                </button>
                <button
                  type="button"
                  role="tab"
                  class="detail-tab"
                  [class.is-active]="detailTab() === 'usage'"
                  (click)="openUsage(lib)"
                >
                  Used by
                </button>
              </div>
              @if (detailTab() === 'source') {
                @if (loadingDetail()) {
                  <p class="muted small">Loading source…</p>
                } @else {
                  <app-pine-editor
                    [value]="detail()?.source ?? ''"
                    [readOnly]="true"
                    height="480px"
                  />
                }
              } @else if (detailTab() === 'changes') {
                <!-- PE-I12: what changed between two versions of this library. -->
                @if (otherVersions(lib).length === 0) {
                  <p class="muted small">
                    This is the only version of {{ lib.publisher }}/{{ lib.name }}.
                  </p>
                } @else {
                  <label class="compare-bar">
                    <span class="muted small">Compare v{{ lib.version }} with</span>
                    <select
                      class="field-input"
                      (change)="compareWith(+$any($event.target).value)"
                      aria-label="Version to compare with"
                    >
                      @for (v of otherVersions(lib); track v.id) {
                        <option [value]="v.id" [selected]="v.id === compareId()">
                          v{{ v.version }}
                        </option>
                      }
                    </select>
                  </label>
                  @if (compareLoading() || loadingDetail()) {
                    <p class="muted small">Loading the versions…</p>
                  } @else if (comparePair(); as pair) {
                    <app-script-diff
                      [before]="pair.older.source"
                      [after]="pair.newer.source"
                      [beforeLabel]="'v' + pair.older.version"
                      [afterLabel]="'v' + pair.newer.version"
                      maxHeight="480px"
                    />
                    @if (exportDiff(); as x) {
                      <div class="export-diff" data-testid="export-diff">
                        @if (x.added.length + x.removed.length + x.changed.length === 0) {
                          <p class="muted small">The exports are the same.</p>
                        }
                        @for (e of x.added; track e.name) {
                          <p class="small">
                            <span class="tag tag-add">added</span>
                            <span class="mono">{{ e.name }}</span>
                          </p>
                        }
                        @for (e of x.removed; track e.name) {
                          <p class="small">
                            <span class="tag tag-del">removed</span>
                            <span class="mono">{{ e.name }}</span>
                          </p>
                        }
                        @for (e of x.changed; track e.name) {
                          <p class="small">
                            <span class="tag">changed</span>
                            <span class="mono">{{ e.before }}</span> →
                            <span class="mono">{{ e.after }}</span>
                          </p>
                        }
                      </div>
                    }
                  }
                  @if (compareError(); as e) {
                    <div class="error-box">{{ e }}</div>
                  }
                }
              } @else if (detailTab() === 'usage') {
                <!-- PE-I12: what imports this version, directly or through another library. -->
                @if (usageLoading()) {
                  <p class="muted small">Looking for importers…</p>
                } @else if (usageError(); as e) {
                  <div class="error-box">{{ e }}</div>
                } @else if (usage(); as u) {
                  @if (u.strategies.length + u.chartScripts.length + u.libraries.length === 0) {
                    <p class="muted small" data-testid="usage-none">
                      Nothing imports {{ u.importPath }}: deleting it breaks no script.
                    </p>
                  } @else {
                    <div class="usage" data-testid="usage">
                      @if (u.strategies.length > 0) {
                        <h4 class="usage-title">Strategies ({{ u.strategies.length }})</h4>
                        <ul>
                          @for (st of u.strategies; track st.id) {
                            <li>
                              <a [routerLink]="['/strategies', st.id]">{{ st.name }}</a>
                              <span class="muted small">
                                {{ st.symbol }} {{ st.timeframe }} · {{ st.status }} ·
                                {{ st.lifecycleStage }}
                                {{ st.direct ? '' : '· through another library' }}
                              </span>
                              @if (st.blocksDelete) {
                                <span
                                  class="chip chip-warn"
                                  title="Live, approved, shadow-live or paper trading"
                                  >trading</span
                                >
                              }
                            </li>
                          }
                        </ul>
                      }
                      @if (u.chartScripts.length > 0) {
                        <h4 class="usage-title">Chart scripts ({{ u.chartScripts.length }})</h4>
                        <ul>
                          @for (c of u.chartScripts; track c.id) {
                            <li>
                              {{ c.name }}
                              <span class="muted small">
                                {{
                                  c.ownedByMe
                                    ? 'yours'
                                    : 'shared by ' + (c.createdBy || 'another operator')
                                }}
                                {{ c.direct ? '' : '· through another library' }}
                              </span>
                            </li>
                          }
                        </ul>
                      }
                      @if (u.libraries.length > 0) {
                        <h4 class="usage-title">Libraries ({{ u.libraries.length }})</h4>
                        <ul>
                          @for (l of u.libraries; track l.id) {
                            <li>
                              <span class="mono"
                                >{{ l.publisher }}/{{ l.name }}/{{ l.version }}</span
                              >
                              <span class="muted small">{{
                                l.direct ? '' : 'through another library'
                              }}</span>
                            </li>
                          }
                        </ul>
                      }
                    </div>
                  }
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
                Scripts import a version with
                <code class="mono">import publisher/name/version as alias</code>.
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
      .compare-bar {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .compare-bar .field-input {
        width: auto;
      }
      .export-diff p,
      .usage ul {
        margin: 0;
      }
      .usage ul {
        padding-left: 16px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 13px;
      }
      .usage-title {
        margin: 8px 0 4px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
      }
      .tag {
        display: inline-block;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 10px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .tag-add {
        background: rgba(52, 199, 89, 0.15);
      }
      .tag-del {
        background: rgba(255, 59, 48, 0.15);
      }
      .chip-warn {
        border-color: rgba(255, 149, 0, 0.5);
      }
      a.btn {
        text-decoration: none;
      }
    `,
  ],
})
export class LibrariesPageComponent implements OnInit, HasUnsavedChanges {
  private readonly scripting = inject(ScriptingService);
  private readonly language = inject(PineCatalogService);
  private readonly notifications = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly dialogs = inject(ScriptDialogService);

  readonly libraries = signal<ScriptLibraryDto[]>([]);
  readonly loading = signal(false);
  readonly listError = signal<string | null>(null);
  readonly publisherFilter = signal('');
  readonly nameFilter = signal('');
  readonly myPublisher = signal<string | null>(null);

  readonly selectedId = signal<number | null>(null);
  readonly selected = computed(
    () => this.libraries().find((l) => l.id === this.selectedId()) ?? null,
  );
  readonly detail = signal<ScriptLibraryDetailDto | null>(null);
  readonly loadingDetail = signal(false);
  readonly detailError = signal<string | null>(null);
  readonly detailTab = signal<DetailTab>('source');

  // PE-I12: version comparison and usage.
  readonly compareId = signal<number | null>(null);
  readonly compareDetail = signal<ScriptLibraryDetailDto | null>(null);
  readonly compareLoading = signal(false);
  readonly compareError = signal<string | null>(null);
  readonly usage = signal<ScriptLibraryUsageDto | null>(null);
  readonly usageLoading = signal(false);
  readonly usageError = signal<string | null>(null);

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

  readonly suggestedName = computed(
    () => readDeclarationHeader(this.draft()?.source ?? '')?.title ?? '',
  );
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
    if (c && c.diagnostics.some((x) => x.severity === 'error'))
      return 'Fix the compile errors first';
    if (this.draftKindWarning()) return 'The script must declare library()';
    return null;
  });
  readonly canPublish = computed(() => this.publishBlockedReason() === null);
  /** The two versions being compared, older first; null until both sources are loaded. */
  readonly comparePair = computed(() => {
    const cur = this.detail();
    const other = this.compareDetail();
    if (!cur || !other || cur.id === other.id) return null;
    return other.version < cur.version
      ? { older: other, newer: cur }
      : { older: cur, newer: other };
  });
  readonly exportDiff = computed(() => {
    const pair = this.comparePair();
    return pair ? exportChanges(pair.older.exports ?? [], pair.newer.exports ?? []) : null;
  });

  /** PE-14: the draft holds something it did not open with. */
  readonly draftDirty = computed(() => {
    const d = this.draft();
    return (
      !!d &&
      (d.source !== d.startSource || d.name !== d.startName || d.description !== d.startDescription)
    );
  });

  // Closing or reloading the browser tab with an unpublished draft asks the browser's question.
  private readonly unloadGuard = warnBeforeUnload(() => this.hasUnsavedChanges());

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
        this.scripting.listLibraries({
          publisher: this.publisherFilter(),
          name: this.nameFilter(),
        }),
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

  /** PE-14: an unpublished draft holds changes (the route guard and the browser ask first). */
  hasUnsavedChanges(): boolean {
    return this.draftDirty() && !this.publishing();
  }

  unsavedChangesNote(): string {
    return DRAFT_UNSAVED;
  }

  /** Runs `then` at once when no draft would be lost; otherwise only after the operator agrees. */
  private leaveDraft(then: () => void | Promise<void>): void | Promise<void> {
    if (!this.hasUnsavedChanges()) return then();
    return confirmDiscard(this.dialogs, DRAFT_UNSAVED).then((ok) => (ok ? then() : undefined));
  }

  async select(id: number): Promise<void> {
    if (this.hasUnsavedChanges() && !(await confirmDiscard(this.dialogs, DRAFT_UNSAVED))) return;
    this.draft.set(null);
    this.selectedId.set(id);
    this.detail.set(null);
    this.detailError.set(null);
    this.detailTab.set('source');
    this.compareId.set(null);
    this.compareDetail.set(null);
    this.compareError.set(null);
    this.usage.set(null);
    this.usageError.set(null);
    void this.router.navigate([], {
      queryParams: { id },
      replaceUrl: true,
      queryParamsHandling: 'merge',
    });
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

  /** The library's other listed versions, newest first. */
  otherVersions(lib: ScriptLibraryDto): ScriptLibraryDto[] {
    return versionsOf(this.libraries(), lib).filter((v) => v.id !== lib.id);
  }

  /** The Changes tab: compares with the previous version (or the next, for a first version). */
  openChanges(lib: ScriptLibraryDto): void {
    this.detailTab.set('changes');
    if (this.compareId() !== null) return;
    const other = previousVersionOf(this.libraries(), lib) ?? this.otherVersions(lib).at(-1);
    if (other) void this.compareWith(other.id);
  }

  async compareWith(id: number): Promise<void> {
    this.compareId.set(id);
    this.compareError.set(null);
    this.compareLoading.set(true);
    try {
      const d = await firstValueFrom(this.scripting.getLibrary(id));
      if (this.compareId() === id) this.compareDetail.set(d);
    } catch (err) {
      if (this.compareId() === id) {
        this.compareError.set(toScriptingError(err, 'That version could not be loaded.').message);
      }
    } finally {
      if (this.compareId() === id) this.compareLoading.set(false);
    }
  }

  /** The Used-by tab: strategies, chart scripts and libraries importing this version. */
  async openUsage(lib: ScriptLibraryDto): Promise<void> {
    this.detailTab.set('usage');
    if (this.usage()?.libraryId === lib.id || this.usageLoading()) return;
    this.usageLoading.set(true);
    this.usageError.set(null);
    try {
      const u = await firstValueFrom(this.scripting.getLibraryUsage(lib.id));
      if (this.selectedId() === lib.id) this.usage.set(u);
    } catch (err) {
      if (this.selectedId() === lib.id) {
        this.usageError.set(toScriptingError(err, 'Its importers could not be listed.').message);
      }
    } finally {
      this.usageLoading.set(false);
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

  startNew(): void | Promise<void> {
    return this.leaveDraft(() => {
      this.selectedId.set(null);
      this.publishError.set(null);
      this.draftCompile.set(null);
      this.draft.set({
        baseId: null,
        name: '',
        description: '',
        visibility: 'Private',
        source: NEW_LIBRARY_TEMPLATE,
        startName: '',
        startDescription: '',
        startSource: NEW_LIBRARY_TEMPLATE,
        basedOnVersion: 0,
        baseExports: null,
      });
    });
  }

  /**
   * A new version starts from the newest one (PE-14): starting from an older version would publish
   * its source over the newer versions' changes. From an older version it asks which to start from.
   */
  async startNewVersion(lib: ScriptLibraryDto): Promise<void> {
    const newest = newestVersionOf(this.libraries(), lib);
    let from = newest;
    if (newest.id !== lib.id) {
      const answer = await this.dialogs.ask<'newest' | 'this'>({
        title: 'Start the new version from which version?',
        message: `v${lib.version} is not the newest version of ${lib.publisher}/${lib.name} — v${newest.version} is. Whichever you start from is published as v${newest.version + 1}.`,
        details: [
          `Starting from v${lib.version} drops whatever v${lib.version + 1}–v${newest.version} changed, unless you bring it back.`,
        ],
        choices: [
          { id: 'newest', label: `Start from v${newest.version}`, tone: 'primary' },
          { id: 'this', label: `Start from v${lib.version}` },
        ],
        cancelLabel: 'Cancel',
      });
      if (!answer.choice) return;
      from = answer.choice === 'newest' ? newest : lib;
    }
    if (this.hasUnsavedChanges() && !(await confirmDiscard(this.dialogs, DRAFT_UNSAVED))) return;
    this.publishError.set(null);
    try {
      const source = await this.sourceOf(from);
      const baseExports = await this.exportsOfVersion(newest);
      this.draftCompile.set(null);
      this.draft.set({
        baseId: lib.id,
        name: lib.name,
        description: from.description ?? '',
        visibility: from.visibility === 'Shared' ? 'Shared' : 'Private',
        source,
        startName: lib.name,
        startDescription: from.description ?? '',
        startSource: source,
        basedOnVersion: newest.version,
        baseExports,
      });
    } catch (err) {
      this.notifications.error(toScriptingError(err, 'That version could not be loaded.').message);
    }
  }

  private async sourceOf(lib: ScriptLibraryDto): Promise<string> {
    const d = this.detail();
    if (d?.id === lib.id) return d.source;
    return (await firstValueFrom(this.scripting.getLibrary(lib.id))).source;
  }

  /** A version's exports: the loaded detail's, the list's, else read from the engine. */
  private async exportsOfVersion(lib: ScriptLibraryDto): Promise<ScriptExportDto[] | null> {
    const d = this.detail();
    if (d?.id === lib.id && d.exports) return d.exports;
    if (lib.exports) return lib.exports;
    try {
      return (await firstValueFrom(this.scripting.getLibrary(lib.id))).exports ?? null;
    } catch {
      return null;
    }
  }

  patchDraft(patch: Partial<LibraryDraft>): void {
    const d = this.draft();
    if (!d) return;
    this.draft.set({ ...d, ...patch });
  }

  cancelDraft(): void | Promise<void> {
    return this.leaveDraft(() => {
      const baseId = this.draft()?.baseId ?? null;
      this.draft.set(null);
      this.publishError.set(null);
      if (baseId) this.selectedId.set(baseId);
    });
  }

  /**
   * Publishes the draft. A new version that drops exports the newest version has asks first
   * (PE-I12); a newer version published since the draft started comes back as `-409` and opens a
   * comparison with it.
   */
  async publish(): Promise<void> {
    const d = this.draft();
    if (!d || !this.canPublish() || this.publishing()) return;
    const removed = this.removedExports(d);
    if (removed.length > 0) {
      const ok = await this.dialogs.confirm({
        title: 'Publish without some exports?',
        message: `This version drops ${removed.length === 1 ? 'an export' : `${removed.length} exports`} v${d.basedOnVersion} has: ${removed.join(', ')}.`,
        details: [
          `Scripts importing v${d.basedOnVersion} or older keep working: an import names its version.`,
          'A script moved to the new version stops compiling wherever it uses them.',
        ],
        confirmLabel: 'Publish anyway',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
      if (!ok || this.draft() !== d) return;
    }
    this.publishing.set(true);
    this.publishError.set(null);
    const name = (d.name.trim() || this.suggestedName()).trim();
    try {
      const lib = await firstValueFrom(
        this.scripting.createLibrary({
          name,
          description: d.description.trim() || null,
          visibility: d.visibility,
          source: d.source,
          basedOnVersion: d.basedOnVersion,
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
      if (e.isConflict && (await this.resolveNewerVersion(d, name, e.message))) return;
      this.publishError.set(e.message);
    } finally {
      this.publishing.set(false);
    }
  }

  /** Export names the newest version has and the draft's compiled exports do not. */
  private removedExports(d: LibraryDraft): string[] {
    const compiled = this.draftCompile();
    if (!d.baseExports || !compiled?.exports) return [];
    const now = new Set(compiled.exports.map((e) => e.name));
    return d.baseExports.filter((e) => !now.has(e.name)).map((e) => e.name);
  }

  /**
   * `-409` on publish: a version newer than the one the draft started from exists. Shows it next to
   * the draft; "Publish anyway" re-bases the draft on it and publishes again (asking again about
   * dropped exports). False when the conflict is something else (the message is shown instead).
   */
  private async resolveNewerVersion(
    d: LibraryDraft,
    name: string,
    message: string,
  ): Promise<boolean> {
    await this.load();
    const publisher = this.myPublisher();
    const mine = this.libraries().filter(
      (l) =>
        l.name.toLowerCase() === name.toLowerCase() &&
        (publisher === null || l.publisher.toLowerCase() === publisher.toLowerCase()),
    );
    const newest = mine.sort((a, b) => b.version - a.version)[0];
    if (!newest || newest.version <= d.basedOnVersion) return false;
    let newestDetail: ScriptLibraryDetailDto;
    try {
      newestDetail = await firstValueFrom(this.scripting.getLibrary(newest.id));
    } catch {
      return false;
    }
    const answer = await this.dialogs.ask<'publish'>({
      title: d.baseId
        ? 'A newer version was published'
        : `${newest.publisher}/${newest.name} already exists`,
      message: d.baseId
        ? message
        : `You already publish a library named ${newest.name} (v${newest.version}). Publishing adds v${newest.version + 1} to it.`,
      details: ['Compare the two, bring over what you need, then publish again.'],
      compare: {
        before: newestDetail.source,
        after: d.source,
        beforeLabel: `v${newest.version}`,
        afterLabel: 'Your draft',
      },
      choices: [
        { id: 'publish', label: `Publish as v${newest.version + 1} anyway`, tone: 'danger' },
      ],
      cancelLabel: 'Keep editing',
      tone: 'danger',
    });
    const current = this.draft();
    if (!current) return true;
    if (answer.choice !== 'publish') {
      this.publishError.set(
        `v${newest.version} was published after this draft started. Compare, then publish again.`,
      );
      return true;
    }
    this.draft.set({
      ...current,
      basedOnVersion: newest.version,
      baseExports: newestDetail.exports ?? newest.exports ?? null,
    });
    this.publishing.set(false);
    await this.publish();
    return true;
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
