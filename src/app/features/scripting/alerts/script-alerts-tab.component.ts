import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, forkJoin, map, of } from 'rxjs';

import type { AlertChannel, AlertChannelStatusDto, StrategyDto } from '@core/api/api.types';
import type { ScriptAlertDeliveryDto } from '@core/api/alerts.types';
import { NotificationService } from '@core/notifications/notification.service';
import { AlertsService } from '@core/services/alerts.service';
import { ConfigService } from '@core/services/config.service';
import { ScriptingService } from '@core/services/scripting.service';

import { ScriptStrategyService } from '../api/script-strategy.service';
import type { ScriptCompileResult, ScriptStrategyFields } from '../api/scripting-api.types';
import { describeFailure, isOk } from '../shared/api-error';
import { scriptSourceOf } from '../shared/script-strategy';
import {
  ALERT_CHANNELS,
  DEFAULT_STORM_GUARD,
  FREQUENCY_OPTIONS,
  alertRowsDiffer,
  buildAlertRows,
  channelChip,
  channelLabel,
  channelWarnings,
  deliveryAlertTitle,
  deliveryStatusLabel,
  extractAlertConditions,
  extractPlots,
  insertAt,
  placeholderGroupsFor,
  renderSampleMessage,
  rowTitle,
  scriptKind,
  stormGuardText,
  strategyConditionWarning,
  toAlertBindings,
  validateRow,
  type AlertConditionScan,
  type AlertRow,
  type PlaceholderGroup,
  type PlotInfo,
  type ScriptAlertBindingView,
  type StormGuard,
} from './alerts.model';

const KIND_LABELS: Record<AlertRow['kind'], string> = {
  condition: 'alertcondition',
  'alert-calls': 'alert()',
  'order-fills': 'Order fills',
};

const KIND_HINTS: Record<AlertRow['kind'], string> = {
  condition: 'Fires when this alertcondition() is true, as often as its trigger allows.',
  'alert-calls':
    'Every alert() the script calls, with the text the script passes — and the frequency it sets (alert.freq_*).',
  'order-fills':
    'Every order the strategy fills (entries, exits, reversals). The strategy.order placeholders describe the fill.',
};

/** One channel's answer to "Send test". */
interface TestOutcome {
  channel: AlertChannel;
  state: 'sending' | 'sent' | 'not-sent';
  text: string;
}

interface RowTest {
  message: string;
  outcomes: TestOutcome[];
}

/**
 * Alerts tab of a script strategy (§10 `GET|PUT strategy/{id}/script/alerts`): one row per
 * alertcondition title (read from the compiled script), plus alert() calls and order fills — each
 * with an enable switch, channels, a webhook URL when Webhook is chosen and a message template
 * with a Pine placeholder picker. PE-I10 (2026-10-09): the channels' state, each alertcondition's
 * trigger (frequency), the storm guard, why the engine switched an alert off, "Send test" with the
 * rendered message, and the delivery log.
 */
