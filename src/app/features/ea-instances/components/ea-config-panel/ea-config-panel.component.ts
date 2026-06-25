import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Output,
  ViewChild,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EAConfigInputs, UpdateInstanceConfigRequest } from '@core/api/api.types';
import { SkeletonComponent } from '@shared/components/ui/skeleton/skeleton.component';

/**
 * Phase-4 EA configuration editor.  Two tabs:
 *   - **Editable** — 16 hot-reloadable input shadows grouped by Timing /
 *     Entry tolerance / Execution / Runtime safety.  Each field shows the
 *     current value (from the heartbeat envelope), an editable input, and
 *     a "Hot-reloadable" badge.  Only dirty fields (non-empty, non-equal to
 *     current) are sent on submit.
 *   - **Read-only** — frozen Inp* declarations (engine URL, symbols, magic
 *     number, etc.).  Displayed for reference with a "Restart required"
 *     badge; no edit controls.
 *
 * The component is purely client-side: it inspects `inputs()` for current
 * values and posts to `EAAdminService.updateInstanceConfig`.  Parent page
 * passes the state envelope's inputs block and listens for `configPushed`
 * to refresh.
 */
@Component({
  selector: 'app-ea-config-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, SkeletonComponent],
  template: `
    <section class="panel" aria-label="EA configuration">
      <header class="panel-head">
        <h3>Configuration</h3>
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'editable'"
            (click)="tab.set('editable')"
            [attr.aria-selected]="tab() === 'editable'"
          >
            Editable
            <span class="badge tone-ok">{{ HOT_RELOAD_FIELDS.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="tab() === 'readonly'"
            (click)="tab.set('readonly')"
            [attr.aria-selected]="tab() === 'readonly'"
          >
            Read-only
            <span class="badge tone-muted">{{ READ_ONLY_FIELDS.length }}</span>
          </button>
        </div>
      </header>

      @if (loading() && !inputs()) {
        <div class="form-grid skeleton-grid" aria-label="Loading configuration" role="status">
          @for (i of skeletonFields(); track i) {
            <div class="skeleton-field">
              <ui-skeleton height="11px" width="48%" borderRadius="4px" />
              <ui-skeleton height="32px" width="100%" borderRadius="6px" />
            </div>
          }
        </div>
      } @else if (!inputs()) {
        <p class="empty muted">
          No input envelope yet — the EA pushes one on each heartbeat starting at v8.47.137. Older
          builds report only legacy safety params via the existing "Push safety config" modal.
        </p>
      } @else if (tab() === 'editable') {
        <!-- ── Sticky toolbar (search + filters + save-all) ─────── -->
        <div class="cfg-toolbar">
          <div class="cfg-search-wrap">
            <span class="cfg-search-icon" aria-hidden="true">⌕</span>
            <input
              #searchInput
              type="text"
              class="cfg-search"
              [placeholder]="'Search ' + HOT_RELOAD_FIELDS.length + ' fields…'"
              [ngModel]="searchTerm()"
              (ngModelChange)="searchTerm.set($event)"
              aria-label="Search configuration fields"
            />
            @if (searchTerm()) {
              <button
                type="button"
                class="cfg-search-clear"
                (click)="searchTerm.set('')"
                aria-label="Clear search"
              >
                ✕
              </button>
            }
            <kbd class="cfg-kbd">/</kbd>
          </div>
          <div class="chip-row" role="tablist" aria-label="Filter by reload behaviour">
            @for (b of badgeFilterOptions; track b.value) {
              <button
                type="button"
                role="tab"
                class="chip"
                [class.active]="badgeFilter() === b.value"
                [attr.aria-selected]="badgeFilter() === b.value"
                (click)="badgeFilter.set(b.value)"
              >
                {{ b.label }}
              </button>
            }
          </div>
          <label class="cfg-dirty-toggle" [class.active]="dirtyOnly()">
            <input type="checkbox" [checked]="dirtyOnly()" (change)="dirtyOnly.set(!dirtyOnly())" />
            Unsaved only
            @if (dirtyCount() > 0) {
              <span class="cfg-toolbar-count">{{ dirtyCount() }}</span>
            }
          </label>
          <div class="cfg-spacer"></div>
          <button
            type="button"
            class="btn btn-primary cfg-save-all"
            [disabled]="submitting() || !hasDirty()"
            (click)="submit()"
            [title]="hasDirty() ? 'Push pending changes (⌘/Ctrl + S)' : 'No unsaved changes'"
          >
            @if (submitting()) {
              Pushing…
            } @else if (hasDirty()) {
              Push {{ dirtyCount() }} change{{ dirtyCount() === 1 ? '' : 's' }}
              <kbd class="save-bar-kbd">⌘S</kbd>
            } @else {
              Push 0 changes
            }
          </button>
        </div>

        @if (filteredGroups().length === 0) {
          <p class="cfg-empty muted">
            No fields match the current filter.
            <button type="button" class="link-btn" (click)="clearSearch()">Clear filters</button>
          </p>
        } @else {
          <!-- ── Master-detail body ─────────────────────────────── -->
          <div class="cfg-body">
            <aside class="cfg-sidebar" aria-label="Sections">
              <div class="cfg-sb-head">
                <span>Sections</span>
                <span class="muted">{{ sidebarGroups().length }}</span>
              </div>
              <input
                type="search"
                class="cfg-sb-filter"
                placeholder="Filter sections…"
                [ngModel]="categoryFilter()"
                (ngModelChange)="categoryFilter.set($event)"
                aria-label="Filter sections"
              />
              <nav class="cfg-sb-list">
                <button
                  type="button"
                  class="cat"
                  [class.active]="selectedCategory() === ALL_CATEGORY"
                  (click)="selectCategory(ALL_CATEGORY)"
                >
                  <span class="cat-name">All sections</span>
                  <span class="cat-meta">
                    @if (dirtyCount() > 0) {
                      <span class="cat-dirty">{{ dirtyCount() }}</span>
                    }
                    <span class="cat-count">{{ visibleCount() }}</span>
                  </span>
                </button>
                @for (group of sidebarGroups(); track group.title) {
                  <button
                    type="button"
                    class="cat"
                    [class.active]="selectedCategory() === group.title"
                    (click)="selectCategory(group.title)"
                  >
                    <span class="cat-name">{{ group.title }}</span>
                    <span class="cat-meta">
                      @if (groupDirtyCount(group) > 0) {
                        <span class="cat-dirty">{{ groupDirtyCount(group) }}</span>
                      }
                      <span class="cat-count">{{ group.fields.length }}</span>
                    </span>
                  </button>
                }
              </nav>
            </aside>

            <main class="cfg-editor">
              <header class="cfg-editor-head">
                <div class="cfg-editor-title">
                  <h4>{{ selectedCategoryTitle() }}</h4>
                  <span class="muted">
                    {{ visibleCount() }}
                    {{ visibleCount() === 1 ? 'field' : 'fields' }}
                    @if (dirtyOnly() || searchTerm() || badgeFilter() !== 'all') {
                      · filtered
                    }
                  </span>
                </div>
                <p class="cfg-editor-hint muted">
                  Hot-reload takes effect on the next read-site cycle. Empty = keep current; ⏎ saves
                  the row, Esc reverts it.
                </p>
              </header>
              @if (visibleFields().length === 0) {
                <p class="cfg-empty muted">No fields in this section match the current filter.</p>
              } @else {
                <div class="cfg-table-scroll">
                  <table class="cfg-table">
                    <thead>
                      <tr>
                        <th class="col-key">Field</th>
                        <th class="col-value">Value</th>
                        <th class="col-reload">Reload</th>
                        <th class="col-current">Current</th>
                        <th class="col-actions"></th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (field of visibleFields(); track field.key) {
                        <tr [class.row-dirty]="isDirty(field)">
                          <td class="col-key">
                            <span class="field-label">{{ field.label }}</span>
                            <code class="field-key" [title]="field.takesEffect">{{
                              field.key
                            }}</code>
                          </td>
                          <td class="col-value">
                            @switch (field.kind) {
                              @case ('bool') {
                                <select
                                  [(ngModel)]="edits[field.key]"
                                  (ngModelChange)="markEdited()"
                                  (keydown)="onFieldKey($event, field)"
                                  class="input"
                                >
                                  <option [ngValue]="undefined">— keep current —</option>
                                  <option [ngValue]="true">true</option>
                                  <option [ngValue]="false">false</option>
                                </select>
                              }
                              @case ('enum') {
                                <select
                                  [(ngModel)]="edits[field.key]"
                                  (ngModelChange)="markEdited()"
                                  (keydown)="onFieldKey($event, field)"
                                  class="input"
                                >
                                  <option [ngValue]="undefined">— keep current —</option>
                                  @for (opt of field.options ?? []; track opt) {
                                    <option [ngValue]="opt">{{ opt }}</option>
                                  }
                                </select>
                              }
                              @case ('string') {
                                <input
                                  type="text"
                                  [placeholder]="
                                    'current: ' + (formatCurrent(field.key) || '(blank)')
                                  "
                                  [(ngModel)]="edits[field.key]"
                                  (ngModelChange)="markEdited()"
                                  (keydown)="onFieldKey($event, field)"
                                  class="input"
                                  autocomplete="off"
                                />
                              }
                              @default {
                                <input
                                  type="number"
                                  [step]="field.step ?? 'any'"
                                  [min]="field.min ?? null"
                                  [max]="field.max ?? null"
                                  [placeholder]="'current: ' + formatCurrent(field.key)"
                                  [(ngModel)]="edits[field.key]"
                                  (ngModelChange)="markEdited()"
                                  (keydown)="onFieldKey($event, field)"
                                  class="input"
                                />
                              }
                            }
                          </td>
                          <td class="col-reload">
                            <span
                              class="badge"
                              [attr.data-badge]="field.badge"
                              [title]="field.takesEffect"
                              >{{ field.badge }}</span
                            >
                          </td>
                          <td class="col-current">
                            <span class="current mono">{{
                              formatCurrent(field.key) || '(blank)'
                            }}</span>
                          </td>
                          <td class="col-actions">
                            @if (isDirty(field)) {
                              <button
                                type="button"
                                class="reset-btn"
                                (click)="revertField(field)"
                                title="Discard this edit (Esc)"
                              >
                                ↺
                              </button>
                            }
                            <button
                              type="button"
                              class="btn-row-save"
                              [disabled]="!isDirty(field) || submitting()"
                              (click)="saveField(field)"
                              [title]="isDirty(field) ? 'Save this row (⏎)' : 'No changes'"
                            >
                              Save
                            </button>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </main>
          </div>
        }
      } @else {
        <p class="hint muted">
          These inputs are read at attach-time and cached on objects that don't expose live setters.
          Re-attach the EA in MT5 after editing the input dialog to apply changes.
        </p>
        <div class="form-grid">
          @for (field of READ_ONLY_FIELDS; track field.key) {
            <div class="ro-field">
              <span class="field-label">
                {{ field.label }}
                <span class="badge tone-muted">restart required</span>
              </span>
              <span class="ro-value mono">{{ formatCurrent(field.key) }}</span>
            </div>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .panel-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .tabs {
        display: flex;
        gap: 4px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 2px;
      }
      .tabs button {
        padding: 6px 14px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        cursor: pointer;
        border-radius: calc(var(--radius-sm) - 2px);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .tabs button.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.06));
      }
      .badge {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: var(--radius-full);
        font-weight: var(--font-semibold);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .badge.tone-ok,
      .badge[data-badge='live'] {
        background: rgba(52, 199, 89, 0.15);
        color: #248a3d;
      }
      .badge.tone-muted {
        background: rgba(0, 0, 0, 0.06);
        color: var(--text-secondary);
      }
      .badge[data-badge='next-job'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .badge[data-badge='restart'] {
        background: rgba(255, 149, 0, 0.15);
        color: #c93400;
      }
      .hint,
      .empty {
        margin: 0;
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .form-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: var(--space-3);
      }
      .skeleton-grid {
        margin-top: var(--space-2);
      }
      .skeleton-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .field-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .input {
        padding: 5px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
        width: 100%;
        outline: none;
        transition: border-color 0.12s ease;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .current {
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .ro-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 8px 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
      }
      .ro-value {
        font-size: var(--text-sm);
        color: var(--text-primary);
        font-weight: var(--font-medium);
        font-variant-numeric: tabular-nums;
        word-break: break-all;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-3);
      }

      /* ── Search toolbar (sticky inside the panel) ────────────── */
      .cfg-toolbar {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        flex-wrap: wrap;
        position: sticky;
        top: 0;
        z-index: 3;
      }
      .cfg-search-wrap {
        position: relative;
        flex: 1 1 280px;
        min-width: 220px;
        display: inline-flex;
        align-items: center;
      }
      .cfg-search-icon {
        position: absolute;
        left: 10px;
        color: var(--text-tertiary);
        font-size: 14px;
        pointer-events: none;
      }
      .cfg-search {
        width: 100%;
        height: 30px;
        padding: 0 56px 0 30px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
        transition: border-color 0.12s ease;
      }
      .cfg-search:focus {
        border-color: var(--accent);
      }
      .cfg-search-clear {
        position: absolute;
        right: 32px;
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        cursor: pointer;
        font-size: 11px;
        padding: 3px 5px;
      }
      .cfg-search-clear:hover {
        color: var(--text-primary);
      }
      .cfg-kbd,
      .save-bar-kbd {
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 10px;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        padding: 1px 5px;
        border-radius: var(--radius-sm);
      }
      .cfg-kbd {
        position: absolute;
        right: 8px;
      }
      .chip-row {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-full);
      }
      .chip {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-family: inherit;
        font-size: 11px;
        font-weight: var(--font-semibold);
        padding: 3px 10px;
        border-radius: var(--radius-full);
        cursor: pointer;
        transition:
          background 0.12s ease,
          color 0.12s ease;
      }
      .chip:hover {
        color: var(--text-primary);
      }
      .chip.active {
        background: var(--bg-secondary);
        color: var(--text-primary);
        box-shadow: 0 0 0 1px var(--border);
      }
      .cfg-dirty-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        cursor: pointer;
        user-select: none;
        padding: 3px 8px;
        border-radius: var(--radius-full);
        transition: background 0.12s ease;
      }
      .cfg-dirty-toggle:hover {
        background: var(--bg-tertiary);
      }
      .cfg-dirty-toggle input {
        accent-color: var(--accent);
        margin: 0;
      }
      .cfg-dirty-toggle.active {
        color: var(--text-primary);
      }
      .cfg-toolbar-count {
        font-size: 10px;
        font-weight: var(--font-semibold);
        background: var(--accent);
        color: white;
        border-radius: var(--radius-full);
        padding: 1px 6px;
        font-variant-numeric: tabular-nums;
      }
      .cfg-empty {
        padding: var(--space-4);
        text-align: center;
        font-size: var(--text-xs);
        background: var(--bg-primary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-sm);
      }
      .link-btn {
        background: transparent;
        border: none;
        color: var(--accent);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        cursor: pointer;
        padding: 0 0 0 6px;
      }
      .link-btn:hover {
        text-decoration: underline;
      }

      /* ── Toolbar spacer + save-all CTA ──────────────────────── */
      .cfg-spacer {
        flex: 1;
      }
      .cfg-save-all {
        height: 32px;
        padding: 0 14px;
        font-size: 12px;
        font-weight: var(--font-semibold);
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: auto;
      }
      .save-bar-kbd {
        background: rgba(255, 255, 255, 0.22);
        color: rgba(255, 255, 255, 0.9);
        padding: 1px 5px;
        border-radius: var(--radius-sm);
        font-size: 9px;
        font-family: 'SF Mono', 'Menlo', monospace;
      }

      /* ── Master-detail body (sidebar | editor) ──────────────── */
      .cfg-body {
        display: grid;
        grid-template-columns: 200px 1fr;
        gap: var(--space-3);
        height: min(70vh, 720px);
        min-height: 440px;
      }
      @media (max-width: 900px) {
        .cfg-body {
          grid-template-columns: 1fr;
          height: auto;
        }
      }

      .cfg-sidebar {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      .cfg-sb-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding: 6px 10px;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--border);
      }
      .cfg-sb-head .muted {
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .cfg-sb-filter {
        appearance: none;
        margin: 6px 6px;
        height: 26px;
        padding: 0 8px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        font-size: 11px;
        outline: none;
      }
      .cfg-sb-filter:focus {
        border-color: var(--accent);
      }
      .cfg-sb-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .cat {
        appearance: none;
        background: transparent;
        border: none;
        color: var(--text-primary);
        font-family: inherit;
        font-size: 12px;
        text-align: left;
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        transition:
          background 0.1s ease,
          color 0.1s ease;
      }
      .cat:hover {
        background: var(--bg-tertiary);
      }
      .cat.active {
        background: color-mix(in srgb, var(--accent, #0071e3) 14%, transparent);
        color: var(--accent, #0071e3);
        font-weight: var(--font-semibold);
      }
      .cat-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cat-meta {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        flex-shrink: 0;
      }
      .cat-count {
        font-size: 10.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .cat.active .cat-count {
        color: var(--accent, #0071e3);
      }
      .cat-dirty {
        font-size: 10px;
        font-weight: var(--font-semibold);
        background: rgba(255, 149, 0, 0.18);
        color: #b86200;
        padding: 0 6px;
        border-radius: var(--radius-full);
        font-variant-numeric: tabular-nums;
        min-width: 16px;
        text-align: center;
      }

      /* ── Editor pane ────────────────────────────────────────── */
      .cfg-editor {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        overflow: hidden;
      }
      .cfg-editor-head {
        padding: 10px var(--space-3) 8px;
        border-bottom: 1px solid var(--border);
      }
      .cfg-editor-title {
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .cfg-editor-title h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .cfg-editor-title .muted {
        font-size: 11px;
        color: var(--text-tertiary);
      }
      .cfg-editor-hint {
        margin: 6px 0 0 0;
        font-size: 11px;
      }

      .cfg-table-scroll {
        flex: 1;
        overflow: auto;
      }
      .cfg-table {
        width: 100%;
        border-collapse: collapse;
      }
      .cfg-table th {
        text-align: left;
        padding: 6px var(--space-3);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .cfg-table td {
        padding: 6px var(--space-3);
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .cfg-table tbody tr:hover {
        background: var(--bg-secondary);
      }
      .cfg-table tbody tr:last-child td {
        border-bottom: none;
      }
      .row-dirty {
        background: rgba(255, 149, 0, 0.05) !important;
        box-shadow: inset 3px 0 0 0 #ff9500;
      }
      .col-key {
        min-width: 240px;
        max-width: 380px;
      }
      .col-value {
        min-width: 200px;
      }
      .col-reload {
        width: 80px;
      }
      .col-current {
        width: 140px;
      }
      .col-actions {
        width: 110px;
        text-align: right;
        white-space: nowrap;
      }
      .cfg-table .field-label {
        display: block;
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        line-height: 1.3;
      }
      .field-key {
        display: block;
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--text-tertiary);
        margin-top: 2px;
      }
      .cfg-table .current {
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--text-secondary);
        word-break: break-all;
      }
      .btn-row-save {
        height: 24px;
        padding: 0 10px;
        border: none;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: white;
        font-size: 11px;
        font-weight: var(--font-semibold);
        cursor: pointer;
        font-family: inherit;
        min-width: 52px;
      }
      .btn-row-save:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .btn-row-save:disabled {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        cursor: not-allowed;
      }
      .reset-btn {
        height: 24px;
        width: 24px;
        margin-right: 4px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 13px;
        cursor: pointer;
        vertical-align: middle;
      }
      .reset-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      .btn {
        padding: 8px 18px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        border: 1px solid transparent;
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .btn-secondary {
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
    `,
  ],
})
export class EAConfigPanelComponent {
  readonly instanceId = input.required<string>();
  readonly inputs = input<EAConfigInputs | null>(null);
  /**
   * True while the parent detail resource is still mid-flight on first
   * load.  Shimmers placeholder fields instead of the "no input envelope
   * yet" copy — that copy is reserved for the legitimate case of a pre-
   * 8.47.137 EA build that never publishes the inputs block.
   */
  readonly loading = input(false);
  @Output() readonly configPushed = new EventEmitter<void>();

