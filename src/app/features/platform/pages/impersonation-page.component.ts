import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { BrowserLocation } from '@core/browser/browser-location';
import { Permission } from '@core/auth/permissions.generated';
import { DEFAULT_POST_LOGIN_ROUTE } from '@core/auth/return-url';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, filterMembers, memberLabel, reportable } from '@features/iam/iam.logic';
import type { IamMember, TenantDto } from '@features/iam/iam.types';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';

/**
 * Impersonation (U3.6, ADR-0031 §6): platform staff view the console as another user to see what
 * they see — read-only (every change is refused), carried as the staff member in the session and
 * recorded in the organisation's audit log. A banner stays on every page until it is ended.
 */
@Component({
  selector: 'app-platform-impersonation-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent, MfaHintComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Impersonation"
        subtitle="See the console as another user, read-only. Recorded in their organisation's audit log."
      />

      <section class="card">
        <header class="card-head">
          <h3>Choose the person</h3>
          <span class="spacer"></span>
          <select
            class="select search"
            name="tenant"
            aria-label="Organisation"
            [ngModel]="tenantId()"
            (ngModelChange)="pickTenant($event)"
          >
            <option [ngValue]="null">Organisation…</option>
            @for (t of tenants.value(); track t.id) {
              <option [ngValue]="t.id">{{ t.name }} ({{ t.slug }})</option>
            }
          </select>
          <input
            class="input search"
            type="search"
            placeholder="Filter people"
            aria-label="Filter people"
            [ngModel]="filter()"
            (ngModelChange)="filter.set($event)"
          />
        </header>
        @if (tenantId() === null) {
          <p class="pad muted">Choose an organisation to list its members.</p>
        } @else if (membersError(); as e) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ e }}</p>
        } @else if (shown().length === 0) {
          <p class="pad muted">No active members.</p>
        } @else {
          <table class="grid">
            <tbody>
              @for (m of shown(); track m.userId) {
                <tr>
                  <td>
                    {{ label(m) }}<span class="sub">{{ m.email || '' }}</span>
                  </td>
                  <td class="actions">
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      [disabled]="busy()"
                      (click)="target.set(m)"
                    >
                      View as
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>

      <app-confirm-dialog
        [open]="target() !== null"
        [title]="'View the console as ' + (target() ? label(target()!) : '') + '?'"
        message="Read-only: you see what they see and can change nothing. It is recorded in their organisation's audit log, and a banner shows it until you end it."
        confirmLabel="Start, read-only"
        [loading]="busy()"
        (confirm)="start()"
        (cancelled)="target.set(null)"
      >
        <label class="field">
          <span class="label">Why (recorded in their audit log)</span>
          <input
            class="input"
            name="reason"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event)"
            placeholder="e.g. Ticket 4411: their dashboard is empty"
          />
        </label>
        <app-mfa-hint [permission]="P.PlatformImpersonate" />
      </app-confirm-dialog>
    </div>
  `,
})
export class ImpersonationPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly browser = inject(BrowserLocation);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;

  readonly tenants = iamResource(
    () =>
      this.auth.hasPermission(Permission.PlatformTenantsManage)
        ? this.iam.tenants().pipe(catchError(() => of([] as TenantDto[])))
        : of([] as TenantDto[]),
    [] as TenantDto[],
  );
  readonly tenantId = signal<number | null>(null);
  readonly members = signal<IamMember[]>([]);
  readonly membersError = signal<string | null>(null);
  readonly filter = signal('');
  readonly shown = computed(() =>
    filterMembers(
      this.members().filter(
        (m) => m.status === 'Active' && String(m.userId) !== this.auth.user()?.passportId,
      ),
      this.filter(),
    ),
  );
  readonly target = signal<IamMember | null>(null);
  readonly reason = signal('');
  readonly busy = signal(false);

  constructor() {
    this.tenants.reload();
  }

  label(m: IamMember): string {
    return memberLabel(m);
  }

  pickTenant(id: number | null): void {
    this.tenantId.set(id);
    this.members.set([]);
    this.membersError.set(null);
    if (id === null) return;
    this.iam.tenantMembers(id).subscribe({
      next: (m) => this.members.set(m),
      error: (e) => this.membersError.set(errorText(e, 'Could not load members.')),
    });
  }

  start(): void {
    const m = this.target();
    const tenantId = this.tenantId();
    if (!m || tenantId === null || this.busy()) return;
    this.busy.set(true);
    this.iam
      .startImpersonation({
        userId: m.userId,
        tenantId,
        readOnly: true,
        reason: this.reason().trim() || null,
      })
      .subscribe({
        next: () => {
          // The session is now theirs (read-only): reload so every page shows their console.
          this.browser.assign(DEFAULT_POST_LOGIN_ROUTE);
        },
        error: (e) => {
          this.busy.set(false);
          this.target.set(null);
          if (reportable(e)) this.notify.error(errorText(e, 'Impersonation did not start.'));
        },
      });
  }
}
