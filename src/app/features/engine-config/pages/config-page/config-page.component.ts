import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  signal,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { EChartsOption } from 'echarts';

import { ConfigService } from '@core/services/config.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { ConfigDataType, EngineConfigDto, UpsertConfigRequest } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
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

const DAY_MS = 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-config-page',
  standalone: true,
  imports: [
    PageHeaderComponent,
    PresenceBadgeComponent,
    MetricCardComponent,
    ChartCardComponent,
    FormsModule,
    RelativeTimePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header
        title="Engine Configuration"
        subtitle="View and edit engine configuration parameters"
      >
        <app-presence-badge routeKey="engine-config" />
      </app-page-header>

      @if (loading()) {
        <div class="loading-state">
          <div class="skeleton-block"></div>
          <div class="skeleton-block"></div>
          <div class="skeleton-block"></div>
        </div>
      } @else if (entries().length > 0) {
        <!-- 8-card KPI strip — fleet view of the config surface -->
        <div class="kpis">
          <app-metric-card
            label="Total"
            [value]="entries().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Categories"
            [value]="totalGroupCount()"
            format="number"
            dotColor="#5AC8FA"
          />
          <app-metric-card
            label="Hot-reloadable"
            [value]="hotReloadCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Restart-required"
            [value]="entries().length - hotReloadCount()"
            format="number"
            [dotColor]="entries().length - hotReloadCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Updated 24h"
            [value]="recent24hCount()"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Updated 7d"
            [value]="recent7dCount()"
            format="number"
            dotColor="#AF52DE"
          />
          <app-metric-card
            label="Json configs"
            [value]="dataTypeCounts().Json"
            format="number"
            dotColor="#FF9500"
          />
          <app-metric-card
            label="Unsaved"
            [value]="dirtyCount()"
            format="number"
            [dotColor]="dirtyCount() > 0 ? '#FF3B30' : '#34C759'"
          />
        </div>

        <!-- 2-col chart row: data type donut + top categories -->
        <div class="chart-row">
          <app-chart-card
            title="Data type distribution"
            subtitle="String · Int · Decimal · Bool · Json"
            [options]="dataTypeDonutOptions()"
            height="220px"
          />
          <app-chart-card
            title="Top categories by config count"
            subtitle="Largest groups in the configuration surface"
            [options]="topCategoriesOptions()"
            height="220px"
          />
        </div>

        <!-- Toolbar: search, filters, sort, bulk save, expand/collapse all -->
        <div class="toolbar">
          <input
            type="text"
            class="input search"
            placeholder="Search keys or descriptions…"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <select
            class="input"
            [ngModel]="dataTypeFilter()"
            (ngModelChange)="dataTypeFilter.set($event)"
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
          >
            <option value="all">All</option>
            <option value="hot">Hot-reloadable only</option>
            <option value="cold">Restart-required only</option>
          </select>
          <select class="input" [ngModel]="sortMode()" (ngModelChange)="sortMode.set($event)">
            <option value="key">Sort: key A→Z</option>
            <option value="updated-desc">Sort: recently updated</option>
            <option value="updated-asc">Sort: oldest updated</option>
          </select>
          <div class="link-group">
            <button type="button" class="link-btn" (click)="expandAll()">Expand all</button>
            <button type="button" class="link-btn" (click)="collapseAll()">Collapse all</button>
          </div>
          <button
            type="button"
            class="save-btn primary"
            [disabled]="dirtyCount() === 0 || bulkSaving()"
            (click)="saveAllDirty()"
          >
            @if (bulkSaving()) {
              <span class="spinner"></span> Saving…
            } @else {
              Save {{ dirtyCount() }} unsaved
            }
          </button>
          <span class="muted">
            {{ filteredEntryCount() }} of {{ entries().length }} · {{ filteredGroups().length }} of
            {{ totalGroupCount() }} groups
          </span>
        </div>

        @if (filteredGroups().length === 0) {
          <div class="empty-row">No configs match the current filters.</div>
        }

        @for (group of filteredGroups(); track group.prefix) {
          <div class="config-group">
            <button class="group-header" (click)="toggleGroup(group.prefix)">
              <span class="group-chevron" [class.group-chevron--open]="isExpanded(group.prefix)">
                &#9654;
              </span>
              <span class="group-title">{{ group.prefix }}</span>
              <span class="group-count">{{ group.configs.length }}</span>
              @if (group.dirtyCount > 0) {
                <span class="agg-pill bad">{{ group.dirtyCount }} unsaved</span>
              }
              @if (group.hotReloadCount > 0) {
                <span class="agg-pill good">{{ group.hotReloadCount }} hot-reload</span>
              }
              @if (group.recent24hCount > 0) {
                <span class="agg-pill warn">{{ group.recent24hCount }} updated 24h</span>
              }
              <span class="agg-pill type-summary">
                @for (t of typeBreakdown(group); track t.type) {
                  <span class="type-chip">{{ t.type }} {{ t.count }}</span>
                }
              </span>
            </button>

            @if (isExpanded(group.prefix)) {
              <div class="config-table-wrapper">
                <table class="config-table">
                  <thead>
                    <tr>
                      <th class="col-key">Key</th>
                      <th class="col-value">Value</th>
                      <th class="col-type">Type</th>
                      <th class="col-reload">Hot</th>
                      <th class="col-updated">Last updated</th>
                      <th class="col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (config of group.configs; track config.id) {
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
                              [title]="config.editValue"
                            ></textarea>
                          } @else if (config.dataType === 'Bool') {
                            <select
                              class="config-input"
                              [(ngModel)]="config.editValue"
                              (ngModelChange)="markDirty(config)"
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
                            />
                          }
                        </td>
                        <td class="col-type">
                          <span class="type-badge">{{ config.dataType }}</span>
                        </td>
                        <td class="col-reload">
                          @if (config.isHotReloadable) {
                            <span class="badge badge--success">Yes</span>
                          } @else {
                            <span class="badge badge--neutral">No</span>
                          }
                        </td>
                        <td class="col-updated">
                          <span class="updated-text">{{
                            config.lastUpdatedAt | relativeTime
                          }}</span>
                        </td>
                        <td class="col-actions">
                          <button
                            class="save-btn"
                            [disabled]="!config.dirty || config.saving"
                            (click)="saveConfig(config)"
                          >
                            @if (config.saving) {
                              <span class="spinner"></span>
                            } @else {
                              Save
                            }
                          </button>
                          @if (config.dirty) {
                            <button
                              class="reset-btn"
                              type="button"
                              (click)="resetConfig(config)"
                              title="Discard changes"
                            >
                              ↺
                            </button>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
        }
      } @else {
        <div class="empty-row">No engine configuration entries returned.</div>
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
      }

      .loading-state {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
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

      /* 8-card KPI strip */
      .kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
      }
      @media (max-width: 1400px) {
        .kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

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

      .toolbar {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
      }
      .input {
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        outline: none;
      }
      .input:focus {
        border-color: var(--accent);
      }
      .search {
        flex: 1 1 280px;
        min-width: 240px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .link-group {
        display: inline-flex;
        gap: var(--space-2);
        align-items: center;
      }
      .link-btn {
        background: transparent;
        border: none;
        padding: 0;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--accent);
        cursor: pointer;
      }
      .link-btn:hover {
        text-decoration: underline;
      }
      .link-group .link-btn + .link-btn::before {
        content: '·';
        margin-right: var(--space-2);
        color: var(--text-tertiary);
      }
      .save-btn.primary {
        background: var(--accent);
        color: white;
        height: 36px;
        padding: 0 var(--space-4);
        font-size: var(--text-sm);
      }
      .save-btn.primary:disabled {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        cursor: not-allowed;
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

      .config-group {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .group-header {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        width: 100%;
        padding: var(--space-3) var(--space-4);
        border: none;
        background: none;
        cursor: pointer;
        font-family: inherit;
        text-align: left;
        transition: background 0.15s ease;
        flex-wrap: wrap;
      }
      .group-header:hover {
        background: var(--bg-tertiary);
      }
      .group-chevron {
        font-size: 10px;
        color: var(--text-tertiary);
        transition: transform 0.2s ease;
        display: inline-block;
      }
      .group-chevron--open {
        transform: rotate(90deg);
      }
      .group-title {
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .group-count {
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        background: var(--bg-tertiary);
        padding: 1px 8px;
        border-radius: var(--radius-full);
      }
      .agg-pill {
        font-size: 10.5px;
        font-weight: var(--font-medium);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .agg-pill.good {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .agg-pill.warn {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .agg-pill.bad {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .agg-pill.type-summary {
        background: transparent;
        padding: 0;
        margin-left: auto;
        display: inline-flex;
        gap: 4px;
      }
      .type-chip {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
        padding: 1px 6px;
        border-radius: var(--radius-full);
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 10px;
      }

      .config-table-wrapper {
        max-height: 540px;
        overflow: auto;
        border-top: 1px solid var(--border);
      }
      .config-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .config-table th {
        text-align: left;
        padding: var(--space-2) var(--space-3);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border);
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .config-table td {
        padding: var(--space-2) var(--space-3);
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .config-table tbody tr:last-child td {
        border-bottom: none;
      }
      .row-dirty {
        background: rgba(0, 113, 227, 0.04);
      }

      .col-key {
        min-width: 220px;
        max-width: 360px;
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
        width: 130px;
      }
      .col-actions {
        width: 110px;
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
        height: 30px;
        padding: 0 var(--space-2);
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
      }
      .config-textarea {
        height: 30px;
        resize: vertical;
        padding: 6px var(--space-2);
        white-space: nowrap;
        overflow: hidden;
        font-size: 11px;
      }
      .config-textarea:focus {
        height: 100px;
        white-space: pre;
        overflow: auto;
      }
      .type-badge {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: 600;
        background: rgba(0, 113, 227, 0.12);
        color: #0040dd;
      }
      .badge {
        display: inline-flex;
        padding: 2px 8px;
        border-radius: var(--radius-full);
        font-size: 11px;
        font-weight: 600;
      }
      .badge--success {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .badge--neutral {
        background: rgba(142, 142, 147, 0.12);
        color: #636366;
      }
      .updated-text {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .save-btn {
        height: 28px;
        padding: 0 var(--space-3);
        border: none;
        border-radius: var(--radius-full);
        background: var(--accent);
        color: white;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
        transition: all 0.15s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        min-width: 56px;
      }
      .save-btn:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .save-btn:active:not(:disabled) {
        transform: scale(0.97);
      }
      .save-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .reset-btn {
        height: 28px;
        width: 28px;
        margin-left: 4px;
        border: 1px solid var(--border);
        border-radius: 50%;
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 14px;
        cursor: pointer;
      }
      .reset-btn:hover {
        background: var(--bg-tertiary);
      }
      .spinner {
        width: 14px;
        height: 14px;
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
    `,
  ],
})
export class ConfigPageComponent implements OnInit {
  private readonly configService = inject(ConfigService);
  private readonly notifications = inject(NotificationService);

  readonly loading = signal(true);
  readonly entries = signal<ConfigEntry[]>([]);

  readonly search = signal('');
  readonly dataTypeFilter = signal<DataTypeFilter>('all');
  readonly hotReloadFilter = signal<'all' | 'hot' | 'cold'>('all');
  readonly sortMode = signal<SortMode>('key');
  readonly bulkSaving = signal(false);

  // Set of group prefixes the user has explicitly expanded. Default: empty
  // (everything collapsed) — with 2300+ entries we can't render expanded.
  private readonly expanded = signal<Set<string>>(new Set());

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

  // ---------- Aggregate KPIs ----------

  readonly hotReloadCount = computed(() => this.entries().filter((e) => e.isHotReloadable).length);

  readonly recent24hCount = computed(() => {
    const cutoff = Date.now() - DAY_MS;
    return this.entries().filter(
      (e) => e.lastUpdatedAt && new Date(e.lastUpdatedAt).getTime() > cutoff,
    ).length;
  });

  readonly recent7dCount = computed(() => {
    const cutoff = Date.now() - 7 * DAY_MS;
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

  // ---------- Filtering + grouping ----------

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

  readonly filteredEntryCount = computed(() => this.filteredEntries().length);

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
    return Array.from(buckets.entries())
      .map(([prefix, configs]) => {
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
      })
      .sort((a, b) => {
        // Groups with unsaved changes float to the top — that's where the
        // operator's attention should be. Then by recent activity, then size.
        if (a.dirtyCount !== b.dirtyCount) return b.dirtyCount - a.dirtyCount;
        if (a.recent24hCount !== b.recent24hCount) return b.recent24hCount - a.recent24hCount;
        if (a.configs.length !== b.configs.length) return b.configs.length - a.configs.length;
        return a.prefix.localeCompare(b.prefix);
      });
  });

  typeBreakdown(group: ConfigGroup): { type: ConfigDataType; count: number }[] {
    return (Object.entries(group.dataTypes) as [ConfigDataType, number][])
      .filter(([, c]) => c > 0)
      .map(([type, count]) => ({ type, count }));
  }

  // ---------- Charts ----------

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

  // ---------- Expand / collapse ----------

  isExpanded(prefix: string): boolean {
    // Active search auto-expands matching groups so the user actually sees the
    // results they searched for; otherwise we honour the explicit toggle set.
    if (this.search().trim()) return true;
    return this.expanded().has(prefix);
  }

  toggleGroup(prefix: string): void {
    const next = new Set(this.expanded());
    if (next.has(prefix)) next.delete(prefix);
    else next.add(prefix);
    this.expanded.set(next);
  }

  expandAll(): void {
    this.expanded.set(new Set(this.filteredGroups().map((g) => g.prefix)));
  }

  collapseAll(): void {
    this.expanded.set(new Set());
  }

  // ---------- Edit / save ----------

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
}