  /** Six placeholder rows for the loading skeleton — enough to fill the panel. */
  protected readonly skeletonFields = computed(() => Array.from({ length: 6 }, (_, i) => i));

  private readonly admin = inject(EAAdminService);
  private readonly notify = inject(NotificationService);
  private readonly cdr = inject(ChangeDetectorRef);

  // Per-key edit values.  Number fields use strings to preserve
  // empty-vs-zero semantics (empty = keep current).  Bool fields use
  // true/false/undefined.  Enum fields use the option string or undefined.
  // String fields use the raw text (empty = keep current).
  protected edits: Partial<Record<HotReloadKey, string | number | boolean | null | undefined>> = {};
  protected readonly tab = signal<'editable' | 'readonly'>('editable');
  protected readonly submitting = signal(false);

  // ── Browse / search state ─────────────────────────────────────────
  protected readonly ALL_CATEGORY = '__all__';

  protected readonly searchTerm = signal<string>('');
  protected readonly badgeFilter = signal<'all' | 'live' | 'next-job' | 'restart'>('all');
  protected readonly dirtyOnly = signal<boolean>(false);
  /** Currently selected section in the sidebar; `__all__` means show everything. */
  protected readonly selectedCategory = signal<string>(this.ALL_CATEGORY);
  /** Small filter on the sidebar list itself — for finding a section fast. */
  protected readonly categoryFilter = signal<string>('');
  /**
   * Spike counter that ticks whenever an edit changes — used purely to
   * invalidate the dirty-derived computeds since `edits` is a plain
   * object (no Angular signal under it). Anything that reads dirty
   * state in a computed must read this via `dirtyRevision()` to opt
   * into recomputation.
   */
  private readonly dirtyRevision = signal(0);

