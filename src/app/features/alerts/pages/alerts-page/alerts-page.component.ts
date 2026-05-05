import {
  Component,
  ChangeDetectionStrategy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { catchError, forkJoin, of } from 'rxjs';

import { AlertsService } from '@core/services/alerts.service';
import { ConfigService } from '@core/services/config.service';
import { NotificationService } from '@core/notifications/notification.service';
import type {
  AlertChannel,
  AlertChannelStatusDto,
  AlertDto,
  AlertSeverity,
  AlertType,
  CreateAlertRequest,
  EngineConfigDto,
  UpdateAlertRequest,
} from '@core/api/api.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { TabsComponent, TabItem } from '@shared/components/ui/tabs/tabs.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import type { EChartsOption } from 'echarts';

const ALERT_TYPES: AlertType[] = [
  'PriceLevel',
  'DrawdownBreached',
  'SignalGenerated',
  'OrderFilled',
  'PositionClosed',
  'MLModelDegraded',
  'DataQualityIssue',
  'SystemicMLDegradation',
  'LatencySla',
  'OptimizationLifecycleIssue',
  'WorkerCrash',
  'EADisconnected',
  'ConfigurationDrift',
  'BrokerReconciliation',
  'MLMonitoringStale',
  'SymbolicFeatureLifecycle',
];

const SEVERITIES: AlertSeverity[] = ['Info', 'Medium', 'High', 'Critical'];

interface ChannelDef {
  channel: AlertChannel;
  title: string;
  description: string;
  // Engine config keys (mirrors the appsettings sections):
  //   EmailAlertOptions:Host, :Port, :Username, :Password, :EnableSsl,
  //   :ToAddress, :FromAddress, :FromName
  //   WebhookAlertOptions:Url, :TimeoutSeconds, :SharedSecret
  //   TelegramAlertOptions:BotToken, :ChatId, :TimeoutSeconds
  fields: ChannelField[];
}

interface ChannelField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'checkbox';
  hint?: string;
  required?: boolean;
}

const CHANNEL_DEFS: ChannelDef[] = [
  {
    channel: 'Email',
    title: 'Email (SMTP)',
    description:
      'Sends each triggered alert as a plain-text email via SMTP. Use a transactional provider (SendGrid, Postmark, SES) for production.',
    fields: [
      { key: 'EmailAlertOptions:Host', label: 'SMTP host', type: 'text', required: true },
      {
        key: 'EmailAlertOptions:Port',
        label: 'Port',
        type: 'number',
        hint: '587 for STARTTLS, 465 for TLS',
      },
      { key: 'EmailAlertOptions:Username', label: 'Username', type: 'text' },
      { key: 'EmailAlertOptions:Password', label: 'Password / API key', type: 'password' },
      { key: 'EmailAlertOptions:EnableSsl', label: 'Enable SSL/TLS', type: 'checkbox' },
      { key: 'EmailAlertOptions:ToAddress', label: 'To address', type: 'text', required: true },
      { key: 'EmailAlertOptions:FromAddress', label: 'From address', type: 'text', required: true },
      { key: 'EmailAlertOptions:FromName', label: 'From name', type: 'text' },
    ],
  },
  {
    channel: 'Webhook',
    title: 'Webhook',
    description:
      'POSTs every alert to the configured URL. Use the shared secret to verify origin via the X-Lascodia-Secret header.',
    fields: [
      { key: 'WebhookAlertOptions:Url', label: 'Webhook URL', type: 'text', required: true },
      { key: 'WebhookAlertOptions:TimeoutSeconds', label: 'Timeout (s)', type: 'number' },
      {
        key: 'WebhookAlertOptions:SharedSecret',
        label: 'Shared secret',
        type: 'password',
        hint: 'Sent as X-Lascodia-Secret header — leave blank to omit.',
      },
    ],
  },
  {
    channel: 'Telegram',
    title: 'Telegram',
    description:
      'Posts to a Telegram chat via a bot. Get the bot token from @BotFather; the bot must be a member of the target chat/group.',
    fields: [
      {
        key: 'TelegramAlertOptions:BotToken',
        label: 'Bot token',
        type: 'password',
        required: true,
        hint: 'Issued by @BotFather (e.g. 123456:ABC-DEF…)',
      },
      {
        key: 'TelegramAlertOptions:ChatId',
        label: 'Chat ID',
        type: 'text',
        required: true,
        hint: 'Numeric for users/groups, @channelname for public channels',
      },
      { key: 'TelegramAlertOptions:TimeoutSeconds', label: 'Timeout (s)', type: 'number' },
    ],
  },
];

