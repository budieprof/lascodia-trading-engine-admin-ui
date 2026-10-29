import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { SecretOnceComponent } from '@features/iam/shared/secret-once.component';
import {
  CHANNELS,
  MAX_RECIPIENTS,
  RECEIVER_NODE,
  RECEIVER_PYTHON,
  SIGNATURE_HEADERS,
  channelErrors,
  channelTitle,
  draftFor,
  houseTakeoverNotice,
  saveBody,
  sourceText,
  testText,
  type ChannelDraft,
} from '../alerts.logic';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage } from '../organisation.logic';
import type { AlertChannelName, AlertChannelSettings } from '../organisation.types';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { catchError, defer, of } from 'rxjs';
import { ApiService } from '@core/api/api.service';

/**
 * Alert channels (multi-tenancy Phase 7, T7.5; engine `/alerts/channels`, docs/api/alert-webhooks.md).
 * Where the organisation's alerts go: e-mail recipients, a Telegram chat, and an https webhook signed
 * with HMAC-SHA256. Bot tokens, webhook URLs and signing secrets are write-only (a generated or rotated
 * signing secret is shown once, with a receiver sample). Every change needs `alerts.manage`, a step-up
 * key. A test is sent only on an explicit click and the engine allows one per channel every 10 s.
 */