  @ViewChild('searchInput') private searchInput?: ElementRef<HTMLInputElement>;

  protected readonly badgeFilterOptions: ReadonlyArray<{
    label: string;
    value: 'all' | 'live' | 'next-job' | 'restart';
  }> = [
    { label: 'All', value: 'all' },
    { label: 'Live', value: 'live' },
    { label: 'Next-job', value: 'next-job' },
    { label: 'Restart', value: 'restart' },
  ];

  // ── Field catalogues (driven from the engine DTO schema) ───────────────

  protected readonly HOT_RELOAD_GROUPS: readonly FieldGroup[] = [
    {
      title: 'Symbols',
      fields: [
        {
          key: 'symbols',
          label: 'Owned symbols (CSV)',
          kind: 'string',
          badge: 'live',
          takesEffect:
            'CInstanceManager.TryUpdateOwnedSymbols — diff against current set, ' +
            'release ownership of removed symbols + claim added ones via SymbolOwnership CAS. ' +
            'REFUSED when any removed symbol still has open positions — close them first. ' +
            'Empty / "CHART" / "ALL" rejected as init-only modes. ' +
            'Sibling instances on the same MT5 terminal can only own NON-overlapping sets.',
        },
      ],
    },
    {
      title: 'Timing',
      fields: [
        {
          key: 'tickThrottleMs',
          label: 'Tick throttle (ms)',
          kind: 'int',
          step: 10,
          badge: 'live',
          takesEffect: 'Next AutotuneThrottle cycle.',
        },
        {
          key: 'signalPollSec',
          label: 'Signal poll (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-6 cycle.',
        },
        {
          key: 'positionSyncSec',
          label: 'Position sync (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-7 cycle.',
        },
        {
          key: 'accountSyncSec',
          label: 'Account sync (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-7 cycle.',
        },
        {
          key: 'heartbeatSec',
          label: 'Heartbeat (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CHeartbeat.SetIntervalSec — next heartbeat cycle. Floored at 5s.',
        },
        {
          key: 'commandPollSec',
          label: 'Command poll (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next Phase-6 cycle.',
        },
      ],
    },
    {
      title: 'Entry tolerance',
      fields: [
        {
          key: 'entryToleranceBandPct',
          label: 'Tolerance band — legacy fraction of price (0 to use TP-frac only)',
          kind: 'double',
          step: 0.0001,
          badge: 'live',
          takesEffect:
            'Next signal ClassifyExecutionType. Used as fallback when entryToleranceTpFrac=0 or TP missing.',
        },
        {
          key: 'entryToleranceTpFrac',
          label: 'Tolerance band (fraction of |TP-entry|, 0 = use legacy band)',
          kind: 'double',
          step: 0.01,
          badge: 'live',
          takesEffect:
            'Next signal ClassifyExecutionType — dimensionally-correct fast-market-fill threshold.',
        },
        {
          key: 'entryToleranceMaxSignalAgeSec',
          label: 'Max signal age (s) — tolerance band gate',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next signal ClassifyExecutionType.',
        },
        {
          key: 'maxSignalAgeSec',
          label: 'Hard staleness gate (s, 0 = disabled)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'Next SignalProcessor::Poll cycle — older signals are skipped locally.',
        },
        {
          key: 'maxAdverseTpDriftPct',
          label: 'Max adverse drift (fraction of TP distance, 0 = disabled)',
          kind: 'double',
          step: 0.01,
          badge: 'live',
          takesEffect:
            'Next SignalProcessor::Poll cycle — signals whose market has overshot entry past this fraction of |TP-entry| are skipped locally.',
        },
      ],
    },
    {
      title: 'Execution',
      fields: [
        {
          key: 'maxSlippagePoints',
          label: 'Max slippage (points) — legacy fallback',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect:
            'COrderExecutor.SetMaxSlippagePoints — next OrderSend. Only used when maxSlippageSlFrac=0.',
        },
        {
          key: 'maxSlippageSlFrac',
          label: 'Max slippage (fraction of SL distance, 0 = use legacy points)',
          kind: 'double',
          step: 0.01,
          badge: 'live',
          takesEffect: 'Next OrderSend — request.deviation scales with the signal’s SL distance.',
        },
        {
          key: 'maxSpreadSlFrac',
          label: 'Max spread (fraction of SL distance, 0 = use legacy points)',
          kind: 'double',
          step: 0.01,
          badge: 'live',
          takesEffect: 'Next signal validation + execution-time spread re-check.',
        },
        {
          key: 'maxOrderRetries',
          label: 'Max order retries',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'COrderExecutor.SetMaxRetries — next retry loop.',
        },
        {
          key: 'httpTimeoutData',
          label: 'HTTP timeout: data (ms)',
          kind: 'int',
          step: 100,
          badge: 'live',
          takesEffect:
            'CHttpClient.SetDefaultDataTimeoutMs — next request without an explicit timeout.',
        },
        {
          key: 'httpTimeoutOrder',
          label: 'HTTP timeout: order (ms)',
          kind: 'int',
          step: 100,
          badge: 'live',
          takesEffect: 'Shadow available for code that opts in — wiring lands in Phase 4c.',
        },
      ],
    },
    {
      title: 'Runtime safety',
      fields: [
        {
          key: 'maxNotionalExposurePct',
          label: 'Max notional exposure %',
          kind: 'double',
          step: 1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.SetMaxNotionalExposurePct — next exposure check.',
        },
        {
          key: 'maxPeakDrawdownPct',
          label: 'Max peak drawdown %',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.SetMaxPeakDrawdownPct — next drawdown check.',
        },
        {
          key: 'flashCrashPct',
          label: 'Flash-crash threshold %',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect:
            'CGlobalCircuitBreaker.SetFlashCrashPct — rolling window resets on each update.',
        },
        {
          key: 'dailyProfitTargetAbs',
          label: 'Daily profit target ($)',
          kind: 'double',
          step: 0.01,
          badge: 'live',
          takesEffect:
            'Per-instance: when combined daily P&L (realized + floating) reaches this, the EA cancels pendings, flattens, and enters SAFETY_STOP until next trading day. 0 = disabled. If % is also set, % wins.',
        },
        {
          key: 'dailyProfitTargetPct',
          label: 'Daily profit target (% of start equity)',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect:
            'Per-instance: same as the $ target but expressed as % of start-of-day equity. 0 = disabled. Takes precedence over the $ target when both are set.',
        },
        {
          key: 'engineTimeoutSec',
          label: 'Engine timeout (s)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect:
            'CConnectionMonitor.SetEngineTimeoutSec + CGlobalCircuitBreaker.SetEngineTimeoutSec — next SAFE_MODE gate. Floored at 5s.',
        },
        {
          key: 'engineFailThreshold',
          label: 'Engine fail threshold',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CConnectionMonitor.SetEngineFailThreshold — next failure check.',
        },
        {
          key: 'unmatchedDealExpirySec',
          label: 'Unmatched deal expiry (s)',
          kind: 'int',
          step: 30,
          badge: 'restart',
          takesEffect: 'Cached on TradeTransactionHandler at OnInit.',
        },
        {
          key: 'safeModeTimeoutSec',
          label: 'SAFE_MODE → SAFETY_STOP escalation (s)',
          kind: 'int',
          step: 30,
          badge: 'live',
          takesEffect: 'Read every cycle in EAEngineHealthAndCoordinationPhases.',
        },
      ],
    },
    {
      title: 'Data + backfill',
      fields: [
        {
          key: 'backfillBars',
          label: 'Backfill bars / TF / symbol',
          kind: 'int',
          step: 100,
          badge: 'next-job',
          takesEffect: 'Read at backfill-job creation — new jobs use the new value.',
        },
        {
          key: 'backfillChunkSize',
          label: 'Backfill chunk size',
          kind: 'int',
          step: 100,
          badge: 'next-job',
          takesEffect: 'Read at backfill-chunk creation.',
        },
        {
          key: 'specRefreshHour',
          label: 'Daily spec-refresh hour',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'BackfillCursor reads shadow each scheduler check.',
        },
        {
          key: 'tickBufferMax',
          label: 'Max ticks to buffer',
          kind: 'int',
          step: 100,
          badge: 'restart',
          takesEffect: 'Cached on tick buffer at OnInit.',
        },
      ],
    },
    {
      title: 'Telemetry',
      fields: [
        {
          key: 'telemetryEndpoint',
          label: 'Telemetry push URL (blank = file-only)',
          kind: 'string',
          badge: 'restart',
          takesEffect: 'Cached on telemetry config at OnInit.',
        },
        {
          key: 'telemetryPushSec',
          label: 'Telemetry push interval (s)',
          kind: 'int',
          step: 1,
          badge: 'restart',
          takesEffect: 'Same cached path.',
        },
      ],
    },
    {
      title: 'News blackout',
      fields: [
        {
          key: 'enableNewsBlackout',
          label: 'Reject entries during scheduled news',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'Cached on news-blackout manager at OnInit.',
        },
        {
          key: 'newsBlackoutFilePath',
          label: 'Override schedule file path',
          kind: 'string',
          badge: 'restart',
          takesEffect: 'Same cached path.',
        },
      ],
    },
    {
      title: 'Logging + chart',
      fields: [
        {
          key: 'logLevel',
          label: 'Log verbosity',
          kind: 'enum',
          options: ['DEBUG', 'INFO', 'WARN', 'ERROR'],
          badge: 'live',
          takesEffect: 'CLogger.SetLevel — propagates to file sink.',
        },
        {
          key: 'enableFileLogging',
          label: 'Write logs to file',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'File logger init cached at OnInit.',
        },
        {
          key: 'logJsonFormat',
          label: 'JSON-per-line log format',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'File logger init cached at OnInit.',
        },
        {
          key: 'enableChartPanel',
          label: 'Show status panel on chart',
          kind: 'bool',
          badge: 'restart',
          takesEffect: 'Chart panel init cached at OnInit.',
        },
        {
          key: 'enableChartMarkers',
          label: 'Show trade markers on chart',
          kind: 'bool',
          badge: 'live',
          takesEffect: 'OperationalHelpers reads shadow before each marker.',
        },
      ],
    },
    {
      title: 'Safety — per-instance',
      fields: [
        {
          key: 'maxPosPerSymbol',
          label: 'Max positions per symbol',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next safety check.',
        },
        {
          key: 'maxLotPerOrder',
          label: 'Max lot per order',
          kind: 'double',
          step: 0.01,
          badge: 'live',
          takesEffect:
            'CCircuitBreaker.HotReload + COrderExecutor.SetMaxLotPerOrder — next OrderSend.',
        },
        {
          key: 'maxSpreadPoints',
          label: 'Max spread (points)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next pre-send check.',
        },
        {
          key: 'maxConsecLosses',
          label: 'Max consecutive losses',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next loss tally.',
        },
        {
          key: 'consecLossPauseMin',
          label: 'Consec-loss pause (min)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — applies when pause is next armed.',
        },
        {
          key: 'maxDailyLossPerSymbolPct',
          label: 'Max daily loss % / symbol',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CCircuitBreaker.HotReload — next daily-PnL check. 0 = disabled.',
        },
      ],
    },
    {
      title: 'Safety — fleet',
      fields: [
        {
          key: 'maxOpenPositions',
          label: 'Max total open positions (global)',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next position-count check.',
        },
        {
          key: 'maxDailyLossPct',
          label: 'Max daily loss % of equity',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next equity check.',
        },
        {
          key: 'maxOrdersPerMin',
          label: 'Max orders per minute',
          kind: 'int',
          step: 1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next rate-limit window.',
        },
        {
          key: 'maxTotalLots',
          label: 'Max total open lots',
          kind: 'double',
          step: 0.1,
          badge: 'live',
          takesEffect: 'CGlobalCircuitBreaker.HotReload — next position-open check.',
        },
      ],
    },
  ];

