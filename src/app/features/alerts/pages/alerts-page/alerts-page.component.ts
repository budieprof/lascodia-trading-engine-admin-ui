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
import { ConfigService, isQueuedForCoolingOff } from '@core/services/config.service';
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
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import type { EChartsOption } from 'echarts';

/**
 * Every member of the engine's AlertType enum (Domain/Enums/AlertType.cs). Without the last eight,
 * opening an AgentApprovalRequired or RoleBuildSkew rule showed an empty type select.
 */
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
  'IntermediateRewardCalibrationDrift',
  'AutoTuneProposalAvailable',
  'RoleBuildSkew',
  'AgentApprovalRequired',
  'ScriptAlert',
  'ScriptPositionsOrphaned',
  'ChartAlert',
  'ScriptParityDrift',
  'SurveillanceAlert',
];

const SEVERITIES: AlertSeverity[] = ['Info', 'Medium', 'High', 'Critical'];

/** Severity-mix panel order and colours (Critical red, High amber — matching the pills). */
const SEVERITY_DISPLAY_ORDER: AlertSeverity[] = ['Critical', 'High', 'Medium', 'Info'];
const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  Critical: '#FF3B30',
  High: '#FF9500',
  Medium: '#0A84FF',
  Info: '#8E8E93',
};

const NUMBER_FMT = new Intl.NumberFormat('en-US');

export interface ChannelDef {
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

export interface ChannelField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'checkbox' | 'select';
  hint?: string;
  required?: boolean;
  /** `select` only: the values offered. The first option of the list is NOT implied — an unset key shows "Default (…)". */
  options?: readonly string[];
  /** The engine's compiled default, shown while the key has no saved value. */
  defaultValue?: string;
}

/**
 * The delivery policy of an outbound channel (engine `Alert:Delivery:{Channel}:*`, 2026-10-29): which severities are
 * sent, which wait for a digest, how many may go out an hour, and whether a still-active alert is repeated only as a
 * reminder (after 1 h, 2 h, 4 h … then once a day). Every alert is still recorded on this page whatever these say.
 */
export function deliveryPolicyFields(
  channel: 'Email' | 'Webhook' | 'Telegram',
  d: { min: string; immediate: string; digest: number; perHour: number },
): ChannelField[] {
  const key = (k: string) => `Alert:Delivery:${channel}:${k}`;
  return [
    {
      key: key('MinSeverity'),
      label: 'Send alerts from',
      type: 'select',
      options: SEVERITIES,
      defaultValue: d.min,
      hint: 'Less severe alerts are recorded here but not sent on this channel.',
    },
    {
      key: key('ImmediateMinSeverity'),
      label: 'Send straight away from',
      type: 'select',
      options: SEVERITIES,
      defaultValue: d.immediate,
      hint: 'Less severe ones wait for the digest (when a digest interval is set).',
    },
    {
      key: key('DigestMinutes'),
      label: 'Digest every (minutes)',
      type: 'number',
      defaultValue: String(d.digest),
      hint: 'One message listing the alerts queued since the last one. 0 = no digest.',
    },
    {
      key: key('MaxPerHour'),
      label: 'At most per hour',
      type: 'number',
      defaultValue: String(d.perHour),
      hint: 'Messages sent straight away per hour; past it they go in the digest. 0 = no limit.',
    },
    {
      key: key('Reminders'),
      label: 'Repeat a still-active alert only as a reminder (1 h, 2 h, 4 h … then daily)',
      type: 'checkbox',
      defaultValue: 'true',
    },
    {
      key: key('ResolvedNotices'),
      label: 'Say when an alert this channel announced has cleared',
      type: 'checkbox',
      defaultValue: 'true',
    },
  ];
}

