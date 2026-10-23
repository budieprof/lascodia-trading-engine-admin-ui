import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { RUNTIME_CONFIG } from '@core/config/runtime-config';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { SecretOnceComponent } from '@features/iam/shared/secret-once.component';
import { saveBlob } from '@features/scripting/shared/download';
import { Permission } from '@core/auth/permissions.generated';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage } from '../organisation.logic';
import type { EnrollmentTokenCreated } from '../organisation.types';
import { LABEL_MAX, LOGIN_MAX, SERVER_MAX } from '../terminals.logic';
import {
  allowListEntry,
  connectBlocker,
  engineBaseUrl,
  isInsecureRemote,
  nextPollMs,
  presetFileName,
  presetText,
  stageHeadline,
} from './terminal-wizard.logic';
import type { EnrollmentProgress, TerminalSetup } from './terminal-wizard.types';

/**
 * The guided terminal connection (engine enterprise onboarding): what you need, one enrollment token
 * (shown once, with a ready-made MT5 preset), the exact MetaTrader 5 steps (EA, WebRequest
 * allow-list, inputs), then the engine's view of the terminal — token used, signed in, registered,
 * first heartbeat — read every few seconds until it turns green, with the known failure modes
 * (allow-list error 4060, expired token, a refusal and its reason, clock skew, an old EA) named as
 * they happen. `?token=<id>` follows a token created earlier. Creating a token needs
 * `accounts.connect` (step-up); following one `accounts.read`.
 */