  protected readonly HOT_RELOAD_FIELDS = this.HOT_RELOAD_GROUPS.flatMap((g) => g.fields);

  protected readonly READ_ONLY_FIELDS: readonly ReadOnlyField[] = [
    // Truly load-bearing — changing mid-flight breaks identity, transport
    // re-bind, or concurrency invariants.  Surfaced here as inspection-only
    // so operators can see the current value without poking the EA host.
    { key: 'engineBaseUrl', label: 'Engine base URL' },
    // symbols was moved to the editable tab (Phase-13).  Kept commented
    // here so future maintainers can quickly trace the migration.
    // { key: 'symbols',                  label: 'Symbols (CSV)' },
    { key: 'symbolMapping', label: 'Broker→Engine symbol map' },
    { key: 'timeframes', label: 'Timeframes' },
    { key: 'instanceLabel', label: 'Instance label' },
    { key: 'magicNumber', label: 'Magic number' },
    { key: 'useAsyncOrders', label: 'Use async orders' },
    { key: 'useDllTransport', label: 'Use DLL transport' },
    { key: 'dllBridgeHost', label: 'DLL bridge host (override)' },
    { key: 'dllBridgePort', label: 'DLL bridge port (override)' },
    { key: 'dllBridgeUseTls', label: 'DLL bridge TLS' },
    { key: 'dllBridgeStrictTls', label: 'DLL bridge strict TLS' },
    { key: 'dllBridgeCertFingerprint', label: 'DLL bridge cert fingerprint (SHA-256)' },
    { key: 'coordinatorStaleSec', label: 'Coordinator stale (s)' },
    { key: 'casEscalateThreshold', label: 'CAS escalate threshold' },
  ];

