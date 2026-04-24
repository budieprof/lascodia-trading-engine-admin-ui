import { Component, ChangeDetectionStrategy, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ConfigService } from '@core/services/config.service';
import { NotificationService } from '@core/notifications/notification.service';
import type { EngineConfigDto, UpsertConfigRequest } from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PresenceBadgeComponent } from '@shared/components/presence-badge/presence-badge.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

interface ConfigGroup {
  prefix: string;
  configs: ConfigEntry[];
  collapsed: boolean;
}

interface ConfigEntry extends EngineConfigDto {
  editValue: string;
  saving: boolean;
  dirty: boolean;
}

@Component({
  selector: 'app-config-page',
  standalone: true,
  imports: [PageHeaderComponent, PresenceBadgeComponent, FormsModule, RelativeTimePipe],
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
      } @else {
        @for (group of groups(); track group.prefix) {
          <div class="config-group">
            <button class="group-header" (click)="toggleGroup(group)">
              <span class="group-chevron" [class.group-chevron--open]="!group.collapsed">
                &#9654;
              </span>
              <span class="group-title">{{ group.prefix }}</span>
              <span class="group-count">{{ group.configs.length }}</span>
            </button>

            @if (!group.collapsed) {
              <div class="config-table-wrapper">
                <table class="config-table">
                  <thead>
                    <tr>
                      <th class="col-key">Key</th>
                      <th class="col-value">Value</th>
                      <th class="col-type">Data Type</th>
                      <th class="col-reload">Hot Reload</th>
                      <th class="col-updated">Last Updated</th>
                      <th class="col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (config of group.configs; track config.id) {
                      <tr [class.row-dirty]="config.dirty">
                        <td class="col-key">
                          <code class="config-key">{{ config.key }}</code>
                          @if (config.description) {
                            <span class="config-desc">{{ config.description }}</span>
                          }
                        </td>
                        <td class="col-value">
                          <input
                            type="text"
                            class="config-input"
                            [(ngModel)]="config.editValue"
                            (ngModelChange)="markDirty(config)"
                          />
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
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
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

      .config-group {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-3);
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

      .config-table-wrapper {
        overflow-x: auto;
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
        min-width: 200px;
      }
      .col-value {
        min-width: 200px;
      }
      .col-type {
        width: 100px;
      }
      .col-reload {
        width: 100px;
      }
      .col-updated {
        width: 140px;
      }
      .col-actions {
        width: 80px;
      }

      .config-key {
        font-family: 'SF Mono', 'Menlo', monospace;
        font-size: 12px;
        color: var(--text-primary);
        display: block;
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

  loading = signal(true);
  groups = signal<ConfigGroup[]>([]);

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
          }));

          const groupMap = new Map<string, ConfigEntry[]>();
          for (const entry of entries) {
            const key = entry.key ?? '';
            const dotIndex = key.indexOf('.');
            const prefix = dotIndex > 0 ? key.substring(0, dotIndex) + '.*' : 'General';
            if (!groupMap.has(prefix)) groupMap.set(prefix, []);
            groupMap.get(prefix)!.push(entry);
          }

          const groups: ConfigGroup[] = Array.from(groupMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([prefix, configs]) => ({
              prefix,
              configs: configs.sort((a, b) => (a.key ?? '').localeCompare(b.key ?? '')),
              collapsed: false,
            }));

          this.groups.set(groups);
        }
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.notifications.error('Failed to load configuration');
      },
    });
  }

  toggleGroup(group: ConfigGroup): void {
    group.collapsed = !group.collapsed;
    this.groups.set([...this.groups()]);
  }

  markDirty(config: ConfigEntry): void {
    config.dirty = config.editValue !== config.value;
    this.groups.set([...this.groups()]);
  }

  saveConfig(config: ConfigEntry): void {
    config.saving = true;
    this.groups.set([...this.groups()]);

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
        this.groups.set([...this.groups()]);
      },
      error: () => {
        config.saving = false;
        this.groups.set([...this.groups()]);
        this.notifications.error(`Failed to update "${config.key}"`);
      },
    });
  }
}