@Component({
  selector: 'app-script-alerts-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe],
  template: `
    <div class="stack">
      <header class="head">
        <div>
          <h3 class="title">Alerts</h3>
          <p class="sub">
            Where this script's alerts are delivered. Channels use the engine's alert settings
            (Configuration → Alerts).
          </p>
        </div>
        <button type="button" class="btn" (click)="reload()" [disabled]="loading() || saving()">
          Reload
        </button>
      </header>

      <div class="chips" aria-label="Alert channels" data-testid="channel-chips">
        @for (chip of chips(); track chip.channel) {
          <span class="chip" [attr.data-state]="chip.state" [title]="chip.title">{{
            chip.label
          }}</span>
        }
      </div>
      <p class="sub">{{ stormText() }}</p>

      @if (loading()) {
        <p class="muted" role="status">Loading alerts…</p>
      } @else if (loadError()) {
        <div class="error" role="alert">
          <span>{{ loadError() }}</span>
          <button type="button" class="btn" (click)="reload()">Retry</button>
        </div>
      } @else {
        @if (compileNote()) {
          <p class="note" role="status">{{ compileNote() }}</p>
        }
        @if (scan().untitled > 0) {
          <p class="note">
            {{ scan().untitled }} alertcondition() call{{
              scan().untitled === 1 ? ' has' : 's have'
            }}
            no constant title and cannot be bound individually.
          </p>
        }

        @for (row of rows(); track row.alertKey; let i = $index) {
          <section
            class="row"
            [class.enabled]="row.enabled"
            [class.orphan]="row.orphan"
            [attr.aria-labelledby]="uid + '-row-' + i"
          >
            <div class="row-head">
              <button
                type="button"
                role="switch"
                class="switch"
                [attr.aria-checked]="row.enabled"
                [attr.aria-label]="(row.enabled ? 'Disable ' : 'Enable ') + rowTitle(row)"
                (click)="patch(i, { enabled: !row.enabled })"
              >
                <span class="knob" aria-hidden="true"></span>
              </button>
              <h4 class="row-title" [id]="uid + '-row-' + i">{{ rowTitle(row) }}</h4>
              <span class="kind">{{ kindLabel(row) }}</span>
              @if (row.orphan) {
                <span class="orphan-tag">not in the script any more</span>
                <button type="button" class="btn small danger-text" (click)="removeRow(i)">
                  Remove
                </button>
              }
            </div>
            <p class="hint">{{ kindHint(row) }}</p>
            @if (row.disabledReason && !row.enabled) {
              <p class="row-disabled" data-testid="disabled-reason">
                Switched off by the engine{{
                  row.disabledAt ? ' on ' + (row.disabledAt | date: 'MMM d, HH:mm') : ''
                }}: {{ row.disabledReason }} Switch it on to re-arm it.
              </p>
            }
            @if (row.lastFiredAt || row.lastDeliveryError) {
              <p class="hint">
                @if (row.lastFiredAt) {
                  Last fired {{ row.lastFiredAt | date: 'MMM d, HH:mm:ss' }}.
                }
                @if (row.lastDeliveryError) {
                  <span class="row-warn-inline"
                    >Last delivery problem: {{ row.lastDeliveryError }}</span
                  >
                }
              </p>
            }

            <fieldset class="channels">
              <legend>Channels</legend>
              @for (c of channels; track c) {
                <label class="check">
                  <input
                    type="checkbox"
                    [checked]="row.channels.includes(c)"
                    (change)="toggleChannel(i, c, $any($event.target).checked)"
                  />
                  <span>{{ channelName(c) }}</span>
                </label>
              }
            </fieldset>

            @if (row.kind === 'condition') {
              <label class="field">
                <span class="field-label">Trigger</span>
                <select
                  class="picker trigger"
                  data-testid="frequency"
                  (change)="patch(i, { frequency: $any($event.target).value })"
                >
                  @for (f of frequencies; track f.id) {
                    <option [value]="f.id" [selected]="f.id === row.frequency">
                      {{ f.label }}
                    </option>
                  }
                </select>
                <span class="hint">{{ frequencyHint(row) }}</span>
              </label>
            }

            @if (row.channels.includes('Webhook')) {
              <label class="field">
                <span class="field-label">Webhook URL</span>
                <input
                  type="url"
                  inputmode="url"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://example.com/hook"
                  [value]="row.webhookUrl ?? ''"
                  [attr.aria-invalid]="!!urlError(row)"
                  (input)="patch(i, { webhookUrl: $any($event.target).value })"
                />
              </label>
            }

            @if (row.kind === 'alert-calls') {
              <p class="hint">
                Message: the text the script passes to alert() — the engine sends it as it is.
              </p>
            } @else {
              <div class="field">
                <label class="field-label" [attr.for]="uid + '-tpl-' + i">Message</label>
                <div class="tpl-tools">
                  <label class="sr-only" [attr.for]="uid + '-ph-' + i">Insert a placeholder</label>
                  <select
                    [id]="uid + '-ph-' + i"
                    class="picker"
                    (change)="onPick(i, tpl, $any($event.target))"
                  >
                    <option value="">Insert placeholder…</option>
                    @for (g of groupsFor(row); track g.label) {
                      <optgroup [label]="g.label">
                        @for (p of g.items; track p.token) {
                          <option [value]="p.token">{{ p.token }} — {{ p.label }}</option>
                        }
                      </optgroup>
                    }
                  </select>
                </div>
                <textarea
                  #tpl
                  [id]="uid + '-tpl-' + i"
                  rows="3"
                  spellcheck="false"
                  [placeholder]="templatePlaceholder(row)"
                  [value]="row.messageTemplate ?? ''"
                  (input)="patch(i, { messageTemplate: $any($event.target).value })"
                ></textarea>
              </div>
            }

            @if (issues()[i]; as is) {
              @for (e of is.errors; track $index) {
                <p class="row-error">{{ e }}</p>
              }
              @for (w of is.warnings; track $index) {
                <p class="row-warn">{{ w }}</p>
              }
            }

            <div class="test-row">
              <button
                type="button"
                class="btn small"
                data-testid="send-test"
                [disabled]="row.channels.length === 0 || testing(row)"
                (click)="sendTest(row)"
              >
                {{ testing(row) ? 'Sending…' : 'Send test' }}
              </button>
              <span class="hint">
                Sends this message with sample values through the chosen channels{{
                  row.channels.includes('Webhook')
                    ? ' (Webhook goes to the engine’s alert webhook, not this alert’s URL)'
                    : ''
                }}.
              </span>
            </div>
            @if (tests()[row.alertKey]; as t) {
              <div class="test-result" data-testid="test-result">
                <code class="test-msg">{{ t.message }}</code>
                <div class="chips">
                  @for (o of t.outcomes; track o.channel) {
                    <span class="chip" [attr.data-state]="o.state">{{ o.text }}</span>
                  }
                </div>
              </div>
            }
          </section>
        } @empty {
          <p class="muted">This script has no alerts to bind.</p>
        }

        @if (saveError()) {
          <p class="error" role="alert">{{ saveError() }}</p>
        }
        <div class="save-row">
          <button type="button" class="btn" [disabled]="!dirty() || saving()" (click)="discard()">
            Discard
          </button>
          <button
            type="button"
            class="btn primary"
            [disabled]="!dirty() || saving() || hasErrors()"
            (click)="save()"
          >
            {{ saving() ? 'Saving…' : 'Save alerts' }}
          </button>
        </div>

        <section class="log" aria-label="Recent deliveries">
          <div class="log-head">
            <button
              type="button"
              class="btn small"
              data-testid="toggle-log"
              [attr.aria-expanded]="logOpen()"
              (click)="toggleLog()"
            >
              {{ logOpen() ? 'Hide recent deliveries' : 'Show recent deliveries' }}
            </button>
            @if (logOpen()) {
              <button type="button" class="btn small" [disabled]="logLoading()" (click)="loadLog()">
                Refresh
              </button>
            }
          </div>
          @if (logOpen()) {
            @if (logError()) {
              <p class="row-error" role="alert">{{ logError() }}</p>
            } @else if (logLoading() && deliveries().length === 0) {
              <p class="muted" role="status">Loading deliveries…</p>
            } @else if (deliveries().length === 0) {
              <p class="muted">Nothing has been sent for this script yet.</p>
            } @else {
              <div class="log-scroll">
                <table class="log-table" data-testid="delivery-log">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Alert</th>
                      <th>Channel</th>
                      <th>Outcome</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (d of deliveries(); track d.id) {
                      <tr [attr.data-status]="d.status">
                        <td class="nowrap">{{ d.createdAt | date: 'MMM d, HH:mm:ss' }}</td>
                        <td>{{ alertTitle(d.alertKey) }}</td>
                        <td>{{ channelName(d.channel) }}</td>
                        <td [title]="d.lastError ?? ''">
                          {{ outcome(d) }}
                          @if (d.lastError) {
                            <span class="muted">— {{ d.lastError }}</span>
                          }
                        </td>
                        <td class="msg">{{ d.message }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .stack {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-3);
      }
      .title {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      .sub {
        margin: 2px 0 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .row {
        padding: var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .row.enabled {
        border-color: rgba(0, 113, 227, 0.4);
      }
      .row.orphan {
        border-style: dashed;
      }
      .row-head {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .row-title {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
        overflow-wrap: anywhere;
      }
      .kind {
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: var(--text-xs);
        color: var(--text-secondary);
        padding: 1px 6px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
      }
      .orphan-tag {
        font-size: var(--text-xs);
        color: #b25000;
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .switch {
        border: none;
        background: none;
        padding: 0;
        cursor: pointer;
      }
      .knob {
        display: block;
        width: 32px;
        height: 18px;
        border-radius: 9px;
        background: var(--bg-tertiary);
        position: relative;
      }
      .knob::after {
        content: '';
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        box-shadow: var(--shadow-sm);
        transition: transform var(--dur-fast);
      }
      .switch[aria-checked='true'] .knob {
        background: var(--accent);
      }
      .switch[aria-checked='true'] .knob::after {
        transform: translateX(14px);
      }
      .channels {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        border: none;
        margin: 0;
        padding: 0;
      }
      .channels legend {
        font-size: var(--text-xs);
        color: var(--text-secondary);
        margin-bottom: var(--space-1);
        padding: 0;
      }
      .check {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-sm);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .field-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field input,
      textarea,
      .picker {
        padding: var(--space-2);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
      }
      textarea {
        font-family: 'SF Mono', 'Fira Code', monospace;
        resize: vertical;
      }
      .field input[aria-invalid='true'] {
        border-color: var(--loss);
      }
      .tpl-tools {
        display: flex;
        justify-content: flex-end;
      }
      .picker {
        max-width: 100%;
        font-size: var(--text-xs);
      }
      .row-error {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--loss);
      }
      .row-warn {
        margin: 0;
        font-size: var(--text-xs);
        color: #b25000;
      }
      .note {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .save-row {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
      .btn {
        height: 32px;
        padding: 0 var(--space-4);
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
      }
      .btn.small {
        height: 26px;
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
      .btn.danger-text {
        color: var(--loss);
      }
      .btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .btn:focus-visible,
      .switch:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .muted {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
      }
      .error {
        margin: 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 59, 48, 0.08);
        color: var(--loss);
        font-size: var(--text-sm);
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .chip {
        padding: 1px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        font-size: var(--text-xs);
        color: var(--text-secondary);
        background: var(--bg-primary);
      }
      .chip[data-state='ready'],
      .chip[data-state='sent'] {
        border-color: var(--profit, #34c759);
        color: var(--text-primary);
      }
      .chip[data-state='off'],
      .chip[data-state='unset'],
      .chip[data-state='not-sent'] {
        border-color: #b25000;
        color: #b25000;
      }
      .row-disabled {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: rgba(255, 149, 0, 0.1);
        color: #b25000;
        font-size: var(--text-xs);
      }
      .row-warn-inline {
        color: #b25000;
      }
      .trigger {
        align-self: flex-start;
      }
      .test-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .test-result {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .test-msg {
        font-size: var(--text-xs);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        color: var(--text-secondary);
      }
      .log {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .log-head {
        display: flex;
        gap: var(--space-2);
      }
      .log-scroll {
        max-height: 360px;
        overflow: auto;
      }
      .log-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .log-table th,
      .log-table td {
        padding: 4px 6px;
        border-bottom: 1px solid var(--border);
        text-align: left;
        vertical-align: top;
      }
      .log-table tr[data-status='Failed'] td,
      .log-table tr[data-status='Expired'] td {
        color: var(--loss);
      }
      .log-table .msg {
        max-width: 320px;
        overflow-wrap: anywhere;
      }
      .nowrap {
        white-space: nowrap;
      }
    `,
  ],
})
export class ScriptAlertsTabComponent {
  private readonly api = inject(ScriptStrategyService);
  private readonly scripting = inject(ScriptingService);
  private readonly notifications = inject(NotificationService);
  private readonly alertsApi = inject(AlertsService);
  private readonly config = inject(ConfigService);

