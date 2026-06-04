import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { EChartsOption } from 'echarts';

import { ConfigService } from '@core/services/config.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ConfigDataType, EngineConfigDto, UpsertConfigRequest } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

interface ConfigEntry extends EngineConfigDto {
  editValue: string;
  saving: boolean;
  dirty: boolean;
  /** First segment up to the first `:` or `.` — e.g. `EA`, `Drawdown`, `General`. */
  prefix: string;
}

interface ConfigGroup {
  prefix: string;
  configs: ConfigEntry[];
  hotReloadCount: number;
  recent24hCount: number;
  dirtyCount: number;
  dataTypes: Record<ConfigDataType, number>;
}

type DataTypeFilter = 'all' | ConfigDataType;
type SortMode = 'key' | 'updated-desc' | 'updated-asc';

const ALL_CATEGORY = '__all__';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Soft render cap for the "All" view when no search query narrows it.
 *  77 categories × dozens-to-thousands of keys would otherwise materialise
 *  ~5,700 input fields into the DOM on first paint. */
const ALL_RENDER_CAP = 250;

@Component({
  selector: 'app-config-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    PresenceBadgeComponent,
    ChartCardComponent,
    FormsModule,
    DatePipe,
    DecimalPipe,
    RelativeTimePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Engine Configuration"
        subtitle="View and edit engine configuration parameters."
      >
        <app-presence-badge routeKey="engine-config" />
      </app-page-header>

      @if (loading()) {
        <div class="loading-state">
          <div class="skeleton-block"></div>
          <div class="skeleton-block"></div>
          <div class="skeleton-block"></div>
        </div>
      } @else if (entries().length === 0) {
        <div class="empty-row">No engine configuration entries returned.</div>
      } @else {
        <!-- ── Compact stats strip ─────────────────────────────────── -->
        <div class="stats-strip">
          <span class="stat"
            ><strong>{{ entries().length | number }}</strong> keys</span
          >
          <span class="stat"
            ><strong>{{ totalGroupCount() }}</strong> categories</span
          >
          <span class="stat ok"
            ><strong>{{ hotReloadCount() | number }}</strong> hot-reload</span
          >
          <span class="stat warn"
            ><strong>{{ entries().length - hotReloadCount() | number }}</strong>
            restart-required</span
          >
          <span class="stat"
            ><strong>{{ recent24hCount() | number }}</strong> updated 24h</span
          >
          @if (dirtyCount() > 0) {
            <span class="stat bad"
              ><strong>{{ dirtyCount() }}</strong> unsaved</span
            >
          }
          <button class="overview-toggle" (click)="showOverview.set(!showOverview())">
            {{ showOverview() ? 'Hide' : 'Show' }} overview
            <span class="chevron" [class.open]="showOverview()">▾</span>
          </button>
        </div>

        @if (showOverview()) {
          <div class="chart-row">
            <app-chart-card
              title="Data type distribution"
              subtitle="String · Int · Decimal · Bool · Json"
              [options]="dataTypeDonutOptions()"
              height="200px"
            />
            <app-chart-card
              title="Top categories by config count"
              subtitle="Largest groups in the configuration surface"
              [options]="topCategoriesOptions()"
              height="200px"
            />
          </div>
        }

        <!-- ── Sticky toolbar ──────────────────────────────────────── -->
        <div class="toolbar">
          <div class="search-wrap">
            <span class="search-icon" aria-hidden="true">⌕</span>
            <input
              #searchInput
              type="text"
              class="search"
              [placeholder]="searchPlaceholder()"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
              aria-label="Search keys or descriptions"
            />
            @if (search()) {
              <button
                type="button"
                class="search-clear"
                (click)="search.set('')"
                aria-label="Clear"
              >
                ✕
              </button>
            }
            <kbd class="search-shortcut">/</kbd>
          </div>
          <select
            class="input"
            [ngModel]="dataTypeFilter()"
            (ngModelChange)="dataTypeFilter.set($event)"
            aria-label="Filter by data type"
          >
            <option value="all">All types</option>
            <option value="String">String ({{ dataTypeCounts().String }})</option>
            <option value="Int">Int ({{ dataTypeCounts().Int }})</option>
            <option value="Decimal">Decimal ({{ dataTypeCounts().Decimal }})</option>
            <option value="Bool">Bool ({{ dataTypeCounts().Bool }})</option>
            <option value="Json">Json ({{ dataTypeCounts().Json }})</option>
          </select>
          <select
            class="input"
            [ngModel]="hotReloadFilter()"
            (ngModelChange)="hotReloadFilter.set($event)"
            aria-label="Filter by reload behaviour"
          >
            <option value="all">All keys</option>
            <option value="hot">Hot-reloadable only</option>
            <option value="cold">Restart-required only</option>
          </select>
          <select
            class="input"
            [ngModel]="sortMode()"
            (ngModelChange)="sortMode.set($event)"
            aria-label="Sort order"
          >
            <option value="key">Sort: key A→Z</option>
            <option value="updated-desc">Sort: recently updated</option>
            <option value="updated-asc">Sort: oldest updated</option>
          </select>
          <div class="toolbar-spacer"></div>
          <button
            type="button"
            class="save-btn primary"
            [disabled]="dirtyCount() === 0 || bulkSaving()"
            (click)="saveAllDirty()"
            [title]="dirtyCount() > 0 ? 'Save all unsaved (⌘S)' : 'No unsaved changes'"
          >
            @if (bulkSaving()) {
              <span class="spinner"></span> Saving…
            } @else {
              Save {{ dirtyCount() }} unsaved
            }
          </button>
        </div>

        <!-- ── Master-detail body ─────────────────────────────────── -->
        <div class="body">
          <aside class="sidebar" aria-label="Categories">
            <div class="sb-head">
              <span>Categories</span>
              <span class="muted">{{ sidebarGroups().length }}</span>
            </div>
            <input
              type="search"
              class="sb-filter"
              placeholder="Filter categories…"
              [ngModel]="categoryFilter()"
              (ngModelChange)="categoryFilter.set($event)"
              aria-label="Filter categories"
            />
            <nav class="sb-list">
              <button
                type="button"
                class="cat"
                [class.active]="selectedCategory() === allCategory"
                (click)="selectCategory(allCategory)"
              >
                <span class="cat-name">All keys</span>
                <span class="cat-count">{{ filteredEntries().length | number }}</span>
              </button>
              @for (g of sidebarGroups(); track g.prefix) {
                <button
                  type="button"
                  class="cat"
                  [class.active]="selectedCategory() === g.prefix"
                  (click)="selectCategory(g.prefix)"
                >
                  <span class="cat-name">{{ g.prefix }}</span>
                  <span class="cat-badges">
                    @if (g.dirtyCount > 0) {
                      <span class="dot bad" [attr.title]="g.dirtyCount + ' unsaved'"></span>
                    }
                    @if (g.recent24hCount > 0) {
                      <span
                        class="dot warn"
                        [attr.title]="g.recent24hCount + ' updated 24h'"
                      ></span>
                    }
                    <span class="cat-count">{{ g.configs.length | number }}</span>
                  </span>
                </button>
              }
              @if (sidebarGroups().length === 0) {
                <div class="empty-cat">No categories match.</div>
              }
            </nav>
          </aside>

          <main class="editor">
            <header class="editor-head">
              <div class="editor-title">
                <h3>{{ selectedCategoryTitle() }}</h3>
                <span class="muted">{{ selectedCategorySubtitle() }}</span>
              </div>
              @if (visibleEntries().length > 0 && !categoryDirtyAllSaved()) {
                <div class="editor-actions">
                  <span class="muted small">
                    {{ visibleEntries().length | number }}
                    {{ visibleEntries().length === 1 ? 'key' : 'keys' }}
                  </span>
                </div>
              }
            </header>

            @if (filteredEntries().length === 0) {
              <div class="empty-row">No keys match the current filters.</div>
            } @else if (visibleEntries().length === 0) {
              <div class="empty-row">This category has no matching keys. Try clearing filters.</div>
            } @else {
              <div class="table-scroll">
                <table class="config-table">
                  <thead>
                    <tr>
                      <th class="col-key">Key</th>
                      <th class="col-value">Value</th>
                      <th class="col-type">Type</th>
                      <th class="col-reload">Reload</th>
                      <th class="col-updated">Updated</th>
                      <th class="col-actions"></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (config of visibleEntries(); track config.id) {
                      <tr [class.row-dirty]="config.dirty">
                        <td class="col-key">
                          <code class="config-key" [title]="config.key ?? ''">{{
                            config.key
                          }}</code>
                          @if (config.description) {
                            <span class="config-desc">{{ config.description }}</span>
                          }
                        </td>
                        <td class="col-value">
                          @if (config.dataType === 'Json') {
                            <textarea
                              class="config-input config-textarea"
                              rows="1"
                              [(ngModel)]="config.editValue"
                              (ngModelChange)="markDirty(config)"
                              (keydown)="onValueKey($event, config)"
                              [title]="config.editValue"
                            ></textarea>
                          } @else if (config.dataType === 'Bool') {
                            <select
                              class="config-input"
                              [(ngModel)]="config.editValue"
                              (ngModelChange)="markDirty(config)"
                              (keydown)="onValueKey($event, config)"
                            >
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </select>
                          } @else {
                            <input
                              type="text"
                              class="config-input"
                              [(ngModel)]="config.editValue"
                              (ngModelChange)="markDirty(config)"
                              (keydown)="onValueKey($event, config)"
                            />
                          }
                        </td>
                        <td class="col-type">
                          <span class="type-badge" [attr.data-type]="config.dataType">{{
                            config.dataType
                          }}</span>
                        </td>
                        <td class="col-reload">
                          @if (config.isHotReloadable) {
                            <span class="badge badge--success" title="Hot-reloadable">Hot</span>
                          } @else {
                            <span class="badge badge--neutral" title="Restart required">Cold</span>
                          }
                        </td>
                        <td class="col-updated">
                          <span
                            class="updated-text"
                            [title]="
                              config.lastUpdatedAt
                                ? (config.lastUpdatedAt | date: 'yyyy-MM-dd HH:mm:ss UTC')
                                : ''
                            "
                            >{{ config.lastUpdatedAt | relativeTime }}</span
                          >
                        </td>
                        <td class="col-actions">
                          @if (config.dirty) {
                            <button
                              type="button"
                              class="reset-btn"
                              (click)="resetConfig(config)"
                              title="Discard (Esc)"
                            >
                              ↺
                            </button>
                          }
                          <button
                            type="button"
                            class="save-btn small"
                            [disabled]="!config.dirty || config.saving"
                            (click)="saveConfig(config)"
                            [title]="config.dirty ? 'Save (Enter)' : 'No changes'"
                          >
                            @if (config.saving) {
                              <span class="spinner"></span>
                            } @else {
                              Save
                            }
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
                @if (renderCapped()) {
                  <div class="capped-footer">
                    Showing first {{ ALL_RENDER_CAP }} of
                    {{ filteredEntries().length | number }} keys. Refine the search or pick a
                    category to see more.
                  </div>
                }
              </div>
            }
          </main>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-height: 0;
      }

      /* ── Loading / empty states ──────────────────────────────── */
      .loading-state {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .skeleton-block {
        height: 60px;
        background: var(--bg-tertiary);
        border-radius: var(--radius-md);
        animation: pulse 1.5s ease infinite;
      }
      @keyframes pulse {
        0%,
        100% {
          opacity: 0.6;
        }
        50% {
          opacity: 1;
        }
      }
      .empty-row {
        background: var(--bg-secondary);
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-5);
        text-align: center;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }

      /* ── Stats strip (replaces 8-card KPI grid) ──────────────── */
      .stats-strip {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
        padding: 6px var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .stat {
        display: inline-flex;
        align-items: baseline;
        gap: 5px;
      }
      .stat strong {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        font-size: 13px;
      }
      .stat.ok strong {
        color: #1d8a3e;
      }
      .stat.warn strong {
        color: #cb8a17;
      }
      .stat.bad strong {
        color: #c93631;
      }
      .stat + .stat::before {
        content: '·';
        margin-right: var(--space-3);
        color: var(--text-tertiary);
      }
      .overview-toggle {
        margin-left: auto;
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text-secondary);
        padding: 3px 10px;
        font-size: 11px;
        border-radius: var(--radius-full);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .overview-toggle:hover {
        color: var(--text-primary);
        background: var(--bg-elevated);
      }
      .chevron {
        font-size: 9px;
        transition: transform 0.15s ease;
      }
      .chevron.open {
        transform: rotate(180deg);
      }

      /* ── Optional overview row (hidden by default) ───────────── */
      .chart-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .chart-row {
          grid-template-columns: 1fr;
        }
      }

      /* ── Toolbar ────────────────────────────────────────────── */
      .toolbar {
        display: flex;
        gap: var(--space-2);
        align-items: center;
        flex-wrap: wrap;
        padding: var(--space-2) var(--space-3);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .search-wrap {
        position: relative;
        flex: 1 1 320px;
        min-width: 260px;
        display: inline-flex;
        align-items: center;
      }
      .search-icon {
        position: absolute;
        left: 10px;
        color: var(--text-tertiary);
        font-size: 14px;
        pointer-events: none;
      }
      .search {
        width: 100%;
        height: 32px;
        padding: 0 56px 0 30px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
        transition: border-color 0.15s ease;
      }
      .search:focus {
        border-color: var(--accent);
      }
      .search-clear {
        position: absolute;
        right: 36px;
        background: transparent;
        border: none;
        color: var(--text-tertiary);
        cursor: pointer;
        font-size: 11px;
        padding: 3px 5px;
      }
      .search-clear:hover {
        color: var(--text-primary);
      }
      .search-shortcut {
        position: absolute;
        right: 8px;
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 10px;
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        padding: 1px 5px;
        border-radius: var(--radius-sm);
      }
      .input {
        height: 32px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-xs);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .toolbar-spacer {
        flex: 1;
      }
      .save-btn.primary {
        height: 32px;
        padding: 0 var(--space-3);
        background: var(--accent);
        color: white;
        border: none;
        border-radius: var(--radius-sm);
        font-weight: var(--font-semibold);
        font-size: var(--text-xs);
        cursor: pointer;
      }
      .save-btn.primary:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .save-btn.primary:disabled {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        cursor: not-allowed;
      }

      /* ── Master-detail body ─────────────────────────────────── */
      .body {
        display: grid;
        grid-template-columns: 260px 1fr;
        gap: var(--space-3);
        height: min(74vh, 760px);
        min-height: 480px;
      }
      @media (max-width: 900px) {
        .body {
          grid-template-columns: 1fr;
          height: auto;
        }
      }

      /* ── Sidebar ─────────────────────────────────────────────── */
      .sidebar {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .sb-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        padding: 8px var(--space-3);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        border-bottom: 1px solid var(--border);
      }
      .sb-head .muted {
        font-size: 10px;
        color: var(--text-tertiary);
      }
      .sb-filter {
        appearance: none;
        margin: 8px var(--space-2);
        height: 28px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        outline: none;
      }
      .sb-filter:focus {
        border-color: var(--accent);
      }
      .sb-list {
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
        font-size: var(--text-xs);
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
      .cat-badges {
        display: inline-flex;
        align-items: center;
        gap: 4px;
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
      .dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .dot.bad {
        background: #c93631;
      }
      .dot.warn {
        background: #cb8a17;
      }
      .empty-cat {
        padding: 12px;
        text-align: center;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }

      /* ── Editor (right pane) ─────────────────────────────────── */
      .editor {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .editor-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .editor-title h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .editor-title .muted {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-left: 8px;
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-tertiary);
      }

      /* ── Config table ────────────────────────────────────────── */
      .table-scroll {
        flex: 1;
        overflow: auto;
        position: relative;
      }
      .config-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .config-table th {
        text-align: left;
        padding: 6px var(--space-3);
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
        font-size: 10.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .config-table td {
        padding: 6px var(--space-3);
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .config-table tbody tr:hover {
        background: var(--bg-primary);
      }
      .config-table tbody tr:last-child td {
        border-bottom: none;
      }
      .row-dirty {
        background: rgba(0, 113, 227, 0.05) !important;
        box-shadow: inset 3px 0 0 0 var(--accent, #0071e3);
      }

      .col-key {
        min-width: 240px;
        max-width: 380px;
      }
      .col-value {
        min-width: 220px;
      }
      .col-type {
        width: 80px;
      }
      .col-reload {
        width: 70px;
      }
      .col-updated {
        width: 120px;
      }
      .col-actions {
        width: 110px;
        text-align: right;
        white-space: nowrap;
      }

      .config-key {
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 12px;
        color: var(--text-primary);
        display: block;
        word-break: break-all;
      }
      .config-desc {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        display: block;
        margin-top: 2px;
      }
      .config-input {
        width: 100%;
        height: 28px;
        padding: 0 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 12px;
        outline: none;
        transition: border-color 0.15s ease;
      }
      .config-input:focus {
        border-color: var(--accent);
        background: var(--bg-elevated);
      }
      .config-textarea {
        height: 28px;
        resize: vertical;
        padding: 5px 8px;
        white-space: nowrap;
        overflow: hidden;
        font-size: 11px;
      }
      .config-textarea:focus {
        height: 120px;
        white-space: pre;
        overflow: auto;
      }
      .type-badge {
        display: inline-flex;
        padding: 1px 7px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .type-badge[data-type='String'] {
        background: rgba(0, 113, 227, 0.12);
        color: #0058b8;
      }
      .type-badge[data-type='Int'] {
        background: rgba(90, 200, 250, 0.18);
        color: #006fa3;
      }
      .type-badge[data-type='Decimal'] {
        background: rgba(52, 199, 89, 0.14);
        color: #1d8a3e;
      }
      .type-badge[data-type='Bool'] {
        background: rgba(255, 149, 0, 0.16);
        color: #b86200;
      }
      .type-badge[data-type='Json'] {
        background: rgba(175, 82, 222, 0.15);
        color: #7a3aa8;
      }
      .badge {
        display: inline-flex;
        padding: 1px 7px;
        border-radius: var(--radius-full);
        font-size: 10.5px;
        font-weight: var(--font-semibold);
      }
      .badge--success {
        background: rgba(52, 199, 89, 0.14);
        color: #1d8a3e;
      }
      .badge--neutral {
        background: rgba(142, 142, 147, 0.12);
        color: var(--text-secondary);
      }
      .updated-text {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        font-variant-numeric: tabular-nums;
      }
      .save-btn.small {
        height: 24px;
        padding: 0 10px;
        border: none;
        border-radius: var(--radius-sm);
        background: var(--accent);
        color: white;
        font-size: 11px;
        font-weight: var(--font-semibold);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-width: 52px;
      }
      .save-btn.small:hover:not(:disabled) {
        filter: brightness(1.05);
      }
      .save-btn.small:disabled {
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
      }
      .reset-btn:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .spinner {
        width: 11px;
        height: 11px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .capped-footer {
        position: sticky;
        bottom: 0;
        padding: 8px var(--space-4);
        background: var(--bg-tertiary);
        border-top: 1px solid var(--border);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        text-align: center;
      }
    `,
  ],
})
export class ConfigPageComponent implements OnInit {
  private readonly configService = inject(ConfigService);
  private readonly notifications = inject(NotificationService);

  protected readonly allCategory = ALL_CATEGORY;
  protected readonly ALL_RENDER_CAP = ALL_RENDER_CAP;

  readonly loading = signal(true);
  readonly entries = signal<ConfigEntry[]>([]);

  readonly search = signal('');
  readonly dataTypeFilter = signal<DataTypeFilter>('all');
  readonly hotReloadFilter = signal<'all' | 'hot' | 'cold'>('all');
  readonly sortMode = signal<SortMode>('key');
  readonly bulkSaving = signal(false);

  // Master-detail state ──────────────────────────────────────────────
  readonly selectedCategory = signal<string>(ALL_CATEGORY);
  readonly categoryFilter = signal('');
  readonly showOverview = signal(false);

  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  ngOnInit(): void {
    this.loadConfigs();
  }

  loadConfigs(): void {
    this.loading.set(true);
    this.configService.getAll().subscribe({
      next: (res) => {
        if (res.data) {
          const entries: ConfigEntry[] = res.data.map((c) => ({
            ...c,
            editValue: c.value ?? '',
            saving: false,
            dirty: false,
            // Engine keys are colon-delimited (`Drawdown:LastRecoveryMode`,
            // `EA:HeartbeatTimeoutSeconds`); the previous dot-based split sent
            // every entry into a single 'General' bucket of ~2300 rows.
            prefix: this.derivePrefix(c.key),
          }));
          this.entries.set(entries);
        }
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.notifications.error('Failed to load configuration');
      },
    });
  }

  private derivePrefix(key: string | null): string {
    if (!key) return 'General';
    const i = key.search(/[:.]/);
    return i > 0 ? key.substring(0, i) : 'General';
  }

  // ── Aggregate KPIs ─────────────────────────────────────────────
  readonly hotReloadCount = computed(() => this.entries().filter((e) => e.isHotReloadable).length);

  readonly recent24hCount = computed(() => {
    const cutoff = Date.now() - DAY_MS;
    return this.entries().filter(
      (e) => e.lastUpdatedAt && new Date(e.lastUpdatedAt).getTime() > cutoff,
    ).length;
  });

  readonly dirtyCount = computed(() => this.entries().filter((e) => e.dirty).length);

  readonly dataTypeCounts = computed<Record<ConfigDataType, number>>(() => {
    const counts: Record<ConfigDataType, number> = {
      String: 0,
      Int: 0,
      Decimal: 0,
      Bool: 0,
      Json: 0,
    };
    for (const e of this.entries()) {
      counts[e.dataType] = (counts[e.dataType] ?? 0) + 1;
    }
    return counts;
  });

  readonly totalGroupCount = computed(() => {
    const set = new Set<string>();
    for (const e of this.entries()) set.add(e.prefix);
    return set.size;
  });

  // ── Filtering ──────────────────────────────────────────────────
  readonly filteredEntries = computed(() => {
    const q = this.search().toLowerCase().trim();
    const dt = this.dataTypeFilter();
    const hr = this.hotReloadFilter();
    return this.entries().filter((e) => {
      if (dt !== 'all' && e.dataType !== dt) return false;
      if (hr === 'hot' && !e.isHotReloadable) return false;
      if (hr === 'cold' && e.isHotReloadable) return false;
      if (!q) return true;
      const k = (e.key ?? '').toLowerCase();
      const d = (e.description ?? '').toLowerCase();
      return k.includes(q) || d.includes(q);
    });
  });

  /**
   * Category groups, derived from the global filter set so the sidebar
   * counts react to the active type / hot-reload filters. Sorted with
   * the operator's attention in mind: anything dirty floats up, then
   * recently-changed categories, then alphabetical.
   */
  readonly filteredGroups = computed<ConfigGroup[]>(() => {
    const sort = this.sortMode();
    const sortFn = (a: ConfigEntry, b: ConfigEntry): number => {
      switch (sort) {
        case 'updated-desc':
          return (
            new Date(b.lastUpdatedAt ?? 0).getTime() - new Date(a.lastUpdatedAt ?? 0).getTime()
          );
        case 'updated-asc':
          return (
            new Date(a.lastUpdatedAt ?? 0).getTime() - new Date(b.lastUpdatedAt ?? 0).getTime()
          );
        case 'key':
        default:
          return (a.key ?? '').localeCompare(b.key ?? '');
      }
    };

    const buckets = new Map<string, ConfigEntry[]>();
    for (const e of this.filteredEntries()) {
      const list = buckets.get(e.prefix) ?? [];
      list.push(e);
      buckets.set(e.prefix, list);
    }

    const cutoff24h = Date.now() - DAY_MS;
    return Array.from(buckets.entries()).map(([prefix, configs]) => {
      const sorted = [...configs].sort(sortFn);
      const dataTypes: Record<ConfigDataType, number> = {
        String: 0,
        Int: 0,
        Decimal: 0,
        Bool: 0,
        Json: 0,
      };
      let hotReloadCount = 0;
      let recent24hCount = 0;
      let dirtyCount = 0;
      for (const c of configs) {
        dataTypes[c.dataType]++;
        if (c.isHotReloadable) hotReloadCount++;
        if (c.lastUpdatedAt && new Date(c.lastUpdatedAt).getTime() > cutoff24h) recent24hCount++;
        if (c.dirty) dirtyCount++;
      }
      return {
        prefix,
        configs: sorted,
        hotReloadCount,
        recent24hCount,
        dirtyCount,
        dataTypes,
      };
    });
  });

  /**
   * Sidebar listing: filteredGroups sorted alphabetically (dirty-first
   * sorting would make categories jump around as the user edits, which
   * is disorienting in a navigation surface). The dirty marker is shown
   * as a coloured dot on the row instead.
   */
  readonly sidebarGroups = computed<ConfigGroup[]>(() => {
    const filter = this.categoryFilter().toLowerCase().trim();
    return this.filteredGroups()
      .filter((g) => !filter || g.prefix.toLowerCase().includes(filter))
      .sort((a, b) => a.prefix.localeCompare(b.prefix));
  });

  /**
   * Entries shown in the right-hand editor. When "All" is selected, we
   * cap the render at ALL_RENDER_CAP so the page doesn't materialise
   * thousands of <input> fields on first paint — the footer prompts the
   * user to refine or pick a category.
   */
  readonly visibleEntries = computed<ConfigEntry[]>(() => {
    const cat = this.selectedCategory();
    const allFiltered = this.filteredEntries();
    const sort = this.sortMode();
    const sortFn = (a: ConfigEntry, b: ConfigEntry): number => {
      switch (sort) {
        case 'updated-desc':
          return (
            new Date(b.lastUpdatedAt ?? 0).getTime() - new Date(a.lastUpdatedAt ?? 0).getTime()
          );
        case 'updated-asc':
          return (
            new Date(a.lastUpdatedAt ?? 0).getTime() - new Date(b.lastUpdatedAt ?? 0).getTime()
          );
        case 'key':
        default:
          return (a.key ?? '').localeCompare(b.key ?? '');
      }
    };
    const scoped = cat === ALL_CATEGORY ? allFiltered : allFiltered.filter((e) => e.prefix === cat);
    const sorted = [...scoped].sort(sortFn);
    if (cat === ALL_CATEGORY && !this.search().trim() && sorted.length > ALL_RENDER_CAP) {
      return sorted.slice(0, ALL_RENDER_CAP);
    }
    return sorted;
  });

  readonly renderCapped = computed(() => {
    const cat = this.selectedCategory();
    return (
      cat === ALL_CATEGORY &&
      !this.search().trim() &&
      this.filteredEntries().length > ALL_RENDER_CAP
    );
  });

  readonly selectedCategoryTitle = computed(() => {
    const cat = this.selectedCategory();
    return cat === ALL_CATEGORY ? 'All keys' : cat;
  });

  readonly selectedCategorySubtitle = computed(() => {
    const total = this.filteredEntries().length;
    if (this.search().trim()) return `${total} matches`;
    if (this.selectedCategory() === ALL_CATEGORY) return `${total} keys`;
    return '';
  });

  readonly categoryDirtyAllSaved = computed(() => false);

  // ── Charts (overview drawer) ───────────────────────────────────
  readonly dataTypeDonutOptions = computed<EChartsOption>(() => {
    const counts = this.dataTypeCounts();
    const palette: Record<ConfigDataType, string> = {
      String: '#0071E3',
      Int: '#5AC8FA',
      Decimal: '#34C759',
      Bool: '#FF9500',
      Json: '#AF52DE',
    };
    const data = (Object.entries(counts) as [ConfigDataType, number][])
      .filter(([, c]) => c > 0)
      .map(([type, value]) => ({
        name: type,
        value,
        itemStyle: { color: palette[type] },
      }));
    if (data.length === 0) return {};
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          label: { show: false },
          data,
        },
      ],
    };
  });

  readonly topCategoriesOptions = computed<EChartsOption>(() => {
    const counts = new Map<string, number>();
    for (const e of this.entries()) {
      counts.set(e.prefix, (counts.get(e.prefix) ?? 0) + 1);
    }
    const rows = Array.from(counts.entries())
      .map(([prefix, value]) => ({ prefix, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    if (rows.length === 0) return {};
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      grid: { top: 10, right: 50, bottom: 30, left: 110 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.prefix).reverse(),
        axisLabel: { fontSize: 11, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: rows
            .map((r) => ({
              value: r.value,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  // ── Category selection ─────────────────────────────────────────
  selectCategory(prefix: string): void {
    this.selectedCategory.set(prefix);
  }

  searchPlaceholder(): string {
    const n = this.entries().length;
    return `Search ${n.toLocaleString()} keys, descriptions…`;
  }

  // ── Edit / save ────────────────────────────────────────────────
  markDirty(config: ConfigEntry): void {
    config.dirty = config.editValue !== config.value;
    this.entries.set([...this.entries()]);
  }

  resetConfig(config: ConfigEntry): void {
    config.editValue = config.value ?? '';
    config.dirty = false;
    this.entries.set([...this.entries()]);
  }

  saveConfig(config: ConfigEntry): void {
    if (!config.dirty || config.saving) return;
    config.saving = true;
    this.entries.set([...this.entries()]);

    const request: UpsertConfigRequest = {
      key: config.key ?? '',
      value: config.editValue,
      description: config.description,
      dataType: config.dataType,
      isHotReloadable: config.isHotReloadable,
    };

    this.configService.upsert(request).subscribe({
      next: (res) => {
        config.saving = false;
        if (res.status && res.data) {
          config.value = res.data.value;
          config.editValue = res.data.value ?? '';
          config.lastUpdatedAt = res.data.lastUpdatedAt;
          config.dirty = false;
          this.notifications.success(`Config "${config.key}" updated`);
        } else {
          this.notifications.error(res.message ?? `Failed to update "${config.key}"`);
        }
        this.entries.set([...this.entries()]);
      },
      error: () => {
        config.saving = false;
        this.entries.set([...this.entries()]);
        this.notifications.error(`Failed to update "${config.key}"`);
      },
    });
  }

  saveAllDirty(): void {
    const dirty = this.entries().filter((e) => e.dirty);
    if (dirty.length === 0) return;
    this.bulkSaving.set(true);
    let remaining = dirty.length;
    let failures = 0;

    for (const config of dirty) {
      config.saving = true;
      const request: UpsertConfigRequest = {
        key: config.key ?? '',
        value: config.editValue,
        description: config.description,
        dataType: config.dataType,
        isHotReloadable: config.isHotReloadable,
      };
      this.configService.upsert(request).subscribe({
        next: (res) => {
          config.saving = false;
          if (res.status && res.data) {
            config.value = res.data.value;
            config.editValue = res.data.value ?? '';
            config.lastUpdatedAt = res.data.lastUpdatedAt;
            config.dirty = false;
          } else {
            failures++;
          }
          remaining--;
          this.entries.set([...this.entries()]);
          if (remaining === 0) this.finishBulkSave(dirty.length, failures);
        },
        error: () => {
          config.saving = false;
          failures++;
          remaining--;
          this.entries.set([...this.entries()]);
          if (remaining === 0) this.finishBulkSave(dirty.length, failures);
        },
      });
    }
  }

  private finishBulkSave(total: number, failures: number): void {
    this.bulkSaving.set(false);
    if (failures === 0) {
      this.notifications.success(`Saved ${total} configuration${total === 1 ? '' : 's'}`);
    } else {
      this.notifications.error(`Saved ${total - failures} of ${total} · ${failures} failed`);
    }
  }

  // ── Per-row keyboard ──────────────────────────────────────────
  /**
   * Enter saves the row (cmd-S equivalent at field-level), Escape resets
   * it. Shift+Enter passes through in textareas for multiline JSON.
   */
  onValueKey(ev: KeyboardEvent, config: ConfigEntry): void {
    if (ev.key === 'Enter' && !ev.shiftKey && !(ev.target instanceof HTMLTextAreaElement)) {
      ev.preventDefault();
      if (config.dirty) this.saveConfig(config);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      this.resetConfig(config);
      (ev.target as HTMLElement).blur();
    }
  }

  // ── Page-level keyboard shortcuts ─────────────────────────────
  /**
   * `/` focuses the search box (when no input is focused — so it doesn't
   * fight per-row editing). `⌘S` / `Ctrl+S` saves all unsaved.
   */
  @HostListener('document:keydown', ['$event'])
  onPageKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    const inEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target?.isContentEditable ?? false);

    // Save-all: Cmd/Ctrl + S
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      if (this.dirtyCount() > 0 && !this.bulkSaving()) this.saveAllDirty();
      return;
    }

    // Focus search: `/`
    if (ev.key === '/' && !inEditable) {
      ev.preventDefault();
      this.searchInput?.nativeElement.focus();
      this.searchInput?.nativeElement.select();
    }
  }
}
