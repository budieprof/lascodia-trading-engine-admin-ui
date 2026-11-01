import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';

import { EAAdminService } from '@core/services/ea-admin.service';
import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import type { EATerminalDto } from '@core/api/ea-selfheal.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { SecurityApiService } from '@features/security/security-api.service';
import type { EaReleaseInfo } from '@features/security/security.types';

import { EaActionDialogComponent } from './ea-action-dialog.component';
import { EaPruneFilesDialogComponent } from './ea-prune-files-dialog.component';
import { EaOpsService, type OpsAction } from './ea-ops.service';
import {
  actionCopy,
  agoText,
  beaconSummary,
  formatBytes,
  journalWarnings,
  shortSha,
  terminalActionBlocker,
  watchdogSummary,
  type ActionCopy,
} from './selfheal.logic';
import { SELFHEAL_PANEL_STYLES } from './selfheal-styles';

type TerminalAnswer = { ok: true; dto: EATerminalDto } | { ok: false; message: string };

const DISK_LOW_BYTES = 2 * 1024 ** 3;

/**
 * The instance's MT5 terminal as its host supervisor reports it, and every
 * terminal-level control: start / stop / restart, auto-heal, update the EA
 * build, force recovery. Each button goes through a confirm step and its
 * outcome lands in the page's results tray.
 */