  readonly strategy = input.required<StrategyDto & ScriptStrategyFields>();

  private static nextUid = 0;
  readonly uid = `alerts-${ScriptAlertsTabComponent.nextUid++}`;
  readonly channels = ALERT_CHANNELS;
  readonly frequencies = FREQUENCY_OPTIONS;

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly compileNote = signal<string | null>(null);

  readonly scan = signal<AlertConditionScan>({ conditions: [], untitled: 0 });
  readonly plots = signal<PlotInfo[]>([]);
  readonly plotsKnown = signal(false);
  readonly isStrategy = signal(false);
  readonly savedRows = signal<AlertRow[]>([]);
  readonly rows = signal<AlertRow[]>([]);

  /** The engine's channels (`GET alert/channel/status`); null until read (or when it cannot be). */
  readonly channelStatuses = signal<AlertChannelStatusDto[] | null>(null);
  readonly stormGuard = signal<StormGuard>(DEFAULT_STORM_GUARD);
  readonly chips = computed(() =>
    ALERT_CHANNELS.map((c) => channelChip(c, this.channelStatuses())),
  );
  readonly stormText = computed(() => stormGuardText(this.stormGuard()));

  /** "Send test" per row (by alert key). */
  readonly tests = signal<Record<string, RowTest>>({});

