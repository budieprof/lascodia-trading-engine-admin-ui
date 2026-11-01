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
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage } from '../organisation.logic';
import { saveBlob } from '@features/scripting/shared/download';
import { sha256Matches } from './terminal-wizard.logic';
import type { EnrollmentTokenCreated } from '../organisation.types';
import {
  COMPUTER_LABEL_MAX,
  WHAT_IT_DOES,
  anyAllowListProblem,
  daemonHeadline,
  detectOs,
  eaStatus,
  expiresInText,
  installAccountText,
  installCommand,
  installRunningText,
  isAllDone,
  installerAvailable,
  installerFileName,
  installerPlatform,
  installerSteps,
  installerWhyAsked,
  macInstallerErrorText,
  shellName,
  nextDaemonPollMs,
  openShellSteps,
  osAvailability,
  osLabel,
} from './add-computer.logic';
import type { ComputerOs, SupervisorSetup } from './add-computer.types';
import type { EnrollmentProgress } from './terminal-wizard.types';

/**
 * "Add a computer" (self-heal program, contract C9): name the computer, pick Mac or Windows, get
 * ONE line to paste, then watch the computer connect — the supervisor starting, the MetaTrader 5
 * terminals it found, and per terminal the only step left to do by hand (MetaTrader's WebRequest
 * allow-list), until everything is green. `?token=<id>` follows a line made earlier. Making a line
 * needs `accounts.connect` (step-up); following one `accounts.read`.
 */
