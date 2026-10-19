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
 * Operator workflow: install the daemon (see lascodia-mt5-supervisor/README),
 * configure ~/.lascodia/supervisor.yaml with the MT5 installs, start the
 * daemon → it appears here within ~30s.  Click "Launch" → engine proxies
 * the call to the daemon → MT5 process starts.
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
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Terminals"
        subtitle="Launch, monitor and close MT5 terminals through the supervisor daemon running on each host."
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
        <!-- ── Daemons ───────────────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <h3>
              Daemons <span class="count">{{ daemons().length }}</span>
            </h3>
          </header>

          @if (daemonsErr()) {
            <app-error-state
              title="Could not load daemons"
              [message]="daemonsErr()!"
              (retry)="daemonsResource.refresh()"
            />
          } @else if (daemons().length === 0) {
            <app-empty-state
              title="No daemons registered"
              description="Install the lascodia-mt5-supervisor daemon on a host with one or more MT5 terminals and start it. The daemon registers itself on boot; it will appear here within ~30 seconds."
            />
          } @else {
            <div class="cards">
              @for (d of daemons(); track d.id) {
                <article class="card" [attr.data-online]="d.isOnline">
                  <header class="card-head">
                    <div>
                      <h4>{{ d.name }}</h4>
                      <p class="mono small muted">{{ d.daemonId }}</p>
                    </div>
                    <span class="status-pill" [attr.data-online]="d.isOnline">
                      {{ d.isOnline ? 'online' : 'offline' }}
                    </span>
                  </header>
                  <dl class="kv">
                    <dt>Base URL</dt>
                    <dd class="mono small">{{ d.baseUrl }}</dd>
                    <dt>Registered</dt>
                    <dd class="small">{{ d.registeredAt | date: 'yyyy-MM-dd HH:mm' }} UTC</dd>
                    <dt>Last seen</dt>
                    <dd class="small">
                      <span [title]="d.lastSeenAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                        {{ d.lastSeenAt | relativeTime }}
                      </span>
                    </dd>
                  </dl>
                  <details class="installs">
                    <summary>
                      {{ d.installs.length }} install{{ d.installs.length === 1 ? '' : 's' }}
                      advertised
                    </summary>
                    @for (i of d.installs; track i.installId) {
                      <div class="install-row">
                        <span class="mono small">{{ i.installId }}</span>
                        <span class="small">{{ i.name }}</span>
                        @if (i.brokerName) {
                          <span class="small muted">· {{ i.brokerName }}</span>
                        }
                        @if (i.accountLogin) {
                          <span class="small muted">· #{{ i.accountLogin }}</span>
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
                      </div>
                    }
                  </details>

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
                        !d.isOnline || !launchInstallByDaemon[d.id] || launchingForDaemon() === d.id
                      "
                    >
                      @if (launchingForDaemon() === d.id) {
                        Launching…
                      } @else {
                        Launch terminal
                      }
                    </button>
                  </form>

                  <!-- Phase-15 wave 1: opens the 3-stage Add Broker
                       Terminal wizard.  The wizard handles clone-mt5
                       + manual-step prompts + register-install; on
                       Done we refresh the daemons list so the new
                       install shows up in the dropdown above. -->
                  <button
                    type="button"
                    class="btn btn-secondary btn-add-broker"
                    [disabled]="!d.isOnline"
                    (click)="openWizardFor(d.id)"
                  >
                    + Add broker terminal
                  </button>

                  <!-- Phase-15 waves 2 + 3: daemon ops + observability.
                       Compact button strip with confirms for the
                       destructive ones; logs/config open inline. -->
                  <div class="daemon-ops">
                    <button
                      type="button"
                      class="btn-link"
                      [disabled]="!d.isOnline || daemonOpInFlight() === d.id + ':restart'"
                      (click)="onRestartDaemon(d.id, d.name)"
                    >
                      @if (daemonOpInFlight() === d.id + ':restart') {
                        Restarting…
                      } @else {
                        Restart daemon
                      }
                    </button>
                    <span class="dot">·</span>
                    <button
                      type="button"
                      class="btn-link warn"
                      [disabled]="!d.isOnline || daemonOpInFlight() === d.id + ':rotate'"
                      (click)="onRotateApiKey(d.id, d.name)"
                    >
                      @if (daemonOpInFlight() === d.id + ':rotate') {
                        Rotating…
                      } @else {
                        Rotate API key
                      }
                    </button>
                    <span class="dot">·</span>
                    <button
                      type="button"
                      class="btn-link"
                      [disabled]="!d.isOnline"
                      (click)="toggleLogs(d.id)"
                    >
                      @if (logsOpenFor() === d.id) {
                        Hide logs
                      } @else {
                        View logs
                      }
                    </button>
                    <span class="dot">·</span>
                    <button
                      type="button"
                      class="btn-link warn"
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

                  @if (logsOpenFor() === d.id) {
                    <pre class="logs-panel">{{ logsBuffer() || 'Loading…' }}</pre>
                  }

                  @if (orphansOpenFor() === d.id) {
                    <div class="orphans-panel">
                      @if (orphansLoading()) {
                        <p class="small muted">Scanning host for untracked terminal64.exe…</p>
                      } @else if (orphansErr()) {
                        <p class="small warn">{{ orphansErr() }}</p>
                      } @else if (orphansBuffer().length === 0) {
                        <p class="small muted">No orphan MT5 processes on this host.</p>
                      } @else {
                        <p class="small muted">
                          {{ orphansBuffer().length }} untracked terminal64.exe — choose carefully;
                          killing stops MT5 immediately and disconnects whatever was attached.
                        </p>
                        <table class="orphans-table">
                          <thead>
                            <tr>
                              <th>PID</th>
                              <th>Install hint</th>
                              <th>Started</th>
                              <th>Executable</th>
                              <th></th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (o of orphansBuffer(); track o.pid) {
                              <tr>
                                <td>
                                  <code>{{ o.pid }}</code>
                                </td>
                                <td>
                                  @if (o.installHint) {
                                    <code>{{ o.installHint }}</code>
                                  } @else {
                                    <span class="muted">—</span>
                                  }
                                </td>
                                <td>{{ o.startedAt | date: 'short' }}</td>
                                <td class="exe-cell" [title]="o.exePath ?? o.cmdline">
                                  {{ o.exePath ?? o.cmdline }}
                                </td>
                                <td class="actions">
                                  <button
                                    type="button"
                                    class="btn-link warn"
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
                                    class="btn-link warn"
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
                </article>
              }
            </div>
          }
        </section>

        <!-- ── Sessions ───────────────────────────────────────────── -->
        <section class="block">
          <header class="block-head">
            <h3>
              Sessions <span class="count">{{ sessions().length }}</span>
            </h3>
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
              description="Launch a terminal from a registered daemon above to see its session here."
            />
          } @else {
            <table class="grid">
              <thead>
                <tr>
                  <th>Daemon</th>
                  <th>Install</th>
                  <th>PID</th>
                  <th>Status</th>
                  <th>Launched</th>
                  <th>Last seen</th>
                  <th>Reason</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (s of sessions(); track s.id) {
                  <tr [attr.data-status]="s.status">
                    <td class="mono small">{{ s.daemonName }}</td>
                    <td class="mono small">{{ s.installId }}</td>
                    <td class="mono small">{{ s.pid ?? '—' }}</td>
                    <td>
                      <span class="status-pill" [attr.data-status]="s.status">{{ s.status }}</span>
                    </td>
                    <td class="small">{{ s.launchedAt | date: 'yyyy-MM-dd HH:mm' }} UTC</td>
                    <td class="small" [title]="s.lastSeenAt | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                      {{ s.lastSeenAt | relativeTime }}
                    </td>
                    <td class="small muted">{{ s.reason ?? '—' }}</td>
                    <td>
                      @if (s.stoppedAt === null && s.status !== 'Stopping') {
                        <button
                          type="button"
                          class="btn btn-secondary btn-sm"
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
  styles: [
    `
      /* Same frame as every other page: the extra side padding indented this page's title 16px. */
      .page {
        max-width: var(--page-max-width);
        margin: 0 auto;
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
      }
      .ask-details {
        margin: var(--space-2) 0 0;
        padding-left: 18px;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: 1.45;
      }
      .key-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--space-4);
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(4px);
      }
      .key-dialog {
        width: min(560px, 100%);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-5) var(--space-6);
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
      }
      .key-dialog h3 {
        margin: 0;
        font-size: var(--text-lg);
      }
      .key-dialog p {
        margin: 0;
      }
      .key-row {
        display: flex;
        gap: var(--space-2);
      }
      .key-row .input {
        flex: 1;
        min-width: 0;
        height: 36px;
        padding: 0 var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-xs);
      }
      .key-remediation {
        white-space: pre-line;
        color: var(--text-secondary);
      }
      .key-actions {
        display: flex;
        justify-content: flex-end;
      }
      .block {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .block-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .block-head h3 {
        margin: 0;
        font-size: var(--text-md);
      }
      .count {
        font-size: var(--text-xs);
        background: var(--bg-tertiary);
        padding: 2px 8px;
        border-radius: 999px;
        color: var(--text-secondary);
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-left-color: var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .card[data-online='true'] {
        border-left-color: #34c759;
      }
      .card[data-online='false'] {
        border-left-color: #ff9500;
        opacity: 0.85;
      }
      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--space-2);
      }
      .card-head h4 {
        margin: 0;
        font-size: var(--text-sm);
      }
      .card-head p {
        margin: 2px 0 0;
      }
      .status-pill {
        font-size: 10px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
      .status-pill[data-online='true'] {
        background: #d4f4dc;
        color: #1d8a3e;
      }
      .status-pill[data-online='false'] {
        background: #fde0c2;
        color: #b56b00;
      }
      .status-pill[data-status='Running'] {
        background: #d4f4dc;
        color: #1d8a3e;
      }
      .status-pill[data-status='Starting'],
      .status-pill[data-status='Stopping'] {
        background: #fff4e0;
        color: #b56b00;
      }
      .status-pill[data-status='Stopped'] {
        background: #e9e9eb;
        color: #555;
      }
      .status-pill[data-status='Crashed'] {
        background: #fde0de;
        color: #c4290a;
      }
      .kv {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 0;
        font-size: var(--text-xs);
      }
      .kv dt {
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
      }
      .kv dd {
        margin: 0;
      }
      .installs {
        background: var(--bg-primary);
        padding: 8px 10px;
        border-radius: var(--radius-sm);
        font-size: var(--text-xs);
      }
      .installs summary {
        cursor: pointer;
        color: var(--text-secondary);
      }
      .install-row {
        display: flex;
        gap: 6px;
        align-items: baseline;
        padding: 4px 0;
        border-top: 1px solid var(--border);
        margin-top: 4px;
      }
      .install-row:first-of-type {
        border-top: none;
        margin-top: 8px;
      }
      .install-row-delete {
        margin-left: auto;
        background: none;
        border: none;
        cursor: pointer;
        color: var(--text-secondary);
        font-size: 14px;
        line-height: 1;
        padding: 0 6px;
      }
      .install-row-delete:hover:not(:disabled) {
        color: #c93631;
      }
      .install-row-delete:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .install-default-tag {
        margin-left: auto;
        padding: 2px 8px;
        background: rgba(0, 113, 227, 0.1);
        color: #0071e3;
        border-radius: 10px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: 600;
        cursor: help;
      }

      /* Wave 2/3: daemon ops button strip + logs panel */
      .daemon-ops {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--border);
        display: flex;
        gap: 4px;
        align-items: center;
        font-size: 12px;
      }
      .daemon-ops .btn-link {
        background: none;
        border: none;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 2px 4px;
        font-size: 12px;
      }
      .daemon-ops .btn-link:hover:not(:disabled) {
        color: var(--text-primary);
        text-decoration: underline;
      }
      .daemon-ops .btn-link.warn:hover:not(:disabled) {
        color: #c93631;
      }
      .daemon-ops .btn-link:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .daemon-ops .dot {
        color: var(--text-secondary);
      }
      .logs-panel {
        margin-top: 8px;
        padding: 10px;
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        background: var(--bg-tertiary);
        color: var(--text-primary);
        border-radius: 6px;
        max-height: 280px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .orphans-panel {
        margin-top: 8px;
        padding: 10px;
        background: var(--bg-tertiary);
        border-radius: 6px;
      }
      .orphans-panel .warn {
        color: #c93631;
      }
      .orphans-table {
        margin-top: 8px;
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .orphans-table th,
      .orphans-table td {
        padding: 6px 8px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: top;
      }
      .orphans-table th {
        font-weight: 600;
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .orphans-table .exe-cell {
        font-family: var(--font-mono, monospace);
        font-size: 11px;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .orphans-table .actions {
        white-space: nowrap;
        display: flex;
        gap: 8px;
      }
      .btn-add-broker {
        margin-top: 6px;
      }
      .launch-form {
        display: flex;
        gap: var(--space-2);
        align-items: center;
        flex-wrap: wrap;
      }
      .launch-form .input {
        flex: 1;
        min-width: 200px;
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--border);
        background: var(--bg-primary);
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
      }
      .grid {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-xs);
      }
      .grid th,
      .grid td {
        padding: 8px 10px;
        border-bottom: 1px solid var(--border);
        text-align: left;
      }
      .grid th {
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-size: 10px;
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }
      .btn {
        height: 32px;
        padding: 0 14px;
        font-size: var(--text-sm);
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .btn-sm {
        height: 28px;
        padding: 0 10px;
        font-size: var(--text-xs);
      }
      .btn-secondary {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        color: var(--text-primary);
      }
      .btn-primary {
        background: var(--accent);
        color: #fff;
        border: 1px solid var(--accent);
      }
      .btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .small {
        font-size: var(--text-xs);
      }
      .muted {
        color: var(--text-secondary);
      }
    `,
  ],
})
export class TerminalsPageComponent {
  private readonly terminals = inject(TerminalsService);
  private readonly notify = inject(NotificationService);

  constructor() {
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
