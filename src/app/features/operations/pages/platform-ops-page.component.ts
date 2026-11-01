import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { ConfigService } from '@core/services/config.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PlatformOpsApiService } from '../platform-ops-api.service';
import {
  expectedConfirmation,
  hostRequirements,
  isFinished,
  jobLine,
  leaderSummary,
  normaliseSetting,
  settingKind,
  shortImage,
  sizeText,
} from '../platform-ops.logic';
import type {
  HostJob,
  PlatformConfigValue,
  PlatformHostAction,
  PlatformOps,
} from '../platform-ops.types';

type PendingAction =
  | { kind: 'host'; action: PlatformHostAction; title: string; message: string }
  | { kind: 'setting'; setting: PlatformConfigValue; value: string }
  | { kind: 'deploy'; rollback: boolean };

/**
 * Operations → Platform (engine gaps program, zero-downtime): the money-path blue/green pair (which colour leads, both
 * colours' health, image and uptime, the swap history), backups and restore drills, alert delivery, the page's settings
 * — and the actions an operator runs day to day, executed by the ENGINE HOST's supervisor (never the api container a
 * deploy replaces): refresh status, back up now, run the restore drill, send a test alert, and — only while
 * Ops:ConsoleDeploy:Enabled — a blue/green deploy with typed confirmation, the high-risk-window check and four-eyes.
 */
