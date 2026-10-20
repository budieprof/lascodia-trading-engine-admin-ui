import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '../iam-api.service';
import { errorText, filterMembers, memberLabel, nextMemberStatus, reportable, when } from '../iam.logic';
import type { IamMember, IamSession, MemberStatus } from '../iam.types';
import { iamResource } from '../shared/iam-resource';

type PendingAction =
  | { kind: 'status'; member: IamMember; to: MemberStatus; label: string }
  | { kind: 'remove'; member: IamMember }
  | { kind: 'endSessions'; member: IamMember };

/**
 * Organisation members (U3.4, contract C3.5): who belongs, their status and roles, suspend /
 * reactivate / remove (`tenant.members.manage`), and their sign-in sessions (`iam.sessions.manage`).
 * Suspending or removing someone also ends their sessions in this organisation (engine side).
 */
@Component({
  selector: 'app-iam-members-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, ConfirmDialogComponent, LscCanDirective],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Members"
        subtitle="People in this organisation. Roles are given on the Access grants page; new people join through Invitations."
      >
        <a class="btn btn-secondary" routerLink="/iam/invitations" *lscCan="P.IamInvitationsManage">Invite someone</a>
        <button type="button" class="btn btn-secondary" (click)="members.reload()" [disabled]="members.loading()">
          {{ members.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <section class="card">
        <header class="card-head">
          <h3>{{ visible().length }} of {{ members.value().length }} members</h3>
          <span class="spacer"></span>
          <input
            class="input search"
            type="search"
            placeholder="Filter by name, username or e-mail"
            aria-label="Filter members"
            [ngModel]="filter()"
            (ngModelChange)="filter.set($event)"
          />
        </header>

        @if (members.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (members.loaded() && members.value().length === 0) {
          <p class="pad muted">Nobody is a member yet.</p>
        }

        @if (visible().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Status</th>
                  <th>Roles</th>
                  <th>Joined</th>
                  <th>Last sign-in</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (m of visible(); track m.userId) {
                  <tr [class.selected]="openSessionsFor() === m.userId">
                    <td>
                      {{ label(m) }}
                      <span class="sub">{{ m.email || '—' }}</span>
                    </td>
                    <td>
                      <span
                        class="chip"
                        [class.ok]="m.status === 'Active'"
                        [class.warn]="m.status === 'Invited'"
                        [class.bad]="m.status === 'Suspended'"
                        >{{ m.status }}</span
                      >
                      @if (m.mfaEnabled === false) {
                        <span class="chip warn" title="No second factor set up yet">No MFA</span>
                      }
                    </td>
                    <td>
                      @for (r of m.roles ?? []; track r) {
                        <span class="chip info">{{ r }}</span>
                      } @empty {
                        <span class="muted small">None</span>
                      }
                    </td>
                    <td class="small">{{ when(m.joinedAtUtc) }}</td>
                    <td class="small">{{ when(m.lastSignInAtUtc) }}</td>
                    <td class="actions">
                      @if (!isMe(m)) {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          *lscCan="P.IamSessionsManage"
                          (click)="toggleSessions(m)"
                          [attr.aria-expanded]="openSessionsFor() === m.userId"
                        >
                          Sessions
                        </button>
                        <ng-container *lscCan="P.TenantMembersManage">
                          @if (statusChange(m); as next) {
                            <button
                              type="button"
                              class="btn btn-sm btn-secondary"
                              (click)="pending.set({ kind: 'status', member: m, to: next.to, label: next.label })"
                            >
                              {{ next.label }}
                            </button>
                          }
                          <button
                            type="button"
                            class="btn btn-sm btn-danger"
                            (click)="pending.set({ kind: 'remove', member: m })"
                          >
                            Remove
                          </button>
                        </ng-container>
                      } @else {
                        <span class="muted small">You</span>
                      }
                    </td>
                  </tr>
                  @if (openSessionsFor() === m.userId) {
                    <tr class="selected">
                      <td colspan="6">
                        @if (sessionsLoading()) {
                          <span class="muted small">Loading sessions…</span>
                        } @else if (sessionsError(); as e) {
                          <span class="chip bad">Could not load</span> {{ e }}
                        } @else if (sessions().length === 0) {
                          <span class="muted small">No active sessions.</span>
                        } @else {
                          <table class="grid">
                            <thead>
                              <tr>
                                <th>Started</th>
                                <th>Last seen</th>
                                <th>Expires</th>
                                <th>From</th>
                                <th>Device</th>
                              </tr>
                            </thead>
                            <tbody>
                              @for (s of sessions(); track s.id) {
                                <tr>
                                  <td class="small">{{ when(s.createdAtUtc) }}</td>
                                  <td class="small">{{ when(s.lastSeenAtUtc) }}</td>
                                  <td class="small">{{ when(s.expiresAtUtc) }}</td>
                                  <td class="small">{{ s.ipAddress || '—' }}</td>
                                  <td class="small">{{ s.userAgent || '—' }}</td>
                                </tr>
                              }
                            </tbody>
                          </table>
                          <div class="actions-row">
                            <button
                              type="button"
                              class="btn btn-sm btn-danger"
                              (click)="pending.set({ kind: 'endSessions', member: m })"
                            >
                              Sign out everywhere
                            </button>
                          </div>
                        }
                      </td>
                    </tr>
                  }
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="confirmTitle()"
        [message]="confirmMessage()"
        [confirmLabel]="confirmLabel()"
        [confirmVariant]="confirmVariant()"
        [loading]="busy()"
        (confirm)="run()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class MembersPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;

  readonly members = iamResource(() => this.iam.members(), [] as IamMember[], 'Could not load members.');
  readonly filter = signal('');
  readonly visible = computed(() => filterMembers(this.members.value(), this.filter()));

  readonly openSessionsFor = signal<number | null>(null);
  readonly sessions = signal<IamSession[]>([]);
  readonly sessionsLoading = signal(false);
  readonly sessionsError = signal<string | null>(null);

  readonly pending = signal<PendingAction | null>(null);
  readonly busy = signal(false);

  readonly confirmTitle = computed(() => {
    const p = this.pending();
    if (!p) return '';
    const who = memberLabel(p.member);
    if (p.kind === 'status') return `${p.label} ${who}?`;
    if (p.kind === 'remove') return `Remove ${who}?`;
    return `Sign ${who} out everywhere?`;
  });
  readonly confirmMessage = computed(() => {
    const p = this.pending();
    if (!p) return '';
    if (p.kind === 'status' && p.to === 'Suspended')
      return 'They are signed out of this organisation and refused until reactivated. Their roles are kept.';
    if (p.kind === 'status') return 'They can sign in to this organisation again with the roles they had.';
    if (p.kind === 'remove')
      return 'They lose every role in this organisation and are signed out of it. They need a new invitation to come back.';
    return 'Every console session they have in this organisation ends now. They can sign in again.';
  });
  readonly confirmVariant = computed<'primary' | 'destructive'>(() => {
    const p = this.pending();
    return p?.kind === 'status' && p.to === 'Active' ? 'primary' : 'destructive';
  });
  readonly confirmLabel = computed(() => {
    const p = this.pending();
    if (!p) return 'Confirm';
    return p.kind === 'status' ? p.label : p.kind === 'remove' ? 'Remove' : 'Sign out everywhere';
  });

  constructor() {
    this.members.reload();
  }

  label(m: IamMember): string {
    return memberLabel(m);
  }

  statusChange(m: IamMember) {
    return nextMemberStatus(m.status);
  }

  isMe(m: IamMember): boolean {
    return this.auth.user()?.passportId === String(m.userId);
  }

  toggleSessions(m: IamMember): void {
    if (this.openSessionsFor() === m.userId) {
      this.openSessionsFor.set(null);
      return;
    }
    this.openSessionsFor.set(m.userId);
    this.loadSessions(m.userId);
  }

  private loadSessions(userId: number): void {
    this.sessions.set([]);
    this.sessionsError.set(null);
    this.sessionsLoading.set(true);
    this.iam.memberSessions(userId).subscribe({
      next: (s) => {
        this.sessions.set(s);
        this.sessionsLoading.set(false);
      },
      error: (e) => {
        this.sessionsError.set(errorText(e, 'Could not load sessions.'));
        this.sessionsLoading.set(false);
      },
    });
  }

  run(): void {
    const p = this.pending();
    if (!p || this.busy()) return;
    this.busy.set(true);
    const call =
      p.kind === 'status'
        ? this.iam.setMemberStatus(p.member.userId, p.to)
        : p.kind === 'remove'
          ? this.iam.removeMember(p.member.userId)
          : this.iam.endMemberSessions(p.member.userId);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        const who = memberLabel(p.member);
        this.notify.success(
          p.kind === 'status'
            ? `${who}: ${p.to === 'Suspended' ? 'suspended' : 'reactivated'}.`
            : p.kind === 'remove'
              ? `${who} was removed from the organisation.`
              : `${who} was signed out everywhere.`,
        );
        if (p.kind === 'endSessions') this.loadSessions(p.member.userId);
        else this.members.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.pending.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'That did not work. Try again.'));
      },
    });
  }
}