  readonly logOpen = signal(false);
  readonly logLoading = signal(false);
  readonly logError = signal<string | null>(null);
  readonly deliveries = signal<ScriptAlertDeliveryDto[]>([]);

  readonly dirty = computed(() => alertRowsDiffer(this.savedRows(), this.rows()));
  readonly issues = computed(() =>
    this.rows().map((r) => {
      const issues = validateRow(r, this.groupsFor(r), this.plotsKnown());
      const strategyWarning = strategyConditionWarning(r, this.isStrategy());
      return {
        errors: issues.errors,
        warnings: [
          ...issues.warnings,
          ...channelWarnings(r, this.channelStatuses()),
          ...(strategyWarning ? [strategyWarning] : []),
        ],
      };
    }),
  );
  readonly hasErrors = computed(() => this.issues().some((i) => i.errors.length > 0));

  constructor() {
    // A new strategy object (another strategy, or this one after its script was edited) reloads.
    effect(() => {
      if (this.strategy()) untracked(() => this.reload());
    });
    this.loadDeliveryContext();
  }

  /** The channels' state and the storm guard's limits — context for every row, read once. */
  private loadDeliveryContext(): void {
    this.alertsApi
      .getChannelStatus()
      .pipe(catchError(() => of(null)))
      .subscribe((res) => this.channelStatuses.set(res?.status && res.data ? res.data : null));
    const intOf = (key: string) =>
      this.config.getByKey(key, { silent: true }).pipe(
        map((res) =>
          res?.status && res.data?.value != null ? Number.parseInt(res.data.value, 10) : NaN,
        ),
        catchError(() => of(NaN)),
      );
    forkJoin({
      maxFires: intOf('ScriptAlerts:StormMaxFires'),
      windowMinutes: intOf('ScriptAlerts:StormWindowMinutes'),
    }).subscribe(({ maxFires, windowMinutes }) =>
      this.stormGuard.set({
        maxFires:
          Number.isFinite(maxFires) && maxFires >= 0 ? maxFires : DEFAULT_STORM_GUARD.maxFires,
        windowMinutes:
          Number.isFinite(windowMinutes) && windowMinutes > 0
            ? windowMinutes
            : DEFAULT_STORM_GUARD.windowMinutes,
      }),
    );
  }