  // ── Field helpers ──────────────────────────────────────────────────────

  protected formatCurrent(key: string): string {
    const inputs = this.inputs();
    if (!inputs) return '—';
    const v = inputs[key];
    if (v == null) return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    return String(v);
  }

  protected hasDirty(): boolean {
    return this.dirtyCount() > 0;
  }

  protected dirtyCount(): number {
    this.dirtyRevision(); // opt computeds into recomputation when edits change
    let n = 0;
    for (const f of this.HOT_RELOAD_FIELDS) {
      if (this.isDirty(f)) n++;
    }
    return n;
  }

  protected isDirty(field: FieldDef): boolean {
    const raw = this.edits[field.key];
    if (raw === undefined || raw === null || raw === '') return false;
    const current = this.inputs()?.[field.key];
    if (field.kind === 'bool') return typeof raw === 'boolean' && raw !== current;
    if (field.kind === 'enum' || field.kind === 'string')
      return String(raw) !== String(current ?? '');
    const num = Number(raw);
    if (!Number.isFinite(num)) return false;
    return current !== num;
  }

  /**
   * Bump after any field edit so dirty-derived computeds invalidate.
   * Called inline from the template via (ngModelChange) on every input.
   */
  protected markEdited(): void {
    this.dirtyRevision.update((n) => n + 1);
  }

