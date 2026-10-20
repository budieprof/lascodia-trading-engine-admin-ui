import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { describeDevice, errorText, reportable, when } from '@features/iam/iam.logic';
import type { IamSession } from '@features/iam/iam.types';
import { iamResource } from '@features/iam/shared/iam-resource';

/**
 * Your sessions and devices (U3.5, contract C3.5): every console session signed in as you, where
 * from and when last used. Sign one out, or every one except this one — the engine also ends the
 * matching identity-provider session.
 */
@Component({
  selector: 'app-account-sessions-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, ConfirmDialogComponent],
  styleUrl: '../../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Sessions & devices"
        subtitle="Where you are signed in. Sign out anything you do not recognise."
      >
        <button type="button" class="btn btn-secondary" (click)="sessions.reload()" [disabled]="sessions.loading()">
          {{ sessions.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button type="button" class="btn btn-danger" [disabled]="others().length === 0 || busy()" (click)="pending.set('others')">
          Sign out all other sessions
        </button>
      </app-page-header>

      <section class="card">
        @if (sessions.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (sessions.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>From</th>
                  <th>Signed in</th>
                  <th>Last active</th>
                  <th>Ends</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (s of sessions.value(); track s.id) {
                  <tr>
                    <td>
                      {{ device(s) }}
                      @if (s.current) {
                        <span class="chip ok">This session</span>
                      }
                      <span class="sub">{{ s.userAgent || '' }}</span>
                    </td>
                    <td class="small">{{ s.ipAddress || '—' }}</td>
                    <td class="small">{{ when(s.createdAtUtc) }}</td>
                    <td class="small">{{ when(s.lastSeenAtUtc) }}</td>
                    <td class="small">{{ when(s.expiresAtUtc) }}</td>
                    <td class="actions">
                      @if (!s.current) {
                        <button type="button" class="btn btn-sm btn-danger" [disabled]="busy()" (click)="pending.set(s)">Sign out</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (sessions.loaded()) {
          <p class="pad muted">No sessions.</p>
        }
      </section>

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="pending() === 'others' ? 'Sign out every other session?' : 'Sign out this session?'"
        [message]="
          pending() === 'others'
            ? 'Every device except this one is signed out now.'
            : 'That device is signed out now. Whoever uses it must sign in again.'
        "
        confirmLabel="Sign out"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="run()"
        (cancelled)="pending.set(null)"
      />
    </div>
  `,
})
export class SessionsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly when = when;

  readonly sessions = iamResource(() => this.iam.mySessions(), [] as IamSession[], 'Could not load your sessions.');
  readonly others = computed(() => this.sessions.value().filter((s) => !s.current));
  readonly pending = signal<IamSession | 'others' | null>(null);
  readonly busy = signal(false);

  constructor() {
    this.sessions.reload();
  }

  device(s: IamSession): string {
    return describeDevice(s.userAgent);
  }

  run(): void {
    const p = this.pending();
    if (!p || this.busy()) return;
    this.busy.set(true);
    const call = p === 'others' ? this.iam.endMyOtherSessions() : this.iam.endMySession(p.id);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        this.notify.success(p === 'others' ? 'Every other session is signed out.' : 'That session is signed out.');
        this.sessions.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.pending.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'Nothing was signed out.'));
      },
    });
  }
}