  reload(): void {
    const s = this.strategy();
    const source = scriptSourceOf(s);
    this.loading.set(true);
    this.loadError.set(null);
    this.saveError.set(null);
    this.compileNote.set(null);
    this.tests.set({});
    if (this.logOpen()) this.loadLog();
    forkJoin({
      alerts: this.api.getAlerts(s.id),
      compile: source
        ? this.scripting
            .compile({ source, symbol: s.symbol ?? undefined, timeframe: s.timeframe ?? undefined })
            .pipe(catchError(() => of(null)))
        : of(null),
    }).subscribe({
      next: ({ alerts, compile }) => {
        if (!isOk(alerts)) {
          this.loadError.set(describeFailure(alerts, 'Could not load the alert bindings.'));
          this.loading.set(false);
          return;
        }
        const compiled: ScriptCompileResult | null = compile;
        if (!source) {
          this.compileNote.set(
            'This strategy carries no script source; only saved bindings are shown.',
          );
        } else if (!compiled) {
          this.compileNote.set(
            'The script could not be compiled just now; alert titles were read from its source.',
          );
        }
        const scan: AlertConditionScan = compiled?.alertConditions?.length
          ? {
              conditions: compiled.alertConditions.map((c, i) => ({
                title: c.title,
                message: c.message ?? null,
                line: i,
              })),
              untitled: 0,
            }
          : extractAlertConditions(source);
        const plots: PlotInfo[] = compiled?.plots?.length
          ? compiled.plots.map((p, index) => ({ index, title: p.title || null }))
          : extractPlots(source);
        const kind = scriptKind(compiled, source);
        const isStrategy = kind !== 'indicator';
        const rows = buildAlertRows(
          (alerts.data ?? []) as ScriptAlertBindingView[],
          scan.conditions,
          isStrategy,
        );
        this.scan.set(scan);
        this.plots.set(plots);
        this.plotsKnown.set(!!source);
        // Only a script KNOWN to be a strategy gets the "alertcondition() is not sent" warning.
        this.isStrategy.set(kind === 'strategy');
        this.savedRows.set(rows);
        this.rows.set(rows.map((r) => ({ ...r, channels: [...r.channels] })));
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.loadError.set(describeFailure(err, 'Could not load the alert bindings.'));
        this.loading.set(false);
      },
    });
  }