@Component({
  selector: 'app-org-alerts-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    LscCanDirective,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
    SecretOnceComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      pre {
        margin: 0;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        overflow-x: auto;
        white-space: pre;
      }
      details summary {
        cursor: pointer;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
      }
      details[open] summary {
        margin-bottom: var(--space-2);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Alert channels"
        subtitle="Where the organisation's alerts go: e-mail, Telegram and a signed webhook."
      >
        <app-mfa-hint [permission]="P.AlertsManage" />
        <button
          type="button"
          class="btn btn-secondary"
          (click)="channels.reload()"
          [disabled]="channels.loading()"
        >
          {{ channels.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Alert delivery today" />
      <p class="note">
        Above: how alerts are delivered right now, channel by channel (the platform's channels
        unless the organisation sets up its own below). In-app alerts always reach the console's
        bell.
      </p>

      @if (channels.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      @if (secret(); as s) {
        <section class="card">
          <div class="card-body">
            <app-secret-once
              title="Webhook signing secret"
              [value]="s"
              warning="Copy it into your receiver now: it is shown only this once. Deliveries are signed with it from now on."
              (dismissed)="secret.set(null)"
            />
            <p class="small">
              Verify every delivery as below; the old secret no longer signs anything.
            </p>
          </div>
        </section>
      }

      @if (channels.loaded()) {
        @for (c of channelNames; track c) {
          <section class="card">
            <header class="card-head">
              <h3>{{ title(c) }}</h3>
              <span
                class="chip"
                [class.ok]="settings(c)?.source === 'organisation' && settings(c)?.enabled"
                [class.info]="settings(c)?.source === 'platform-default'"
                >{{ sourceText(settings(c)) }}</span
              >
              <span class="spacer"></span>
              @if (settings(c)?.destination; as dest) {
                <span class="muted small">To {{ dest }}</span>
              }
            </header>
            <form class="card-body" (ngSubmit)="startSave(c)">
              @if (houseNotice(c); as n) {
                <p class="note">{{ n }}</p>
              }
              <label class="check">
                <input
                  type="checkbox"
                  [name]="'enabled-' + c"
                  [ngModel]="draft(c).enabled"
                  (ngModelChange)="patch(c, { enabled: $event })"
                />
                Send alerts on this channel
              </label>
              <div class="form-grid">
                @switch (c) {
                  @case ('Email') {
                    <label class="field">
                      <span class="label">Recipients (1–{{ maxRecipients }}, comma-separated)</span>
                      <input
                        class="input"
                        name="emailTo"
                        autocomplete="off"
                        placeholder="desk@example.com, risk@example.com"
                        [ngModel]="draft(c).emailTo"
                        (ngModelChange)="patch(c, { emailTo: $event })"
                      />
                    </label>
                  }
                  @case ('Telegram') {
                    <label class="field">
                      <span class="label">Chat id or channel name</span>
                      <input
                        class="input"
                        name="chatId"
                        autocomplete="off"
                        placeholder="-1001234567890 or @my_alerts"
                        [ngModel]="draft(c).chatId"
                        (ngModelChange)="patch(c, { chatId: $event })"
                      />
                    </label>
                    <label class="field">
                      <span class="label">
                        Bot token{{
                          settings(c)?.source === 'organisation' && settings(c)?.telegramBotTokenSet
                            ? ' (stored — leave empty to keep it)'
                            : ''
                        }}
                      </span>
                      <input
                        class="input"
                        type="password"
                        name="botToken"
                        autocomplete="new-password"
                        [ngModel]="draft(c).botToken"
                        (ngModelChange)="patch(c, { botToken: $event })"
                      />
                    </label>
                  }
                  @case ('Webhook') {
                    <label class="field">
                      <span class="label">
                        URL (https, a public host){{
                          ownWebhookUrl()
                            ? ' — stored: ' + ownWebhookUrl() + ' (leave empty to keep it)'
                            : ''
                        }}
                      </span>
                      <input
                        class="input"
                        type="password"
                        name="url"
                        autocomplete="off"
                        placeholder="https://hooks.example.com/lascodia"
                        [ngModel]="draft(c).url"
                        (ngModelChange)="patch(c, { url: $event })"
                      />
                    </label>
                    <label class="field">
                      <span class="label">
                        Signing secret (optional, 32–256 characters; empty =
                        {{
                          settings(c)?.webhookSecretSet
                            ? 'keep the stored one'
                            : 'one is generated'
                        }})
                      </span>
                      <input
                        class="input"
                        type="password"
                        name="secret"
                        autocomplete="new-password"
                        [ngModel]="draft(c).secret"
                        (ngModelChange)="patch(c, { secret: $event })"
                      />
                    </label>
                  }
                }
              </div>
              @if (c === 'Webhook') {
                <label class="check small">
                  <input
                    type="checkbox"
                    name="legacyHeader"
                    [ngModel]="draft(c).legacyHeader"
                    (ngModelChange)="patch(c, { legacyHeader: $event })"
                  />
                  Also send the secret itself in the old X-Lascodia-Secret header (deprecated: only
                  for a receiver that cannot check signatures yet)
                </label>
                @if (settings(c)?.webhookSecretSetAtUtc; as at) {
                  <p class="muted small">Signing secret set {{ when(at) }}.</p>
                }
              }
              @if (submitted()[c] && errors(c).length) {
                <ul class="errors" role="alert">
                  @for (e of errors(c); track e) {
                    <li>{{ e }}</li>
                  }
                </ul>
              }
              @if (testResult()[c]; as t) {
                <p class="small" role="status">{{ t }}</p>
              }
              <div class="actions-row" *lscCan="P.AlertsManage">
                @if (settings(c)?.source === 'organisation') {
                  <button
                    type="button"
                    class="btn btn-sm btn-danger"
                    [disabled]="busy()"
                    (click)="removing.set(c)"
                  >
                    Remove
                  </button>
                }
                @if (c === 'Webhook' && settings(c)?.source === 'organisation') {
                  <button
                    type="button"
                    class="btn btn-sm btn-secondary"
                    [disabled]="busy()"
                    (click)="rotating.set(true)"
                  >
                    Rotate signing secret…
                  </button>
                }
                @if (settings(c)?.source !== 'not-set-up') {
                  <button
                    type="button"
                    class="btn btn-sm btn-secondary"
                    [disabled]="busy() || testing() === c"
                    (click)="test(c)"
                  >
                    {{ testing() === c ? 'Sending…' : 'Send a test' }}
                  </button>
                }
                <button type="submit" class="btn btn-primary" [disabled]="busy()">
                  {{ settings(c)?.source === 'organisation' ? 'Save' : 'Set up' }}
                </button>
              </div>
            </form>
          </section>
        }

        <section class="card">
          <div class="card-body">
            <details>
              <summary>Receiving the webhook: check every delivery's signature</summary>
              <p class="small">
                Each delivery is a JSON POST carrying two headers. Read the raw body before parsing
                it, refuse a timestamp more than five minutes from your clock, and compare the
                signature in constant time with every v1= value (several may appear while a secret
                is being rotated).
              </p>
              <pre>{{ headers }}</pre>
              <p class="small">Python:</p>
              <pre>{{ python }}</pre>
              <p class="small">Node.js:</p>
              <pre>{{ node }}</pre>
            </details>
          </div>
        </section>
      }

      <app-confirm-dialog
        [open]="confirmingSave() !== null"
        [title]="'Save the ' + title(confirmingSave() ?? 'Email') + ' channel?'"
        [message]="saveMessage()"
        confirmLabel="Save"
        [loading]="busy()"
        (confirm)="save()"
        (cancelled)="confirmingSave.set(null)"
      />

      <app-confirm-dialog
        [open]="removing() !== null"
        [title]="'Remove the ' + title(removing() ?? 'Email') + ' channel?'"
        [message]="removeMessage()"
        confirmLabel="Remove"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="removing.set(null)"
      />

      <app-confirm-dialog
        [open]="rotating()"
        title="Rotate the webhook signing secret?"
        message="A new secret is generated and shown once. The old one stops signing at once, so deliveries fail your receiver's check until you put the new one in. The old X-Lascodia-Secret header is turned off."
        confirmLabel="Rotate"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="rotate()"
        (cancelled)="rotating.set(false)"
      />

      <app-audit-trail
        heading="Channel changes"
        [actions]="['config.alert_channel.']"
        empty="No alert channel has been set up, changed or removed for this organisation, and no signing secret rotated. Each change is recorded here."
      />
    </div>
  `,
})
export class AlertsPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly auth = inject(AuthService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly title = channelTitle;
  protected readonly sourceText = sourceText;
  protected readonly houseNotice = (c: AlertChannelName) => houseTakeoverNotice(this.settings(c));
  protected readonly channelNames = CHANNELS;
  protected readonly maxRecipients = MAX_RECIPIENTS;
  protected readonly headers = SIGNATURE_HEADERS;
  protected readonly python = RECEIVER_PYTHON;
  protected readonly node = RECEIVER_NODE;

  readonly channels = iamResource<AlertChannelSettings[]>(
    () => this.api.alertChannels(),
    [],
    'Could not load the alert channels.',
  );
  private readonly byChannel = computed(
    () => new Map(this.channels.value().map((s) => [String(s.channel), s])),
  );
  readonly ownWebhookUrl = computed(() => {
    const s = this.byChannel().get('Webhook');
    return s?.source === 'organisation' ? s.webhookUrl : null;
  });

  readonly drafts = signal<Record<string, ChannelDraft>>({});
  readonly submitted = signal<Record<string, boolean>>({});
  readonly testResult = signal<Record<string, string>>({});
  readonly busy = signal(false);
  readonly testing = signal<AlertChannelName | null>(null);
  readonly confirmingSave = signal<AlertChannelName | null>(null);
  readonly removing = signal<AlertChannelName | null>(null);
  readonly rotating = signal(false);
  /** A generated or rotated signing secret, shown once. */
  readonly secret = signal<string | null>(null);

  readonly saveMessage = computed(() => {
    const c = this.confirmingSave();
    if (!c) return '';
    const takeover = houseTakeoverNotice(this.settings(c));
    const enabled = this.draft(c).enabled;
    return [
      enabled
        ? `The organisation's alerts will go to this ${channelTitle(c)} channel.`
        : `The channel is kept but switched off: no alerts are sent on it.`,
      takeover ?? '',
    ]
      .filter(Boolean)
      .join(' ');
  });
  readonly removeMessage = computed(() => {
    const c = this.removing();
    if (!c) return '';
    return this.isHouse()
      ? `House's alerts on this channel go back to the platform channel set in Engine Config.`
      : `The organisation's alerts are no longer sent on this channel. Its stored settings and secrets are deleted.`;
  });

  private readonly rawApi = inject(ApiService);
  readonly delivery = iamResource<
    {
      channel: string;
      isConfigured: boolean;
      isEnabled: boolean;
      destinationPreview: string | null;
    }[]
  >(
    () =>
      defer(() =>
        this.auth.hasPermission(Permission.AccessOperator)
          ? this.rawApi
              .getEnvelope<
                {
                  channel: string;
                  isConfigured: boolean;
                  isEnabled: boolean;
                  destinationPreview: string | null;
                }[]
              >('/alert/channel/status', { silent: true })
              .pipe(catchError(() => of([])))
          : of([]),
      ).pipe(catchError(() => of([]))),
    [],
  );
  readonly tiles = computed<StatTile[]>(() =>
    this.delivery.value().map((c) => ({
      label: c.channel === 'InApp' ? 'In the console' : c.channel,
      value: !c.isConfigured ? 'Not set up' : c.isEnabled ? 'Delivering' : 'Off',
      caption: c.destinationPreview ?? (c.isConfigured ? null : 'no destination configured'),
      tone: !c.isConfigured ? null : c.isEnabled ? ('good' as const) : ('warn' as const),
    })),
  );

  constructor() {
    this.delivery.reload();
    this.channels.reload();
  }

  /**
   * House: removing its own channel hands its alerts back to the platform channel. A console session
   * names its organisation; a legacy sign-in always acts in House.
   */
  readonly isHouse = computed(() => {
    const t = this.auth.activeTenant();
    return t ? t.kind === 'House' : this.auth.mode === 'legacy';
  });

  settings(c: AlertChannelName): AlertChannelSettings | undefined {
    return this.byChannel().get(c);
  }

  draft(c: AlertChannelName): ChannelDraft {
    return this.drafts()[c] ?? draftFor(this.settings(c));
  }

  patch(c: AlertChannelName, p: Partial<ChannelDraft>): void {
    this.drafts.update((all) => ({ ...all, [c]: { ...this.draft(c), ...p } }));
  }

  errors(c: AlertChannelName): string[] {
    return channelErrors(c, this.draft(c), this.settings(c));
  }

  startSave(c: AlertChannelName): void {
    this.submitted.update((s) => ({ ...s, [c]: true }));
    if (this.busy() || this.errors(c).length) return;
    this.confirmingSave.set(c);
  }

  save(): void {
    const c = this.confirmingSave();
    if (!c || this.busy()) return;
    this.busy.set(true);
    this.api.saveAlertChannel(c, saveBody(c, this.draft(c))).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.confirmingSave.set(null);
        if (r.signingSecret) this.secret.set(r.signingSecret);
        this.notify.success(`${channelTitle(c)} channel saved.`);
        this.resetDraft(c);
        this.channels.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.confirmingSave.set(null);
        const msg = failureMessage(e, 'The channel was not saved.');
        if (msg) this.notify.error(msg);
      },
    });
  }

  remove(): void {
    const c = this.removing();
    if (!c || this.busy()) return;
    this.busy.set(true);
    this.api.removeAlertChannel(c).subscribe({
      next: () => {
        this.busy.set(false);
        this.removing.set(null);
        this.notify.success(`${channelTitle(c)} channel removed.`);
        this.resetDraft(c);
        this.channels.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.removing.set(null);
        const msg = failureMessage(e, 'The channel was not removed.');
        if (msg) this.notify.error(msg);
      },
    });
  }

  rotate(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.rotateWebhookSecret().subscribe({
      next: (r) => {
        this.busy.set(false);
        this.rotating.set(false);
        if (r.signingSecret) this.secret.set(r.signingSecret);
        this.notify.success('A new signing secret was generated. Put it into your receiver now.');
        this.resetDraft('Webhook');
        this.channels.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.rotating.set(false);
        const msg = failureMessage(e, 'The signing secret was not rotated.');
        if (msg) this.notify.error(msg);
      },
    });
  }

  /** One explicit click sends one test to the channel's destination. */
  test(c: AlertChannelName): void {
    if (this.testing()) return;
    this.testing.set(c);
    this.api.testAlertChannel(c, null).subscribe({
      next: (r) => {
        this.testing.set(null);
        this.testResult.update((t) => ({ ...t, [c]: testText(r) }));
      },
      error: (e) => {
        this.testing.set(null);
        const msg = failureMessage(e, 'The test was not sent.');
        if (msg) this.testResult.update((t) => ({ ...t, [c]: msg }));
      },
    });
  }

  private resetDraft(c: AlertChannelName): void {
    this.drafts.update((all) => {
      const next = { ...all };
      delete next[c];
      return next;
    });
    this.submitted.update((s) => ({ ...s, [c]: false }));
  }
}