@Component({
  selector: 'app-alerts-page',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    TabsComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ChartCardComponent,
    RelativeTimePipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Alerts" subtitle="Rules and notification channels" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        <!-- ── Rules tab ─────────────────────────────────────────────── -->
        @if (activeTab() === 'rules') {
          <!-- 8-card KPI strip — fleet-wide rule roll-ups -->
          <div class="alerts-kpis">
            <div class="alerts-kpi">
              <span class="kpi-label">Total rules</span>
              <span class="kpi-value">{{ alerts().length }}</span>
            </div>
            <div class="alerts-kpi">
              <span class="kpi-label">Active</span>
              <span class="kpi-value good">{{ ruleStats().active }}</span>
            </div>
            <div class="alerts-kpi">
              <span class="kpi-label">Paused</span>
              <span class="kpi-value muted-val">{{ ruleStats().paused }}</span>
            </div>
            <div class="alerts-kpi">
              <span class="kpi-label">Critical</span>
              <span class="kpi-value bad">{{ ruleStats().critical }}</span>
            </div>
            <div class="alerts-kpi">
              <span class="kpi-label">High</span>
              <span class="kpi-value warn">{{ ruleStats().high }}</span>
            </div>
            <div class="alerts-kpi">
              <span class="kpi-label">Medium / Info</span>
              <span class="kpi-value">{{ ruleStats().mediumOrInfo }}</span>
            </div>
            <div class="alerts-kpi">
              <span class="kpi-label">Symbols covered</span>
              <span class="kpi-value">{{ ruleStats().symbolCount }}</span>
            </div>
            <div class="alerts-kpi">
              <span class="kpi-label">Triggered &lt; 1h</span>
              <span class="kpi-value" [class.warn]="ruleStats().recentlyTriggered > 0">
                {{ ruleStats().recentlyTriggered }}
              </span>
            </div>
          </div>

          <!-- 3-col chart row: severity donut + by symbol + by alert type -->
          <div class="alerts-charts">
            <app-chart-card
              title="Severity distribution"
              subtitle="Critical · High · Medium · Info"
              [options]="severityDonutOptions()"
              height="240px"
            />
            <app-chart-card
              title="Rules by symbol"
              subtitle="Top 10 symbols with most alert rules"
              [options]="bySymbolOptions()"
              height="240px"
            />
            <app-chart-card
              title="Rules by detector"
              subtitle="Distribution of rule types in the fleet"
              [options]="byTypeOptions()"
              height="240px"
            />
          </div>

          <!-- Recently triggered feed -->
          @if (recentlyTriggered().length > 0) {
            <section class="recent-trig">
              <header class="rt-head">
                <h3>Recently triggered</h3>
                <span class="muted"
                  >Last {{ recentlyTriggered().length }} firings — newest first</span
                >
              </header>
              <ul class="rt-list">
                @for (a of recentlyTriggered(); track a.id) {
                  <li class="rt-item" [attr.data-sev]="a.severity">
                    <span class="rt-sev pill" [attr.data-sev]="a.severity">{{ a.severity }}</span>
                    <span class="rt-type mono">{{ a.alertType }}</span>
                    <span class="rt-symbol mono">{{ a.symbol ?? 'system-wide' }}</span>
                    <span class="rt-time">
                      {{ a.lastTriggeredAt ? (a.lastTriggeredAt | relativeTime) : '—' }}
                    </span>
                    <span class="rt-cd">cooldown {{ a.cooldownSeconds }}s</span>
                    <button class="btn btn-ghost rt-btn" (click)="openEditRule(a)">Open</button>
                  </li>
                }
              </ul>
            </section>
          }

          <section class="rules-toolbar">
            <input
              type="search"
              class="input"
              placeholder="Search symbol or dedup key…"
              [ngModel]="search()"
              (ngModelChange)="search.set($event)"
            />
            <select
              class="input"
              [ngModel]="statusFilter()"
              (ngModelChange)="statusFilter.set($event)"
            >
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="paused">Paused only</option>
            </select>
            <select
              class="input"
              [ngModel]="severityFilter()"
              (ngModelChange)="severityFilter.set($event)"
            >
              <option value="all">All severities</option>
              @for (s of severities; track s) {
                <option [value]="s">{{ s }}</option>
              }
            </select>
            <span class="muted">{{ filteredAlerts().length }} of {{ alerts().length }}</span>
            <span class="spacer"></span>
            <button class="btn btn-primary" (click)="openCreateRule()">+ Create rule</button>
          </section>

          @if (alertsLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else if (filteredAlerts().length > 0) {
            <div class="rules-grid">
              @for (a of pagedAlerts(); track a.id) {
                <article class="rule-card" [class.paused]="!a.isActive">
                  <header class="rule-head">
                    <div class="rule-title">
                      <h4>{{ a.alertType }}</h4>
                      <span class="muted">{{ a.symbol ?? 'system-wide' }}</span>
                    </div>
                    <span class="pill" [attr.data-sev]="a.severity">{{ a.severity }}</span>
                    @if (!a.isActive) {
                      <span class="pill pill-paused">Paused</span>
                    }
                  </header>

                  <pre class="condition mono">{{ formatConditionJson(a.conditionJson) }}</pre>

                  <dl class="rule-meta">
                    <div>
                      <dt>Cooldown</dt>
                      <dd>{{ a.cooldownSeconds }}s</dd>
                    </div>
                    <div>
                      <dt>Dedup key</dt>
                      <dd class="trunc">{{ a.deduplicationKey ?? '—' }}</dd>
                    </div>
                    <div>
                      <dt>Last triggered</dt>
                      <dd>
                        {{ a.lastTriggeredAt ? (a.lastTriggeredAt | relativeTime) : 'never' }}
                      </dd>
                    </div>
                  </dl>

                  <footer class="rule-actions">
                    <button class="btn btn-ghost" (click)="openEditRule(a)">Edit</button>
                    <button class="btn btn-ghost" (click)="toggleActive(a)" [disabled]="busy()">
                      {{ a.isActive ? 'Pause' : 'Resume' }}
                    </button>
                    <button
                      class="btn btn-destructive"
                      (click)="askDeleteRule(a)"
                      [disabled]="busy()"
                    >
                      Delete
                    </button>
                  </footer>
                </article>
              }
            </div>

            <!-- Pagination — client-side over filteredAlerts. Total respects
                 the active search/status/severity filters. -->
            <nav class="rules-pager" aria-label="Rules pagination">
              <span class="muted">
                Showing {{ pageStart() }}–{{ pageEnd() }} of {{ filteredAlerts().length }}
              </span>
              <div class="pager-controls">
                <button
                  class="btn btn-ghost pager-btn"
                  (click)="rulesPage.set(rulesPage() - 1)"
                  [disabled]="rulesPage() <= 1"
                  aria-label="Previous page"
                >
                  ‹
                </button>
                @for (n of pageNumbers(); track n) {
                  @if (n === -1) {
                    <span class="pager-ellipsis">…</span>
                  } @else {
                    <button
                      class="btn pager-btn"
                      [class.active]="n === rulesPage()"
                      (click)="rulesPage.set(n)"
                    >
                      {{ n }}
                    </button>
                  }
                }
                <button
                  class="btn btn-ghost pager-btn"
                  (click)="rulesPage.set(rulesPage() + 1)"
                  [disabled]="rulesPage() >= totalPages()"
                  aria-label="Next page"
                >
                  ›
                </button>
              </div>
              <select
                class="input pager-size"
                [ngModel]="rulesPageSize()"
                (ngModelChange)="onPageSizeChange($event)"
                aria-label="Cards per page"
              >
                <option [ngValue]="12">12 / page</option>
                <option [ngValue]="24">24 / page</option>
                <option [ngValue]="48">48 / page</option>
                <option [ngValue]="96">96 / page</option>
              </select>
            </nav>
          } @else {
            <app-empty-state
              title="No alert rules"
              description="Create a rule to start firing notifications when conditions match."
            />
          }
        }

        <!-- ── Channels tab ──────────────────────────────────────────── -->
        @if (activeTab() === 'channels') {
          @if (channelsLoading()) {
            <app-card-skeleton [lines]="6" />
          } @else {
            <!-- 6-card KPI strip — channel + outbound-alert posture -->
            <div class="alerts-kpis ch-kpis">
              <div class="alerts-kpi">
                <span class="kpi-label">Channels</span>
                <span class="kpi-value">{{ channelDefs.length }}</span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Configured</span>
                <span class="kpi-value good">{{ channelKpis().configured }}</span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Not configured</span>
                <span
                  class="kpi-value"
                  [class.warn]="channelKpis().notConfigured > 0"
                  [class.good]="channelKpis().notConfigured === 0"
                >
                  {{ channelKpis().notConfigured }}
                </span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Active rules</span>
                <span class="kpi-value">{{ ruleStats().active }}</span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Pending channel changes</span>
                <span class="kpi-value" [class.warn]="channelKpis().dirtyChannels > 0">
                  {{ channelKpis().dirtyChannels }}
                </span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Last test</span>
                <span
                  class="kpi-value"
                  [class.good]="lastTestResult()?.delivered === true"
                  [class.bad]="lastTestResult()?.delivered === false"
                >
                  @if (lastTestResult(); as r) {
                    {{ r.delivered ? '✓ delivered' : '✗ failed' }}
                  } @else {
                    none
                  }
                </span>
              </div>
            </div>

            <!-- Action toolbar — bulk operations across all channels -->
            <section class="ch-toolbar">
              <p class="channel-intro muted">
                Channels are global — every triggered alert broadcasts to every configured channel.
                Settings are stored as engine config keys; changes take effect on the next worker
                cycle without an engine restart.
              </p>
              <div class="ch-actions">
                <button
                  class="btn btn-ghost"
                  (click)="testAllChannels()"
                  [disabled]="channelKpis().configured === 0 || busy()"
                  title="Send a test alert to every configured channel"
                >
                  Test all configured
                </button>
              </div>
            </section>

            <!-- Test history feed — chronological list of recent test attempts -->
            @if (testHistory().length > 0) {
              <section class="ch-history">
                <header class="ch-history-head">
                  <h3>Test history</h3>
                  <span class="muted"
                    >Last {{ testHistory().length }} test attempts — newest first</span
                  >
                  <button class="btn btn-ghost ch-clear" (click)="clearTestHistory()">Clear</button>
                </header>
                <ul class="ch-history-list">
                  @for (t of testHistory(); track $index) {
                    <li class="ch-history-item" [attr.data-ok]="t.delivered ? 'true' : 'false'">
                      <span class="ch-row-icon">{{ t.delivered ? '✓' : '✗' }}</span>
                      <span class="ch-row-channel mono">{{ t.channel }}</span>
                      <span class="ch-row-dest mono">{{ t.destination }}</span>
                      <span class="ch-row-time">{{ t.attemptedAt | relativeTime }}</span>
                    </li>
                  }
                </ul>
              </section>
            }

            <div class="channel-grid">
              @for (def of channelDefs; track def.channel) {
                <article
                  class="channel-card"
                  [class.channel-disabled]="channelStatus(def.channel)?.isEnabled === false"
                >
                  <header class="channel-head">
                    <div>
                      <h4>{{ def.title }}</h4>
                      <span class="muted">{{ def.description }}</span>
                    </div>
                    <div class="channel-head-right">
                      <span
                        class="pill"
                        [attr.data-state]="channelStatus(def.channel)?.isConfigured ? 'on' : 'off'"
                      >
                        {{
                          channelStatus(def.channel)?.isConfigured ? 'Configured' : 'Not configured'
                        }}
                      </span>
                      <!-- Per-channel kill-switch — short-circuits engine
                           dispatch without touching credentials. -->
                      <label
                        class="ch-toggle"
                        [class.on]="channelStatus(def.channel)?.isEnabled !== false"
                        [class.off]="channelStatus(def.channel)?.isEnabled === false"
                        [title]="
                          channelStatus(def.channel)?.isEnabled === false
                            ? 'Channel disabled — click to enable'
                            : 'Channel enabled — click to disable'
                        "
                      >
                        <input
                          type="checkbox"
                          [checked]="channelStatus(def.channel)?.isEnabled !== false"
                          [disabled]="busy() || togglingChannel() === def.channel"
                          (change)="toggleChannelEnabled(def.channel, $event)"
                        />
                        <span class="ch-toggle-track" aria-hidden="true">
                          <span class="ch-toggle-thumb"></span>
                        </span>
                        <span class="ch-toggle-label">
                          {{ channelStatus(def.channel)?.isEnabled === false ? 'Off' : 'On' }}
                        </span>
                      </label>
                    </div>
                  </header>

                  @if (channelStatus(def.channel); as s) {
                    @if (s.destinationPreview) {
                      <div class="channel-preview mono">{{ s.destinationPreview }}</div>
                    }
                  }

                  <!-- Inline completeness indicator: required-fields fill % +
                       optional pending-changes badge. Lets the operator see
                       at a glance whether a save will go through. -->
                  <div class="ch-fillrow">
                    <div class="ch-fill">
                      <div class="ch-fill-track">
                        <div
                          class="ch-fill-bar"
                          [style.width.%]="channelCompleteness(def).pct"
                          [class.full]="channelCompleteness(def).pct === 100"
                        ></div>
                      </div>
                      <span class="ch-fill-label">
                        {{ channelCompleteness(def).filled }} /
                        {{ channelCompleteness(def).requiredCount }} required
                      </span>
                    </div>
                    @if (isChannelDirty(def)) {
                      <span class="ch-dirty">Unsaved changes</span>
                    }
                    <span class="ch-timeout">
                      Timeout {{ channelStatus(def.channel)?.timeoutSeconds ?? '—' }}s
                    </span>
                  </div>

                  <div class="channel-fields">
                    @for (f of def.fields; track f.key) {
                      <label class="field" [class.field-checkbox]="f.type === 'checkbox'">
                        <span class="field-label">
                          {{ f.label }}
                          @if (f.required) {
                            <span class="req">*</span>
                          }
                        </span>
                        @if (f.type === 'checkbox') {
                          <input
                            type="checkbox"
                            [checked]="getBool(f.key)"
                            (change)="setField(f.key, $event)"
                          />
                        } @else {
                          <input
                            class="input"
                            [type]="f.type"
                            [value]="getValue(f.key)"
                            (input)="setField(f.key, $event)"
                            [attr.placeholder]="f.hint ?? null"
                            autocomplete="off"
                            [attr.aria-label]="f.label"
                          />
                        }
                        @if (f.hint && f.type !== 'checkbox') {
                          <span class="hint muted">{{ f.hint }}</span>
                        }
                      </label>
                    }
                  </div>

                  <footer class="channel-actions">
                    <button
                      class="btn btn-primary"
                      (click)="saveChannel(def)"
                      [disabled]="!isChannelDirty(def) || busy()"
                    >
                      Save settings
                    </button>
                    <button
                      class="btn btn-ghost"
                      (click)="testChannel(def.channel)"
                      [disabled]="
                        !channelStatus(def.channel)?.isConfigured ||
                        channelStatus(def.channel)?.isEnabled === false ||
                        busy()
                      "
                      [title]="
                        channelStatus(def.channel)?.isEnabled === false
                          ? 'Channel is disabled — enable it to send a test'
                          : ''
                      "
                    >
                      Send test
                    </button>
                  </footer>

                  @if (lastTestResult()?.channel === def.channel; as _) {
                    @if (lastTestResult(); as r) {
                      <div class="test-result" [attr.data-ok]="r.delivered ? 'true' : 'false'">
                        {{ r.delivered ? '✓' : '✗' }} test sent to {{ r.destination }} —
                        {{ r.attemptedAt | relativeTime }}
                      </div>
                    }
                  }
                </article>
              }
            </div>
          }
        }
      </ui-tabs>

      <!-- ── Rule editor modal ──────────────────────────────────────── -->
      @if (editingRule(); as draft) {
        <div class="modal-backdrop" (click)="cancelRule()">
          <div class="modal" (click)="$event.stopPropagation()">
            <header class="modal-head">
              <h3>{{ draft.id ? 'Edit alert rule' : 'New alert rule' }}</h3>
              <button class="btn-close" (click)="cancelRule()" aria-label="Close">×</button>
            </header>

            <form [formGroup]="ruleForm" (ngSubmit)="saveRule()" class="rule-form">
              <div class="form-row">
                <label class="field">
                  <span class="field-label">Alert type<span class="req">*</span></span>
                  <select class="input" formControlName="alertType">
                    @for (t of alertTypes; track t) {
                      <option [value]="t">{{ t }}</option>
                    }
                  </select>
                </label>
                <label class="field">
                  <span class="field-label">Severity<span class="req">*</span></span>
                  <select class="input" formControlName="severity">
                    @for (s of severities; track s) {
                      <option [value]="s">{{ s }}</option>
                    }
                  </select>
                </label>
              </div>
              <div class="form-row">
                <label class="field">
                  <span class="field-label">Symbol</span>
                  <input
                    class="input"
                    formControlName="symbol"
                    placeholder="EURUSD (blank = system-wide)"
                  />
                </label>
                <label class="field">
                  <span class="field-label">Cooldown (s)<span class="req">*</span></span>
                  <input class="input" type="number" formControlName="cooldownSeconds" min="0" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">Dedup key</span>
                <input
                  class="input"
                  formControlName="deduplicationKey"
                  placeholder="Optional — same key within cooldown is suppressed"
                />
              </label>
              <label class="field">
                <span class="field-label">Condition JSON<span class="req">*</span></span>
                <textarea
                  class="input mono"
                  rows="6"
                  formControlName="conditionJson"
                  spellcheck="false"
                ></textarea>
                <span class="hint muted">
                  Schema varies by alert type — e.g.
                  <code>{{ '{' }}"price": 1.0850, "direction": "Above"{{ '}' }}</code>
                  for PriceLevel.
                </span>
              </label>
              <label class="field field-checkbox">
                <input type="checkbox" formControlName="isActive" />
                <span>Active</span>
              </label>

              <footer class="modal-actions">
                <button type="button" class="btn btn-ghost" (click)="cancelRule()">Cancel</button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="ruleForm.invalid || busy()"
                >
                  {{ draft.id ? 'Save changes' : 'Create rule' }}
                </button>
              </footer>
            </form>
          </div>
        </div>
      }

      <app-confirm-dialog
        [open]="showDeleteDialog()"
        title="Delete alert rule?"
        message="This will stop the engine from evaluating this condition. Already-fired notifications are kept for audit."
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="confirmDelete()"
        (cancelled)="showDeleteDialog.set(false)"
      />
    </div>
  `,
  styles: [
    `
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .btn {
        height: 36px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: none;
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
        cursor: pointer;
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--accent);
        color: white;
      }
      .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .btn-ghost {
        background: transparent;
        border: 1px solid var(--border);
      }
      .btn-destructive {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
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
      textarea.input {
        height: auto;
        padding: var(--space-2) var(--space-3);
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        resize: vertical;
      }
      .req {
        color: var(--loss);
        margin-left: 2px;
      }
      .muted {
        color: var(--text-tertiary);
        font-size: var(--text-xs);
      }
      .mono {
        font-family: 'SF Mono', 'Fira Code', monospace;
      }

      .rules-toolbar {
        display: flex;
        gap: var(--space-3);
        align-items: center;
        flex-wrap: wrap;
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-3);
      }
      .spacer {
        flex: 1;
      }

      /* Alerts-page density additions */
      .alerts-kpis {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: var(--space-2);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1400px) {
        .alerts-kpis {
          grid-template-columns: repeat(4, 1fr);
        }
      }
      @media (max-width: 720px) {
        .alerts-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      .alerts-kpi {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3) var(--space-4);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .alerts-kpi .kpi-label {
        font-size: 10px;
        font-weight: var(--font-semibold);
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .alerts-kpi .kpi-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .alerts-kpi .kpi-value.good {
        color: var(--profit);
      }
      .alerts-kpi .kpi-value.bad {
        color: var(--loss);
      }
      .alerts-kpi .kpi-value.warn {
        color: #c93400;
      }
      .alerts-kpi .kpi-value.muted-val {
        color: var(--text-tertiary);
      }

      .alerts-charts {
        display: grid;
        grid-template-columns: 1fr 1.2fr 1.4fr;
        gap: var(--space-3);
        margin-bottom: var(--space-3);
      }
      @media (max-width: 1100px) {
        .alerts-charts {
          grid-template-columns: 1fr;
        }
      }

      .recent-trig {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--space-3);
      }
      .rt-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .rt-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .rt-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 320px;
        overflow-y: auto;
      }
      .rt-item {
        display: grid;
        grid-template-columns: 90px 1.4fr 1fr 1fr 1fr 80px;
        align-items: center;
        gap: var(--space-3);
        padding: 8px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .rt-item:last-child {
        border-bottom: none;
      }
      .rt-sev {
        text-align: center;
      }
      .rt-type {
        font-weight: var(--font-semibold);
      }
      .rt-cd {
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .rt-time {
        color: var(--text-secondary);
      }
      .rt-btn {
        padding: 4px 12px;
        height: 26px;
        font-size: 11px;
      }

      /* Rules-grid pagination */
      .rules-pager {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        margin-top: var(--space-4);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        flex-wrap: wrap;
      }
      .pager-controls {
        display: flex;
        gap: 4px;
        align-items: center;
      }
      .pager-btn {
        height: 30px;
        min-width: 32px;
        padding: 0 var(--space-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: var(--font-medium);
      }
      .pager-btn:hover:not(:disabled) {
        color: var(--text-primary);
        border-color: var(--text-tertiary);
      }
      .pager-btn.active {
        background: var(--accent);
        color: #fff;
        border-color: var(--accent);
      }
      .pager-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .pager-ellipsis {
        padding: 0 var(--space-1);
        color: var(--text-tertiary);
        font-size: 12px;
      }
      .pager-size {
        height: 30px;
        padding: 0 var(--space-2);
        font-size: 12px;
      }

      /* Channels-tab density additions */
      .ch-kpis {
        grid-template-columns: repeat(6, 1fr);
      }
      @media (max-width: 1100px) {
        .ch-kpis {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 600px) {
        .ch-kpis {
          grid-template-columns: repeat(2, 1fr);
        }
      }

      .ch-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-3);
        flex-wrap: wrap;
      }
      .ch-toolbar .channel-intro {
        margin: 0;
        flex: 1;
      }
      .ch-actions {
        display: flex;
        gap: var(--space-2);
      }

      .ch-history {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        overflow: hidden;
        margin-bottom: var(--space-3);
      }
      .ch-history-head {
        display: flex;
        align-items: baseline;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--border);
      }
      .ch-history-head h3 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .ch-clear {
        margin-left: auto;
        height: 26px;
        padding: 0 var(--space-3);
        font-size: 11px;
      }
      .ch-history-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 240px;
        overflow-y: auto;
      }
      .ch-history-item {
        display: grid;
        grid-template-columns: 24px 100px 1fr auto;
        align-items: center;
        gap: var(--space-3);
        padding: 6px var(--space-4);
        border-bottom: 1px solid var(--border);
        font-size: var(--text-xs);
      }
      .ch-history-item:last-child {
        border-bottom: none;
      }
      .ch-history-item[data-ok='true'] .ch-row-icon {
        color: var(--profit);
        font-weight: var(--font-bold);
      }
      .ch-history-item[data-ok='false'] .ch-row-icon {
        color: var(--loss);
        font-weight: var(--font-bold);
      }
      .ch-row-channel {
        font-weight: var(--font-semibold);
      }
      .ch-row-dest {
        color: var(--text-secondary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ch-row-time {
        color: var(--text-tertiary);
      }

      /* Per-card completeness row */
      .ch-fillrow {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) 0;
        border-bottom: 1px solid var(--border);
        margin-bottom: var(--space-3);
        flex-wrap: wrap;
      }
      .ch-fill {
        flex: 1;
        min-width: 160px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .ch-fill-track {
        height: 4px;
        background: var(--bg-tertiary);
        border-radius: 2px;
        overflow: hidden;
      }
      .ch-fill-bar {
        height: 100%;
        background: var(--accent);
        transition: width 0.2s ease;
      }
      .ch-fill-bar.full {
        background: var(--profit);
      }
      .ch-fill-label {
        font-size: 10.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }
      .ch-dirty {
        font-size: 10px;
        font-weight: var(--font-bold);
        padding: 2px 8px;
        border-radius: var(--radius-full);
        background: rgba(255, 149, 0, 0.14);
        color: #c93400;
        letter-spacing: 0.04em;
      }
      .ch-timeout {
        font-size: 10.5px;
        color: var(--text-tertiary);
        font-variant-numeric: tabular-nums;
      }

      .rules-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: var(--space-4);
      }
      .rule-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .rule-card.paused {
        opacity: 0.65;
      }
      .rule-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .rule-title {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .rule-title h4 {
        margin: 0;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .pill {
        padding: 2px 10px;
        border-radius: var(--radius-full);
        font-size: 10px;
        font-weight: var(--font-semibold);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .pill[data-sev='Critical'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .pill[data-sev='High'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .pill[data-sev='Medium'] {
        background: rgba(0, 113, 227, 0.12);
        color: var(--accent);
      }
      .pill[data-sev='Info'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill-paused {
        background: var(--bg-tertiary);
        color: var(--text-tertiary);
      }
      .pill[data-state='on'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .pill[data-state='off'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .condition {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-primary);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 100px;
        overflow: auto;
      }
      .rule-meta {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: var(--space-2);
        margin: 0;
      }
      .rule-meta dt {
        font-size: 10px;
        color: var(--text-tertiary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .rule-meta dd {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-primary);
      }
      .rule-meta dd.trunc {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .rule-actions {
        display: flex;
        gap: var(--space-2);
        justify-content: flex-end;
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
      }

      .channel-intro {
        max-width: 60ch;
      }
      .channel-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: var(--space-4);
      }
      .channel-card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        transition:
          opacity 0.15s ease,
          border-color 0.15s ease;
      }
      /* When the channel is disabled, dim the body and tint the border so it's
         visually obvious without hiding any controls. */
      .channel-card.channel-disabled {
        opacity: 0.65;
        border-color: rgba(255, 149, 0, 0.45);
      }
      .channel-card.channel-disabled .channel-fields,
      .channel-card.channel-disabled .channel-preview,
      .channel-card.channel-disabled .ch-fillrow {
        opacity: 0.7;
      }
      .channel-head {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
        justify-content: space-between;
      }
      .channel-head h4 {
        margin: 0 0 2px;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      .channel-head-right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
      }

      /* Per-channel enable/disable toggle (iOS-style switch). */
      .ch-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        font-size: 11px;
        font-weight: var(--font-semibold);
        color: var(--text-secondary);
      }
      .ch-toggle input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
        width: 0;
        height: 0;
      }
      .ch-toggle-track {
        position: relative;
        display: inline-block;
        width: 32px;
        height: 18px;
        background: var(--text-tertiary);
        border-radius: 999px;
        transition: background 0.15s ease;
      }
      .ch-toggle-thumb {
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        background: #fff;
        border-radius: 50%;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        transition: transform 0.15s ease;
      }
      .ch-toggle.on .ch-toggle-track {
        background: var(--profit, #34c759);
      }
      .ch-toggle.on .ch-toggle-thumb {
        transform: translateX(14px);
      }
      .ch-toggle.on .ch-toggle-label {
        color: var(--profit, #248a3d);
      }
      .ch-toggle.off .ch-toggle-label {
        color: #c93400;
      }
      .ch-toggle:has(input:disabled) {
        cursor: not-allowed;
        opacity: 0.5;
      }
      .ch-toggle:focus-within .ch-toggle-track {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .channel-preview {
        padding: 4px var(--space-3);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .channel-fields {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: var(--space-3);
      }
      .channel-fields .field-checkbox {
        grid-column: 1 / -1;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .field-checkbox {
        flex-direction: row;
        align-items: center;
        gap: var(--space-2);
      }
      .field-label {
        font-size: 11px;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .hint {
        font-size: 10.5px;
      }
      .channel-actions {
        display: flex;
        gap: var(--space-2);
        padding-top: var(--space-2);
        border-top: 1px solid var(--border);
      }
      .test-result {
        font-size: var(--text-xs);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .test-result[data-ok='true'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .test-result[data-ok='false'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }

      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 100;
      }
      .modal {
        width: 100%;
        max-width: 560px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        max-height: 90vh;
        overflow: auto;
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--space-4) var(--space-5);
        border-bottom: 1px solid var(--border);
      }
      .modal-head h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .btn-close {
        background: transparent;
        border: none;
        font-size: 22px;
        cursor: pointer;
        color: var(--text-tertiary);
      }
      .rule-form {
        padding: var(--space-4) var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }
      .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
        padding-top: var(--space-3);
        border-top: 1px solid var(--border);
      }
    `,
  ],
})
export class AlertsPageComponent {
  private readonly alertsService = inject(AlertsService);
  private readonly configService = inject(ConfigService);
  private readonly notifications = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  readonly tabs: TabItem[] = [
    { label: 'Rules', value: 'rules' },
    { label: 'Channels', value: 'channels' },
  ];
  readonly activeTab = signal<'rules' | 'channels'>('rules');

  readonly alertTypes = ALERT_TYPES;
  readonly severities = SEVERITIES;
  readonly channelDefs = CHANNEL_DEFS;

  // ── Rules state ──────────────────────────────────────────────────────
  readonly alerts = signal<AlertDto[]>([]);
  readonly alertsLoading = signal(true);
  readonly busy = signal(false);

  readonly search = signal('');
  readonly statusFilter = signal<'all' | 'active' | 'paused'>('all');
  readonly severityFilter = signal<'all' | AlertSeverity>('all');

  readonly editingRule = signal<Partial<AlertDto> | null>(null);
  readonly showDeleteDialog = signal(false);
  readonly pendingDeleteId = signal<number | null>(null);

  readonly ruleForm = this.fb.nonNullable.group({
    alertType: ['PriceLevel' as AlertType, [Validators.required]],
    symbol: [''],
    severity: ['Medium' as AlertSeverity, [Validators.required]],
    cooldownSeconds: [300, [Validators.required, Validators.min(0), Validators.max(86_400)]],
    deduplicationKey: [''],
    conditionJson: ['{}', [Validators.required]],
    isActive: [true],
  });

  readonly filteredAlerts = computed(() => {
    const q = this.search().toLowerCase().trim();
    const st = this.statusFilter();
    const sev = this.severityFilter();
    // Reading the filter signals here naturally invalidates this computed
    // when any of them change — and that's the cue for the page-reset effect
    // below to drop the user back to page 1.
    return this.alerts().filter((a) => {
      if (st === 'active' && !a.isActive) return false;
      if (st === 'paused' && a.isActive) return false;
      if (sev !== 'all' && a.severity !== sev) return false;
      if (q) {
        const hay = `${a.symbol ?? ''} ${a.deduplicationKey ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  // ── Rules-grid pagination (client-side) ──────────────────────────────
  readonly rulesPage = signal(1);
  readonly rulesPageSize = signal(24);

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredAlerts().length / this.rulesPageSize())),
  );

  readonly pagedAlerts = computed(() => {
    const all = this.filteredAlerts();
    const size = this.rulesPageSize();
    // Clamp to total pages — guards against the page index outliving its
    // page when filters shrink the result set below the current offset.
    const page = Math.min(this.rulesPage(), Math.max(1, Math.ceil(all.length / size)));
    const start = (page - 1) * size;
    return all.slice(start, start + size);
  });

  readonly pageStart = computed(() =>
    this.filteredAlerts().length === 0 ? 0 : (this.rulesPage() - 1) * this.rulesPageSize() + 1,
  );
  readonly pageEnd = computed(() =>
    Math.min(this.rulesPage() * this.rulesPageSize(), this.filteredAlerts().length),
  );

  // Compact page-number list with ellipses: 1 … (cur-1) cur (cur+1) … last.
  readonly pageNumbers = computed<number[]>(() => {
    const total = this.totalPages();
    const cur = this.rulesPage();
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages: number[] = [1];
    if (cur > 3) pages.push(-1);
    const start = Math.max(2, cur - 1);
    const end = Math.min(total - 1, cur + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (cur < total - 2) pages.push(-1);
    pages.push(total);
    return pages;
  });

  onPageSizeChange(size: number): void {
    this.rulesPageSize.set(size);
    this.rulesPage.set(1);
  }

  // ── Rule analytics roll-ups ──────────────────────────────────────────
  ruleStats = computed(() => {
    const all = this.alerts();
    const symbols = new Set<string>();
    let active = 0;
    let critical = 0;
    let high = 0;
    let mediumOrInfo = 0;
    let recentlyTriggered = 0;
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const a of all) {
      if (a.isActive) active++;
      if (a.symbol) symbols.add(a.symbol);
      if (a.severity === 'Critical') critical++;
      else if (a.severity === 'High') high++;
      else mediumOrInfo++;
      if (a.lastTriggeredAt && new Date(a.lastTriggeredAt).getTime() >= oneHourAgo) {
        recentlyTriggered++;
      }
    }
    return {
      active,
      paused: all.length - active,
      critical,
      high,
      mediumOrInfo,
      symbolCount: symbols.size,
      recentlyTriggered,
    };
  });

  severityDonutOptions = computed<EChartsOption>(() => {
    const counts: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Info: 0 };
    for (const a of this.alerts()) {
      counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    }
    if (this.alerts().length === 0) return {};
    const colors: Record<string, string> = {
      Critical: '#FF3B30',
      High: '#FF9500',
      Medium: '#5AC8FA',
      Info: '#8E8E93',
    };
    return {
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { bottom: 0, textStyle: { fontSize: 10, color: '#6E6E73' } },
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          center: ['50%', '45%'],
          avoidLabelOverlap: true,
          label: { show: false },
          data: Object.entries(counts)
            .map(([k, v]) => ({ name: k, value: v, itemStyle: { color: colors[k] } }))
            .filter((d) => d.value > 0),
        },
      ],
    };
  });

  bySymbolOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const a of this.alerts()) {
      const k = a.symbol ?? 'system-wide';
      map[k] = (map[k] ?? 0) + 1;
    }
    const entries = Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 90 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#0071E3', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 14,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  byTypeOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const a of this.alerts()) {
      map[a.alertType] = (map[a.alertType] ?? 0) + 1;
    }
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return {};
    return {
      grid: { top: 10, right: 30, bottom: 30, left: 150 },
      xAxis: {
        type: 'value',
        axisLabel: { fontSize: 10, color: '#6E6E73' },
        splitLine: { lineStyle: { color: 'rgba(0,0,0,0.04)' } },
      },
      yAxis: {
        type: 'category',
        data: entries.map(([k]) => k).reverse(),
        axisLabel: { fontSize: 10, color: '#6E6E73' },
      },
      series: [
        {
          type: 'bar',
          data: entries
            .map(([, v]) => ({
              value: v,
              itemStyle: { color: '#AF52DE', borderRadius: [0, 4, 4, 0] },
            }))
            .reverse(),
          barWidth: 12,
          label: { show: true, position: 'right', fontSize: 10, color: '#6E6E73' },
        },
      ],
    };
  });

  recentlyTriggered = computed(() =>
    [...this.alerts()]
      .filter((a) => !!a.lastTriggeredAt)
      .sort(
        (a, b) => new Date(b.lastTriggeredAt!).getTime() - new Date(a.lastTriggeredAt!).getTime(),
      )
      .slice(0, 12),
  );

  // ── Channels state ───────────────────────────────────────────────────
  readonly channelStatuses = signal<AlertChannelStatusDto[]>([]);
  readonly configValues = signal<Record<string, string>>({});
  readonly draftValues = signal<Record<string, string>>({});
  readonly channelsLoading = signal(true);
  readonly lastTestResult = signal<{
    channel: AlertChannel;
    delivered: boolean;
    destination: string;
    attemptedAt: string;
  } | null>(null);

  // Rolling chronological log of every test fired this session — gives the
  // operator a paper-trail when debugging delivery (a one-shot lastTestResult
  // forgets the previous attempt every time you click Send test).
  readonly testHistory = signal<
    {
      channel: AlertChannel;
      delivered: boolean;
      destination: string;
      attemptedAt: string;
    }[]
  >([]);

  // Channel currently mid-toggle, so we can disable the affected switch and
  // suppress double-clicks. `null` when no toggle is in flight.
  readonly togglingChannel = signal<AlertChannel | null>(null);

  channelStatus(c: AlertChannel): AlertChannelStatusDto | null {
    return this.channelStatuses().find((s) => s.channel === c) ?? null;
  }

  /**
   * Toggle the per-channel kill-switch. Optimistic UI: update the local
   * status immediately so the switch animates, then reconcile from the
   * server response. On failure we revert and surface a notification.
   */
  toggleChannelEnabled(channel: AlertChannel, ev: Event): void {
    const target = ev.target as HTMLInputElement;
    const requested = target.checked;
    const current = this.channelStatus(channel);
    if (current?.isEnabled === requested) return;

    this.togglingChannel.set(channel);

    // Optimistic update so the toggle's visual state reflects the click
    // immediately. We re-sync from the server result regardless.
    this.channelStatuses.set(
      this.channelStatuses().map((s) =>
        s.channel === channel ? { ...s, isEnabled: requested } : s,
      ),
    );

    this.alertsService.setChannelEnabled({ channel, isEnabled: requested }).subscribe({
      next: (res) => {
        this.togglingChannel.set(null);
        if (res?.status && res.data) {
          this.channelStatuses.set(
            this.channelStatuses().map((s) =>
              s.channel === channel ? { ...s, isEnabled: res.data!.isEnabled } : s,
            ),
          );
          this.notifications.success(
            `${channel} channel ${res.data.isEnabled ? 'enabled' : 'disabled'}`,
          );
        } else {
          // Revert the optimistic update.
          this.channelStatuses.set(
            this.channelStatuses().map((s) =>
              s.channel === channel ? { ...s, isEnabled: !requested } : s,
            ),
          );
          this.notifications.error(res?.message ?? `Failed to update ${channel}`);
        }
      },
      error: () => {
        this.togglingChannel.set(null);
        this.channelStatuses.set(
          this.channelStatuses().map((s) =>
            s.channel === channel ? { ...s, isEnabled: !requested } : s,
          ),
        );
        this.notifications.error(`Failed to update ${channel}`);
      },
    });
  }

  // ── Channels-tab analytics ───────────────────────────────────────────
  channelKpis = computed(() => {
    let configured = 0;
    let dirtyChannels = 0;
    for (const def of this.channelDefs) {
      if (this.channelStatus(def.channel)?.isConfigured) configured++;
      if (this.isChannelDirty(def)) dirtyChannels++;
    }
    return {
      configured,
      notConfigured: this.channelDefs.length - configured,
      dirtyChannels,
    };
  });

  channelCompleteness(def: ChannelDef): {
    filled: number;
    requiredCount: number;
    pct: number;
  } {
    const required = def.fields.filter((f) => f.required);
    let filled = 0;
    for (const f of required) {
      const v = this.getValue(f.key).trim();
      if (v) filled++;
    }
    return {
      filled,
      requiredCount: required.length,
      pct: required.length === 0 ? 100 : Math.round((filled / required.length) * 100),
    };
  }

  testAllChannels(): void {
    for (const def of this.channelDefs) {
      if (this.channelStatus(def.channel)?.isConfigured) {
        this.testChannel(def.channel);
      }
    }
  }

  clearTestHistory(): void {
    this.testHistory.set([]);
  }

  constructor() {
    this.loadAlerts();
    this.loadChannels();

    // Snap the user back to page 1 whenever the filtered result set shrinks
    // past their current page. Without this they'd be stranded on a page
    // whose content the clamp logic has silently swapped underneath them.
    effect(() => {
      const total = Math.max(1, Math.ceil(this.filteredAlerts().length / this.rulesPageSize()));
      if (this.rulesPage() > total) this.rulesPage.set(1);
    });
  }

  // ── Rules ────────────────────────────────────────────────────────────

  formatConditionJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  openCreateRule(): void {
    this.ruleForm.reset({
      alertType: 'PriceLevel',
      symbol: '',
      severity: 'Medium',
      cooldownSeconds: 300,
      deduplicationKey: '',
      conditionJson: '{\n  \n}',
      isActive: true,
    });
    this.editingRule.set({});
  }

  openEditRule(a: AlertDto): void {
    this.ruleForm.reset({
      alertType: a.alertType,
      symbol: a.symbol ?? '',
      severity: a.severity,
      cooldownSeconds: a.cooldownSeconds,
      deduplicationKey: a.deduplicationKey ?? '',
      conditionJson: this.formatConditionJson(a.conditionJson),
      isActive: a.isActive,
    });
    this.editingRule.set(a);
  }

  cancelRule(): void {
    this.editingRule.set(null);
  }

  saveRule(): void {
    if (this.ruleForm.invalid) return;
    const v = this.ruleForm.getRawValue();
    const editing = this.editingRule();
    if (!editing) return;

    // Validate JSON before sending — server-side validation will catch it too
    // but the operator gets a faster, clearer error here.
    try {
      JSON.parse(v.conditionJson);
    } catch {
      this.notifications.error('Condition JSON is not valid JSON.');
      return;
    }

    this.busy.set(true);
    const payload: CreateAlertRequest & UpdateAlertRequest = {
      alertType: v.alertType,
      symbol: v.symbol?.trim() || null,
      severity: v.severity,
      cooldownSeconds: v.cooldownSeconds,
      deduplicationKey: v.deduplicationKey?.trim() || null,
      conditionJson: v.conditionJson,
      isActive: v.isActive,
    };

    const op = editing.id
      ? this.alertsService.update(editing.id, payload)
      : this.alertsService.create(payload);

    op.subscribe({
      next: (res) => {
        this.busy.set(false);
        if (res.status) {
          this.notifications.success(editing.id ? 'Rule updated' : 'Rule created');
          this.editingRule.set(null);
          this.loadAlerts();
        } else {
          this.notifications.error(res.message ?? 'Save failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.notifications.error('Save failed');
      },
    });
  }

  toggleActive(a: AlertDto): void {
    this.busy.set(true);
    this.alertsService
      .update(a.id, {
        alertType: a.alertType,
        symbol: a.symbol,
        severity: a.severity,
        cooldownSeconds: a.cooldownSeconds,
        deduplicationKey: a.deduplicationKey,
        conditionJson: a.conditionJson,
        isActive: !a.isActive,
      })
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          if (res.status) {
            this.notifications.success(a.isActive ? 'Rule paused' : 'Rule resumed');
            this.loadAlerts();
          } else {
            this.notifications.error(res.message ?? 'Failed to toggle');
          }
        },
        error: () => this.busy.set(false),
      });
  }

  askDeleteRule(a: AlertDto): void {
    this.pendingDeleteId.set(a.id);
    this.showDeleteDialog.set(true);
  }

  confirmDelete(): void {
    const id = this.pendingDeleteId();
    if (!id) return;
    this.busy.set(true);
    this.alertsService.delete(id).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.showDeleteDialog.set(false);
        if (res.status) {
          this.notifications.success('Rule deleted');
          this.loadAlerts();
        } else {
          this.notifications.error(res.message ?? 'Delete failed');
        }
      },
      error: () => {
        this.busy.set(false);
        this.showDeleteDialog.set(false);
      },
    });
  }

  private loadAlerts(): void {
    this.alertsLoading.set(true);
    // Probe-and-fetch: a 1-row request first reveals the true server total
    // via pager.totalItemCount, then we fetch exactly that many rows so the
    // KPI strip + analytics charts reflect every rule in the database
    // instead of the artificial 200-row cap. Pagination is purely a client-
    // side slice over this full set.
    this.alertsService
      .list({ currentPage: 1, itemCountPerPage: 1 })
      .pipe(catchError(() => of(null)))
      .subscribe((probe) => {
        const total = probe?.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.alerts.set([]);
          this.alertsLoading.set(false);
          return;
        }
        this.alertsService
          .list({ currentPage: 1, itemCountPerPage: total })
          .pipe(catchError(() => of(null)))
          .subscribe((full) => {
            this.alerts.set(full?.data?.data ?? []);
            this.alertsLoading.set(false);
          });
      });
  }

  // ── Channels ─────────────────────────────────────────────────────────

  getValue(key: string): string {
    return this.draftValues()[key] ?? this.configValues()[key] ?? '';
  }

  getBool(key: string): boolean {
    const v = this.getValue(key);
    return v === 'true' || v === '1';
  }

  setField(key: string, evt: Event): void {
    const target = evt.target as HTMLInputElement;
    const value = target.type === 'checkbox' ? String(target.checked) : target.value;
    this.draftValues.update((d) => ({ ...d, [key]: value }));
  }

  isChannelDirty(def: ChannelDef): boolean {
    const drafts = this.draftValues();
    return def.fields.some(
      (f) => f.key in drafts && drafts[f.key] !== (this.configValues()[f.key] ?? ''),
    );
  }

  saveChannel(def: ChannelDef): void {
    const drafts = this.draftValues();
    const allDirty = def.fields.filter(
      (f) => f.key in drafts && drafts[f.key] !== (this.configValues()[f.key] ?? ''),
    );
    if (allDirty.length === 0) return;

    // Engine validator rejects empty values. Two cases:
    //   - Required field cleared → block save and tell the operator.
    //   - Optional field cleared (e.g. SMTP password for an open relay,
    //     webhook shared secret, telegram timeout) → silently skip the
    //     upsert. Sending "" would 400 server-side and abort the whole
    //     batch, which is worse than just leaving the prior value in place.
    const blankRequired = allDirty.filter((f) => f.required && !drafts[f.key]?.length);
    if (blankRequired.length > 0) {
      this.notifications.error(
        `Cannot save empty value for: ${blankRequired.map((b) => b.label).join(', ')}.`,
      );
      return;
    }
    const dirty = allDirty.filter((f) => drafts[f.key]?.length);
    if (dirty.length === 0) {
      this.notifications.warning(
        'Nothing to save — optional fields cleared without other changes are ignored.',
      );
      return;
    }

    // ConfigDataType enum on the engine is { String, Int, Decimal, Bool, Json } —
    // not "Integer" / "Boolean". Mismatched casing is tolerated server-side
    // (Enum.TryParse with ignoreCase=true) but the literal must be one of those.
    const dtFor = (t: ChannelField['type']): 'Int' | 'Bool' | 'String' =>
      t === 'number' ? 'Int' : t === 'checkbox' ? 'Bool' : 'String';

    this.busy.set(true);
    const ops = dirty.map((f) =>
      this.configService.upsert({
        key: f.key,
        value: drafts[f.key] ?? '',
        dataType: dtFor(f.type),
        isHotReloadable: true,
      }),
    );
    forkJoin(ops).subscribe({
      next: () => {
        this.busy.set(false);
        this.notifications.success(`${def.title} saved — changes apply on next worker cycle`);
        // Adopt the saved drafts as the new baseline + drop *all* dirty
        // entries (including the optional-blank ones we silently skipped, so
        // the form stops flagging them dirty). Then refetch masked status.
        this.configValues.update((cv) => {
          const next = { ...cv };
          for (const f of dirty) next[f.key] = drafts[f.key] ?? '';
          return next;
        });
        this.draftValues.update((d) => {
          const next = { ...d };
          for (const f of allDirty) delete next[f.key];
          return next;
        });
        this.refreshChannelStatuses();
      },
      error: () => {
        this.busy.set(false);
        this.notifications.error('Failed to save channel settings');
      },
    });
  }

  testChannel(channel: AlertChannel): void {
    this.busy.set(true);
    this.alertsService.testChannel({ channel }).subscribe({
      next: (res) => {
        this.busy.set(false);
        const data = res.data;
        if (data) {
          const entry = {
            channel: data.channel,
            delivered: data.delivered,
            destination: data.destination,
            attemptedAt: data.attemptedAt,
          };
          this.lastTestResult.set(entry);
          // Prepend so newest is first; cap at 20 to keep the panel tidy.
          this.testHistory.set([entry, ...this.testHistory()].slice(0, 20));
          if (data.delivered) {
            this.notifications.success(`Test sent via ${channel}`);
          } else {
            this.notifications.error(res.message ?? `${channel} test failed`);
          }
        } else {
          this.notifications.error(res.message ?? `${channel} test failed`);
        }
      },
      error: () => {
        this.busy.set(false);
        this.notifications.error(`${channel} test failed`);
      },
    });
  }

  private loadChannels(): void {
    this.channelsLoading.set(true);
    forkJoin({
      status: this.alertsService.getChannelStatus().pipe(catchError(() => of(null))),
      configs: this.configService.getAll().pipe(catchError(() => of(null))),
    }).subscribe(({ status, configs }) => {
      this.channelsLoading.set(false);
      this.channelStatuses.set(status?.data ?? []);
      this.configValues.set(buildConfigMap(configs?.data ?? []));
    });
  }

  private refreshChannelStatuses(): void {
    this.alertsService.getChannelStatus().subscribe({
      next: (res) => this.channelStatuses.set(res.data ?? []),
    });
  }
}

function buildConfigMap(rows: EngineConfigDto[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (r.key) map[r.key] = r.value ?? '';
  }
  return map;
}