@Component({
  selector: 'app-add-computer-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, MfaHintComponent],
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
      .os-choice {
        display: flex;
        gap: var(--space-3);
        flex-wrap: wrap;
      }
      .os-choice label {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        cursor: pointer;
        font-size: var(--text-sm);
      }
      .os-choice label.selected {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, transparent);
      }
      .command {
        display: flex;
        gap: var(--space-2);
        align-items: stretch;
      }
      .command pre {
        flex: 1;
        margin: 0;
        padding: var(--space-3);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        font-size: var(--text-sm);
        white-space: pre-wrap;
        word-break: break-all;
        user-select: all;
      }
      ol.how,
      ul.what {
        margin: 0;
        padding-left: var(--space-5);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        font-size: var(--text-sm);
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
      .terminal {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .terminal-head {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        flex-wrap: wrap;
      }
      .terminal-head strong {
        font-size: var(--text-sm);
      }
      .ea-line {
        display: flex;
        gap: var(--space-2);
        align-items: baseline;
        font-size: var(--text-sm);
      }
      .menu-path {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        font-size: var(--text-xs);
      }
      .menu-path span {
        padding: 2px 8px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-secondary, var(--bg-primary));
      }
      .menu-path .sep {
        border: none;
        background: none;
        padding: 0;
        color: var(--text-secondary);
      }
      .allow-box {
        border: 1px dashed var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Add a computer"
        subtitle="Connect a Mac or Windows PC that runs MetaTrader 5. You copy one line, paste it on that computer, and this page shows it connecting."
      >
        <a class="btn btn-secondary" routerLink="/organisation/terminals">All terminals</a>
      </app-page-header>

      <div class="wizard">
        @if (setup.error(); as err) {
          <p class="note warn" role="alert">{{ err }}</p>
        }

        <!-- 1. Name + OS -->
        <section class="card">
          <header class="card-head">
            <h3><span class="num">1</span>Which computer?</h3>
            <span class="spacer"></span>
            <app-mfa-hint [permission]="P.AccountsConnect" />
          </header>
          @if (created() || following() !== null) {
            <div class="card-body">
              <p class="small">
                <strong>{{ created()?.label ?? progress()?.label ?? 'This computer' }}</strong>
                @if (created()) {
                  · {{ osName() }}
                }
              </p>
              <div class="actions">
                <button type="button" class="btn btn-secondary btn-sm" (click)="startOver()">
                  Add another computer
                </button>
              </div>
            </div>
          } @else if (canCreate()) {
            <form class="card-body" (ngSubmit)="create()">
              <label class="field">
                <span class="label">Give it a name you will recognise</span>
                <input
                  class="input"
                  name="label"
                  [maxlength]="labelMax"
                  placeholder="e.g. Office Mac, London VPS"
                  [ngModel]="label()"
                  (ngModelChange)="label.set($event)"
                />
              </label>
              <div class="field">
                <span class="label">What kind of computer is it?</span>
                <div class="os-choice" role="radiogroup" aria-label="Operating system">
                  @for (o of osOptions; track o) {
                    <label [class.selected]="os() === o">
                      <input
                        type="radio"
                        name="os"
                        [value]="o"
                        [checked]="os() === o"
                        (change)="os.set(o)"
                      />
                      {{ o === 'macos' ? 'Mac (macOS)' : 'Windows PC' }}
                    </label>
                  }
                </div>
              </div>
              @if (availability().note; as note) {
                <p class="note" [class.warn]="!availability().available">{{ note }}</p>
              }
              @if (problem(); as p) {
                <p class="small muted">{{ p }}</p>
              }
              <div class="actions">
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="busy() || !!problem() || !availability().available"
                >
                  {{ busy() ? 'Preparing…' : 'Get my install line' }}
                </button>
              </div>
            </form>
          } @else {
            <p class="pad muted">
              Adding a computer needs the "connect accounts" permission. Ask an administrator of your
              organisation to do it, or to give you that permission.
            </p>
          }
        </section>

        <!-- 2. The one line -->
        @if (created(); as c) {
          <section class="card">
            <header class="card-head">
              <h3>
                <span class="num">2</span>{{ pkgOffered() ? 'Install it on the ' + osName() : 'Paste this line on the ' + osName() }}
              </h3>
            </header>
            <div class="card-body">
              @if (expiry().expired) {
                <p class="note warn" role="alert">
                  This line has expired, so it will not work any more.
                </p>
                <div class="actions">
                  <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="remake()">
                    {{ busy() ? 'Preparing…' : 'Make a new line' }}
                  </button>
                </div>
              } @else if (command(); as cmd) {
                @if (pkgOffered()) {
                  <h4>Easiest: download the installer and double-click it</h4>
                  <ol class="how">
                    @for (s of installerSteps(); track $index) {
                      <li>{{ s }}</li>
                    }
                  </ol>
                  <div class="actions">
                    <button
                      type="button"
                      class="btn btn-primary"
                      [disabled]="downloadingPkg()"
                      (click)="downloadInstaller(c.token)"
                    >
                      {{ downloadingPkg() ? 'Downloading…' : 'Download the installer' }}
                    </button>
                  </div>
                  <p class="small muted">{{ whyAsked() }}</p>
                  <h4>Or paste this line in {{ shellName() }}</h4>
                }
                <div class="command">
                  <pre aria-label="Install line">{{ cmd }}</pre>
                  <button type="button" class="btn btn-primary" (click)="copy(cmd)">
                    {{ copied() ? 'Copied' : 'Copy' }}
                  </button>
                </div>
                <p class="small muted">
                  Works once, for this computer only. It expires {{ expiry().text }}
                  ({{ when(c.expiresAtUtc) }}). It is shown only on this page — keep the page open
                  until the computer is connected.
                </p>
                <ol class="how">
                  @for (s of shellSteps(); track $index) {
                    <li>{{ s }}</li>
                  }
                </ol>
                <h4>What this does</h4>
                <ul class="what">
                  @for (w of whatItDoes; track $index) {
                    <li>{{ w }}</li>
                  }
                </ul>
              } @else {
                <p class="muted">Loading the install line…</p>
              }
            </div>
          </section>
        }

        <!-- 3. Progress -->
        @if (tokenId() !== null) {
          <section class="card" aria-live="polite">
            <header class="card-head">
              <h3><span class="num">{{ created() ? 3 : 2 }}</span>Connecting</h3>
              <span class="spacer"></span>
              <button type="button" class="btn btn-sm btn-secondary" (click)="pollNow()">
                Check now
              </button>
            </header>
            <div class="card-body">
              @if (progressError(); as err) {
                <p role="alert"><span class="chip bad">Could not read the progress</span> {{ err }}</p>
              }
              @if (progress(); as p) {
                @if (p.kind && p.kind !== 'Daemon') {
                  <p class="note warn">
                    This is a code for one EA terminal, not for a computer.
                    <a [routerLink]="['/organisation/terminals/connect']" [queryParams]="{ token: p.tokenId }"
                      >Follow it on the terminal page</a
                    >.
                  </p>
                } @else {
                  <p class="headline">
                    <span class="chip" [class]="headline().tone">{{ headline().text }}</span>
                  </p>
                  @if (allDone()) {
                    <div class="green">
                      <strong>All set.</strong> {{ p.daemon?.name ?? 'The computer' }} is connected and
                      every terminal's EA is reaching the engine. The supervisor keeps the terminals
                      running from now on.
                      <div class="actions">
                        <a class="btn btn-primary" routerLink="/organisation/terminals">See my terminals</a>
                        <button type="button" class="btn btn-secondary" (click)="startOver()">
                          Add another computer
                        </button>
                      </div>
                    </div>
                  }
                  <ul class="progress">
                    @for (s of p.steps; track s.key) {
                      <li>
                        <span class="dot" [class]="s.state" [attr.aria-label]="s.state"></span>
                        <span>
                          {{ s.title }}
                          @if (s.detail) {
                            <span class="sub">{{ s.detail }}</span>
                          }
                        </span>
                      </li>
                    }
                  </ul>

                  @if (p.daemon; as d) {
                    @if (d.installs.length) {
                      <h4>Terminals on this computer</h4>
                      @for (i of d.installs; track i.installId) {
                        <div class="terminal">
                          <div class="terminal-head">
                            <strong>{{ i.name }}</strong>
                            <span class="small muted">{{ accountText(i) }}</span>
                            @if (runningText(i); as rt) {
                              <span class="chip" [class.ok]="i.running === true">{{ rt }}</span>
                            }
                          </div>
                          @if (i.eaInstances.length === 0) {
                            <div class="ea-line">
                              <span class="chip warn">No EA yet</span>
                              <span>
                                The Lascodia EA is not on a chart in this terminal.
                                <a routerLink="/organisation/terminals/connect">Put the EA on this terminal</a>
                                — it gives you the EA file and a code to paste into it.
                              </span>
                            </div>
                          }
                          @for (e of i.eaInstances; track e.instanceId) {
                            <div class="ea-line">
                              <span class="chip" [class]="status(e).tone">{{ e.status === 'ok' ? 'OK' : 'Action needed' }}</span>
                              <span>{{ status(e).text }} <span class="sub">{{ e.instanceId }}</span></span>
                            </div>
                          }
                        </div>
                      }
                    }
                  }

                  @if (showAllowList()) {
                    <div class="allow-box">
                      <strong>The one thing to do by hand: let MetaTrader 5 reach the engine</strong>
                      <span>In each terminal marked above:</span>
                      <div class="menu-path" aria-label="Menu path">
                        <span>Tools</span><span class="sep">›</span><span>Options</span><span class="sep">›</span
                        ><span>Expert Advisors</span><span class="sep">›</span
                        ><span>☑ Allow WebRequest for listed URL</span>
                      </div>
                      <span>Then click the empty line under it (or "Add new URL"), paste this address and press OK:</span>
                      <div class="command">
                        <pre aria-label="Address to allow">{{ allowUrl() }}</pre>
                        <button type="button" class="btn btn-secondary" (click)="copy(allowUrl())">Copy</button>
                      </div>
                      <span class="small muted"
                        >MetaTrader 5 only lets an EA call addresses on this list, and only you can change it — the
                        supervisor cannot do it for you. This page turns green within a minute of the change.</span
                      >
                    </div>
                  }

                  @if (p.hints.length) {
                    <h4>{{ p.connected ? 'Notes' : 'If it does not move' }}</h4>
                    @for (h of p.hints; track h.code) {
                      @if (h.code !== 'allowlist-4014' || !showAllowList()) {
                        <div class="hint" [class.observed]="h.observed">
                          <strong>{{ h.title }}</strong>
                          <div>{{ h.text }}</div>
                        </div>
                      }
                    }
                  }

                  @if ((p.stage === 'token-expired' || p.stage === 'token-revoked') && canCreate()) {
                    <div class="actions">
                      <button type="button" class="btn btn-primary" [disabled]="busy()" (click)="remake()">
                        {{ busy() ? 'Preparing…' : 'Make a new line' }}
                      </button>
                    </div>
                  }
                }
              } @else if (!progressError()) {
                <p class="muted">Waiting for your computer…</p>
              }
            </div>
          </section>
        }
      </div>
    </div>
  `,
})
export class AddComputerPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly labelMax = COMPUTER_LABEL_MAX;
  protected readonly whatItDoes = WHAT_IT_DOES;
  protected readonly osOptions: ComputerOs[] = ['macos', 'windows'];
  protected readonly status = eaStatus;
  protected readonly accountText = installAccountText;
  protected readonly runningText = installRunningText;

  readonly setup = iamResource<SupervisorSetup | null>(
    () => this.api.supervisorSetup(),
    null,
    'Could not load the install settings.',
  );

  readonly canCreate = computed(() => this.auth.hasPermission(Permission.AccountsConnect));
  readonly label = signal('');
  readonly os = signal<ComputerOs>(detectOs(globalThis.navigator) ?? 'windows');
  readonly osName = computed(() => osLabel(this.os()));
  readonly availability = computed(() => osAvailability(this.setup.value(), this.os()));
  readonly problem = computed(() =>
    this.label().trim() ? null : 'Give the computer a name first.',
  );
  readonly busy = signal(false);
  readonly copied = signal(false);
  readonly created = signal<EnrollmentTokenCreated | null>(null);
  readonly following = signal<number | null>(null);
  readonly tokenId = computed(() => this.created()?.id ?? this.following());
  readonly command = computed(() => {
    const c = this.created();
    return c ? installCommand(this.setup.value(), this.os(), c.token) : null;
  });
  readonly shellSteps = computed(() => openShellSteps(this.os()));
  /** A double-click installer is published for the chosen OS (the Mac .pkg or the Windows .exe). */
  readonly pkgOffered = computed(() => installerAvailable(this.setup.value(), this.os()));
  readonly downloadingPkg = signal(false);
  protected readonly installerSteps = computed(() => installerSteps(this.os()));
  protected readonly whyAsked = computed(() => installerWhyAsked(this.os()));
  protected readonly shellName = computed(() => shellName(this.os()));

  /** Re-evaluated every 30 s so the expiry line counts down. */
  private readonly now = signal(Date.now());
  readonly expiry = computed(() => expiresInText(this.created()?.expiresAtUtc, this.now()));

  readonly progress = signal<EnrollmentProgress | null>(null);
  readonly progressError = signal<string | null>(null);
  readonly headline = computed(() => daemonHeadline(this.progress()));
  readonly allDone = computed(() => isAllDone(this.progress()));
  readonly showAllowList = computed(() => anyAllowListProblem(this.progress()));
  readonly allowUrl = computed(() => this.setup.value()?.webRequestAllowUrl ?? '');

  private timer: ReturnType<typeof setTimeout> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.clock = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.stopPolling();
      if (this.clock !== null) clearInterval(this.clock);
      if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
    });
  }

  create(label = this.label().trim()): void {
    if (this.busy() || !label || !this.canCreate() || !this.availability().available) return;
    this.busy.set(true);
    this.api.createEnrollmentToken({ kind: 'Daemon', label }).subscribe({
      next: (c) => {
        this.busy.set(false);
        this.created.set(c);
        this.following.set(null);
        this.now.set(Date.now());
        this.startPolling();
      },
      error: (e) => {
        this.busy.set(false);
        const msg = failureMessage(e, 'The install line was not created.');
        if (msg) this.notify.error(msg);
      },
    });
  }

  /** A fresh line for the same computer name (the old one expired or was cancelled). */
  remake(): void {
    const label = this.created()?.label ?? this.progress()?.label ?? this.label().trim();
    if (!label) return;
    this.stopPolling();
    this.progress.set(null);
    this.create(label);
  }

  copy(text: string): void {
    if (!text) return;
    const done = () => {
      this.copied.set(true);
      if (this.copiedTimer !== null) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(false), 2_000);
    };
    const clip = globalThis.navigator?.clipboard;
    if (!clip?.writeText) {
      this.notify.error('This browser does not allow copying from the page: select the line and copy it by hand.');
      return;
    }
    clip.writeText(text).then(done, () =>
      this.notify.error('Copying was blocked by the browser: select the line and copy it by hand.'),
    );
  }

  /**
   * Saves the double-click installer named after this line's install code: the package reads the
   * code back from its own file name. Checked against the published SHA-256 before it is saved.
   */
  downloadInstaller(token: string): void {
    if (!token || this.downloadingPkg()) return;
    this.downloadingPkg.set(true);
    const os = this.os();
    this.api.downloadInstaller(installerPlatform(os)).subscribe({
      next: async (file) => {
        try {
          const verdict = await sha256Matches(await file.blob.arrayBuffer(), file.sha256);
          if (verdict === false) {
            this.notify.error('The downloaded installer does not match the published file, so it was not saved. Try again.');
            return;
          }
          saveBlob(file.blob, installerFileName(this.setup.value(), os, token));
          this.notify.success('Installer downloaded. Open it from your Downloads folder.');
        } finally {
          this.downloadingPkg.set(false);
        }
      },
      error: (e) => {
        this.downloadingPkg.set(false);
        this.notify.error(macInstallerErrorText(e));
      },
    });
  }

  startOver(): void {
    this.stopPolling();
    this.following.set(null);
    this.created.set(null);
    this.progress.set(null);
    this.progressError.set(null);
    this.label.set('');
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
    const delay = override ?? nextDaemonPollMs(p, Date.now() - this.startedAt);
    if (delay === null) return;
    this.timer = setTimeout(() => this.poll(), hidden ? Math.max(delay, 15_000) : delay);
  }
}