  rowTitle(row: AlertRow): string {
    return rowTitle(row);
  }

  channelName(channel: AlertChannel | string): string {
    return channelLabel(channel);
  }

  frequencyHint(row: AlertRow): string {
    return FREQUENCY_OPTIONS.find((f) => f.id === row.frequency)?.hint ?? '';
  }

  alertTitle(alertKey: string): string {
    return deliveryAlertTitle(alertKey);
  }

  outcome(d: ScriptAlertDeliveryDto): string {
    return deliveryStatusLabel(d);
  }

  testing(row: AlertRow): boolean {
    return this.tests()[row.alertKey]?.outcomes.some((o) => o.state === 'sending') ?? false;
  }

  /**
   * Sends the row's message, its placeholders filled with SAMPLE values, through each chosen channel
   * (`POST alert/channel/test`) and shows what each channel did. Webhook tests the engine's alert webhook: a binding's
   * own URL is only used by real alerts.
   */
  sendTest(row: AlertRow): void {
    if (row.channels.length === 0 || this.testing(row)) return;
    const s = this.strategy();
    const key = row.alertKey;
    const message = renderSampleMessage(row, {
      symbol: s.symbol,
      timeframe: s.timeframe,
      now: new Date(),
      plots: this.plots(),
    });
    const channels = [...row.channels];
    const set = (outcomes: TestOutcome[]) =>
      this.tests.update((t) => ({ ...t, [key]: { message, outcomes } }));
    set(
      channels.map((channel) => ({
        channel,
        state: 'sending',
        text: `${channelLabel(channel)}: sending…`,
      })),
    );
    forkJoin(
      channels.map((channel) =>
        this.alertsApi.testChannel({ channel, message }).pipe(
          map((res): TestOutcome => {
            const sent = !!res?.status && res.data?.delivered === true;
            return sent
              ? {
                  channel,
                  state: 'sent',
                  text: `${channelLabel(channel)}: sent to ${res.data!.destination}`,
                }
              : {
                  channel,
                  state: 'not-sent',
                  text: `${channelLabel(channel)}: not sent — ${res?.data?.reason ?? res?.message ?? 'no answer'}`,
                };
          }),
          catchError(() =>
            of<TestOutcome>({
              channel,
              state: 'not-sent',
              text: `${channelLabel(channel)}: the engine did not answer`,
            }),
          ),
        ),
      ),
    ).subscribe((outcomes) => set(outcomes));
  }