@Component({
  selector: 'app-ea-terminal-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, EaActionDialogComponent, EaPruneFilesDialogComponent],
  template: `
    <section class="panel" aria-label="Terminal">
      <header class="panel-head">
        <h3>Terminal</h3>
        @if (dto(); as t) {
          <span class="meta">
            @if (t.runtimeUpdatedAt) {
              host report {{ ago(t.runtimeUpdatedAt) }}
            }
          </span>
        }
      </header>

      @if (answer(); as a) {
        @if (!a.ok) {
          <p class="error-line">{{ a.message }}</p>
        } @else {
          @let t = a.dto;
          @if (t.linkedBy === 'none') {
            <p class="empty">
              No supervised terminal is linked to this EA. The engine links one when the host's
              supervisor reports this EA's beacon (EA v8.47.259+) or a terminal signed in to the
              same account and server. Until then it cannot start, stop or update this terminal.
            </p>
          } @else {
            <dl class="kv">
              <dt>Host</dt>
              <dd>
                <span class="pill" [attr.data-tone]="t.daemonOnline ? 'ok' : 'bad'">{{
                  t.daemonOnline ? 'Online' : 'Offline'
                }}</span>
                {{ t.daemonName ?? t.daemonHostId ?? '—' }}
                @if (!t.daemonOnline && t.daemonLastSeenAt) {
                  <span class="muted small"> · last seen {{ ago(t.daemonLastSeenAt) }}</span>
                }
              </dd>

              <dt>Terminal</dt>
              <dd>
                {{ t.installName ?? t.installId }}
                <span class="muted small">
                  · linked by {{ t.linkedBy === 'beacon' ? "the EA's beacon" : 'account login' }}
                </span>
              </dd>

              <dt>Process</dt>
              <dd>
                @if (t.runtime; as rt) {
                  <span class="pill" [attr.data-tone]="rt.running ? 'ok' : 'bad'">{{
                    rt.running ? 'Running' : 'Not running'
                  }}</span>
                  @if (rt.running && rt.terminalPid) {
                    <span class="muted small mono"> pid {{ rt.terminalPid }}</span>
                  }
                  @if (rt.adopted) {
                    <span class="muted small"> · started outside the supervisor</span>
                  }
                } @else {
                  <span class="muted">Not reported (supervisor older than 0.3)</span>
                }
              </dd>

              <dt>Should be</dt>
              <dd>
                <span
                  class="pill"
                  [attr.data-tone]="t.desiredState === 'Stopped' ? 'muted' : 'ok'"
                  >{{ t.desiredState ?? 'Unknown' }}</span
                >
                @if (t.desiredStateChangedAt) {
                  <span class="muted small">
                    · set {{ ago(t.desiredStateChangedAt) }}
                    @if (t.desiredStateChangedBy) {
                      by {{ t.desiredStateChangedBy }}
                    }
                    @if (t.desiredStateReason) {
                      — {{ t.desiredStateReason }}
                    }
                  </span>
                }
              </dd>

              <dt>EA beacon</dt>
              <dd [class]="'tone-' + beacon().tone">{{ beacon().text }}</dd>

              <dt>Watchdog</dt>
              <dd>
                <span [class]="'tone-' + watchdog().tone">{{ watchdog().text }}</span>
                @if (t.runtime?.watchdog?.lastReason; as r) {
                  <div class="muted small">
                    Last action: {{ r }}
                    @if (watchdogLastAction()) {
                      ({{ ago(watchdogLastAction()) }})
                    }
                  </div>
                }
              </dd>

              @if (journal().length > 0) {
                <dt>Journal</dt>
                <dd>
                  @for (w of journal(); track w) {
                    <div class="tone-warn">{{ w }}</div>
                  }
                </dd>
              }

              <dt>Disk free</dt>
              <dd [class.tone-warn]="diskLow()">
                {{ bytes(t.runtime?.diskFreeBytes) }}
                @if (diskLow()) {
                  <span class="small"> — low; the terminal stops writing history when it fills</span>
                }
              </dd>

              <dt>EA build</dt>
              <dd>
                <span class="mono small">{{ sha(t.runtime?.eaBinarySha256) }}</span>
                @if (t.latestRelease; as rel) {
                  @if (t.eaBinaryIsLatest === true) {
                    <span class="pill" data-tone="ok">latest ({{ rel.version }})</span>
                  } @else if (t.eaBinaryIsLatest === false) {
                    <span class="pill" data-tone="warn">not the latest — {{ rel.version }} is available</span>
                  } @else {
                    <span class="muted small"> · latest release {{ rel.version }}</span>
                  }
                }
              </dd>

              <dt>Auto-heal</dt>
              <dd>
                <span class="pill" [attr.data-tone]="t.autoHeal ? 'ok' : 'muted'">{{
                  t.autoHeal ? 'On' : 'Off'
                }}</span>
                @if (!t.autoHeal && t.instanceAutoHeal && t.installAutoHeal === false) {
                  <span class="muted small"> · off for this terminal</span>
                }
              </dd>
            </dl>

            @if (blocker()) {
              <p class="blocker small">{{ blocker() }}</p>
            }

            <div class="actions">
              @if (canStart()) {
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  (click)="ask('terminal/start')"
                  [disabled]="!!blocker() || busy()"
                >
                  Start terminal
                </button>
              }
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                (click)="ask('terminal/restart')"
                [disabled]="!!blocker() || busy()"
              >
                Restart terminal
              </button>
              @if (t.desiredState !== 'Stopped' || t.runtime?.running) {
                <button
                  type="button"
                  class="btn btn-secondary btn-sm stop"
                  (click)="ask('terminal/stop')"
                  [disabled]="!!blocker() || busy()"
                >
                  Stop terminal
                </button>
              }
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                (click)="ask(t.autoHeal ? 'autoheal-off' : 'autoheal')"
                [disabled]="busy()"
              >
                {{ t.autoHeal ? 'Turn auto-heal off' : 'Turn auto-heal on' }}
              </button>
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                (click)="ask('force-recovery')"
                [disabled]="busy()"
                title="Clear a failed start-up recovery and let the EA return to running"
              >
                Force recovery
              </button>
              <button
                type="button"
                class="btn btn-sm"
                [class.btn-primary]="diskLow()"
                [class.btn-secondary]="!diskLow()"
                (click)="pruneOpen.set(true)"
                [disabled]="!!blocker() || busy()"
                title="List old logs and files of retired EA instances on the host, then delete them after you confirm"
              >
                Clean up old files
              </button>
              @if (t.latestRelease) {
                <button
                  type="button"
                  class="btn btn-sm"
                  [class.btn-primary]="t.eaBinaryIsLatest === false"
                  [class.btn-secondary]="t.eaBinaryIsLatest !== false"
                  (click)="ask('deploy')"
                  [disabled]="!!blocker() || busy()"
                >
                  Update EA to {{ t.latestRelease.version }}
                </button>
              }
            </div>
          }
        }
      } @else {
        <p class="empty">Loading terminal…</p>
      }
    </section>

    <app-ea-action-dialog
      [open]="!!pending()"
      [title]="copy()?.title ?? ''"
      [description]="copy()?.description ?? ''"
      [warning]="copy()?.warning ?? null"
      [confirmLabel]="copy()?.confirmLabel ?? 'Confirm'"
      [tone]="copy()?.tone ?? 'warn'"
      [askReason]="copy()?.askReason ?? false"
      [reasonRequired]="copy()?.reasonRequired ?? false"
      [busy]="busy()"
      (confirmed)="confirm($event)"
      (cancelled)="pending.set(null)"
    >
      @if (pending() === 'deploy') {
        @if (releases().length > 1) {
          <label class="field">
            <span>Build</span>
            <select [(ngModel)]="releaseId">
              <option [ngValue]="null">Latest ({{ dto()?.latestRelease?.version }})</option>
              @for (r of releases(); track r.id) {
                <option [ngValue]="r.id">{{ r.version }} · {{ r.publishedAtUtc.slice(0, 10) }}</option>
              }
            </select>
          </label>
        }
        <label class="check">
          <input type="checkbox" [(ngModel)]="restartAfter" />
          <span>Restart the EAs on the new build right away (otherwise it loads on their next restart)</span>
        </label>
      }
    </app-ea-action-dialog>

    <app-ea-prune-files-dialog
      [instanceId]="instanceId()"
      [open]="pruneOpen()"
      (closed)="pruneOpen.set(false); resource.refresh()"
    />
  `,
  styles: [
    SELFHEAL_PANEL_STYLES,
    `
      .blocker {
        margin: 0;
        color: var(--tone-amber);
      }
      .stop {
        color: var(--tone-red);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: var(--text-sm);
      }
      .field > span {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .field select {
        padding: 6px 10px;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border);
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .check {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        font-size: var(--text-sm);
      }
    `,
  ],
})
export class EaTerminalCardComponent {
  readonly instanceId = input<string>('');
  readonly refreshTick = input(0);

