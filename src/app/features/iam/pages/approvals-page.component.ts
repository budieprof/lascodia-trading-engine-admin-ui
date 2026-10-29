import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import {
  PERMISSION_CATALOG,
  Permission,
  permissionDefinition,
} from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import {
  ApprovalPoliciesApiService,
  type ApprovalPolicyRow,
} from '@features/organisation/approval-policies';
import { IamApiService } from '../iam-api.service';
import { approvalProgress, canDecide, errorText, reportable, when } from '../iam.logic';
import type { ApprovalRequest, ApprovalStatus } from '../iam.types';
import { iamResource } from '../shared/iam-resource';
import { ago, countBy, plural } from '../shared/admin-context.logic';
import { AuditTrailComponent } from '../shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '../shared/stat-tiles.component';

/**
 * Two-person approvals (U3.4, contract C3.3): actions that need a second person — releasing a kill
 * switch, loosening risk — wait here until another person who holds the action's own permission
 * approves (then the engine runs it, with both names in the audit log) or rejects it. Requests
 * expire after 24 hours. Deciding needs `iam.approvals.decide`.
 */
@Component({
  selector: 'app-iam-approvals-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    ConfirmDialogComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../shared/iam-page.scss',
  styles: [
    `
      .cols {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
        gap: var(--space-3);
        align-items: start;
      }
      @media (max-width: 860px) {
        .cols {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Approvals"
        subtitle="Actions waiting for a second person. Approving runs the action as requested."
      >
        <select
          class="select search"
          name="status"
          aria-label="Show"
          [ngModel]="status()"
          (ngModelChange)="status.set($event); list.reload()"
        >
          <option [ngValue]="'Pending'">Waiting for approval</option>
          <option [ngValue]="null">All recent requests</option>
        </select>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="reloadAll()"
          [disabled]="list.loading()"
        >
          {{ list.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Approvals summary" />

      <section class="card">
        <header class="card-head">
          <h3>{{ status() === 'Pending' ? 'Waiting for a second person' : 'Recent requests' }}</h3>
        </header>
        @if (list.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (list.loaded() && list.value().length === 0) {
          <p class="pad small muted">
            @if (status() === 'Pending') {
              Nothing is waiting for approval. A request appears here when someone in this
              organisation starts an action below that needs a second person; it waits up to its
              expiry (24 hours unless a policy says otherwise), then lapses.
              @if (recentCount() > 0) {
                <button type="button" class="btn btn-sm btn-secondary" (click)="showAll()">
                  Show the {{ recentCount() }} recent decided
                </button>
              }
            } @else {
              No request has been made in this organisation yet — nothing below has been asked for.
            }
          </p>
        } @else if (list.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Requested by</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th><span class="sr-only">Decision</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of list.value(); track r.id) {
                  @let d = decide(r);
                  <tr>
                    <td>
                      {{ r.summary || describe(r.actionKey) }}
                      <span class="sub"
                        ><code>{{ r.actionKey }}</code> · request #{{ r.id }}</span
                      >
                    </td>
                    <td class="small">
                      {{ r.requestedBy || '—'
                      }}<span class="sub">{{ when(r.requestedAtUtc) }}</span>
                    </td>
                    <td class="small">{{ when(r.expiresAtUtc) }}</td>
                    <td>
                      <span
                        class="chip"
                        [class.warn]="r.status === 'Pending'"
                        [class.ok]="r.status === 'Approved' || r.status === 'Executed'"
                        [class.bad]="r.status === 'Rejected'"
                      >
                        {{ r.status }}
                      </span>
                      @if (progress(r); as p) {
                        <span class="sub">{{ p }}</span>
                      }
                      @for (a of r.approvals ?? []; track $index) {
                        <span class="sub"
                          >✓ {{ a.decidedBy
                          }}{{ a.qualifyingRole ? ' (' + a.qualifyingRole + ')' : '' }}</span
                        >
                      }
                      @if (r.decidedBy && !r.approvals?.length) {
                        <span class="sub">by {{ r.decidedBy }}</span>
                      }
                    </td>
                    <td class="actions">
                      @if (r.status === 'Pending') {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          [disabled]="!d.ok"
                          [title]="d.why"
                          (click)="open(r, 'reject')"
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          class="btn btn-sm btn-primary"
                          [disabled]="!d.ok"
                          [title]="d.why"
                          (click)="open(r, 'approve')"
                        >
                          Approve
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

      <div class="cols">
        <section class="card">
          <header class="card-head">
            <h3>What needs a second person here</h3>
            <span class="spacer"></span>
            <a class="small" routerLink="/organisation/approval-policies">Approval policies</a>
          </header>
          @if (policies.error(); as err) {
            <p class="pad small" role="alert">
              <span class="chip bad">Could not load</span> {{ err }}
            </p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Rule in force</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of policies.value(); track row.kind) {
                    <tr>
                      <td>
                        {{ row.title }}
                        <span class="sub">{{
                          row.platformWide ? 'House policy, platform-wide' : 'this organisation'
                        }}</span>
                      </td>
                      <td class="small">
                        @if (row.policy?.enabled) {
                          <span class="chip ok">policy</span>
                          {{ policyText(row) }}
                        } @else if (row.policy) {
                          <span class="chip">policy off</span> behaves as without a policy
                        } @else {
                          {{ defaultRule(row.kind) }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <h3>Two-person permissions</h3>
          </header>
          <div class="card-body">
            <p class="small muted">
              Using these permissions never runs at once: the engine answers "sent for approval" and
              another person who holds the same permission on the same thing approves it here.
            </p>
            <ul class="small">
              @for (p of twoPerson; track p.key) {
                <li>
                  <code>{{ p.key }}</code> — {{ p.description }}
                </li>
              }
            </ul>
            <p class="note">
              Outside House the two-person rule always applies. In House it applies when the engine
              host sets <code>Auth:TwoPerson:EnforceForHouse</code>, and to any action that has an
              enabled policy above. The approver can never be the requester, and approving runs the
              stored request again through every check — both names go in the audit log.
            </p>
            <p class="small">
              @if (canDecide()) {
                <span class="chip ok">you can decide</span> You hold the approvals permission; you
                can approve a request when you also hold its action's permission.
              } @else {
                <span class="chip">view only</span> Deciding needs
                <code>iam.approvals.decide</code>.
              }
            </p>
          </div>
        </section>
      </div>

      <app-audit-trail
        heading="Approval history"
        [actions]="['iam.approval.', 'iam.approval_policy.']"
        empty="No approval has been requested, decided or changed in this organisation yet. Requests, each approval, rejections, the run that follows and policy changes are all recorded here."
      />

      <app-confirm-dialog
        [open]="deciding() !== null"
        [title]="dialogTitle()"
        [message]="dialogMessage()"
        [confirmLabel]="deciding()?.verdict === 'approve' ? 'Approve and run' : 'Reject'"
        [confirmVariant]="deciding()?.verdict === 'approve' ? 'primary' : 'destructive'"
        [loading]="busy()"
        (confirm)="decideNow()"
        (cancelled)="deciding.set(null)"
      >
        @if (deciding()?.verdict === 'reject') {
          <label class="field">
            <span class="label">Reason (shown to the requester)</span>
            <input
              class="input"
              name="reason"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event)"
            />
          </label>
        }
      </app-confirm-dialog>
    </div>
  `,
})
export class ApprovalsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly policyApi = inject(ApprovalPoliciesApiService);

  protected readonly when = when;
  protected readonly twoPerson = PERMISSION_CATALOG.filter((p) => p.twoPerson && !p.deprecated);

  readonly status = signal<ApprovalStatus | null>('Pending');
  readonly list = iamResource(
    () => this.iam.approvals(this.status()),
    [] as ApprovalRequest[],
    'Could not load approvals.',
  );
  private readonly me = computed(() => {
    const id = Number(this.auth.user()?.passportId);
    return Number.isInteger(id) && id > 0 ? id : null;
  });

  readonly deciding = signal<{ request: ApprovalRequest; verdict: 'approve' | 'reject' } | null>(
    null,
  );
  readonly reason = signal('');
  readonly busy = signal(false);
  readonly dialogTitle = computed(() => {
    const d = this.deciding();
    if (!d) return '';
    return `${d.verdict === 'approve' ? 'Approve' : 'Reject'} request #${d.request.id}?`;
  });
  readonly dialogMessage = computed(() => {
    const d = this.deciding();
    if (!d) return '';
    const what = d.request.summary || this.describe(d.request.actionKey);
    const required = d.request.requiredApprovals ?? 1;
    const after = (d.request.approvals?.length ?? 0) + 1;
    return d.verdict === 'approve'
      ? after < required
        ? `${what} — requested by ${d.request.requestedBy || 'another member'}. Your approval is ${after} of ${required}; it runs once ${required - after} more ${required - after === 1 ? 'person approves' : 'people approve'}.`
        : `${what} — requested by ${d.request.requestedBy || 'another member'}. The engine runs it as soon as you approve.`
      : `${what} — it will not run.`;
  });

  /** Every request the engine still lists (any status) — the tiles and the "show decided" hint. */
  readonly recent = iamResource(
    () => this.iam.approvals(null),
    [] as ApprovalRequest[],
    'Could not load recent approvals.',
  );
  readonly policies = iamResource(
    () => this.policyApi.list(),
    [] as ApprovalPolicyRow[],
    'Could not load the approval policies.',
  );
  readonly canDecide = computed(() => this.auth.hasPermission(Permission.IamApprovalsDecide));
  readonly recentCount = computed(
    () => this.recent.value().filter((r) => r.status !== 'Pending').length,
  );

  readonly tiles = computed<StatTile[]>(() => {
    const byStatus = countBy(this.recent.value(), (r) => r.status);
    const pending = byStatus['Pending'] ?? 0;
    const done = (byStatus['Executed'] ?? 0) + (byStatus['Approved'] ?? 0);
    const rejected = byStatus['Rejected'] ?? 0;
    const expired = byStatus['Expired'] ?? 0;
    const rows = this.policies.value();
    const inForce = rows.filter((r) => r.policy?.enabled).length;
    const oldest = this.recent
      .value()
      .filter((r) => r.status === 'Pending' && r.requestedAtUtc)
      .map((r) => r.requestedAtUtc as string)
      .sort()[0];
    const loaded = this.recent.loaded();
    return [
      {
        label: 'Waiting now',
        value: loaded ? String(pending) : '…',
        caption: pending ? `oldest asked ${ago(oldest)}` : 'nothing needs a decision',
        tone: pending ? 'warn' : 'good',
      },
      {
        label: 'Approved and run',
        value: loaded ? String(done) : '…',
        caption: 'of the requests the engine still lists',
      },
      {
        label: 'Rejected or lapsed',
        value: loaded ? String(rejected + expired) : '…',
        caption: `${rejected} rejected · ${expired} expired unanswered`,
      },
      {
        label: 'Four-eyes policies',
        value: this.policies.loaded() ? `${inForce} of ${rows.length}` : '…',
        caption: inForce
          ? `${plural(inForce, 'action')} need more than the default`
          : 'none set — the default rules apply',
        route: '/organisation/approval-policies',
      },
      {
        label: 'Two-person permissions',
        value: String(this.twoPerson.length),
        caption: this.twoPerson.map((p) => p.key).join(', '),
      },
    ];
  });

  constructor() {
    this.reloadAll();
  }

  reloadAll(): void {
    this.list.reload();
    this.recent.reload();
    this.policies.reload();
  }

  showAll(): void {
    this.status.set(null);
    this.list.reload();
  }

  policyText(row: ApprovalPolicyRow): string {
    const p = row.policy;
    if (!p) return '';
    const who = p.approverRoles.length ? ` holding ${p.approverRoles.join(' or ')}` : '';
    const above =
      row.hasThreshold && p.thresholdNotional != null
        ? ` at or above ${p.thresholdNotional.toLocaleString()} notional`
        : '';
    const expiry = p.expiryMinutes ? ` · lapses after ${p.expiryMinutes} min` : '';
    return `${plural(p.approversRequired, 'approver')}${who}${above}${expiry}`;
  }

  /** What happens to an action with no policy (engine four-eyes-approvals.md, "no row = today's behaviour"). */
  defaultRule(kind: string): string {
    switch (kind) {
      case 'killswitch.release':
        return 'A second person approves (always outside House; in House when the host enforces two-person).';
      case 'engine.config.change':
        return 'Runs at once; a risk-loosening change still needs risk.loosen, a second person and the cooling-off.';
      default:
        return 'Runs at once — no second person.';
    }
  }

  progress(r: ApprovalRequest): string | null {
    return approvalProgress(r);
  }

  decide(r: ApprovalRequest) {
    return canDecide(r, this.me());
  }

  describe(key: string): string {
    return permissionDefinition(key)?.description ?? key;
  }

  open(r: ApprovalRequest, verdict: 'approve' | 'reject'): void {
    this.reason.set('');
    this.deciding.set({ request: r, verdict });
  }

  decideNow(): void {
    const d = this.deciding();
    if (!d || this.busy()) return;
    this.busy.set(true);
    const call =
      d.verdict === 'approve'
        ? this.iam.approve(d.request.id)
        : this.iam.reject(d.request.id, this.reason().trim() || null);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.deciding.set(null);
        const required = d.request.requiredApprovals ?? 1;
        const recorded = (d.request.approvals?.length ?? 0) + 1;
        this.notify.success(
          d.verdict === 'approve'
            ? recorded < required
              ? `Approval recorded on request #${d.request.id} (${recorded} of ${required}).`
              : `Request #${d.request.id} approved.`
            : `Request #${d.request.id} rejected.`,
        );
        this.list.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.deciding.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'The decision was not recorded.'));
        this.list.reload();
      },
    });
  }
}