  toggleLog(): void {
    this.logOpen.update((open) => !open);
    if (this.logOpen()) this.loadLog();
  }

  /** The script's recent deliveries (`GET alert/script-deliveries`), newest first. */
  loadLog(): void {
    const id = this.strategy().id;
    this.logLoading.set(true);
    this.logError.set(null);
    this.alertsApi.scriptDeliveries(id, 50).subscribe({
      next: (res) => {
        if (this.strategy().id !== id) return;
        this.logLoading.set(false);
        if (res?.status) this.deliveries.set(res.data ?? []);
        else this.logError.set(res?.message || 'Could not load the deliveries.');
      },
      error: () => {
        this.logLoading.set(false);
        this.logError.set('Could not load the deliveries.');
      },
    });
  }

  kindLabel(row: AlertRow): string {
    return KIND_LABELS[row.kind];
  }

  kindHint(row: AlertRow): string {
    return KIND_HINTS[row.kind];
  }

  groupsFor(row: AlertRow): PlaceholderGroup[] {
    return placeholderGroupsFor(row.kind, this.plots());
  }

  templatePlaceholder(row: AlertRow): string {
    if (row.defaultMessage) return `Default: ${row.defaultMessage}`;
    if (row.kind === 'order-fills') {
      return 'e.g. {{strategy.order.action}} {{strategy.order.contracts}} {{ticker}} @ {{strategy.order.price}}';
    }
    return row.kind === 'alert-calls' ? 'Empty = the message the script passes to alert()' : '';
  }

  urlError(row: AlertRow): boolean {
    const i = this.rows().indexOf(row);
    return (this.issues()[i]?.errors ?? []).some((e) => /URL|webhook/i.test(e));
  }

  patch(index: number, change: Partial<AlertRow>): void {
    this.rows.update((rows) => rows.map((r, i) => (i === index ? { ...r, ...change } : r)));
  }

  toggleChannel(index: number, channel: AlertChannel, on: boolean): void {
    const row = this.rows()[index];
    const channels = on
      ? ALERT_CHANNELS.filter((c) => c === channel || row.channels.includes(c))
      : row.channels.filter((c) => c !== channel);
    this.patch(index, { channels });
  }

  onPick(index: number, textarea: HTMLTextAreaElement, select: HTMLSelectElement): void {
    const token = select.value;
    select.value = '';
    if (!token) return;
    const current = this.rows()[index].messageTemplate ?? '';
    const start = textarea.selectionStart ?? current.length;
    const end = textarea.selectionEnd ?? start;
    const { text, caret } = insertAt(current, start, end, token);
    this.patch(index, { messageTemplate: text });
    textarea.value = text;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }

  removeRow(index: number): void {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
  }

  discard(): void {
    this.rows.set(this.savedRows().map((r) => ({ ...r, channels: [...r.channels] })));
    this.saveError.set(null);
  }

  save(): void {
    if (this.saving() || !this.dirty() || this.hasErrors()) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.api.saveAlerts(this.strategy().id, toAlertBindings(this.rows())).subscribe({
      next: (res) => {
        this.saving.set(false);
        if (!isOk(res)) {
          this.saveError.set(describeFailure(res, 'The engine did not save the alerts.'));
          return;
        }
        this.notifications.success('Alerts saved');
        this.reload();
      },
      error: (err: unknown) => {
        this.saving.set(false);
        this.saveError.set(describeFailure(err, 'Saving the alerts failed.'));
      },
    });
  }
}
