import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe, formatDate } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { catchError, forkJoin, map, of, switchMap } from 'rxjs';
import type { EChartsOption } from 'echarts';

import {
  ConfigService,
  isQueuedForCoolingOff,
  type ConfigUpsertResponse,
} from '@core/services/config.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ConfigDataType, EngineConfigDto, UpsertConfigRequest } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

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
/** Rows rendered per step. It used to apply only to "All keys" without a search, so a search for
 *  "ml" or the MLKelly category (1,118 keys) still put thousands of inputs into the DOM. Every
 *  view now renders this many and offers "Show more". */
const ALL_RENDER_CAP = 250;

/** Outcome of one save — the engine's own `outcome` when it reports one, else read back. */
type SaveOutcome = 'applied' | 'unchanged' | 'queued' | 'failed';

interface SaveResult {
  config: ConfigEntry;
  outcome: SaveOutcome;
  message: string | null | undefined;
  /** When a queued change takes effect (engine `effectiveAt`). */
  effectiveAt?: string | null;
  /** Applied immediately past the cooling-off; the audit row is flagged. */
  breakGlass?: boolean;
}

/** The engine's machine-readable outcome (since 2026-10-19); null when it did not send one. */
function reportedOutcome(res: ConfigUpsertResponse): SaveOutcome | null {
  if (isQueuedForCoolingOff(res)) return 'queued';
  if (res.outcome === 'Applied') return 'applied';
  if (res.outcome === 'Unchanged') return 'unchanged';
  return null;
}
/** Same locale as the `| number` pipe, so "5,795 keys" reads the same in
 *  the strip, the subtitle and the search placeholder. */
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

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
    ModalA11yDirective,
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
            ><strong>{{ totalGroupCount() | number }}</strong> categories</span
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
              ><strong>{{ dirtyCount() | number }}</strong> unsaved</span
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
            <option value="String">String ({{ dataTypeCounts().String | number }})</option>
            <option value="Int">Int ({{ dataTypeCounts().Int | number }})</option>
            <option value="Decimal">Decimal ({{ dataTypeCounts().Decimal | number }})</option>
            <option value="Bool">Bool ({{ dataTypeCounts().Bool | number }})</option>
            <option value="Json">Json ({{ dataTypeCounts().Json | number }})</option>
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
              Save {{ dirtyCount() | number }} unsaved
            }
          </button>
        </div>

        <!-- ── Master-detail body ─────────────────────────────────── -->
        <div class="body">
          <aside class="sidebar" aria-label="Categories">
            <div class="sb-head">
              <span>Categories</span>
              <span class="muted">{{ sidebarGroups().length | number }}</span>
            </div>
            <!-- The row dots had no key: an operator saw orange beside
                 "Drawdown" and could not tell whether it was a warning.
                 It only ever meant "a key here changed in the last 24h". -->
            <div class="sb-legend" aria-hidden="true">
              <span><span class="dot bad"></span> unsaved edits</span>
              <span><span class="dot warn"></span> changed in last 24h</span>
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
                  [attr.title]="categoryTitle(g)"
                >
                  <span class="cat-name">{{ g.prefix }}</span>
                  <span class="cat-badges">
                    @if (g.dirtyCount > 0) {
                      <span class="dot bad"></span>
                    }
                    @if (g.recent24hCount > 0) {
                      <span class="dot warn"></span>
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
                          <!-- Segments with a <wbr> after each ":" so a long key
                               breaks at a section boundary instead of mid-token
                               ("AccountCoverage:AutoDeactivate" / "d:18"). -->
                          <code class="config-key" [title]="config.key ?? ''">
                            @for (seg of keySegments(config.key); track $index) {
                              <span class="key-seg">{{ seg }}</span>
                              @if (!$last) {
                                <span class="key-sep">:</span><wbr />
                              }
                            }
                          </code>
                          @if (config.description) {
                            <span class="config-desc" [class.clamped]="!isDescExpanded(config)">{{
                              config.description
                            }}</span>
                            @if (descNeedsToggle(config.description)) {
                              <button
                                type="button"
                                class="desc-toggle"
                                (click)="toggleDesc(config)"
                              >
                                {{ isDescExpanded(config) ? 'less' : 'more' }}
                              </button>
                            }
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
                    Showing {{ visibleEntries().length | number }} of
                    {{ scopedCount() | number }} keys ·
                    <button type="button" class="link-inline" (click)="showMore()">
                      Show {{ ALL_RENDER_CAP | number }} more
                    </button>
                    · or refine the search / pick a category.
                  </div>
                }
              </div>
            }
          </main>
        </div>
      }

      @if (review(); as rv) {
        <!-- Every save is reviewed first. Enter / Save / ⌘S used to write straight to the engine
             with no reason, so a risk-loosening key could not be changed at all (the engine
             demands a reason) and a cooling-off queueing was reported as "updated". -->
        <div class="review-backdrop" role="presentation" (click)="cancelReview()">
          <div
            class="review"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cfg-review-title"
            appModalA11y
            (dismiss)="cancelReview()"
            (click)="$event.stopPropagation()"
          >
            <h3 id="cfg-review-title">
              Save {{ rv.length | number }} change{{ rv.length === 1 ? '' : 's' }}?
            </h3>
            <ul class="review-list">
              @for (c of rv; track c.id) {
                <li>
                  <code class="review-key">{{ c.key }}</code>
                  <span class="review-vals">
                    <span class="review-old" [title]="c.value ?? ''">{{ c.value ?? '∅' }}</span>
                    →
                    <span class="review-new" [title]="c.editValue">{{ c.editValue }}</span>
                    @if (!c.isHotReloadable) {
                      <span class="badge badge--neutral">restart required</span>
                    }
                  </span>
                </li>
              }
            </ul>
            <p class="review-note">
              Risk-loosening keys need a reason and are held for the cooling-off period
              (Governance:CoolingOffHours) unless applied immediately. The engine decides which keys
              that is.
            </p>
            <label class="review-field">
              <span>Reason (audit trail — required for risk-loosening changes)</span>
              <textarea rows="2" maxlength="1000" [(ngModel)]="reviewReason"></textarea>
            </label>
            <label class="review-ack">
              <input type="checkbox" [(ngModel)]="reviewImmediate" />
              <span>Apply immediately — break-glass: skips the cooling-off (needs a reason)</span>
            </label>
            <div class="review-actions">
              <button type="button" class="reset-btn wide" (click)="cancelReview()" data-autofocus>
                Cancel
              </button>
              <button
                type="button"
                class="save-btn primary"
                [disabled]="reviewImmediate && !reviewReason.trim()"
                (click)="confirmReview()"
              >
                Save {{ rv.length | number }}
              </button>
            </div>
          </div>
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
        /* Stacked, the 164-row category list pushed the keys ~5,000px down a 24,782px page. */
        .sidebar {
          max-height: 300px;
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
      .sb-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px var(--space-3);
        padding: 0 var(--space-3) 6px;
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: none;
        letter-spacing: 0;
      }
      .sb-legend > span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
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

      /* The columns must add up to the ~840px keys panel at 1440px: once "Updated" stopped
         wrapping (it read "about 2 / months / ago"), the old minimums summed to ~940px and the
         Save button sat cut off past the panel edge. */
      .col-key {
        min-width: 200px;
        max-width: 380px;
      }
      /* A declared share of the row: without it the auto table layout gave
         the value column whatever the key column left over, and long
         values were cut off at the cell edge. */
      .col-value {
        width: 30%;
        min-width: 220px;
      }
      .col-type {
        width: 72px;
      }
      .col-reload {
        width: 64px;
      }
      .col-updated {
        width: 140px;
      }
      .col-actions {
        width: 104px;
        text-align: right;
        white-space: nowrap;
      }

      .config-key {
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 12px;
        color: var(--text-primary);
        display: block;
        /* break-all split tokens anywhere; anywhere + the <wbr> after each
           ":" means the browser prefers the section boundary and only
           splits inside a segment when a single segment is wider than the
           column. */
        overflow-wrap: anywhere;
        word-break: normal;
      }
      .key-sep {
        color: var(--text-tertiary);
      }
      .config-desc {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        display: block;
        margin-top: 2px;
        line-height: 1.4;
      }
      /* Two lines by default. Seven-line descriptions repeated on every
         row of a category pushed the value column off the fold. */
      .config-desc.clamped {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .desc-toggle {
        appearance: none;
        background: transparent;
        border: none;
        padding: 0;
        margin-top: 1px;
        font-family: inherit;
        font-size: 10.5px;
        color: var(--accent, #0071e3);
        cursor: pointer;
      }
      .desc-toggle:hover {
        text-decoration: underline;
      }
      .config-input {
        box-sizing: border-box;
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
        white-space: nowrap;
      }
      .link-inline {
        background: none;
        border: none;
        padding: 0;
        color: var(--accent);
        font: inherit;
        cursor: pointer;
      }
      .review-backdrop {
        position: fixed;
        inset: 0;
        z-index: 1100;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-4);
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(2px);
      }
      .review {
        width: min(640px, 100%);
        max-height: 88vh;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-5);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
      }
      .review h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .review-list {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 240px;
        overflow: auto;
        font-size: var(--text-xs);
      }
      .review-list li {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
      }
      .review-key {
        word-break: break-all;
      }
      .review-vals {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .review-old,
      .review-new {
        font-family: var(--font-mono, monospace);
        max-width: 40%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .review-old {
        color: var(--text-tertiary);
        text-decoration: line-through;
      }
      .review-new {
        color: var(--text-primary);
        font-weight: var(--font-semibold);
      }
      .review-note {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .review-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .review-field textarea {
        resize: vertical;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
      }
      .review-ack {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: var(--text-sm);
      }
      .review-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
      .reset-btn.wide {
        width: auto;
        padding: 0 12px;
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
  private readonly route = inject(ActivatedRoute);

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
    // Deep links (/system-health/worker-override-knobs → "Open in Engine Config") pass the key as
    // ?search=; it was ignored, so they landed on the unfiltered 6,000-key list.
    const q = this.route.snapshot.queryParamMap.get('search');
    if (q) this.search.set(q);
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
    return sorted.length > this.renderLimit() ? sorted.slice(0, this.renderLimit()) : sorted;
  });

  /** Keys in the current category under the current filters — what "Show more" pages through. */
  readonly scopedCount = computed(() => {
    const cat = this.selectedCategory();
    const all = this.filteredEntries();
    return cat === ALL_CATEGORY ? all.length : all.filter((e) => e.prefix === cat).length;
  });

  /** How many rows to render; resets to one step whenever the view changes. */
  readonly renderLimit = signal(ALL_RENDER_CAP);
  private readonly resetRenderLimit = effect(() => {
    this.selectedCategory();
    this.search();
    this.dataTypeFilter();
    this.hotReloadFilter();
    untracked(() => this.renderLimit.set(ALL_RENDER_CAP));
  });

  showMore(): void {
    this.renderLimit.update((n) => n + ALL_RENDER_CAP);
  }

  readonly renderCapped = computed(() => this.scopedCount() > this.visibleEntries().length);

  readonly selectedCategoryTitle = computed(() => {
    const cat = this.selectedCategory();
    return cat === ALL_CATEGORY ? 'All keys' : cat;
  });

  readonly selectedCategorySubtitle = computed(() => {
    const total = COUNT_FORMAT.format(this.filteredEntries().length);
    if (this.search().trim()) return `${total} matches`;
    if (this.selectedCategory() === ALL_CATEGORY) return `${total} keys`;
    return '';
  });

  readonly categoryDirtyAllSaved = computed(() => false);

  /** Whole-row hover text for the sidebar dots, in words rather than colour. */
  categoryTitle(g: ConfigGroup): string {
    const parts = [`${COUNT_FORMAT.format(g.configs.length)} keys`];
    if (g.dirtyCount > 0) parts.push(`${COUNT_FORMAT.format(g.dirtyCount)} unsaved`);
    if (g.recent24hCount > 0)
      parts.push(`${COUNT_FORMAT.format(g.recent24hCount)} changed in last 24h`);
    return parts.join(' · ');
  }

  // ── Key rendering / description clamp ─────────────────────────
  keySegments(key: string | null): string[] {
    return (key ?? '').split(':');
  }

  /** Keys the operator has expanded past the two-line clamp. */
  private readonly expandedDescKeys = signal<ReadonlySet<string>>(new Set());

  private descId(config: ConfigEntry): string {
    return config.key ?? String(config.id);
  }

  isDescExpanded(config: ConfigEntry): boolean {
    return this.expandedDescKeys().has(this.descId(config));
  }

  toggleDesc(config: ConfigEntry): void {
    const id = this.descId(config);
    const next = new Set(this.expandedDescKeys());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expandedDescKeys.set(next);
  }

  /**
   * Only offer the toggle when the text can plausibly exceed two lines;
   * measuring the DOM per row would cost a layout pass on a 250-row table.
   * ~55 chars per line at the key-column width, so two lines ≈ 110.
   */
  descNeedsToggle(description: string | null): boolean {
    if (!description) return false;
    return description.length > 110 || description.includes('\n');
  }

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
    return `Search ${COUNT_FORMAT.format(this.entries().length)} keys, descriptions…`;
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

  // ── Save review (confirm + reason) ─────────────────────────────
  /** Entries awaiting the operator's confirmation; null = no review open. */
  readonly review = signal<ConfigEntry[] | null>(null);
  reviewReason = '';
  reviewImmediate = false;

  private openReview(configs: ConfigEntry[]): void {
    if (configs.length === 0) return;
    this.reviewReason = '';
    this.reviewImmediate = false;
    this.review.set(configs);
  }

  cancelReview(): void {
    this.review.set(null);
  }

  confirmReview(): void {
    const configs = this.review();
    const reason = this.reviewReason.trim();
    const immediate = this.reviewImmediate;
    if (!configs || (immediate && !reason)) return;
    this.review.set(null);
    this.persist(configs, reason || null, immediate);
  }

  saveConfig(config: ConfigEntry): void {
    if (!config.dirty || config.saving) return;
    this.openReview([config]);
  }

  saveAllDirty(): void {
    this.openReview(this.entries().filter((e) => e.dirty && !e.saving));
  }

  /**
   * Writes each change, then READS THE KEY BACK. The upsert answers `ResponseData<long>` (a row
   * id), not the DTO the typings claim, so the old code set the value to `undefined` — the input
   * went blank after every successful save — and a change the engine had only queued for
   * cooling-off was shown as applied. The engine's own `outcome` (Applied / Unchanged /
   * QueuedForCoolingOff) decides what happened; the read-back fills the row with the live value,
   * and decides the outcome only for an older engine that does not report one.
   */
  private persist(configs: ConfigEntry[], reason: string | null, immediate: boolean): void {
    this.bulkSaving.set(configs.length > 1);
    for (const c of configs) c.saving = true;
    this.entries.set([...this.entries()]);

    forkJoin(
      configs.map((config) => {
        const submitted = config.editValue;
        const request: UpsertConfigRequest = {
          key: config.key ?? '',
          value: submitted,
          description: config.description,
          dataType: config.dataType,
          isHotReloadable: config.isHotReloadable,
          reason,
          immediate,
        };
        return this.configService.upsert(request).pipe(
          switchMap((res) => {
            if (!res.status) {
              return of<SaveResult>({ config, outcome: 'failed', message: res.message });
            }
            const told = reportedOutcome(res);
            const base = {
              config,
              message: res.message,
              effectiveAt: res.effectiveAt ?? null,
              breakGlass: res.breakGlass === true,
            };
            return this.configService.getByKey(config.key ?? '').pipe(
              map((fresh): SaveResult => {
                const dto = fresh.data;
                if (dto) {
                  config.value = dto.value;
                  config.lastUpdatedAt = dto.lastUpdatedAt;
                }
                const held = (dto?.value ?? null) === submitted;
                return { ...base, outcome: told ?? (held ? 'applied' : 'queued') };
              }),
              // Written but not re-readable: trust the envelope.
              catchError(() => {
                const outcome = told ?? 'applied';
                if (outcome === 'applied') config.value = submitted;
                return of<SaveResult>({ ...base, outcome });
              }),
            );
          }),
          catchError((err: { error?: { message?: string } }) =>
            of<SaveResult>({ config, outcome: 'failed', message: err?.error?.message ?? null }),
          ),
        );
      }),
    ).subscribe((results) => {
      for (const r of results) {
        r.config.saving = false;
        if (r.outcome !== 'failed') {
          // Applied / unchanged: the row now holds the live value. Queued: the live value is
          // unchanged until the cooling-off elapses — show it, not the draft.
          r.config.editValue = r.config.value ?? '';
          r.config.dirty = false;
        }
      }
      this.entries.set([...this.entries()]);
      this.bulkSaving.set(false);
      this.reportSave(results);
    });
  }

  private reportSave(results: SaveResult[]): void {
    const applied = results.filter((r) => r.outcome === 'applied');
    const unchanged = results.filter((r) => r.outcome === 'unchanged');
    const queued = results.filter((r) => r.outcome === 'queued');
    const failed = results.filter((r) => r.outcome === 'failed');
    if (results.length === 1) {
      const r = results[0];
      const key = r.config.key ?? '';
      if (r.outcome === 'applied') {
        this.notifications.success(
          r.breakGlass
            ? `Config "${key}" applied immediately (break-glass, audit-flagged)`
            : `Config "${key}" updated`,
        );
      } else if (r.outcome === 'unchanged') {
        this.notifications.info(`"${key}" already holds that value — nothing changed`);
      } else if (r.outcome === 'queued') {
        this.notifications.info(
          r.effectiveAt
            ? `"${key}" queued for cooling-off — takes effect ${this.fmtWhen(r.effectiveAt)}`
            : (r.message ?? `"${key}" was queued, not applied yet.`),
        );
      } else {
        this.notifications.error(r.message ?? `Failed to update "${key}"`);
      }
      return;
    }
    const parts = [`${COUNT_FORMAT.format(applied.length)} applied`];
    if (unchanged.length > 0) parts.push(`${COUNT_FORMAT.format(unchanged.length)} unchanged`);
    if (queued.length > 0) {
      const when = queued.map((r) => r.effectiveAt).find((t): t is string => !!t);
      const at = when ? ` (from ${this.fmtWhen(when)})` : '';
      parts.push(`${COUNT_FORMAT.format(queued.length)} queued for cooling-off${at}`);
    }
    if (failed.length > 0) parts.push(`${COUNT_FORMAT.format(failed.length)} failed`);
    const first = failed[0]?.message ? ` — ${failed[0].config.key}: ${failed[0].message}` : '';
    const text = parts.join(' · ') + first;
    if (failed.length > 0) this.notifications.error(text);
    else if (queued.length > 0) this.notifications.info(text);
    else this.notifications.success(text);
  }

  /** Local time with the zone named — a cooling-off ends hours away, often on another day. */
  private fmtWhen(iso: string): string {
    try {
      return formatDate(iso, 'MMM d, HH:mm z', 'en-US');
    } catch {
      return iso;
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
    } else if (ev.key === 'Escape' && !this.review()) {
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

    // Save-all: Cmd/Ctrl + S (opens the review; never writes on its own)
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      if (this.dirtyCount() > 0 && !this.bulkSaving() && !this.review()) this.saveAllDirty();
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