  protected revertField(field: FieldDef): void {
    delete this.edits[field.key];
    this.markEdited();
    this.cdr.markForCheck();
  }

  // ── Search / filter helpers ──────────────────────────────────────

  protected fieldMatchesGlobalFilters(field: FieldDef): boolean {
    const q = this.searchTerm().trim().toLowerCase();
    if (q) {
      const hay = (field.label + ' ' + field.key).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const bf = this.badgeFilter();
    if (bf !== 'all' && field.badge !== bf) return false;
    if (this.dirtyOnly() && !this.isDirty(field)) return false;
    return true;
  }

  /**
   * Group buckets used by the sidebar — derived from the global filter
   * set (search / badge / dirty-only) so sidebar counts react live, but
   * NOT scoped to the currently-selected category (that scoping happens
   * on the right pane only).
   */
  protected readonly filteredGroups = computed<FieldGroup[]>(() => {
    this.dirtyRevision();
    this.searchTerm();
    this.badgeFilter();
    this.dirtyOnly();
    const out: FieldGroup[] = [];
    for (const g of this.HOT_RELOAD_GROUPS) {
      const fields = g.fields.filter((f) => this.fieldMatchesGlobalFilters(f));
      if (fields.length > 0) out.push({ title: g.title, fields });
    }
    return out;
  });

  /**
   * Sidebar list: filteredGroups passed through the sidebar's own
   * filter input and sorted alphabetically (stable order is important
   * for a nav surface — dirty-first sorting would make sections jump
   * around as the operator edits, which is disorienting).
   */
  protected readonly sidebarGroups = computed<FieldGroup[]>(() => {
    const filter = this.categoryFilter().toLowerCase().trim();
    return this.filteredGroups()
      .filter((g) => !filter || g.title.toLowerCase().includes(filter))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title));
  });

  /**
   * The fields actually rendered in the editor — flat list scoped to
   * the selected category. `__all__` flattens every visible field
   * across every group.
   */
  protected readonly visibleFields = computed<FieldDef[]>(() => {
    const cat = this.selectedCategory();
    const groups = this.filteredGroups();
    if (cat === this.ALL_CATEGORY) return groups.flatMap((g) => g.fields);
    const match = groups.find((g) => g.title === cat);
    return match ? match.fields.slice() : [];
  });

  protected readonly visibleCount = computed(() => this.visibleFields().length);

  protected groupDirtyCount(group: FieldGroup): number {
    this.dirtyRevision();
    let n = 0;
    for (const f of group.fields) if (this.isDirty(f)) n++;
    return n;
  }

  protected selectedCategoryTitle(): string {
    const cat = this.selectedCategory();
    return cat === this.ALL_CATEGORY ? 'All sections' : cat;
  }

  protected selectCategory(title: string): void {
    this.selectedCategory.set(title);
  }

  protected clearSearch(): void {
    this.searchTerm.set('');
    this.badgeFilter.set('all');
    this.dirtyOnly.set(false);
    this.categoryFilter.set('');
  }

  protected clearEdits(): void {
    this.edits = {};
    this.markEdited();
    this.cdr.markForCheck();
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────
  /**
   * `/` focuses the field search; `⌘S` / `Ctrl+S` pushes pending
   * changes. Both are scoped to the document so the operator can hit
   * them from anywhere on the EA detail page while this panel has
   * unsaved state.
   */
  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
      // Only intercept when this panel is the one holding dirty state — avoids
      // hijacking ⌘S on pages that don't have a config form active.
      if (this.tab() === 'editable' && this.hasDirty() && !this.submitting()) {
        ev.preventDefault();
        this.submit();
      }
      return;
    }
    const target = ev.target as HTMLElement | null;
    const inEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target?.isContentEditable ?? false);
    if (ev.key === '/' && !inEditable && this.tab() === 'editable') {
      ev.preventDefault();
      this.searchInput?.nativeElement.focus();
      this.searchInput?.nativeElement.select();
    }
  }

  /**
   * Pack one dirty field into the bulk-push body shape. The API only
   * ships an `UpdateInstanceConfigRequest` endpoint (no per-key route),
   * so per-row saves are a one-field bulk push.
   */
  private packField(body: UpdateInstanceConfigRequest, f: FieldDef): void {
    const raw = this.edits[f.key];
    let value: number | string | boolean;
    if (f.kind === 'bool') value = raw as boolean;
    else if (f.kind === 'enum' || f.kind === 'string') value = String(raw);
    else value = Number(raw);
    (body as Record<string, number | string | boolean>)[f.key] = value;
  }

  protected submit(): void {
    if (!this.hasDirty()) return;
    // Echo `instanceId` in the body even though the API takes it from the
    // route — the server-side DTO marks it `required` and System.Text.Json
    // rejects the request body otherwise (the controller's route-binding
    // assignment runs *after* JSON deserialisation).
    const body: UpdateInstanceConfigRequest = { instanceId: this.instanceId() };
    const fields: FieldDef[] = [];
    for (const f of this.HOT_RELOAD_FIELDS) {
      if (!this.isDirty(f)) continue;
      this.packField(body, f);
      fields.push(f);
    }
    this.pushBody(body, fields);
  }

  /**
   * Push a single field via the bulk endpoint. Mirrors the
   * engine-config page's per-row Save UX so the operator can commit
   * one knob without disturbing other in-flight edits.
   */
  protected saveField(field: FieldDef): void {
    if (!this.isDirty(field) || this.submitting()) return;
    const body: UpdateInstanceConfigRequest = { instanceId: this.instanceId() };
    this.packField(body, field);
    this.pushBody(body, [field]);
  }

  private pushBody(body: UpdateInstanceConfigRequest, fields: FieldDef[]): void {
    this.submitting.set(true);
    this.admin
      .updateInstanceConfig(this.instanceId(), body)
      .pipe(
        finalize(() => {
          this.submitting.set(false);
          this.cdr.markForCheck();
        }),
      )
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(
              `Config push queued (${fields.length} field${fields.length === 1 ? '' : 's'}).`,
            );
            for (const f of fields) delete this.edits[f.key];
            this.markEdited();
            this.configPushed.emit();
          } else {
            this.notify.error(res.message ?? 'Config push failed.');
          }
        },
        error: () => this.notify.error('Config push failed.'),
      });
  }

  /**
   * Per-row keyboard: Enter on a field input saves that field, Esc
   * reverts it. Shift+Enter passes through in textareas (none in this
   * panel today but kept as a safety net for future Json fields).
   */
  protected onFieldKey(ev: KeyboardEvent, field: FieldDef): void {
    if (ev.key === 'Enter' && !ev.shiftKey && !(ev.target instanceof HTMLTextAreaElement)) {
      ev.preventDefault();
      if (this.isDirty(field)) this.saveField(field);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.revertField(field);
      (ev.target as HTMLElement).blur();
    }
  }
}