@Component({
  selector: 'app-platform-ops-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, FeatureStateComponent, ConfirmDialogComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './platform-ops-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Platform operations"
        subtitle="Blue/green money path, backups, alert delivery — host actions run by the engine host's supervisor."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="refreshAll()"
          [disabled]="ops.loading()"
        >
          {{ ops.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (ops.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }
      @if (notice(); as n) {
        <p class="banner" role="status">{{ n }}</p>
      }

      @if (ops.value(); as o) {
        @if (!o.host.configured || !o.host.status) {
          <app-feature-state
            title="Host actions"
            [kind]="o.host.configured ? 'partial' : 'off'"
            switchKey="Ops:HostDaemonId"
            summary="Backups, restore drills, status and deploys run on the engine host through its supervisor. What follows is needed first; everything the engine itself can see is shown below regardless."
            [requirements]="requirements()"
          />
        }

        <!-- ── Money path ─────────────────────────────────────────────── -->
        <section class="card" aria-labelledby="mp-h">
          <header class="card-head">
            <h2 id="mp-h">Money path</h2>
            <span
              class="chip"
              [class.ok]="leader().tone === 'ok'"
              [class.warn]="leader().tone === 'warn'"
              [class.bad]="leader().tone === 'bad'"
              >{{ leader().text }}</span
            >
          </header>
          <table class="table">
            <thead>
              <tr>
                <th>Colour</th>
                <th>State</th>
                <th>Fencing token</th>
                <th>Leads since</th>
                <th>Container</th>
                <th>Image</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              @for (c of o.colours; track c.name) {
                <tr>
                  <td>{{ c.name }}</td>
                  <td>
                    <span class="chip" [class.ok]="c.leader" [class.warn]="c.state === 'standby'">{{
                      c.state
                    }}</span>
                    @if (c.draining) {
                      <span class="chip warn">draining</span>
                    }
                    @if (c.error) {
                      <span class="muted">{{ c.error }}</span>
                    }
                  </td>
                  <td>{{ c.fencingToken ?? '—' }}</td>
                  <td>{{ c.leaderSinceUtc ?? '—' }}</td>
                  @if (container(o, c.name); as k) {
                    <td>
                      {{ k.exists ? (k.running ? 'running' : (k.status ?? 'stopped')) : 'none'
                      }}{{ k.health ? ' · ' + k.health : '' }}
                    </td>
                    <td>
                      <code>{{ k.image ? short(k.image) : '—' }}</code>
                    </td>
                    <td>{{ k.startedAt ?? '—' }}</td>
                  } @else {
                    <td colspan="3" class="muted">no host report</td>
                  }
                </tr>
              }
            </tbody>
          </table>
          <dl class="facts">
            <dt>Lease</dt>
            <dd>
              @if (o.lease; as l) {
                {{ l.key }} · {{ l.holderName }} · token {{ l.fencingToken }} ·
                {{ l.held ? 'held until ' + l.expiresAtUtc : 'released / expired' }}
              } @else {
                no lease row (lease off)
              }
            </dd>
            <dt>This page served by</dt>
            <dd>{{ o.thisProcessHolder }} ({{ o.thisProcessState }})</dd>
            <dt>Schema</dt>
            <dd>{{ o.appliedMigrations }} migrations · head {{ o.schemaHead ?? '—' }}</dd>
            @if (o.host.status?.deployableImage; as img) {
              <dt>Built image</dt>
              <dd>
                <code>{{ short(img.id) }}</code> created {{ img.created ?? '—'
                }}{{ img.revision ? ' · rev ' + img.revision : '' }}
              </dd>
            }
          </dl>
        </section>

        <!-- ── Swap history + deploy ──────────────────────────────────── -->
        <section class="card" aria-labelledby="dep-h">
          <header class="card-head"><h2 id="dep-h">Deploys</h2></header>
          @if (o.host.status?.bluegreen; as bg) {
            <dl class="facts">
              <dt>Last swap</dt>
              <dd>
                @if (bg.state['swapped_at']) {
                  {{ bg.state['mode'] }} at {{ bg.state['swapped_at'] }} —
                  {{ bg.state['active'] }} active, previous {{ bg.state['previous'] || '—' }},
                  handover {{ bg.state['handover_seconds'] || '?' }} s, schema
                  {{
                    bg.state['schema_before'] === bg.state['schema_after']
                      ? 'unchanged'
                      : 'migrated'
                  }}
                } @else {
                  none recorded
                }
              </dd>
              @if (bg.swapInProgress) {
                <dt>Now</dt>
                <dd><span class="chip warn">a swap is running</span></dd>
              }
            </dl>
            @if (bg.history.length) {
              <details>
                <summary>Swap history ({{ bg.history.length }})</summary>
                <pre class="log">{{ bg.history.join('\\n') }}</pre>
              </details>
            }
          }

          @if (!o.deploy.enabled) {
            <p class="pad">
              Console deploys are off (<code>Ops:ConsoleDeploy:Enabled</code> = false). On the
              engine host run:
            </p>
            <pre class="log">{{ o.deploy.cliCommand }}</pre>
          } @else {
            @if (o.deploy.highRiskNow) {
              <div class="banner bad" role="alert">
                High-risk window ({{ o.deploy.minutesBefore }} min before /
                {{ o.deploy.minutesAfter }} min after a high-impact event):
                <ul>
                  @for (r of o.deploy.highRiskReasons; track r) {
                    <li>{{ r }}</li>
                  }
                </ul>
              </div>
            }
            @if (o.deploy.fourEyesPolicy) {
              <p class="muted pad">
                A four-eyes policy governs deploys: your request is held until the approvers approve
                it.
              </p>
            }
            @if (!canDeploy()) {
              <p class="muted pad">
                You need the <code>platform.deploy</code> permission to deploy.
              </p>
            } @else {
              <div class="form">
                <label
                  >Image
                  <code>{{
                    o.host.status?.deployableImage
                      ? short(o.host.status!.deployableImage!.id)
                      : 'unknown — refresh host status'
                  }}</code></label
                >
                <label
                  ><input type="checkbox" [(ngModel)]="dryRun" /> Dry run (print the plan, change
                  nothing)</label
                >
                @if (o.deploy.highRiskNow) {
                  <label
                    ><input type="checkbox" [(ngModel)]="overrideHighRisk" /> Override the high-risk
                    window</label
                  >
                }
                <label
                  >Reason
                  <input
                    class="input"
                    [(ngModel)]="deployReason"
                    placeholder="what this release changes"
                /></label>
                <label
                  >Type <code>{{ confirmText(o, false) }}</code> to confirm
                  <input class="input" [(ngModel)]="deployConfirm" autocomplete="off"
                /></label>
                <div class="row">
                  <button
                    type="button"
                    class="btn btn-primary"
                    [disabled]="
                      !o.host.status?.deployableImage ||
                      deployConfirm() !== confirmText(o, false) ||
                      busy()
                    "
                    (click)="pending.set({ kind: 'deploy', rollback: false })"
                  >
                    Deploy
                  </button>
                  <button
                    type="button"
                    class="btn btn-secondary"
                    [disabled]="deployConfirm() !== 'ROLLBACK' || busy()"
                    (click)="pending.set({ kind: 'deploy', rollback: true })"
                  >
                    Roll back (type ROLLBACK)
                  </button>
                </div>
              </div>
            }
          }
        </section>

        <!-- ── Backups ────────────────────────────────────────────────── -->
        <section class="card" aria-labelledby="bk-h">
          <header class="card-head">
            <h2 id="bk-h">Backups</h2>
            <div class="row">
              <button
                type="button"
                class="btn btn-secondary"
                [disabled]="!o.host.configured || busy()"
                (click)="
                  askHost(
                    'BackupNow',
                    'Back up now?',
                    'The host dumps the whole database (encrypted) and snapshots the market-data store. It reads every row: tens of minutes, safe while trading.'
                  )
                "
              >
                Back up now
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                [disabled]="!o.host.configured || busy()"
                (click)="
                  askHost(
                    'RestoreDrill',
                    'Run the restore drill?',
                    'The host restores the newest backup into a throwaway Postgres on a non-live port and checks it (RTO + row-count parity). It needs free disk of about the database size and refuses otherwise.'
                  )
                "
              >
                Run restore drill
              </button>
            </div>
          </header>
          @if (o.host.status?.backups; as b) {
            <dl class="facts">
              <dt>Configured</dt>
              <dd>
                {{
                  b.configured ? 'yes' : 'no — run scripts/backup/install-launchd.sh on the host'
                }}
              </dd>
              <dt>Schedule</dt>
              <dd>{{ b.scheduleInstalled ? (b.schedule ?? 'installed') : 'not installed' }}</dd>
              <dt>Destination</dt>
              <dd>
                {{ b.dir }}{{ b.remoteUrl ? ' + ' + b.remoteUrl : ' (local only)' }} ·
                {{ b.encryption ?? '—' }}
              </dd>
              <dt>Last success</dt>
              <dd>{{ b.lastSuccess ?? 'never' }}</dd>
              @if (b.newest; as n) {
                <dt>Newest backup</dt>
                <dd>
                  {{ n.createdUtc }} · {{ size(n.bytes) }} · migration {{ n.latestMigration }} ·
                  {{ b.count }} kept
                </dd>
              }
              <dt>Last restore drill</dt>
              <dd>
                @if (b.lastDrill; as d) {
                  <span class="chip" [class.ok]="d.passed" [class.bad]="!d.passed">{{
                    d.passed ? 'passed' : 'failed'
                  }}</span>
                  {{ d.drillUtc }} · RTO {{ d.rtoDatabaseSeconds ?? '?' }} s · rows equal
                  {{ d.rowsEqual }}, differ {{ d.rowsDiffer }}
                } @else {
                  never
                }
              </dd>
            </dl>
          } @else {
            <p class="muted pad">No host report yet.</p>
          }
        </section>

        <!-- ── Alerts ─────────────────────────────────────────────────── -->
        <section class="card" aria-labelledby="al-h">
          <header class="card-head">
            <h2 id="al-h">Alert delivery</h2>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="!o.alerting.reachable || busy()"
              (click)="sendTestAlert()"
            >
              Send test alert
            </button>
          </header>
          @if (!o.alerting.reachable) {
            <p class="pad"><span class="chip warn">not running</span> {{ o.alerting.error }}</p>
          } @else {
            <dl class="facts">
              <dt>Receivers</dt>
              <dd>
                {{
                  o.alerting.integrations.length
                    ? o.alerting.integrations.join(', ')
                    : 'none configured — alerts are kept but not sent (ALERTMANAGER_* in .env)'
                }}
              </dd>
              <dt>Firing now</dt>
              <dd>{{ o.alerting.activeAlerts }}</dd>
              <dt>Silences</dt>
              <dd>
                @if (o.alerting.silences.length) {
                  <ul>
                    @for (s of o.alerting.silences; track s.id) {
                      <li>{{ silenceText(s) }}</li>
                    }
                  </ul>
                } @else {
                  none
                }
              </dd>
            </dl>
          }
        </section>

        <!-- ── Settings ───────────────────────────────────────────────── -->
        <section class="card" aria-labelledby="st-h">
          <header class="card-head"><h2 id="st-h">Settings</h2></header>
          <table class="table">
            <thead>
              <tr>
                <th>Setting</th>
                <th>Value</th>
                <th>Default</th>
                <th>Last changed</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (s of o.settings; track s.key) {
                <tr>
                  <td>
                    <code>{{ s.key }}</code>
                    <div class="muted small">{{ s.description }}</div>
                  </td>
                  <td>
                    @switch (kind(s)) {
                      @case ('bool') {
                        <select
                          class="select"
                          [ngModel]="draft(s)"
                          (ngModelChange)="setDraft(s, $event)"
                          [attr.aria-label]="s.key"
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      }
                      @default {
                        <input
                          class="input"
                          [ngModel]="draft(s)"
                          (ngModelChange)="setDraft(s, $event)"
                          [attr.aria-label]="s.key"
                        />
                      }
                    }
                  </td>
                  <td>
                    <code>{{ s.default || '""' }}</code>
                  </td>
                  <td>
                    {{ s.lastChangedBy ?? '—'
                    }}{{ s.lastChangedAtUtc ? ' · ' + s.lastChangedAtUtc : '' }}
                  </td>
                  <td>
                    <button
                      type="button"
                      class="btn btn-secondary"
                      [disabled]="draft(s) === s.value || busy()"
                      (click)="askSetting(s)"
                    >
                      Save
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        <!-- ── Host jobs ──────────────────────────────────────────────── -->
        <section class="card" aria-labelledby="jb-h">
          <header class="card-head">
            <h2 id="jb-h">Host jobs</h2>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="!o.host.configured || busy()"
              (click)="runHost('RefreshStatus')"
            >
              Refresh host status
            </button>
          </header>
          @if (followed(); as j) {
            <div class="pad">
              <p>
                <span
                  class="chip"
                  [class.ok]="j.status === 'Succeeded'"
                  [class.bad]="j.status === 'Failed' || j.status === 'Expired'"
                  >{{ j.status }}</span
                >
                {{ jobText(j) }}
              </p>
              @if (j.progress) {
                <pre class="log" aria-live="polite">{{ j.progress }}</pre>
              }
            </div>
          }
          @if (o.recentJobs.length) {
            <ul class="jobs">
              @for (j of o.recentJobs; track j.jobId) {
                <li>
                  {{ j.createdAt }} · {{ jobText(j) }}
                  <span class="muted">({{ j.requestedBy }})</span>
                </li>
              }
            </ul>
          } @else {
            <p class="muted pad">No host job yet.</p>
          }
        </section>
      }

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="dialogTitle()"
        [message]="dialogMessage()"
        [confirmLabel]="pending()?.kind === 'deploy' ? 'Run it' : 'Confirm'"
        [confirmVariant]="pending()?.kind === 'deploy' ? 'destructive' : 'primary'"
        [loading]="busy()"
        (confirm)="confirmPending()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class PlatformOpsPageComponent {
  private readonly api = inject(PlatformOpsApiService);
  private readonly config = inject(ConfigService);
  private readonly auth = inject(AuthService);

  readonly ops = iamResource<PlatformOps | null>(
    () => this.api.get(),
    null,
    'Could not load the platform state.',
  );
  readonly notice = signal<string | null>(null);
  readonly busy = signal(false);
  readonly pending = signal<PendingAction | null>(null);
  readonly followed = signal<HostJob | null>(null);
  readonly drafts = signal<Record<string, string>>({});

  readonly dryRun = signal(false);
  readonly overrideHighRisk = signal(false);
  readonly deployReason = signal('');
  readonly deployConfirm = signal('');

  readonly leader = computed(() => leaderSummary(this.ops.value()?.colours ?? []));
  readonly requirements = computed(() => {
    const o = this.ops.value();
    return o ? hostRequirements(o) : [];
  });
  readonly canDeploy = computed(() => this.auth.hasPermission(Permission.PlatformDeploy));

  readonly dialogTitle = computed(() => {
    const p = this.pending();
    if (!p) return '';
    if (p.kind === 'host') return p.title;
    if (p.kind === 'setting') return `Change ${p.setting.key}?`;
    return p.rollback
      ? 'Roll back the money path?'
      : this.dryRun()
        ? 'Run a dry-run deploy?'
        : 'Deploy to the money path?';
  });
  readonly dialogMessage = computed(() => {
    const p = this.pending();
    if (!p) return '';
    if (p.kind === 'host') return p.message;
    if (p.kind === 'setting')
      return `From "${p.setting.value}" to "${p.value}". The change is audited (and held for approvers when a configuration policy exists).`;
    return p.rollback
      ? 'The host supervisor starts the previous colour on its previous image and hands leadership back. EAs see a few seconds of planned downtime.'
      : this.dryRun()
        ? 'The host prints the swap plan; nothing changes.'
        : 'The host supervisor migrates, starts the idle colour on the new image, waits until it is a standby, then hands leadership over. EAs see a few seconds of planned downtime.';
  });

  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.ops.reload();
    inject(DestroyRef).onDestroy(() => this.pollTimer && clearTimeout(this.pollTimer));
  }

  refreshAll(): void {
    this.ops.reload();
    if (this.ops.value()?.host.configured) this.runHost('RefreshStatus');
  }

  short(id: string | null | undefined): string {
    return shortImage(id);
  }
  size(bytes: number | null | undefined): string {
    return sizeText(bytes);
  }
  kind(s: PlatformConfigValue) {
    return settingKind(s);
  }
  jobText(j: HostJob): string {
    return jobLine(j);
  }
  confirmText(o: PlatformOps, rollback: boolean): string {
    return expectedConfirmation(o.host.status?.deployableImage?.id ?? null, rollback);
  }
  container(o: PlatformOps, service: string) {
    return o.host.status?.containers.find((c) => c.service === service) ?? null;
  }
  silenceText(s: {
    comment?: string;
    createdBy?: string;
    endsAt?: string;
    matchers?: { name: string; value: string }[];
  }): string {
    const m = (s.matchers ?? []).map((x) => `${x.name}=${x.value}`).join(', ');
    return `${m} — ${s.comment ?? ''} (${s.createdBy ?? '?'}, until ${s.endsAt ?? '?'})`;
  }

  draft(s: PlatformConfigValue): string {
    return this.drafts()[s.key] ?? s.value;
  }
  setDraft(s: PlatformConfigValue, value: string): void {
    this.drafts.update((d) => ({ ...d, [s.key]: value }));
  }

  askHost(action: PlatformHostAction, title: string, message: string): void {
    this.pending.set({ kind: 'host', action, title, message });
  }

  askSetting(s: PlatformConfigValue): void {
    const result = normaliseSetting(s, this.draft(s));
    if ('error' in result) {
      this.notice.set(`${s.key} must be ${result.error}.`);
      return;
    }
    this.pending.set({ kind: 'setting', setting: s, value: result.value });
  }

  confirmPending(): void {
    const p = this.pending();
    if (!p) return;
    if (p.kind === 'host') this.runHost(p.action);
    else if (p.kind === 'setting') this.saveSetting(p.setting, p.value);
    else this.deploy(p.rollback);
  }

  runHost(action: PlatformHostAction): void {
    this.busy.set(true);
    this.api.hostJob(action).subscribe({
      next: (q) => {
        this.done(q.message);
        this.follow(q.jobId);
      },
      error: (e) => this.done(errorText(e, 'The host job was not queued.')),
    });
  }

  sendTestAlert(): void {
    this.busy.set(true);
    this.api.testAlert().subscribe({
      next: (m) => this.done(m),
      error: (e) => this.done(errorText(e, 'The test alert was not sent.')),
    });
  }

  private saveSetting(s: PlatformConfigValue, value: string): void {
    this.busy.set(true);
    const dataType =
      settingKind(s) === 'bool' ? 'Bool' : settingKind(s) === 'int' ? 'Int' : 'String';
    this.config
      .upsert({ key: s.key, value, dataType, description: s.description, isHotReloadable: true })
      .subscribe({
        next: (res) => {
          this.done(
            res.status ? (res.message ?? 'Saved.') : (res.message ?? 'The change was refused.'),
          );
          this.ops.reload();
        },
        error: (e) => this.done(errorText(e, 'The change was not saved.')),
      });
  }

  private deploy(rollback: boolean): void {
    const o = this.ops.value();
    if (!o) return;
    this.busy.set(true);
    this.api
      .deploy({
        imageId: rollback ? null : (o.host.status?.deployableImage?.id ?? null),
        rollback,
        dryRun: this.dryRun(),
        confirmation: this.deployConfirm(),
        overrideHighRisk: this.overrideHighRisk(),
        reason: this.deployReason() || null,
      })
      .subscribe({
        next: (q) => {
          this.deployConfirm.set('');
          this.done(q.message);
          this.follow(q.jobId);
        },
        error: (e) => this.done(errorText(e, 'The deploy was not queued.')),
      });
  }

  private done(message: string): void {
    this.busy.set(false);
    this.pending.set(null);
    this.notice.set(message);
  }

  /** Polls the job every 2 s until it finishes, showing its streamed progress; then reloads the page's state. */
  private follow(jobId: string): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const tick = () => {
      this.api.job(jobId).subscribe({
        next: (j) => {
          this.followed.set(j);
          if (isFinished(j.status)) {
            this.ops.reload();
            return;
          }
          this.pollTimer = setTimeout(tick, 2000);
        },
        error: () => (this.pollTimer = setTimeout(tick, 5000)),
      });
    };
    tick();
  }
}