@Component({
  selector: 'app-terminal-wizard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, MfaHintComponent, SecretOnceComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .wizard {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .num {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--accent);
        color: var(--accent-contrast, #fff);
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        margin-right: var(--space-2);
      }
      ol.how {
        margin: 0;
        padding-left: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        font-size: var(--text-sm);
      }
      pre.copy {
        margin: var(--space-1) 0 0;
        padding: 6px 8px;
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: var(--text-xs);
        white-space: pre-wrap;
        word-break: break-all;
        user-select: all;
      }
      ul.progress {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      ul.progress li {
        display: grid;
        grid-template-columns: 22px 1fr;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .dot {
        width: 14px;
        height: 14px;
        margin-top: 3px;
        border-radius: 50%;
        border: 2px solid var(--border);
      }
      .dot.done {
        background: var(--success, #2e9e5b);
        border-color: var(--success, #2e9e5b);
      }
      .dot.current {
        border-color: var(--accent);
        animation: pulse 1.4s ease-in-out infinite;
      }
      .dot.failed {
        background: var(--danger, #d64545);
        border-color: var(--danger, #d64545);
      }
      @keyframes pulse {
        50% {
          box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 25%, transparent);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .dot.current {
          animation: none;
        }
      }
      .headline {
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .hint {
        border-left: 3px solid var(--border);
        padding: var(--space-2) var(--space-3);
        font-size: var(--text-sm);
      }
      .hint.observed {
        border-left-color: var(--warning, #d98e04);
        background: color-mix(in srgb, var(--warning, #d98e04) 8%, transparent);
      }
      .green {
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--success, #2e9e5b) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--success, #2e9e5b) 40%, transparent);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Connect a terminal — guided"
        subtitle="Four steps from a MetaTrader 5 terminal to live data. The page turns green when the EA's first heartbeat reaches the engine."
      >
        <a class="btn btn-secondary" routerLink="/organisation/terminals">All terminals</a>
        <a class="btn btn-secondary" routerLink="/docs/ea-install">EA install guide</a>
      </app-page-header>

      <div class="wizard">
        <section class="card">
          <header class="card-head"><h3><span class="num">1</span>Before you start</h3></header>
          @if (setup.error(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
          <div class="card-body">
            @if (blocker(); as b) {
              <p class="note warn" role="alert">{{ b }}</p>
            }
            <ul class="small">
              <li>
                MetaTrader 5 on Windows (or under Wine), signed in to the broker account you want to
                connect{{ setup.value()?.demoAccountsOnly ? ' — a DEMO account: your organisation may connect demo accounts only' : '' }}.
              </li>
              <li>
                The Lascodia EA, version {{ setup.value()?.eaMinimumVersion || '8.47.253' }} or later.
                @if (setup.value()?.eaDownloadUrl; as url) {
                  <a [href]="url" target="_blank" rel="noopener noreferrer">Download the EA</a>.
                } @else {
                  Ask your platform contact for the EA file (LascodiaEA.ex5).
                }
              </li>
              <li>
                The engine address the EA will call:
                <code>{{ engineUrl() }}</code>
                @if (insecure()) {
                  <span class="chip bad">not https</span>
                }
              </li>
            </ul>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <h3><span class="num">2</span>Create the enrollment token</h3>
            <span class="spacer"></span>
            <app-mfa-hint [permission]="P.AccountsConnect" />
          </header>
          @if (created(); as c) {
            <div class="card-body">
              <app-secret-once
                [title]="'Enrollment token — ' + c.label"
                [value]="c.token"
                [warning]="'Copy it or download the preset now: it is shown only this once. It works for one terminal and expires ' + when(c.expiresAtUtc) + '.'"
                (dismissed)="dismissSecret()"
              />
              @if (secretVisible()) {
                <button type="button" class="btn btn-primary" (click)="downloadPreset(c)">
                  Download the MT5 preset (.set)
                </button>
              }
            </div>
          } @else if (following() !== null) {
            <p class="pad muted">
              Following token #{{ following() }}. Its text was shown once when it was created; if you
              no longer have it, create a new token below.
            </p>
            <div class="card-body">
              <button type="button" class="btn btn-secondary" (click)="startOver()">Create a new token</button>
            </div>
          } @else if (canCreate()) {
            <form class="card-body" (ngSubmit)="create()">
              <div class="form-grid">
                <label class="field">
                  <span class="label">Name this terminal</span>
                  <input
                    class="input"
                    name="label"
                    [maxlength]="labelMax"
                    placeholder="e.g. Office PC — EURUSD chart"
                    [ngModel]="label()"
                    (ngModelChange)="label.set($event)"
                  />
                </label>
                <label class="field">
                  <span class="label">Broker login (optional — only this account may use the token)</span>
                  <input
                    class="input"
                    name="login"
                    [maxlength]="loginMax"
                    [ngModel]="login()"
                    (ngModelChange)="login.set($event)"
                  />
                </label>
                @if (login().trim()) {
                  <label class="field">
                    <span class="label">Broker server (exactly as MT5 shows it)</span>
                    <input
                      class="input"
                      name="server"
                      [maxlength]="serverMax"
                      [ngModel]="server()"
                      (ngModelChange)="server.set($event)"
                    />
                  </label>
                }
              </div>
              @if (problem(); as p) {
                <p class="note warn">{{ p }}</p>
              }
              <div class="actions">
                <button type="submit" class="btn btn-primary" [disabled]="busy() || !!problem()">
                  {{ busy() ? 'Creating…' : 'Create token' }}
                </button>
              </div>
            </form>
          } @else {
            <p class="pad muted">
              Creating a token needs the "connect accounts" permission. Ask an administrator of your
              organisation, or follow a token they created (?token=…).
            </p>
          }
        </section>

        <section class="card">
          <header class="card-head"><h3><span class="num">3</span>Set up MetaTrader 5</h3></header>
          <div class="card-body">
            <ol class="how">
              <li>
                Allow the EA to reach the engine: <strong>Tools → Options → Expert Advisors</strong>,
                tick <strong>Allow WebRequest for listed URL</strong> and add
                <pre class="copy">{{ allowList() }}</pre>
                Without it MetaTrader refuses every call (error 4060 in the Experts log) and nothing
                reaches the engine.
              </li>
              <li>
                Copy <code>LascodiaEA.ex5</code> into the terminal's data folder:
                <strong>File → Open Data Folder → MQL5 → Experts</strong>, then right-click
                <strong>Expert Advisors</strong> in the Navigator and choose <strong>Refresh</strong>.
              </li>
              <li>
                Drag the EA onto a chart. In its <strong>Common</strong> tab tick
                <strong>Allow Algo Trading</strong>; in <strong>Inputs</strong> press
                <strong>Load</strong> and pick the preset from step 2 — or set the two inputs by hand:
                <pre class="copy">{{ engineInput() }}={{ engineUrl() }}
{{ tokenInput() }}={{ tokenValue() }}</pre>
              </li>
              <li>
                Press OK and make sure the toolbar's <strong>Algo Trading</strong> button is green. The
                EA exchanges the token for its own credential at once; delete the preset file afterwards.
              </li>
            </ol>
          </div>
        </section>

        <section class="card" aria-live="polite">
          <header class="card-head">
            <h3><span class="num">4</span>Waiting for your terminal</h3>
            <span class="spacer"></span>
            @if (tokenId() !== null) {
              <button type="button" class="btn btn-sm btn-secondary" (click)="pollNow()">Check now</button>
            }
          </header>
          <div class="card-body">
            @if (tokenId() === null) {
              <p class="muted">Create a token in step 2 — this step then follows it.</p>
            } @else if (progressError(); as err) {
              <p role="alert"><span class="chip bad">Could not read the progress</span> {{ err }}</p>
            }
            @if (progress(); as p) {
              <p class="headline">
                <span class="chip" [class]="headline().tone">{{ p.stage }}</span>
                {{ headline().text }}
              </p>
              @if (p.connected) {
                <div class="green">
                  <strong>{{ p.instanceId }}</strong> is connected
                  @if (p.accountLogin) {
                    — account {{ p.accountLogin }} on {{ p.brokerServer }}
                    @if (p.accountType) {
                      ({{ p.accountType }})
                    }
                  }
                  · EA {{ p.eaVersion ?? '?' }}
                  @if (p.eaState) {
                    · {{ p.eaState }}
                  }
                  · last heartbeat {{ p.secondsSinceHeartbeat }} s ago.
                  <div class="actions">
                    <a class="btn btn-primary" routerLink="/chart-analysis">Open a live chart</a>
                    <a class="btn btn-secondary" routerLink="/onboarding">Back to Get started</a>
                  </div>
                </div>
              }
              <ul class="progress">
                @for (s of p.steps; track s.key) {
                  <li>
                    <span class="dot" [class]="s.state" [attr.aria-label]="s.state"></span>
                    <span>
                      {{ s.title }}
                      @if (s.atUtc && s.state === 'done') {
                        <span class="sub">{{ when(s.atUtc) }}</span>
                      }
                      @if (s.detail) {
                        <span class="sub">{{ s.detail }}</span>
                      }
                    </span>
                  </li>
                }
              </ul>
              @if (p.hints.length) {
                <h4>{{ p.connected ? 'Notes' : 'If it does not move' }}</h4>
                @for (h of p.hints; track h.code) {
                  <div class="hint" [class.observed]="h.observed">
                    <strong>{{ h.title }}</strong>
                    <div>{{ h.text }}</div>
                  </div>
                }
              }
            }
          </div>
        </section>
      </div>
    </div>
  `,
})
export class TerminalWizardPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly config = inject(RUNTIME_CONFIG);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly labelMax = LABEL_MAX;
  protected readonly loginMax = LOGIN_MAX;
  protected readonly serverMax = SERVER_MAX;

  readonly setup = iamResource<TerminalSetup | null>(
    () => this.api.terminalSetup(),
    null,
    'Could not load the connection settings.',
  );

  readonly engineUrl = computed(() =>
    engineBaseUrl(this.setup.value(), this.config.apiBaseUrl || globalThis.location?.origin || ''),
  );
  readonly allowList = computed(() => allowListEntry(this.engineUrl()));
  readonly insecure = computed(() => isInsecureRemote(this.engineUrl()));
  readonly blocker = computed(() => connectBlocker(this.setup.value()));
  readonly engineInput = computed(() => this.setup.value()?.engineUrlInput || 'InpEngineBaseUrl');
  readonly tokenInput = computed(() => this.setup.value()?.enrollmentTokenInput || 'InpEnrollmentToken');
  readonly canCreate = computed(
    () => this.auth.hasPermission(Permission.AccountsConnect) && !this.blocker(),
  );

  readonly label = signal('');
  readonly login = signal('');
  readonly server = signal('');
  readonly problem = computed(() => {
    if (!this.label().trim()) return 'Give the terminal a name you will recognise.';
    if (this.login().trim() && !this.server().trim())
      return 'Enter the broker server too, exactly as MetaTrader 5 shows it.';
    return null;
  });
  readonly busy = signal(false);
  readonly created = signal<EnrollmentTokenCreated | null>(null);
  readonly secretVisible = signal(true);
  readonly following = signal<number | null>(null);
  readonly tokenId = computed(() => this.created()?.id ?? this.following());
  readonly tokenValue = computed(() => this.created()?.token ?? '(the token from step 2)');

  readonly progress = signal<EnrollmentProgress | null>(null);
  readonly progressError = signal<string | null>(null);
  readonly headline = computed(() => stageHeadline(this.progress()?.stage ?? 'waiting-for-terminal'));

  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;
  private generation = 0;
  private destroyed = false;

  constructor() {
    this.setup.reload();
    const fromLink = Number(this.route.snapshot.queryParamMap.get('token'));
    if (Number.isInteger(fromLink) && fromLink > 0) {
      this.following.set(fromLink);
      this.startPolling();
    }
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.stopPolling();
    });
  }

  create(): void {
    if (this.busy() || this.problem() || !this.canCreate()) return;
    this.busy.set(true);
    const login = this.login().trim();
    this.api
      .createEnrollmentToken({
        kind: 'EaTerminal',
        label: this.label().trim(),
        ...(login ? { accountLogin: login, brokerServer: this.server().trim() } : {}),
      })
      .subscribe({
        next: (c) => {
          this.busy.set(false);
          this.created.set(c);
          this.secretVisible.set(true);
          this.following.set(null);
          this.startPolling();
        },
        error: (e) => {
          this.busy.set(false);
          const msg = failureMessage(e, 'The enrollment token was not created.');
          if (msg) this.notify.error(msg);
        },
      });
  }

  downloadPreset(c: EnrollmentTokenCreated): void {
    saveBlob(
      new Blob([presetText(this.engineUrl(), c.token, c.label)], { type: 'text/plain;charset=utf-8' }),
      presetFileName(c.label),
    );
  }

  dismissSecret(): void {
    this.secretVisible.set(false);
  }

  startOver(): void {
    this.stopPolling();
    this.following.set(null);
    this.created.set(null);
    this.progress.set(null);
    this.progressError.set(null);
  }

  pollNow(): void {
    this.stopPolling();
    this.poll();
  }

  private startPolling(): void {
    this.stopPolling();
    this.progress.set(null);
    this.progressError.set(null);
    this.startedAt = Date.now();
    this.poll();
  }

  private stopPolling(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
  }

  private poll(): void {
    const id = this.tokenId();
    if (id === null || this.destroyed) return;
    const mine = ++this.generation;
    this.api.enrollmentProgress(id).subscribe({
      next: (p) => {
        if (mine !== this.generation) return;
        this.progress.set(p);
        this.progressError.set(null);
        this.schedule(p);
      },
      error: (e) => {
        if (mine !== this.generation) return;
        this.progressError.set(failureMessage(e, 'The engine did not answer.') ?? 'The engine did not answer.');
        this.schedule(this.progress(), 10_000);
      },
    });
  }

  private schedule(p: EnrollmentProgress | null, override?: number): void {
    if (this.destroyed) return;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const delay = override ?? nextPollMs(p, Date.now() - this.startedAt);
    if (delay === null) return;
    this.timer = setTimeout(() => this.poll(), hidden ? Math.max(delay, 15_000) : delay);
  }
}