type HotReloadKey =
  | 'tickThrottleMs'
  | 'signalPollSec'
  | 'positionSyncSec'
  | 'accountSyncSec'
  | 'heartbeatSec'
  | 'commandPollSec'
  | 'entryToleranceBandPct'
  | 'entryToleranceTpFrac'
  | 'entryToleranceMaxSignalAgeSec'
  | 'maxSignalAgeSec'
  | 'maxAdverseTpDriftPct'
  | 'maxSlippageSlFrac'
  | 'maxSpreadSlFrac'
  | 'maxSlippagePoints'
  | 'maxOrderRetries'
  | 'httpTimeoutData'
  | 'httpTimeoutOrder'
  | 'maxNotionalExposurePct'
  | 'maxPeakDrawdownPct'
  | 'flashCrashPct'
  | 'engineTimeoutSec'
  | 'dailyProfitTargetAbs'
  | 'dailyProfitTargetPct'
  // Phase-4c
  | 'engineFailThreshold'
  | 'unmatchedDealExpirySec'
  | 'safeModeTimeoutSec'
  | 'backfillBars'
  | 'backfillChunkSize'
  | 'specRefreshHour'
  | 'tickBufferMax'
  | 'telemetryEndpoint'
  | 'telemetryPushSec'
  | 'enableNewsBlackout'
  | 'newsBlackoutFilePath'
  | 'logLevel'
  | 'enableFileLogging'
  | 'logJsonFormat'
  | 'enableChartPanel'
  | 'enableChartMarkers'
  // Phase-13: owned-symbol CSV (string)
  | 'symbols'
  // Phase-4d: legacy safety knobs (already hot-reloadable via CB.HotReload)
  | 'maxPosPerSymbol'
  | 'maxLotPerOrder'
  | 'maxSpreadPoints'
  | 'maxConsecLosses'
  | 'consecLossPauseMin'
  | 'maxDailyLossPerSymbolPct'
  | 'maxOpenPositions'
  | 'maxDailyLossPct'
  | 'maxOrdersPerMin'
  | 'maxTotalLots';

interface FieldDef {
  key: HotReloadKey;
  label: string;
  kind: 'int' | 'double' | 'string' | 'bool' | 'enum';
  step?: number;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** UI hint: `live` = next read-cycle; `next-job` = applies to subsequent jobs; `restart` = re-attach to take effect. */
  badge: 'live' | 'next-job' | 'restart';
  takesEffect: string;
}

interface FieldGroup {
  title: string;
  fields: readonly FieldDef[];
}

interface ReadOnlyField {
  key: string;
  label: string;
}
