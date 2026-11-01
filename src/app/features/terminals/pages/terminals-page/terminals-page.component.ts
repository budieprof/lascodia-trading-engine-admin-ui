import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { catchError, finalize, map, of, tap } from 'rxjs';

import { TerminalsService } from '@core/services/terminals.service';
import type { DaemonOrphanDto, TerminalDaemonDto, TerminalSessionDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { ProgressBarComponent } from '@shared/components/ui/progress-bar/progress-bar.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { RefreshButtonComponent } from '@shared/components/refresh-button/refresh-button.component';
import { NotificationService } from '@core/notifications/notification.service';
import { AddBrokerTerminalWizardComponent } from '../../components/add-broker-terminal-wizard/add-broker-terminal-wizard.component';
import { Router, RouterLink } from '@angular/router';
import { supervisorUpdatePill, supervisorVersionText } from '../../supervisor-status.logic';
import {
  fleetSummary,
  orderSessions,
  runningOnInstall,
  sessionTone,
} from '../../terminals-page.logic';
import { EAInstancesService } from '@core/services/ea-instances.service';
import type { EAInstanceDto } from '@core/api/api.types';

/**
 * A daemon / session operation held until the operator confirms it. These used window.confirm(),
 * which an automated session dismisses unseen (that is why "Rotate API key" appeared to do
 * nothing) and which this console does not otherwise use.
 */
interface TerminalAsk {
  title: string;
  message: string;
  details?: string[];
  confirmLabel: string;
  variant: 'primary' | 'destructive';
  run: () => void;
}

/** A freshly rotated daemon key — shown once, in-page, with a copy button. */
interface RotatedKey {
  daemonName: string;
  key: string;
  remediation: string;
}

/**
 * Phase-12 admin page: cross-broker MT5 lifecycle management via the
 * lascodia-mt5-supervisor sidecar daemon.  Two main blocks:
 *
 *   1. Daemons — registered supervisors with online/offline pill, advertised
 *      installs, and a "Launch" form inline.
 *   2. Sessions — active + recently-closed terminal processes the daemon
 *      reported in its heartbeat, with a kill button per session.
 *
 * Operator workflow: "Add a computer" (organisation/terminals/add-computer, C9) gives one line to
 * paste on the host; the supervisor installs itself, finds the MT5 installs and appears here within
 * ~30s.  Click "Launch" → engine proxies the call to the daemon → MT5 process starts.
 */
@Component({
  selector: 'app-terminals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    PageHeaderComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    ProgressBarComponent,
    RelativeTimePipe,
    AddBrokerTerminalWizardComponent,
    ConfirmDialogComponent,
    ModalA11yDirective,
    RefreshButtonComponent,
    RouterLink,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Terminals"
        subtitle="Launch, monitor and close MT5 terminals through the supervisor running on each computer."
      >
        <a class="btn btn-primary btn-head" routerLink="/organisation/terminals/add-computer"
          >Add a computer</a
        >
        <!-- Bound to the resources' first-load flag, the old button never changed on a click. -->
        <app-refresh-button
          [refreshing]="daemonsResource.refreshing() || sessionsResource.refreshing()"
          (refresh)="refreshAll()"
        />
      </app-page-header>

      <ui-progress-bar [active]="loading()" />

      @if (initialLoading()) {
        <app-card-skeleton [lines]="6" />
      } @else {
        <!-- ── Fleet summary: the answer to "is anything wrong?" first ─────── -->
        @if (summary(); as f) {
          <section class="block" aria-label="Fleet summary">
            <div class="kpis">
              <div
                class="kpi"
                [class.pos]="f.daemonsTotal > 0 && f.daemonsOnline === f.daemonsTotal"
                [class.neg]="f.daemonsOnline < f.daemonsTotal"
              >
                <div class="lbl">Computers online</div>
                <div class="k-value">
                  {{ f.daemonsOnline }} <span class="of">of {{ f.daemonsTotal }}</span>
                </div>
                <div class="k-hint">Supervisor daemons reporting in</div>
              </div>
              <div class="kpi" [class.pos]="f.running > 0">
                <div class="lbl">Terminals running</div>
                <div class="k-value">{{ f.running }}</div>
                <div class="k-hint">
                  @if (f.inFlight > 0) {
                    {{ f.inFlight }} starting or stopping
                  } @else {
                    Launched by a supervisor
                  }
                </div>
              </div>
              <div class="kpi" [class.neg]="f.crashed > 0">
                <div class="lbl">Crashed</div>
                <div class="k-value">{{ f.crashed }}</div>
                <div class="k-hint">
                  {{ includeClosed ? 'Incl. the last 24 h' : 'Open sessions only' }} ·
                  {{ f.closed }} closed
                </div>
              </div>
              <div
                class="kpi"
                [class.pos]="activeEas().length > 0"
                [class.warn]="eaInstances().length > 0 && activeEas().length === 0"
              >
                <div class="lbl">EA instances active</div>
                <div class="k-value">
                  {{ activeEas().length }} <span class="of">of {{ eaInstances().length }}</span>
                </div>
                <div class="k-hint">Sending heartbeats (any launch method)</div>
              </div>
            </div>

            @if (f.attention.length > 0) {
              <div class="attention" [class.bad]="hasBadAttention()" role="status">
                <strong
                  >{{ f.attention.length }} thing{{ f.attention.length === 1 ? '' : 's' }} need{{
                    f.attention.length === 1 ? 's' : ''
                  }}
                  a look</strong
                >
                <ul>
                  @for (a of f.attention; track $index) {
                    <li>
                      <span
                        class="dot"
                        [class.bad]="a.tone === 'bad'"
                        [class.warn]="a.tone === 'warn'"
                        >{{ a.text }}</span
                      >
                    </li>
                  }
                </ul>
              </div>
            } @else if (f.daemonsTotal > 0) {
              <p class="allclear">
                <span class="dot ok">All computers online, no crashed sessions.</span>
              </p>
            }
          </section>
        }

        <!-- ── Computers (daemons) ───────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <div>
              <h3>
                Computers <span class="count">{{ daemons().length }}</span>
              </h3>
              <p class="block-sub">
                The supervisor daemon on each host, its MT5 installs and controls.
              </p>
            </div>
          </header>

          @if (daemonsErr()) {
            <app-error-state
              title="Could not load daemons"
              [message]="daemonsErr()!"
              (retry)="daemonsResource.refresh()"
            />
          } @else if (daemons().length === 0) {
            <app-empty-state
              title="No computers connected yet"
              description="Add the computer that runs MetaTrader 5: you get one line to paste on it, and it appears here within a minute with its terminals."
              actionLabel="Add a computer"
              (actionClick)="addComputer()"
            />
          } @else {
            <div class="cards">
              @for (d of daemons(); track d.id) {
                <article class="card" [attr.data-online]="d.isOnline">
                  <!-- Identity + status -->
                  <div class="card-sec">
                    <header class="card-head">
                      <div>
                        <h4>{{ d.name }}</h4>
                        <p class="ident mono">{{ d.daemonId }} · {{ d.baseUrl }}</p>
                      </div>
                      <div class="state">
                        <span class="dot" [class.ok]="d.isOnline" [class.bad]="!d.isOnline">{{
                          d.isOnline ? 'Online' : 'Offline'
                        }}</span>
                        <span
                          class="small faint"
                          [title]="
                            'Last seen ' +
                            (d.lastSeenAt | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC') +
                            ' UTC'
                          "
                          >seen {{ d.lastSeenAt | relativeTime }}</span
                        >
                      </div>
                    </header>
                    <p class="meta">
                      <span>{{ supervisorText(d.supervisor) }}</span>
                      @if (supervisorPill(d.supervisor); as pill) {
                        <span
                          class="pill"
                          [class.ok]="pill.tone === 'ok'"
                          [class.warn]="pill.tone === 'warn'"
                          [class.bad]="pill.tone === 'bad'"
                          [class.info]="pill.tone === 'info'"
                          [title]="pill.title"
                          >{{ pill.text }}</span
                        >
                      }
                      <span class="sep">·</span>
                      <span [title]="(d.registeredAt | date: 'yyyy-MM-dd HH:mm' : 'UTC') + ' UTC'"
                        >Registered {{ d.registeredAt | date: 'yyyy-MM-dd' : 'UTC' }}</span
                      >
                    </p>
                    @if (!d.isOnline) {
                      <p class="offline-note">
                        Not reporting in — launching, closing and the controls below are unavailable
                        until it is back.
                      </p>
                    }
                  </div>

                  <!-- Installs + launch -->
                  <div class="card-sec">
                    <div class="installs-head">
                      <span class="lbl"
                        >{{ d.installs.length }} install{{
                          d.installs.length === 1 ? '' : 's'
                        }}
                        advertised</span
                      >
                    </div>
                    @if (d.installs.length > 0) {
                      <ul class="installs">
                        @for (i of d.installs; track i.installId) {
                          <li class="install-row">
                            <span class="i-main">
                              <span class="i-line">
                                <span class="i-id">{{ i.installId }}</span>
                                <span class="muted">{{ i.name }}</span>
                              </span>
                              @if (i.brokerName || i.accountLogin) {
                                <span class="i-line faint">
                                  {{ i.brokerName }}{{ i.brokerName && i.accountLogin ? ' · ' : ''
                                  }}{{ i.accountLogin ? '#' + i.accountLogin : '' }}
                                </span>
                              }
                            </span>
                            @if (runningCount(d.id, i.installId); as n) {
                              <span
                                class="dot ok i-run"
                                title="Sessions launched by this supervisor that are running now"
                                >{{ n }} running</span
                              >
                            }
                            @if (i.isDefault) {
                              <span
                                class="install-default-tag"
                                title="Canonical source bundle — clone-mt5 reads from this install to seed every broker clone. Cannot be removed via the UI; the daemon refuses without an explicit ?force=true override."
                              >
                                default
                              </span>
                            } @else {
                              <button
                                type="button"
                                class="install-row-delete"
                                title="Remove from supervisor.yaml"
                                [attr.aria-label]="'Remove install ' + i.installId"
                                [disabled]="deletingInstall() === d.id + ':' + i.installId"
                                (click)="onDeleteInstall(d.id, i.installId)"
                              >
                                @if (deletingInstall() === d.id + ':' + i.installId) {
                                  …
                                } @else {
                                  ×
                                }
                              </button>
                            }
                          </li>
                        }
                      </ul>
                    }

                    <form class="launch-form" (submit)="$event.preventDefault(); onLaunch(d)">
                      <!-- The per-daemon value starts undefined, which left the
                           select with nothing selected (a blank control) instead
                           of the placeholder. Default it to '' on read. -->
                      <select
                        [ngModel]="launchInstallByDaemon[d.id] ?? ''"
                        (ngModelChange)="launchInstallByDaemon[d.id] = $event"
                        name="install-{{ d.id }}"
                        class="input"
                        [disabled]="!d.isOnline || launchingForDaemon() === d.id"
                        aria-label="Install to launch"
                      >
                        <option value="" disabled>Choose an install to launch…</option>
                        @for (i of d.installs; track i.installId) {
                          <option [value]="i.installId">{{ i.installId }} · {{ i.name }}</option>
                        }
                      </select>
                      <button
                        type="submit"
                        class="btn btn-primary"
                        [disabled]="
                          !d.isOnline ||
                          !launchInstallByDaemon[d.id] ||
                          launchingForDaemon() === d.id
                        "
                      >
                        @if (launchingForDaemon() === d.id) {
                          Launching…
                        } @else {
                          Launch terminal
                        }
                      </button>
                    </form>
                  </div>

                  <!-- Phase-15 waves 1-3: add broker (wizard), observability, daemon ops.
                       Confirms for the risky ones live in the handlers. -->
                  <div class="card-sec">
                    <div class="daemon-ops">
                      <div class="grp">
                        <!-- Opens the 3-stage Add Broker Terminal wizard; on Done we refresh
                             the daemons list so the new install shows up above. -->
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          [disabled]="!d.isOnline"
                          (click)="openWizardFor(d.id)"
                        >
                          + Add broker terminal
                        </button>
                        <button
                          type="button"
                          class="btn btn-ghost btn-sm"
                          [class.on]="logsOpenFor() === d.id"
                          [attr.aria-expanded]="logsOpenFor() === d.id"
                          [disabled]="!d.isOnline"
                          (click)="toggleLogs(d.id)"
                        >
                          @if (logsOpenFor() === d.id) {
                            Hide logs
                          } @else {
                            View logs
                          }
                        </button>
                        <button
                          type="button"
                          class="btn btn-ghost btn-sm"
                          [class.on]="orphansOpenFor() === d.id"
                          [attr.aria-expanded]="orphansOpenFor() === d.id"
                          [disabled]="!d.isOnline"
                          (click)="toggleOrphans(d.id)"
                          title="MT5 terminal64.exe processes running on the daemon host that the daemon is not tracking — typically pre-daemon manual launches or stale post-crash leftovers."
                        >
                          @if (orphansOpenFor() === d.id) {
                            Hide orphans
                          } @else {
                            Orphan processes
                          }
                        </button>
                      </div>
                      <div class="grp">
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
                          [disabled]="!d.isOnline || daemonOpInFlight() === d.id + ':restart'"
                          (click)="onRestartDaemon(d.id, d.name)"
                        >
                          @if (daemonOpInFlight() === d.id + ':restart') {
                            Restarting…
                          } @else {
                            Restart daemon
                          }
                        </button>
                        <button
                          type="button"
                          class="btn btn-danger btn-sm"
                          [disabled]="!d.isOnline || daemonOpInFlight() === d.id + ':rotate'"
                          (click)="onRotateApiKey(d.id, d.name)"
                        >
                          @if (daemonOpInFlight() === d.id + ':rotate') {
                            Rotating…
                          } @else {
                            Rotate API key
                          }
                        </button>
                      </div>
                    </div>

                    @if (logsOpenFor() === d.id) {
                      <div class="panel-head">
                        <span class="lbl">Supervisor log · last 200 lines</span>
                        <span class="small faint">refreshes every 5 s</span>
                      </div>
                      <pre class="logs-panel">{{ logsBuffer() || 'Loading…' }}</pre>
                    }

                    @if (orphansOpenFor() === d.id) {
                      <div class="orphans-panel">
                        <div class="panel-head">
                          <span class="lbl">Orphan MT5 processes</span>
                          <span class="small faint">rescans every 5 s</span>
                        </div>
                        @if (orphansLoading() && orphansBuffer().length === 0) {
                          <p class="small muted">Scanning host for untracked terminal64.exe…</p>
                        } @else if (orphansErr()) {
                          <p class="small warn">{{ orphansErr() }}</p>
                        } @else if (orphansBuffer().length === 0) {
                          <p class="small muted">No orphan MT5 processes on this host.</p>
                        } @else {
                          <p class="small warn">
                            {{ orphansBuffer().length }} untracked terminal64.exe — choose
                            carefully; killing stops MT5 immediately and disconnects whatever was
                            attached.
                          </p>
                          <table class="orphans-table">
                            <thead>
                              <tr>
                                <th class="num">PID</th>
                                <th>Install hint</th>
                                <th>Started</th>
                                <th>Executable</th>
                                <th><span class="sr-only">Actions</span></th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (o of orphansBuffer(); track o.pid) {
                                <tr>
                                  <td class="num mono">{{ o.pid }}</td>
                                  <td>
                                    @if (o.installHint) {
                                      <code>{{ o.installHint }}</code>
                                    } @else {
                                      <span class="muted">—</span>
                                    }
                                  </td>
                                  <td class="num">{{ o.startedAt | date: 'yyyy-MM-dd HH:mm' }}</td>
                                  <td class="exe-cell" [title]="o.exePath ?? o.cmdline">
                                    {{ o.exePath ?? o.cmdline }}
                                  </td>
                                  <td class="actions">
                                    <button
                                      type="button"
                                      class="btn btn-danger btn-sm"
                                      [disabled]="killingOrphanPid() === o.pid"
                                      (click)="onKillOrphan(d.id, o.pid, false)"
                                    >
                                      @if (killingOrphanPid() === o.pid) {
                                        Killing…
                                      } @else {
                                        Kill
                                      }
                                    </button>
                                    <button
                                      type="button"
                                      class="btn btn-danger btn-sm"
                                      [disabled]="killingOrphanPid() === o.pid"
                                      (click)="onKillOrphan(d.id, o.pid, true)"
                                      title="SIGKILL immediately — use when MT5 is unresponsive."
                                    >
                                      Force
                                    </button>
                                  </td>
                                </tr>
                              }
                            </tbody>
                          </table>
                        }
                      </div>
                    }
                  </div>
                </article>
              }
            </div>
          }
        </section>

        <!-- ── Sessions ───────────────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <div>
              <h3>
                Sessions <span class="count">{{ sessions().length }}</span>
              </h3>
              <p class="block-sub">
                Terminals a supervisor launched. Crashed first, then running, then closed.
              </p>
            </div>
            <label class="check">
              <input
                type="checkbox"
                [(ngModel)]="includeClosed"
                (ngModelChange)="onIncludeClosedChange()"
              />
              <span class="small muted">Include recently closed (24h)</span>
            </label>
          </header>

          @if (sessionsErr()) {
            <app-error-state
              title="Could not load sessions"
              [message]="sessionsErr()!"
              (retry)="sessionsResource.refresh()"
            />
          } @else if (sessions().length === 0) {
            <app-empty-state
              title="No terminal sessions"
              description="A session exists only for a terminal the supervisor daemon launched. Terminals started by hand (the MT5 apps) still trade — their EA instances are listed below."
            />
            <!-- The terminals that ARE running: EA instances reporting heartbeats, launched outside the daemon. -->
            <div class="ea-context">
              <h4>
                EA instances connected now
                <span class="count"
                  >{{ activeEas().length }} active of {{ eaInstances().length }}</span
                >
              </h4>
              @if (activeEas().length === 0) {
                <p class="muted small">No EA instance is sending heartbeats.</p>
              } @else {
                <div class="tablecard">
                  <table class="grid">
                    <thead>
                      <tr>
                        <th>Instance</th>
                        <th>Account</th>
                        <th>Chart</th>
                        <th>Symbols</th>
                        <th>EA</th>
                        <th>Heartbeat</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (e of activeEas(); track e.id) {
                        <tr>
                          <td>
                            <a [routerLink]="['/ea-instances', e.id]">#{{ e.id }}</a
                            >{{ e.isCoordinator ? ' · coordinator' : '' }}
                          </td>
                          <td>
                            <a [routerLink]="['/trading-accounts', e.tradingAccountId]"
                              >#{{ e.tradingAccountId }}</a
                            >
                          </td>
                          <td>{{ e.chartSymbol }} {{ e.chartTimeframe }}</td>
                          <td class="syms">{{ e.symbols }}</td>
                          <td class="mono">{{ e.eaVersion }}</td>
                          <td>{{ e.lastHeartbeat | relativeTime }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              }
            </div>
          } @else {
            <div class="tablecard">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Computer</th>
                    <th>Install</th>
                    <th class="num">PID</th>
                    <th>Launched</th>
                    <th>Last seen</th>
                    <th>Reason</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (s of orderedSessions(); track s.id) {
                    <tr [attr.data-status]="s.status" [class.closed]="s.stoppedAt !== null">
                      <td>
                        <span
                          class="dot"
                          [class.ok]="tone(s.status) === 'ok'"
                          [class.warn]="tone(s.status) === 'warn'"
                          [class.bad]="tone(s.status) === 'bad'"
                          >{{ s.status }}</span
                        >
                      </td>
                      <td>{{ s.daemonName }}</td>
                      <td class="mono">{{ s.installId }}</td>
                      <td class="num mono">{{ s.pid ?? '—' }}</td>
                      <td [title]="(s.launchedAt | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC') + ' UTC'">
                        {{ s.launchedAt | relativeTime }}
                        <span class="sub"
                          >{{ s.launchedAt | date: 'yyyy-MM-dd HH:mm' : 'UTC' }} UTC</span
                        >
                      </td>
                      <td [title]="(s.lastSeenAt | date: 'yyyy-MM-dd HH:mm:ss' : 'UTC') + ' UTC'">
                        {{ s.lastSeenAt | relativeTime }}
                      </td>
                      <td class="muted">{{ s.reason ?? '—' }}</td>
                      <td class="act">
                        @if (s.stoppedAt === null && s.status !== 'Stopping') {
                          <button
                            type="button"
                            class="btn btn-danger btn-sm"
                            title="Stops this MT5 terminal — asks first"
                            (click)="askClose(s)"
                            [disabled]="closingSessionId() === s.id"
                          >
                            @if (closingSessionId() === s.id) {
                              Closing…
                            } @else {
                              Close
                            }
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
      <!-- Phase-15 wave 1: the wizard is a top-layer <dialog> that lives
           outside the page-flow.  We pass the currently-selected daemon
           via wizardDaemonId(); the wizard reads the daemon id at open
           time and ignores changes until reopen. -->
      @if (wizardDaemonId() !== null) {
        <app-add-broker-terminal-wizard
          [daemonId]="wizardDaemonId()!"
          [daemonName]="wizardDaemonName()"
          [open]="wizardOpen()"
          (closed)="onWizardClosed($event)"
        />
      }

      <app-confirm-dialog
        [open]="ask() !== null"
        [title]="ask()?.title ?? ''"
        [message]="ask()?.message ?? ''"
        [confirmLabel]="ask()?.confirmLabel ?? 'Confirm'"
        [confirmVariant]="ask()?.variant ?? 'primary'"
        (confirm)="confirmAsk()"
        (cancelled)="ask.set(null)"
      >
        @if (ask()?.details?.length) {
          <ul class="ask-details">
            @for (line of ask()!.details!; track $index) {
              <li>{{ line }}</li>
            }
          </ul>
        }
      </app-confirm-dialog>

      @if (rotatedKey(); as rk) {
        <div class="key-overlay" role="presentation">
          <div
            class="key-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rotated-key-title"
            appModalA11y
            (dismiss)="rotatedKey.set(null)"
          >
            <h3 id="rotated-key-title">New API key for {{ rk.daemonName }}</h3>
            <p class="small muted">
              Shown once. Copy it before closing — the engine still has the old key pinned.
            </p>
            <div class="key-row">
              <input
                class="input mono"
                readonly
                [value]="rk.key"
                aria-label="New daemon API key"
                (focus)="$any($event.target).select()"
              />
              <button
                type="button"
                class="btn btn-primary"
                (click)="copyKey(rk.key)"
                data-autofocus
              >
                Copy
              </button>
            </div>
            @if (rk.remediation) {
              <p class="small key-remediation">{{ rk.remediation }}</p>
            }
            <div class="key-actions">
              <button type="button" class="btn btn-secondary" (click)="rotatedKey.set(null)">
                Done
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styleUrl: './terminals-page.scss',
})
export class TerminalsPageComponent {
  private readonly terminals = inject(TerminalsService);
  private readonly eaService = inject(EAInstancesService);
  protected readonly eaInstances = signal<EAInstanceDto[]>([]);
  protected readonly activeEas = computed(() =>
    this.eaInstances().filter((e) => e.status === 'Active'),
  );
  private readonly notify = inject(NotificationService);
  private readonly router = inject(Router);

  // C9: the supervisor version / self-update line on each computer card.
  protected readonly supervisorText = supervisorVersionText;
  protected readonly supervisorPill = supervisorUpdatePill;

  protected addComputer(): void {
    void this.router.navigate(['/organisation/terminals/add-computer']);
  }

  constructor() {
    this.eaService.list().subscribe({
      next: (r) => this.eaInstances.set(r?.data ?? []),
      error: () => this.eaInstances.set([]),
    });
    // Ensure the log-tail poll is torn down on navigate-away.  Without
    // this, leaving the Terminals page with logs open keeps a setInterval
    // alive forever and would also keep polling the engine.
    inject(DestroyRef).onDestroy(() => {
      if (this.logsPollHandle) {
        clearInterval(this.logsPollHandle);
        this.logsPollHandle = null;
      }
      if (this.orphansPollHandle) {
        clearInterval(this.orphansPollHandle);
        this.orphansPollHandle = null;
      }
    });
  }

  protected includeClosed = true;
  // launchInstallByDaemon[daemonId] holds the dropdown value per daemon card.
  // A daemon the operator has not touched has no entry, hence `| undefined`
  // — the template falls back to '' so the placeholder option is selected.
  protected launchInstallByDaemon: Record<number, string | undefined> = {};
  protected readonly launchingForDaemon = signal<number | null>(null);
  protected readonly closingSessionId = signal<number | null>(null);

  // Phase-15 wave 1: Add Broker Terminal wizard state.
  // Null → wizard not mounted.  Set to a daemonId on "+ Add broker terminal"
  // click; wizard mounts and opens via showModal().  The `open` signal
  // separately tracks the dialog's visibility so reopening the same
  // daemon's wizard re-runs the open effect.
  protected readonly wizardDaemonId = signal<number | null>(null);
  protected readonly wizardDaemonName = signal<string>('');
  protected readonly wizardOpen = signal<boolean>(false);

  // Phase-15 waves 2 + 3: install-CRUD + daemon-ops state.
  // - deletingInstall: "<daemonId>:<installId>" while a delete is in flight.
  // - daemonOpInFlight: "<daemonId>:restart" or "<daemonId>:rotate".
  // - logsOpenFor: daemon id whose log tail is currently shown inline.
  // - logsBuffer: the rendered log text; refreshes on 5s tick while open.
  protected readonly deletingInstall = signal<string | null>(null);
  protected readonly daemonOpInFlight = signal<string | null>(null);
  protected readonly logsOpenFor = signal<number | null>(null);
  protected readonly logsBuffer = signal<string>('');
  private logsPollHandle: ReturnType<typeof setInterval> | null = null;

  // Orphan MT5 processes — untracked terminal64.exe instances on the
  // daemon host.  Refreshes every 5 s while the panel is open so a
  // freshly-crashed MT5 shows up without manual reload.
  protected readonly orphansOpenFor = signal<number | null>(null);
  protected readonly orphansBuffer = signal<DaemonOrphanDto[]>([]);
  protected readonly orphansLoading = signal<boolean>(false);
  protected readonly orphansErr = signal<string | null>(null);
  protected readonly killingOrphanPid = signal<number | null>(null);
  private orphansPollHandle: ReturnType<typeof setInterval> | null = null;

  // ── Polled resources ──────────────────────────────────────────────
  protected readonly daemonsResource = createPolledResource(
    () =>
      this.terminals.listDaemons().pipe(
        map((res) => res.data ?? []),
        // A later success clears an earlier failure; the error used to stick until "Refresh".
        tap(() => this.daemonsErr.set(null)),
        catchError((err) => {
          this.daemonsErr.set(err?.message ?? 'Failed to load daemons.');
          return of<TerminalDaemonDto[]>([]);
        }),
      ),
    { intervalMs: 15_000 },
  );

  protected readonly sessionsResource = createPolledResource(
    () =>
      this.terminals.listSessions({ includeClosed: this.includeClosed }).pipe(
        map((res) => res.data ?? []),
        tap(() => this.sessionsErr.set(null)),
        catchError((err) => {
          this.sessionsErr.set(err?.message ?? 'Failed to load sessions.');
          return of<TerminalSessionDto[]>([]);
        }),
      ),
    { intervalMs: 10_000 },
  );

  protected readonly daemonsErr = signal<string | null>(null);
  protected readonly sessionsErr = signal<string | null>(null);
  protected readonly daemons = computed(() => this.daemonsResource.value() ?? []);
  protected readonly sessions = computed(() => this.sessionsResource.value() ?? []);

  // Presentation only: the headline summary and attention-first order, from the rows above.
  protected readonly summary = computed(() => fleetSummary(this.daemons(), this.sessions()));
  protected readonly hasBadAttention = computed(() =>
    this.summary().attention.some((a) => a.tone === 'bad'),
  );
  protected readonly orderedSessions = computed(() => orderSessions(this.sessions()));
  protected readonly tone = sessionTone;
  protected runningCount(daemonId: number, installId: string): number {
    return runningOnInstall(this.sessions(), daemonId, installId);
  }

  protected readonly loading = computed(
    () => this.daemonsResource.loading() || this.sessionsResource.loading(),
  );
  protected readonly initialLoading = computed(
    () =>
      (this.daemonsResource.loading() && this.daemonsResource.value() === null) ||
      (this.sessionsResource.loading() && this.sessionsResource.value() === null),
  );

  protected refreshAll(): void {
    this.daemonsErr.set(null);
    this.sessionsErr.set(null);
    this.daemonsResource.refresh();
    this.sessionsResource.refresh();
  }

  protected onIncludeClosedChange(): void {
    this.sessionsResource.refresh();
  }

  // ── Confirmations ──────────────────────────────────────────────────
  protected readonly ask = signal<TerminalAsk | null>(null);
  protected readonly rotatedKey = signal<RotatedKey | null>(null);

  protected confirmAsk(): void {
    const a = this.ask();
    this.ask.set(null);
    a?.run();
  }

  protected copyKey(key: string): void {
    if (!navigator.clipboard?.writeText) {
      this.notify.error('Clipboard unavailable — select the key and copy it manually.');
      return;
    }
    navigator.clipboard
      .writeText(key)
      .then(() => this.notify.success('API key copied.'))
      .catch(() => this.notify.error('Copy failed — select the key and copy it manually.'));
  }

  // Phase-15 waves 2 + 3 — install delete + daemon ops + log tail.

  protected onDeleteInstall(daemonId: number, installId: string): void {
    this.ask.set({
      title: `Remove install '${installId}'?`,
      message:
        'The daemon stops advertising it; running sessions on this install must be closed first.',
      confirmLabel: 'Remove install',
      variant: 'destructive',
      run: () => this.deleteInstall(daemonId, installId),
    });
  }

  private deleteInstall(daemonId: number, installId: string): void {
    const key = `${daemonId}:${installId}`;
    this.deletingInstall.set(key);
    this.terminals
      .deleteInstallOnDaemon(daemonId, installId)
      .pipe(finalize(() => this.deletingInstall.set(null)))
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(`Removed install '${installId}'.`);
            this.daemonsResource.refresh();
          } else {
            this.notify.error(res.message ?? 'Delete failed.');
          }
        },
        error: (err) => this.notify.error(err?.error?.message ?? 'Delete failed.'),
      });
  }

  protected onRestartDaemon(daemonId: number, daemonName: string): void {
    this.ask.set({
      title: `Restart daemon '${daemonName}'?`,
      message:
        "The daemon self-exits and launchd's KeepAlive respawns it within ~2 s. Running MT5 " +
        'sessions survive (spawned with start_new_session=True) — only the supervisor process ' +
        'restarts.',
      confirmLabel: 'Restart daemon',
      variant: 'primary',
      run: () => this.restartDaemon(daemonId, daemonName),
    });
  }

  private restartDaemon(daemonId: number, daemonName: string): void {
    const key = `${daemonId}:restart`;
    this.daemonOpInFlight.set(key);
    this.terminals
      .restartDaemon(daemonId)
      .pipe(finalize(() => this.daemonOpInFlight.set(null)))
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(
              `Daemon '${daemonName}' restart requested (exit scheduled in ${res.data?.scheduledExitInMs ?? 200}ms).`,
            );
            // Give launchd ~3s to respawn before refreshing.
            setTimeout(() => this.daemonsResource.refresh(), 3000);
          } else {
            this.notify.error(res.message ?? 'Restart failed.');
          }
        },
        error: (err) => this.notify.error(err?.error?.message ?? 'Restart failed.'),
      });
  }

  protected onRotateApiKey(daemonId: number, daemonName: string): void {
    this.ask.set({
      title: `Rotate the API key for '${daemonName}'?`,
      message:
        "The engine's TOFU rule keeps the OLD key pinned, so after rotation the daemon is LOCKED " +
        'OUT of /auth until you either:',
      details: [
        'delete the engine-side TerminalDaemon row, or',
        'update its DaemonApiKey column to the new value,',
        '…and then restart the daemon so it re-authenticates.',
        'The new key is shown once on the next screen — copy it there.',
      ],
      confirmLabel: 'Rotate key',
      variant: 'destructive',
      run: () => this.rotateApiKey(daemonId, daemonName),
    });
  }

  private rotateApiKey(daemonId: number, daemonName: string): void {
    const key = `${daemonId}:rotate`;
    this.daemonOpInFlight.set(key);
    this.terminals
      .rotateDaemonApiKey(daemonId)
      .pipe(finalize(() => this.daemonOpInFlight.set(null)))
      .subscribe({
        next: (res) => {
          if (res.status && res.data) {
            // Operators paste the key into a DB row and restart the daemon, so it is shown
            // in-page with a copy button (an alert's text could not be copied reliably).
            this.rotatedKey.set({
              daemonName,
              key: res.data.newApiKey,
              remediation: res.data.remediation ?? '',
            });
          } else {
            this.notify.error(res.message ?? 'Rotate failed.');
          }
        },
        error: (err) => this.notify.error(err?.error?.message ?? 'Rotate failed.'),
      });
  }

  protected toggleLogs(daemonId: number): void {
    if (this.logsOpenFor() === daemonId) {
      this.logsOpenFor.set(null);
      this.logsBuffer.set('');
      if (this.logsPollHandle) {
        clearInterval(this.logsPollHandle);
        this.logsPollHandle = null;
      }
      return;
    }
    // Switching daemons: cancel any in-flight poll for the previous one.
    if (this.logsPollHandle) {
      clearInterval(this.logsPollHandle);
      this.logsPollHandle = null;
    }
    this.logsOpenFor.set(daemonId);
    this.logsBuffer.set('');
    this.refreshLogsBuffer(daemonId);
    this.logsPollHandle = setInterval(() => this.refreshLogsBuffer(daemonId), 5000);
  }

  private refreshLogsBuffer(daemonId: number): void {
    this.terminals.tailDaemonLogs(daemonId, 200).subscribe({
      next: (res) => {
        // Defensive: the operator may have switched daemons between
        // the request firing and the response landing.  Only update
        // the buffer if the open id still matches.
        if (this.logsOpenFor() !== daemonId) return;
        if (res.status && res.data?.available) {
          this.logsBuffer.set(res.data.lines.join('\n'));
        } else if (res.data && !res.data.available) {
          this.logsBuffer.set(
            `(no log file at ${res.data.path} yet — daemon may have just started)`,
          );
        } else {
          this.logsBuffer.set(`(error: ${res.message ?? 'unknown'})`);
        }
      },
      error: () => {
        if (this.logsOpenFor() === daemonId) {
          this.logsBuffer.set('(error tailing daemon logs)');
        }
      },
    });
  }

  // Orphan MT5 processes — list + kill.

  protected toggleOrphans(daemonId: number): void {
    if (this.orphansOpenFor() === daemonId) {
      this.orphansOpenFor.set(null);
      this.orphansBuffer.set([]);
      this.orphansErr.set(null);
      if (this.orphansPollHandle) {
        clearInterval(this.orphansPollHandle);
        this.orphansPollHandle = null;
      }
      return;
    }
    if (this.orphansPollHandle) {
      clearInterval(this.orphansPollHandle);
      this.orphansPollHandle = null;
    }
    this.orphansOpenFor.set(daemonId);
    this.orphansBuffer.set([]);
    this.orphansErr.set(null);
    this.refreshOrphans(daemonId);
    this.orphansPollHandle = setInterval(() => this.refreshOrphans(daemonId), 5000);
  }

  private refreshOrphans(daemonId: number): void {
    this.orphansLoading.set(true);
    this.terminals
      .listOrphansOnDaemon(daemonId)
      .pipe(finalize(() => this.orphansLoading.set(false)))
      .subscribe({
        next: (res) => {
          if (this.orphansOpenFor() !== daemonId) return;
          if (res.status) {
            this.orphansBuffer.set(res.data ?? []);
            this.orphansErr.set(null);
          } else {
            this.orphansErr.set(res.message ?? 'Could not list orphan processes.');
          }
        },
        error: (err) => {
          if (this.orphansOpenFor() === daemonId) {
            this.orphansErr.set(err?.error?.message ?? 'Could not list orphan processes.');
          }
        },
      });
  }

  protected onKillOrphan(daemonId: number, pid: number, force: boolean): void {
    const action = force ? 'Force-kill (SIGKILL)' : 'Terminate (SIGTERM → SIGKILL after 10 s)';
    this.ask.set({
      title: `${action} MT5 process ${pid}?`,
      message: 'MT5 stops immediately; any chart with an EA attached disconnects from the engine.',
      confirmLabel: force ? 'Force-kill' : 'Terminate',
      variant: 'destructive',
      run: () => this.killOrphan(daemonId, pid, force),
    });
  }

  private killOrphan(daemonId: number, pid: number, force: boolean): void {
    this.killingOrphanPid.set(pid);
    this.terminals
      .killOrphanOnDaemon(daemonId, pid, { force, graceSeconds: 10 })
      .pipe(finalize(() => this.killingOrphanPid.set(null)))
      .subscribe({
        next: (res) => {
          if (res.status && res.data?.ok) {
            this.notify.success(
              `Killed pid=${pid} via ${res.data.method}` +
                (res.data.exitedWithinGrace ? '' : ' (did not exit within grace)'),
            );
            // Re-scan immediately so the list reflects the kill.
            this.refreshOrphans(daemonId);
          } else {
            this.notify.error(res.message ?? 'Kill failed.');
          }
        },
        error: (err) => this.notify.error(err?.error?.message ?? 'Kill failed.'),
      });
  }

  // Phase-15 wave 1 — wizard openers + close handler.
  protected openWizardFor(daemonId: number): void {
    const d = this.daemons().find((x) => x.id === daemonId);
    this.wizardDaemonName.set(d?.name ?? '');
    this.wizardDaemonId.set(daemonId);
    this.wizardOpen.set(true);
  }

  protected onWizardClosed(install: import('@core/api/api.types').DaemonInstallDto | null): void {
    this.wizardOpen.set(false);
    // Tear down the component on next tick so the dialog's close
    // animation finishes before unmount.
    setTimeout(() => this.wizardDaemonId.set(null), 200);
    if (install) {
      this.notify.success(
        `Registered ${install.installId} — broker ${install.brokerName || '?'} (#${install.accountLogin || '?'})`,
      );
      // Daemon's next heartbeat (≤30s) advertises the new install;
      // refresh sooner so the operator doesn't sit waiting.
      this.daemonsResource.refresh();
    }
  }

  protected onLaunch(daemon: TerminalDaemonDto): void {
    const installId = this.launchInstallByDaemon[daemon.id];
    if (!installId) return;
    this.launchingForDaemon.set(daemon.id);
    this.terminals
      .launch({ daemonId: daemon.id, installId })
      .pipe(finalize(() => this.launchingForDaemon.set(null)))
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(
              `Launch queued — daemon=${daemon.name} install=${installId} sessionId=${res.data?.id}`,
            );
            this.sessionsResource.refresh();
          } else {
            this.notify.error(res.message ?? 'Launch failed at the daemon.');
          }
        },
        error: (err) => this.notify.error(err?.error?.message ?? 'Launch failed.'),
      });
  }

  /** Closing a session stops that MT5 terminal — and every EA on its charts. It asks first. */
  protected askClose(session: TerminalSessionDto): void {
    this.ask.set({
      title: `Close terminal session ${session.id}?`,
      message:
        `Stops MT5 '${session.installId}' (pid ${session.pid ?? '?'}) on ${session.daemonName}. ` +
        'Every EA attached to its charts disconnects from the engine until the terminal is ' +
        'launched again.',
      confirmLabel: 'Close terminal',
      variant: 'destructive',
      run: () => this.onClose(session),
    });
  }

  private onClose(session: TerminalSessionDto): void {
    this.closingSessionId.set(session.id);
    this.terminals
      .closeSession(session.id, 'Operator-initiated close from admin UI')
      .pipe(finalize(() => this.closingSessionId.set(null)))
      .subscribe({
        next: (res) => {
          if (res.status) {
            this.notify.success(`Close request sent to daemon (sessionId=${session.id}).`);
            this.sessionsResource.refresh();
          } else {
            this.notify.error(res.message ?? 'Daemon refused the close request.');
          }
        },
        error: (err) => this.notify.error(err?.error?.message ?? 'Close failed.'),
      });
  }
}
