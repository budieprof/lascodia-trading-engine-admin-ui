import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { saveBlob } from '@features/scripting/shared/download';

import { SecurityApiService } from '../security-api.service';
import {
  MAX_NOTES,
  countBySeverity,
  findingLabel,
  shortHash,
  signOffProblem,
  sortFindings,
  staleTotal,
} from '../security.logic';
import type { AccessReviewCampaign, AccessReviewCampaignDetail } from '../security.types';

/**
 * Quarterly access reviews (engine security-controls): the engine opens one campaign per quarter — a frozen
 * snapshot of every member, grant, machine identity and API token with last use and stale findings. The reviewer
 * acts on the findings (revoke in the grant list below, terminals under Organisation → Connect a terminal), retakes
 * the snapshot, and signs off with a statement; the sign-off is bound to the snapshot's SHA-256 and freezes it.
 * Embedded in the access-review page; generating needs `iam.access_review`, signing off `iam.access_review.signoff`
 * (step-up).
 */
@Component({
  selector: 'app-access-review-campaigns',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, LscCanDirective, MfaHintComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <section class="card">
      <header class="card-head">
        <h3>Quarterly access reviews</h3>
        <span class="spacer"></span>
        @if (selected(); as d) {
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            (click)="export('csv')"
            [disabled]="busy()"
          >
            Export CSV
          </button>
          <button
            type="button"
            class="btn btn-sm btn-secondary"
            (click)="export('json')"
            [disabled]="busy()"
          >
            Export JSON
          </button>
        }
        <button
          type="button"
          class="btn btn-sm btn-primary"
          (click)="generate()"
          [disabled]="busy() || currentSignedOff()"
          [title]="currentSignedOff() ? 'This quarter is signed off; its snapshot is frozen.' : ''"
        >
          {{ hasCurrent() ? 'Retake snapshot' : 'Take this quarter’s snapshot' }}
        </button>
      </header>

      @if (error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      } @else if (loaded() && campaigns().length === 0) {
        <p class="pad muted">
          No quarterly review yet. The engine opens one at the start of each quarter, or take the
          snapshot now.
        </p>
      } @else if (campaigns().length > 0) {
        <div class="pad row">
          <label class="field">
            <span class="label">Quarter</span>
            <select
              class="select"
              [ngModel]="selectedId()"
              (ngModelChange)="open($event)"
              name="campaign"
            >
              @for (c of campaigns(); track c.id) {
                <option [ngValue]="c.id">
                  {{ c.period }} —
                  {{ c.status === 'SignedOff' ? 'signed off' : 'awaiting sign-off' }}
                </option>
              }
            </select>
          </label>
        </div>
      }

      @if (selected(); as d) {
        <div class="card-body">
          <p class="small">
            Snapshot of {{ when(d.campaign.generatedAtUtc) }} by {{ d.campaign.generatedBy }} ·
            SHA-256
            <code [title]="d.campaign.snapshotSha256">{{ hash(d.campaign.snapshotSha256) }}</code> ·
            stale = no sign-in or use for {{ d.snapshot.staleAfterDays }} days
          </p>
          <div class="row">
            <span class="chip" [class.warn]="d.campaign.stalePeopleCount > 0"
              >People {{ d.campaign.peopleCount }} · {{ d.campaign.stalePeopleCount }} stale</span
            >
            <span class="chip" [class.warn]="d.campaign.staleGrantCount > 0"
              >Grants {{ d.campaign.grantCount }} · {{ d.campaign.staleGrantCount }} stale ·
              {{ d.campaign.privilegedGrantCount }} privileged</span
            >
            <span class="chip" [class.warn]="d.campaign.staleMachineIdentityCount > 0"
              >Terminal credentials {{ d.campaign.machineIdentityCount }} ·
              {{ d.campaign.staleMachineIdentityCount }} stale</span
            >
            <span class="chip" [class.warn]="d.campaign.staleApiTokenCount > 0"
              >API tokens {{ d.campaign.apiTokenCount }} ·
              {{ d.campaign.staleApiTokenCount }} stale</span
            >
          </div>

          @if (d.campaign.status === 'SignedOff') {
            <div class="note">
              <strong>Signed off</strong> by
              {{ d.campaign.signedOffByName || d.campaign.signedOffBy }} on
              {{ when(d.campaign.signedOffAtUtc) }}.
              <p class="small">{{ d.campaign.signOffNotes }}</p>
            </div>
          }

          <h4 class="small">
            Findings ({{ severity().high }} high · {{ severity().medium }} medium ·
            {{ severity().low }} low)
          </h4>
          @if (findings().length === 0) {
            <p class="muted small">Nothing stale or inconsistent.</p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Finding</th>
                    <th>Who / what</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  @for (f of findings(); track $index) {
                    <tr>
                      <td>
                        <span
                          class="chip"
                          [class.bad]="f.severity === 'high'"
                          [class.warn]="f.severity === 'medium'"
                          >{{ f.severity }}</span
                        >
                      </td>
                      <td>{{ label(f.kind) }}</td>
                      <td>{{ f.subject }}</td>
                      <td class="small">{{ f.detail }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          <details>
            <summary class="small">People ({{ d.snapshot.people.length }})</summary>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Membership</th>
                    <th>Roles</th>
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of d.snapshot.people; track p.adminUserId) {
                    <tr>
                      <td>
                        {{ p.username }}<span class="sub">{{ p.email }}</span>
                      </td>
                      <td>
                        {{ p.membershipStatus }}
                        @if (!p.userActive) {
                          <span class="chip bad">deactivated</span>
                        }
                      </td>
                      <td class="small">
                        {{ p.roles.join(', ') || '—' }}
                        @if (p.privileged) {
                          <span class="chip info">privileged</span>
                        }
                      </td>
                      <td class="small">
                        @if (p.stale) {
                          <span class="chip warn">{{
                            p.lastActivityUtc ? when(p.lastActivityUtc) : 'Never'
                          }}</span>
                        } @else {
                          {{ p.lastActivityUtc ? when(p.lastActivityUtc) : 'Never' }}
                        }
                        <span class="sub">{{ p.idleDays }} days idle</span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary class="small">
              Terminal credentials ({{ d.snapshot.machineIdentities.length }})
            </summary>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Instance</th>
                    <th>Kind</th>
                    <th>Account</th>
                    <th>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  @for (m of d.snapshot.machineIdentities; track m.credentialId) {
                    <tr>
                      <td>
                        {{ m.instanceId
                        }}<span class="sub">#{{ m.credentialId }} · {{ m.origin }}</span>
                      </td>
                      <td>{{ m.kind }}</td>
                      <td>{{ m.tradingAccountId ?? '—' }}</td>
                      <td class="small">
                        @if (m.stale) {
                          <span class="chip warn">{{
                            m.lastUsedAtUtc ? when(m.lastUsedAtUtc) : 'Never used'
                          }}</span>
                        } @else {
                          {{ m.lastUsedAtUtc ? when(m.lastUsedAtUtc) : 'Never used' }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary class="small">API tokens ({{ d.snapshot.apiTokens.length }})</summary>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Permissions</th>
                    <th>Expires</th>
                    <th>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of d.snapshot.apiTokens; track t.id) {
                    <tr>
                      <td>
                        {{ t.name }}<span class="sub">{{ t.prefix }} · {{ t.kind }}</span>
                      </td>
                      <td class="small">{{ t.permissions.join(', ') || '—' }}</td>
                      <td class="small">{{ when(t.expiresAtUtc) }}</td>
                      <td class="small">
                        @if (t.stale) {
                          <span class="chip warn">{{
                            t.lastUsedAtUtc ? when(t.lastUsedAtUtc) : 'Never used'
                          }}</span>
                        } @else {
                          {{ t.lastUsedAtUtc ? when(t.lastUsedAtUtc) : 'Never used' }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </details>
          @if (d.snapshot.serviceAccounts.length > 0) {
            <details>
              <summary class="small">
                Service accounts ({{ d.snapshot.serviceAccounts.length }})
              </summary>
              <ul class="small">
                @for (s of d.snapshot.serviceAccounts; track s.id) {
                  <li>
                    <code>{{ s.clientId }}</code> — {{ s.roles.join(', ') }} ({{
                      s.active ? 'active' : 'inactive'
                    }}).
                    {{ s.lastUse }}
                  </li>
                }
              </ul>
            </details>
          }

          @if (d.campaign.status === 'Open') {
            <form class="form-grid" *lscCan="P.IamAccessReviewSignoff" (ngSubmit)="signOff()">
              <label class="field">
                <span class="label">Reviewer statement</span>
                <textarea
                  class="textarea"
                  name="notes"
                  rows="4"
                  [maxlength]="maxNotes"
                  [ngModel]="notes()"
                  (ngModelChange)="notes.set($event)"
                  placeholder="What you checked, what you revoked, what you kept and why."
                ></textarea>
              </label>
              @if (severity().high > 0) {
                <label class="check small">
                  <input
                    type="checkbox"
                    name="ack"
                    [ngModel]="acknowledged()"
                    (ngModelChange)="acknowledged.set($event)"
                  />
                  My statement covers every high finding (revoked, or kept and why).
                </label>
              }
              <p class="small muted">
                You sign off the snapshot shown (SHA-256 {{ hash(d.campaign.snapshotSha256) }}). If
                you revoked access, retake the snapshot first so it records the result. A signed-off
                review cannot be changed.
              </p>
              <div class="actions-row">
                <app-mfa-hint [permission]="P.IamAccessReviewSignoff" />
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="busy() || problem() !== null"
                  [title]="problem() ?? ''"
                >
                  Sign off {{ d.campaign.period }}
                </button>
              </div>
              @if (problem(); as p) {
                <p class="small muted">{{ p }}</p>
              }
            </form>
          }
        </div>
      }
    </section>
  `,
})
export class AccessReviewCampaignsComponent {
  private readonly api = inject(SecurityApiService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly label = findingLabel;
  protected readonly hash = shortHash;
  protected readonly maxNotes = MAX_NOTES;

  readonly campaigns = signal<AccessReviewCampaign[]>([]);
  readonly selectedId = signal<number | null>(null);
  readonly selected = signal<AccessReviewCampaignDetail | null>(null);
  readonly error = signal<string | null>(null);
  readonly loaded = signal(false);
  readonly busy = signal(false);
  readonly notes = signal('');
  readonly acknowledged = signal(false);

  readonly findings = computed(() => sortFindings(this.selected()?.snapshot.findings ?? []));
  readonly severity = computed(() => countBySeverity(this.findings()));
  readonly hasCurrent = computed(() => {
    const first = this.campaigns()[0];
    return !!first && first.periodStartUtc.slice(0, 7) >= currentQuarterStart();
  });
  readonly currentSignedOff = computed(
    () => this.hasCurrent() && this.campaigns()[0].status === 'SignedOff',
  );
  readonly problem = computed(() =>
    signOffProblem(
      this.selected()?.campaign ?? null,
      this.notes(),
      this.acknowledged(),
      this.severity().high,
    ),
  );
  constructor() {
    this.reload();
  }

  reload(selectId?: number): void {
    this.api.campaigns().subscribe({
      next: (rows) => {
        this.campaigns.set(rows);
        this.error.set(null);
        this.loaded.set(true);
        const id = selectId ?? this.selectedId() ?? rows[0]?.id ?? null;
        if (id !== null) this.open(id);
      },
      error: (e) => {
        this.error.set(errorText(e, 'Could not load the quarterly reviews.'));
        this.loaded.set(true);
      },
    });
  }

  open(id: number): void {
    this.selectedId.set(id);
    this.api.campaign(id).subscribe({
      next: (d) => {
        this.selected.set(d);
        this.notes.set('');
        this.acknowledged.set(false);
      },
      error: (e) => {
        if (reportable(e)) this.notify.error(errorText(e, 'Could not open that review.'));
      },
    });
  }

  generate(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.api.generate().subscribe({
      next: (c) => {
        this.busy.set(false);
        this.notify.success(
          `Snapshot for ${c.period} taken (${staleTotal(c)} stale item${staleTotal(c) === 1 ? '' : 's'}).`,
        );
        this.reload(c.id);
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The snapshot was not taken.'));
      },
    });
  }

  signOff(): void {
    const d = this.selected();
    if (!d || this.busy() || this.problem() !== null) return;
    this.busy.set(true);
    this.api.signOff(d.campaign.id, d.campaign.snapshotSha256, this.notes().trim()).subscribe({
      next: (c) => {
        this.busy.set(false);
        this.notify.success(`${c.period} access review signed off.`);
        this.reload(c.id);
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The review was not signed off.'));
      },
    });
  }

  export(format: 'csv' | 'json'): void {
    const d = this.selected();
    if (!d || this.busy()) return;
    this.busy.set(true);
    this.api.exportCampaign(d.campaign.id, format).subscribe({
      next: (file) => {
        this.busy.set(false);
        saveBlob(file.blob, file.fileName);
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The export failed.'));
      },
    });
  }
}

/** `yyyy-mm` of the first month of the current UTC quarter. */
function currentQuarterStart(now = new Date()): string {
  const month = Math.floor(now.getUTCMonth() / 3) * 3 + 1;
  return `${now.getUTCFullYear()}-${String(month).padStart(2, '0')}`;
}