  private readonly admin = inject(EAAdminService);
  private readonly ops = inject(EaOpsService);
  private readonly auth = inject(AuthService);
  private readonly security = inject(SecurityApiService);

  private readonly now = signal(Date.now());

  protected readonly resource = createPolledResource<TerminalAnswer | null>(
    () => {
      const id = this.instanceId();
      if (!id) return of(null);
      return this.admin.getTerminal(id).pipe(
        map((r): TerminalAnswer =>
          r.status && r.data
            ? { ok: true, dto: r.data }
            : { ok: false, message: r.message ?? 'The engine could not find this terminal.' },
        ),
        catchError((err: { status?: number }) =>
          of<TerminalAnswer>({
            ok: false,
            message:
              err?.status === 404
                ? 'This engine version cannot manage terminals from here yet.'
                : 'The engine did not answer.',
          }),
        ),
      );
    },
    { intervalMs: 15_000 },
  );

  protected readonly answer = this.resource.value;
  protected readonly dto = computed(() => {
    const a = this.answer();
    return a && a.ok ? a.dto : null;
  });

  protected readonly beacon = computed(() => beaconSummary(this.dto()?.beacon, this.now()));
  protected readonly watchdog = computed(() =>
    watchdogSummary(this.dto()?.runtime?.watchdog, this.now()),
  );
  protected readonly watchdogLastAction = computed(
    () => this.dto()?.runtime?.watchdog?.lastActionUtc ?? null,
  );
  protected readonly journal = computed(() => journalWarnings(this.dto()?.runtime?.journalSignals));
  protected readonly blocker = computed(() => terminalActionBlocker(this.dto()));
  protected readonly diskLow = computed(() => {
    const free = this.dto()?.runtime?.diskFreeBytes;
    return free != null && free > 0 && free < DISK_LOW_BYTES;
  });
  protected readonly canStart = computed(() => {
    const t = this.dto();
    return !!t && (t.desiredState === 'Stopped' || t.runtime?.running === false);
  });

  // Releases for "Update EA" (platform staff only; everyone else gets "latest").
  protected readonly releases = signal<EaReleaseInfo[]>([]);
  private releasesLoaded = false;

  // Confirm flow -----------------------------------------------------------
  protected readonly pending = signal<OpsAction | null>(null);
  protected readonly busy = signal(false);
  protected readonly pruneOpen = signal(false);
  protected releaseId: number | null = null;
  protected restartAfter = true;
  protected readonly copy = computed<ActionCopy | null>(() => {
    const a = this.pending();
    if (!a) return null;
    const t = this.dto();
    return actionCopy(a, {
      installName: t?.installName ?? t?.installId,
      hostName: t?.daemonName,
      version: t?.latestRelease?.version ?? null,
    });
  });

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
    this.ops.settled$.pipe(takeUntilDestroyed()).subscribe(() => this.resource.refresh());
    // instanceId arrives after construction (the first poll ran with ''), so fetch as soon as it is known.
    let lastId = '';
    effect(() => {
      const id = this.instanceId();
      if (id && id !== lastId) {
        lastId = id;
        untracked(() => this.resource.refresh());
      }
    });
    let first = true;
    effect(() => {
      this.refreshTick();
      if (first) {
        first = false;
        return;
      }
      untracked(() => this.resource.refresh());
    });
  }

  protected ask(action: OpsAction): void {
    if (action === 'deploy') {
      this.releaseId = null;
      this.restartAfter = true;
      this.loadReleases();
    }
    this.pending.set(action);
  }

  protected confirm(reason: string): void {
    const action = this.pending();
    if (!action) return;
    const t = this.dto();
    const chosen = this.releases().find((r) => r.id === this.releaseId);
    const version = chosen?.version ?? t?.latestRelease?.version;
    this.busy.set(true);
    this.ops
      .run(this.instanceId(), action, {
        reason: reason || null,
        releaseId: action === 'deploy' ? this.releaseId : null,
        restartAfter: this.restartAfter,
        label: action === 'deploy' && version ? `Update EA to ${version}` : undefined,
      })
      .subscribe((ok) => {
        this.busy.set(false);
        if (ok) this.pending.set(null);
        this.resource.refresh();
      });
  }

  private loadReleases(): void {
    if (this.releasesLoaded || !this.auth.hasPermission(Permission.PlatformEaReleasesManage)) return;
    this.releasesLoaded = true;
    this.security
      .eaReleases()
      .pipe(catchError(() => of([] as EaReleaseInfo[])))
      .subscribe((rows) => this.releases.set(rows));
  }

  protected ago(iso: string | null | undefined): string {
    return agoText(iso, this.now());
  }
  protected bytes = formatBytes;
  protected sha = shortSha;
}