export const CHANNEL_DEFS: ChannelDef[] = [
  {
    // Contract C2 (2026-10-09): delivered inside this admin UI — nothing to set up, only the on/off switch
    // (InAppAlertOptions:IsEnabled). Chart alerts and script alert bindings can choose it.
    channel: 'InApp',
    title: 'In app',
    description:
      'Shows chart and script alerts inside this admin UI: a pop-up (with an optional sound and browser notification, set in the notification bell) and an entry in the bell. Switching it off silences it for every operator; those deliveries are recorded as not sent.',
    fields: [],
  },
  {
    channel: 'Email',
    title: 'Email (SMTP)',
    description:
      'Sends alerts as plain-text email. By default only Critical alerts go out straight away (at most 6 an hour); Medium and High ones are collected into one digest email an hour. Tick "Use the platform mail service" to send through the same mail service as sign-up email, so no SMTP account is needed here.',
    fields: [
      {
        key: 'EmailAlertOptions:UsePlatformMailRelay',
        label: 'Use the platform mail service (the one sign-up email uses)',
        type: 'checkbox',
        defaultValue: 'false',
        hint: 'Then only the To address is needed below.',
      },
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
      ...deliveryPolicyFields('Email', {
        min: 'Medium',
        immediate: 'Critical',
        digest: 60,
        perHour: 6,
      }),
    ],
  },
  {
    channel: 'Webhook',
    title: 'Webhook',
    description:
      'Add the URL that should receive alerts here — nothing is sent until one is set. Each alert is POSTed as JSON (alertId, symbol, alertType, severity, kind, message, timestamp). Set a signing secret so the receiver can check each request with the X-Lascodia-Signature header.',
    fields: [
      {
        key: 'WebhookAlertOptions:Url',
        label: 'Webhook URL',
        type: 'text',
        required: true,
        hint: 'https://… — the address that should receive alerts',
      },
      { key: 'WebhookAlertOptions:TimeoutSeconds', label: 'Timeout (s)', type: 'number' },
      {
        key: 'WebhookAlertOptions:SharedSecret',
        label: 'Signing secret',
        type: 'password',
        hint: 'Signs every request (X-Lascodia-Timestamp + X-Lascodia-Signature). Leave blank to send unsigned.',
      },
      ...deliveryPolicyFields('Webhook', { min: 'Info', immediate: 'Info', digest: 0, perHour: 0 }),
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
      ...deliveryPolicyFields('Telegram', {
        min: 'Info',
        immediate: 'Info',
        digest: 0,
        perHour: 0,
      }),
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
    ErrorStateComponent,
    ChartCardComponent,
    MetricCardComponent,
    RelativeTimePipe,
    ModalA11yDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <app-page-header title="Alerts" subtitle="Rules and notification channels" />

      <ui-tabs [tabs]="tabs" [(activeTab)]="activeTab">
        <!-- ── Rules tab ─────────────────────────────────────────────── -->
        @if (activeTab() === 'rules') {
          <!-- 8-tile KPI strip (4 × 2) — fleet-wide rule roll-ups -->
          <div class="alerts-kpis">
            <app-metric-card
              label="Total rules"
              [value]="alerts().length"
              dotColor="#0071E3"
              [caption]="typeCount() + ' alert types'"
            />
            <app-metric-card
              label="Active"
              [value]="ruleStats().active"
              [dotColor]="ruleStats().active > 0 ? '#34C759' : ''"
              [caption]="pct(ruleStats().active, alerts().length) + ' of rules open'"
            />
            <!-- Inactive rows are almost all incidents the engine raised and then auto-resolved
                 (AutoResolvedAt set) — they used to be counted as "Paused" (1,376 of them). -->
            <app-metric-card
              label="Resolved / paused"
              [value]="ruleStats().resolved"
              [displayValue]="fmtN(ruleStats().resolved) + ' / ' + fmtN(ruleStats().paused)"
              [caption]="'auto-resolved / by an operator'"
            />
            <app-metric-card
              label="Critical"
              [value]="ruleStats().critical"
              [dotColor]="ruleStats().critical > 0 ? '#FF3B30' : ''"
              [caption]="pct(ruleStats().critical, alerts().length) + ' of rules'"
            />
            <app-metric-card
              label="High"
              [value]="ruleStats().high"
              [dotColor]="ruleStats().high > 0 ? '#FF9500' : ''"
              [caption]="pct(ruleStats().high, alerts().length) + ' of rules'"
            />
            <app-metric-card
              label="Medium / Info"
              [value]="ruleStats().mediumOrInfo"
              [caption]="pct(ruleStats().mediumOrInfo, alerts().length) + ' of rules'"
            />
            <app-metric-card
              label="Symbols covered"
              [value]="ruleStats().symbolCount"
              [caption]="'+ ' + fmtN(systemWideCount()) + ' system-wide rules'"
            />
            <app-metric-card
              label="Triggered < 1h"
              [value]="ruleStats().recentlyTriggered"
              [dotColor]="ruleStats().recentlyTriggered > 0 ? '#FF3B30' : ''"
              [caption]="
                latestTriggeredAt()
                  ? 'latest ' + (latestTriggeredAt() | relativeTime)
                  : 'no firings yet'
              "
            />
          </div>

          <!-- 3-col row: severity mix + by symbol + by alert type -->
          <div class="alerts-charts">
            <section class="sev-panel">
              <header class="sev-panel-head">
                <h3>Severity mix</h3>
                <p>Share of rules by severity, and how many are still active</p>
              </header>
              @if (alerts().length > 0) {
                <div class="sev-body">
                  <div class="sev-headline">
                    <span class="sev-big">{{ fmtN(alerts().length) }}</span>
                    <span class="sev-big-label">rules</span>
                  </div>
                  <div class="sev-stack" role="img" [attr.aria-label]="severitySubtitle()">
                    @for (row of severityMix(); track row.severity) {
                      <span
                        [style.width.%]="row.share"
                        [style.background]="row.color"
                        [title]="row.severity + ': ' + fmtN(row.count)"
                      ></span>
                    }
                  </div>
                  <ul class="sev-rows">
                    @for (row of severityMix(); track row.severity) {
                      <li>
                        <span class="sev-dot" [style.background]="row.color"></span>
                        <span class="sev-name">{{ row.severity }}</span>
                        <span class="sev-track">
                          <i [style.width.%]="row.share" [style.background]="row.color"></i>
                        </span>
                        <span class="sev-count">{{ fmtN(row.count) }}</span>
                        <span class="sev-pct">{{ pct(row.count, alerts().length) }}</span>
                      </li>
                    }
                  </ul>
                  <div class="sev-foot">
                    <div class="open-track">
                      <i [style.width.%]="(ruleStats().active / alerts().length) * 100"></i>
                    </div>
                    <div class="open-legend">
                      <span
                        ><b>{{ fmtN(ruleStats().active) }}</b> active</span
                      >
                      <span
                        ><b>{{ fmtN(alerts().length - ruleStats().active) }}</b> resolved or
                        paused</span
                      >
                    </div>
                  </div>
                </div>
              } @else {
                <p class="sev-empty">No rules yet.</p>
              }
            </section>
            <app-chart-card
              title="Rules by symbol"
              [subtitle]="bySymbolSubtitle()"
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

          <!-- Recently triggered feed — a fixed count of rows, no scroll box
               (the old 320px box showed seven rows and half of an eighth). Each
               row opens the rule's editor, like the old "Open" button did. -->
          @if (recentlyTriggered().length > 0) {
            <section class="recent-trig">
              <header class="rt-head">
                <h3>Recently triggered</h3>
                <span class="muted">
                  Last {{ recentlyTriggered().length }} firing{{
                    recentlyTriggered().length === 1 ? '' : 's'
                  }}
                  — newest first · click to open
                </span>
              </header>
              <ul class="rt-list">
                @for (a of recentlyTriggered(); track a.id) {
                  <li>
                    <button type="button" class="rt-item" (click)="openEditRule(a)">
                      <span class="rt-sev">
                        <span class="pill" [attr.data-sev]="a.severity">{{ a.severity }}</span>
                      </span>
                      <span class="rt-type">{{ a.alertType }}</span>
                      <span class="rt-symbol" [class.sys]="!a.symbol">{{
                        a.symbol ?? 'System-wide'
                      }}</span>
                      <span class="rt-cond" [title]="summarizeCondition(a.conditionJson)">{{
                        summarizeCondition(a.conditionJson)
                      }}</span>
                      <span class="rt-time">
                        {{ a.lastTriggeredAt ? (a.lastTriggeredAt | relativeTime) : '—' }}
                      </span>
                      <span class="rt-cd">cooldown {{ fmtDuration(a.cooldownSeconds) }}</span>
                      <span class="rt-open">Open ›</span>
                    </button>
                  </li>
                }
              </ul>
            </section>
          }

          <section class="rules-toolbar">
            <input
              type="search"
              class="input rules-search"
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
              <option value="resolved">Auto-resolved</option>
              <option value="paused">Paused by an operator</option>
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
          } @else if (alertsError()) {
            <!-- A failed read is not "No alert rules — create one". -->
            <app-error-state
              title="Could not load alert rules"
              [message]="alertsError()!"
              (retry)="loadAlerts()"
            />
          } @else if (filteredAlerts().length > 0) {
            <div class="rules-table-wrap">
              <table class="rules-table">
                <thead>
                  <tr>
                    <th class="col-sev">Severity</th>
                    <th class="col-type">Rule type</th>
                    <th class="col-scope">Scope</th>
                    <th>Condition</th>
                    <th class="col-num">Cooldown</th>
                    <th class="col-when">Last triggered</th>
                    <th class="col-status">Status</th>
                    <th class="col-actions"><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (a of pagedAlerts(); track a.id) {
                    <tr [class.inactive]="!a.isActive">
                      <td class="col-sev">
                        <span class="pill" [attr.data-sev]="a.severity">{{ a.severity }}</span>
                      </td>
                      <td class="col-type">
                        <span class="rule-type" [title]="a.alertType">{{ a.alertType }}</span>
                      </td>
                      <td class="col-scope">
                        @if (a.symbol) {
                          <span class="scope-sym">{{ a.symbol }}</span>
                        } @else {
                          <span class="scope-sys">System-wide</span>
                        }
                      </td>
                      <!-- One-line human summary of the condition; the raw JSON
                           is behind a toggle. Nine thousand cards each carrying a
                           clipped JSON blob was unreadable. -->
                      <td class="col-cond">
                        <div class="condition-row">
                          <span
                            class="condition-summary"
                            [title]="summarizeCondition(a.conditionJson)"
                          >
                            {{ summarizeCondition(a.conditionJson) }}
                          </span>
                          <button
                            type="button"
                            class="link-btn"
                            (click)="toggleJson(a.id)"
                            [attr.aria-expanded]="isJsonOpen(a.id)"
                          >
                            {{ isJsonOpen(a.id) ? 'Hide JSON' : 'JSON' }}
                          </button>
                        </div>
                        @if (a.deduplicationKey) {
                          <span class="dedup" [title]="'Dedup key: ' + a.deduplicationKey">
                            {{ a.deduplicationKey }}
                          </span>
                        }
                      </td>
                      <td class="col-num">{{ fmtDuration(a.cooldownSeconds) }}</td>
                      <td class="col-when" [title]="a.lastTriggeredAt ?? 'never'">
                        @if (a.lastTriggeredAt) {
                          {{ a.lastTriggeredAt | relativeTime }}
                        } @else {
                          <span class="dim">never</span>
                        }
                      </td>
                      <td class="col-status">
                        @if (a.isActive) {
                          <span class="status-dot on">Active</span>
                        } @else if (a.autoResolvedAt) {
                          <span
                            class="status-dot"
                            [title]="
                              'Auto-resolved by the engine ' + (a.autoResolvedAt | relativeTime)
                            "
                            >Resolved</span
                          >
                        } @else {
                          <span class="status-dot paused">Paused</span>
                        }
                      </td>
                      <td class="col-actions">
                        <span class="row-actions">
                          <button class="row-btn" (click)="openEditRule(a)">Edit</button>
                          <!-- An auto-resolved incident is closed, not paused: there is nothing to resume
                               (the engine raises a fresh one if the condition returns). -->
                          @if (a.isActive || !a.autoResolvedAt) {
                            <button
                              class="row-btn"
                              (click)="askToggleActive(a)"
                              [disabled]="busy()"
                            >
                              {{ a.isActive ? 'Pause' : 'Resume' }}
                            </button>
                          }
                          <button
                            class="row-btn danger"
                            (click)="askDeleteRule(a)"
                            [disabled]="busy()"
                          >
                            Delete
                          </button>
                        </span>
                      </td>
                    </tr>
                    @if (isJsonOpen(a.id)) {
                      <tr class="json-row">
                        <td colspan="8">
                          <pre class="condition mono">{{
                            formatConditionJson(a.conditionJson)
                          }}</pre>
                        </td>
                      </tr>
                    }
                  }
                </tbody>
              </table>
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
                aria-label="Rules per page"
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
            <!-- 6-card KPI strip — channel + outbound-alert posture.
                 "Enabled" is the number that matters for delivery: a channel
                 can be fully configured and switched off. -->
            <div class="alerts-kpis ch-kpis">
              <div class="alerts-kpi">
                <span class="kpi-label">Channels</span>
                <span class="kpi-value">{{ channelDefs.length }}</span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Configured</span>
                <span class="kpi-value">{{ channelKpis().configured }}</span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Delivering</span>
                <span
                  class="kpi-value"
                  [class.good]="channelKpis().enabled > 0"
                  [class.warn]="channelKpis().enabled === 0"
                >
                  {{ channelKpis().enabled }}
                </span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Active rules</span>
                <span class="kpi-value">{{ ruleStats().active }}</span>
              </div>
              <div class="alerts-kpi">
                <span class="kpi-label">Unsaved changes</span>
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
                Channels are global — every triggered alert broadcasts to every channel that is
                configured <em>and</em> switched on. Settings are stored as engine config keys;
                changes take effect on the next worker cycle without an engine restart.
              </p>
              <div class="ch-actions">
                <button
                  class="btn btn-ghost"
                  (click)="testAllChannels()"
                  [disabled]="channelKpis().enabled === 0 || busy()"
                  title="Send a test alert to every channel that is configured and switched on"
                >
                  Test all delivering
                </button>
              </div>
            </section>

            <!-- Test history feed — chronological list of recent test attempts -->
            @if (testHistory().length > 0) {
              <section class="ch-history">
                <header class="ch-history-head">
                  <h3>Test history</h3>
                  <span class="muted">
                    Last {{ testHistory().length }} test attempt{{
                      testHistory().length === 1 ? '' : 's'
                    }}
                    — newest first
                  </span>
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
                  <!-- Title, state pill and switch share one row; the
                       description gets the full card width beneath instead
                       of being squeezed into ~250px beside the toggle. -->
                  <header class="channel-head">
                    <div class="channel-head-row">
                      <h4>{{ def.title }}</h4>
                      <span class="pill" [attr.data-state]="channelState(def.channel)">
                        {{ channelStateLabel(def.channel) }}
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
                    <p class="channel-desc muted">{{ def.description }}</p>
                  </header>

                  @if (channelStatus(def.channel); as s) {
                    @if (s.destinationPreview) {
                      <div class="channel-preview mono">{{ s.destinationPreview }}</div>
                    }
                  }

                  <!-- Inline completeness indicator: required-fields fill % +
                       optional pending-changes badge. Lets the operator see
                       at a glance whether a save will go through. Not for a
                       channel with nothing to set up (In app read "0 / 0
                       required" under a full green bar, and "Timeout 0s"). -->
                  @if (def.fields.length > 0) {
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
                        Timeout
                        {{
                          fmtDuration(
                            $safeNavigationMigration(channelStatus(def.channel)?.timeoutSeconds)
                          )
                        }}
                      </span>
                    </div>
                  }

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
                            [checked]="getBool(f.key, f.defaultValue)"
                            (change)="setField(f.key, $event)"
                          />
                        } @else if (f.type === 'select') {
                          <select
                            class="input"
                            [value]="getValue(f.key)"
                            (change)="setField(f.key, $event)"
                            [attr.aria-label]="f.label"
                          >
                            <option value="">Default ({{ f.defaultValue }})</option>
                            @for (o of f.options ?? []; track o) {
                              <option [value]="o" [selected]="getValue(f.key) === o">
                                {{ o }}
                              </option>
                            }
                          </select>
                        } @else {
                          <input
                            class="input"
                            [type]="f.type"
                            [value]="getValue(f.key)"
                            (input)="setField(f.key, $event)"
                            [attr.placeholder]="
                              f.defaultValue !== undefined
                                ? 'Default: ' + f.defaultValue
                                : (f.hint ?? null)
                            "
                            autocomplete="off"
                            [attr.aria-label]="f.label"
                          />
                        }
                        @if (f.hint) {
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
      <!-- Escape + focus come from appModalA11y; the modal used to ignore Escape entirely. -->
      @if (editingRule(); as draft) {
        <div class="modal-backdrop" (click)="cancelRule()">
          <div
            class="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="alert-rule-modal-title"
            appModalA11y
            (dismiss)="cancelRule()"
            (click)="$event.stopPropagation()"
          >
            <header class="modal-head">
              <h3 id="alert-rule-modal-title">
                {{ draft.id ? 'Edit alert rule' : 'New alert rule' }}
              </h3>
              <button class="btn-close" (click)="cancelRule()" aria-label="Close">×</button>
            </header>

            <form [formGroup]="ruleForm" (ngSubmit)="saveRule()" class="rule-form">
              <div class="form-row">
                <label class="field">
                  <span class="field-label">Alert type<span class="req">*</span></span>
                  <select class="input" formControlName="alertType">
                    @for (t of alertTypeOptions(); track t) {
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

      <!-- Pausing a rule or switching a channel off silences alerts; both ask first. -->
      <app-confirm-dialog
        [open]="pendingConfirm() !== null"
        [title]="pendingConfirm()?.title ?? ''"
        [message]="pendingConfirm()?.message ?? ''"
        [confirmLabel]="pendingConfirm()?.confirmLabel ?? 'Confirm'"
        confirmVariant="destructive"
        [loading]="busy() || togglingChannel() !== null"
        (confirm)="runPendingConfirm()"
        (cancelled)="pendingConfirm.set(null)"
      />

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
  styleUrls: ['./alerts-page.component.scss', './alerts-page.rules.scss'],
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
  readonly alertsError = signal<string | null>(null);
  readonly busy = signal(false);

  readonly search = signal('');
  readonly statusFilter = signal<'all' | 'active' | 'resolved' | 'paused'>('all');

  /** Types offered by the editor: the engine's enum plus anything present in the data. */
  readonly alertTypeOptions = computed<string[]>(() => {
    const set = new Set<string>(ALERT_TYPES);
    for (const a of this.alerts()) set.add(a.alertType);
    const draftType = this.editingRule()?.alertType;
    if (draftType) set.add(draftType);
    return [...set];
  });

  /** A silencing action (pause a rule, switch a channel off) waiting on the confirm dialog. */
  readonly pendingConfirm = signal<{
    title: string;
    message: string;
    confirmLabel: string;
    run: () => void;
  } | null>(null);
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
      if (st === 'resolved' && (a.isActive || !a.autoResolvedAt)) return false;
      if (st === 'paused' && (a.isActive || !!a.autoResolvedAt)) return false;
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
    let resolved = 0;
    let critical = 0;
    let high = 0;
    let mediumOrInfo = 0;
    let recentlyTriggered = 0;
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const a of all) {
      if (a.isActive) active++;
      else if (a.autoResolvedAt) resolved++;
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
      /** Inactive because the engine auto-resolved the incident. */
      resolved,
      /** Inactive with no auto-resolve stamp — switched off by an operator. */
      paused: all.length - active - resolved,
      critical,
      high,
      mediumOrInfo,
      symbolCount: symbols.size,
      recentlyTriggered,
    };
  });

  /**
   * The severity-mix panel (replaces the donut): one row per severity present, in
   * Critical → Info order, with its count and share of all rules.
   */
  readonly severityMix = computed(() => {
    const counts: Record<string, number> = { Critical: 0, High: 0, Medium: 0, Info: 0 };
    for (const a of this.alerts()) counts[a.severity] = (counts[a.severity] ?? 0) + 1;
    const total = this.alerts().length;
    return SEVERITY_DISPLAY_ORDER.filter((sev) => counts[sev] > 0).map((sev) => ({
      severity: sev,
      count: counts[sev],
      share: total > 0 ? (counts[sev] / total) * 100 : 0,
      color: SEVERITY_COLOR[sev],
    }));
  });

  /** Distinct alert types among the rules — the "Total rules" tile caption. */
  readonly typeCount = computed(() => new Set(this.alerts().map((a) => a.alertType)).size);

  /** Rules with no symbol (fleet-wide) — not counted by "Symbols covered". */
  readonly systemWideCount = computed(() => this.alerts().filter((a) => !a.symbol).length);

  /** Newest firing across all rules, for the "Triggered < 1h" caption. */
  readonly latestTriggeredAt = computed(() => this.recentlyTriggered()[0]?.lastTriggeredAt ?? '');

  fmtN(n: number): string {
    return NUMBER_FMT.format(n);
  }

  pct(n: number, total: number): string {
    if (total <= 0) return '0%';
    const p = (n / total) * 100;
    return p > 0 && p < 1 ? '<1%' : `${p.toFixed(0)}%`;
  }

  bySymbolOptions = computed<EChartsOption>(() => {
    const map: Record<string, number> = {};
    for (const a of this.alerts()) {
      // System-wide (null-symbol) rules are not a symbol; the "Symbols
      // covered" tile does not count them, so the chart must not either.
      if (!a.symbol) continue;
      map[a.symbol] = (map[a.symbol] ?? 0) + 1;
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
      .slice(0, 8),
  );

  /** Lists only the severities that actually have rules, so the legend and the subtitle agree. */
  severitySubtitle = computed(() => {
    const present = new Set(this.alerts().map((a) => a.severity));
    const ordered = ['Critical', 'High', 'Medium', 'Info'].filter((s) =>
      present.has(s as AlertSeverity),
    );
    return ordered.length > 0 ? ordered.join(' · ') : 'No rules yet';
  });

  bySymbolSubtitle = computed(() => {
    const systemWide = this.alerts().filter((a) => !a.symbol).length;
    return systemWide > 0
      ? `Top 10 symbols by rule count · ${new Intl.NumberFormat('en-US').format(systemWide)} system-wide rules not shown`
      : 'Top 10 symbols by rule count';
  });

  // ── Rule-card helpers ─────────────────────────────────────────────────
  /** Rule IDs whose raw condition JSON is expanded. */
  readonly openJson = signal<Set<number>>(new Set());

  isJsonOpen(id: number): boolean {
    return this.openJson().has(id);
  }

  toggleJson(id: number): void {
    const next = new Set(this.openJson());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.openJson.set(next);
  }

  /**
   * A one-line reading of a rule's condition. Detector payloads are small
   * objects; the two or three keys an operator needs are pulled out, and
   * anything unfamiliar becomes "key: value" pairs. The raw JSON stays one
   * click away.
   */
  summarizeCondition(json: string): string {
    let c: Record<string, unknown>;
    try {
      c = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return json.length > 120 ? json.slice(0, 120) + '…' : json;
    }
    if (c == null || typeof c !== 'object') return String(c);
    if (typeof c['WorkerName'] === 'string') {
      const elapsed = c['ElapsedSeconds'];
      return typeof elapsed === 'number'
        ? `${c['WorkerName']} · stale for ${this.fmtDuration(elapsed)}`
        : String(c['WorkerName']);
    }
    if (typeof c['reason'] === 'string') {
      const parts: string[] = [c['reason'] as string];
      if (typeof c['modelId'] === 'number') parts.push(`model #${c['modelId']}`);
      if (typeof c['timeframe'] === 'string') parts.push(c['timeframe'] as string);
      if (typeof c['consecutiveSkips'] === 'number') parts.push(`${c['consecutiveSkips']} skips`);
      return parts.join(' · ');
    }
    if (typeof c['price'] === 'number') {
      return `${c['direction'] ?? 'crosses'} ${c['price']}`;
    }
    const entries = Object.entries(c);
    if (entries.length === 0) return 'No condition — fires on every evaluation';
    return entries
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
  }

  /** "90s" / "5m" / "6h" / "24h" — cooldowns and timeouts as durations, not raw seconds. */
  fmtDuration(seconds: number | null | undefined): string {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    if (s < 3600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
    if (s < 86_400) {
      const h = Math.floor(s / 3600);
      const m = Math.round((s % 3600) / 60);
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    const d = Math.floor(s / 86_400);
    const h = Math.round((s % 86_400) / 3600);
    return h === 0 ? `${d}d` : `${d}d ${h}h`;
  }

  /** 'on' configured + enabled · 'disabled' configured but switched off · 'off' not configured. */
  channelState(c: AlertChannel): 'on' | 'disabled' | 'off' {
    const s = this.channelStatus(c);
    if (!s?.isConfigured) return 'off';
    return s.isEnabled === false ? 'disabled' : 'on';
  }

  channelStateLabel(c: AlertChannel): string {
    switch (this.channelState(c)) {
      case 'on':
        return 'Configured';
      case 'disabled':
        return 'Configured · off';
      default:
        return 'Not configured';
    }
  }

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
  // forgets the previous attempt every time you click Send test). Kept in
  // sessionStorage so leaving the page and coming back does not erase the
  // Email test that was sent two minutes ago.
  readonly testHistory = signal<
    {
      channel: AlertChannel;
      delivered: boolean;
      destination: string;
      attemptedAt: string;
    }[]
  >(readTestHistory());

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

    // Switching a channel OFF silences every alert on it for every operator — ask first.
    // The checkbox flips back until the operator confirms.
    if (!requested) {
      target.checked = true;
      this.pendingConfirm.set({
        title: `Switch the ${channel} channel off?`,
        message: `No alert is delivered through ${channel} until it is switched back on — for every operator. Credentials are kept.`,
        confirmLabel: 'Switch off',
        run: () => this.setChannelEnabled(channel, false),
      });
      return;
    }
    this.setChannelEnabled(channel, true);
  }

  private setChannelEnabled(channel: AlertChannel, requested: boolean): void {
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
        this.pendingConfirm.set(null);
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
        this.pendingConfirm.set(null);
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
    let enabled = 0;
    let dirtyChannels = 0;
    for (const def of this.channelDefs) {
      const s = this.channelStatus(def.channel);
      if (s?.isConfigured) {
        configured++;
        if (s.isEnabled !== false) enabled++;
      }
      if (this.isChannelDirty(def)) dirtyChannels++;
    }
    return {
      configured,
      /** Configured AND switched on — the channels that will actually deliver. */
      enabled,
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
      if (this.channelState(def.channel) === 'on') {
        this.testChannel(def.channel);
      }
    }
  }

  clearTestHistory(): void {
    this.testHistory.set([]);
    writeTestHistory([]);
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

  /** Pause asks first (it silences the rule); Resume is one click. */
  askToggleActive(a: AlertDto): void {
    if (!a.isActive) {
      this.toggleActive(a);
      return;
    }
    this.pendingConfirm.set({
      title: `Pause ${a.alertType}${a.symbol ? ' · ' + a.symbol : ''}?`,
      message:
        'The engine stops evaluating this rule and sends no further notifications for it until it is resumed.',
      confirmLabel: 'Pause rule',
      run: () => this.toggleActive(a),
    });
  }

  runPendingConfirm(): void {
    const p = this.pendingConfirm();
    if (!p || this.busy() || this.togglingChannel() !== null) return;
    p.run();
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
          this.pendingConfirm.set(null);
          if (res.status) {
            this.notifications.success(a.isActive ? 'Rule paused' : 'Rule resumed');
            this.loadAlerts();
          } else {
            this.notifications.error(res.message ?? 'Failed to toggle');
          }
        },
        error: () => {
          this.busy.set(false);
          this.pendingConfirm.set(null);
        },
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

  loadAlerts(): void {
    this.alertsLoading.set(true);
    this.alertsError.set(null);
    const failed = (msg?: string | null) => {
      this.alertsError.set(msg || 'The engine did not return the alert list.');
      this.alertsLoading.set(false);
    };
    // Probe-and-fetch: a 1-row request first reveals the true server total
    // via pager.totalItemCount, then we fetch exactly that many rows so the
    // KPI strip + analytics charts reflect every rule in the database
    // instead of the artificial 200-row cap. Pagination is purely a client-
    // side slice over this full set. A failure used to become [] and render
    // "No alert rules — create one".
    this.alertsService
      .list({ currentPage: 1, itemCountPerPage: 1 })
      .pipe(catchError(() => of(null)))
      .subscribe((probe) => {
        if (!probe?.status) return failed(probe?.message);
        const total = probe.data?.pager?.totalItemCount ?? 0;
        if (total === 0) {
          this.alerts.set([]);
          this.alertsLoading.set(false);
          return;
        }
        this.alertsService
          .list({ currentPage: 1, itemCountPerPage: total, sortBy: 'id', sortDirection: 'desc' })
          .pipe(catchError(() => of(null)))
          .subscribe((full) => {
            if (!full?.status) return failed(full?.message);
            this.alerts.set(sortAlerts(full.data?.data ?? []));
            this.alertsLoading.set(false);
          });
      });
  }

  // ── Channels ─────────────────────────────────────────────────────────

  getValue(key: string): string {
    return this.draftValues()[key] ?? this.configValues()[key] ?? '';
  }

  getBool(key: string, defaultValue?: string): boolean {
    const v = this.getValue(key) || defaultValue || '';
    return v === 'true' || v === '1';
  }

  setField(key: string, evt: Event): void {
    const target = evt.target as HTMLInputElement | HTMLSelectElement;
    const value =
      target instanceof HTMLInputElement && target.type === 'checkbox'
        ? String(target.checked)
        : target.value;
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
      next: (results) => {
        this.busy.set(false);
        // HTTP 200 does not mean applied: a row can be refused (status false) or queued for the
        // cooling-off period. Saying "saved" for those left the form claiming a change the engine
        // never made.
        const refused = results.filter((r) => !r.status);
        if (refused.length > 0) {
          this.notifications.error(
            `${def.title}: ${refused.length} of ${results.length} change(s) refused — ` +
              (refused[0].message ?? 'the engine did not accept them'),
          );
          return;
        }
        const queued = results.filter((r) => isQueuedForCoolingOff(r));
        if (queued.length > 0) {
          this.notifications.info(queued[0].message ?? `${def.title}: queued for cooling-off`);
        } else {
          this.notifications.success(`${def.title} saved — changes apply on next worker cycle`);
        }
        // Adopt the APPLIED drafts as the new baseline (a queued one is not live until its
        // cooling-off elapses, so its field keeps the live value) + drop *all* dirty entries
        // (including the optional-blank ones we silently skipped, so the form stops flagging
        // them dirty). Then refetch masked status.
        this.configValues.update((cv) => {
          const next = { ...cv };
          dirty.forEach((f, i) => {
            if (!isQueuedForCoolingOff(results[i])) next[f.key] = drafts[f.key] ?? '';
          });
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
          const history = [entry, ...this.testHistory()].slice(0, 20);
          this.testHistory.set(history);
          writeTestHistory(history);
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

type TestHistoryEntry = {
  channel: AlertChannel;
  delivered: boolean;
  destination: string;
  attemptedAt: string;
};

const TEST_HISTORY_KEY = 'lascodia.alert-channel-tests';

function readTestHistory(): TestHistoryEntry[] {
  try {
    const raw = sessionStorage.getItem(TEST_HISTORY_KEY);
    return raw ? (JSON.parse(raw) as TestHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeTestHistory(entries: TestHistoryEntry[]): void {
  try {
    sessionStorage.setItem(TEST_HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* best-effort */
  }
}

/**
 * Active first, then the most recently fired, then the newest id. The engine sorts the list by
 * IsActive alone, so the order inside each group was whatever Postgres returned.
 */
function sortAlerts(rows: AlertDto[]): AlertDto[] {
  return [...rows].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    const ta = a.lastTriggeredAt ?? '';
    const tb = b.lastTriggeredAt ?? '';
    if (ta !== tb) return ta === '' ? 1 : tb === '' ? -1 : tb.localeCompare(ta);
    return b.id - a.id;
  });
}

function buildConfigMap(rows: EngineConfigDto[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (r.key) map[r.key] = r.value ?? '';
  }
  return map;
}
