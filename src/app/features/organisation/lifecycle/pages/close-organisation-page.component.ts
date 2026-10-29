import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { errorText } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { plural } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { LifecycleApiService } from '../lifecycle-api.service';
import { closeConfirmationOk, closeOutcome } from '../lifecycle.logic';
import type { TenantClosure, TenantClosureState } from '../lifecycle.types';

/**
 * Closing the organisation (engine multi-tenancy Phase 7, LC.3, `/tenant/closure`, `tenant.close` — Owner,
 * step-up; with more than one Owner a second one approves). Closing stops everything at once: the kill
 * switch is engaged, members can no longer sign in, terminals are disconnected and their credentials
 * revoked. Platform staff can reopen it during the grace period; after that its data is deleted. The page
 * says what stands in the way (open positions, working orders) and asks for the organisation's handle
 * and a reason; an export first is offered.
 */
@Component({
  selector: 'app-organisation-close-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MfaHintComponent,
    ModalA11yDirective,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrls: ['../../../iam/shared/iam-page.scss'],
  styles: [
    `
      .consequences li {
        margin-bottom: var(--space-1);
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .dialog {
        background: var(--bg-primary);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        padding: var(--space-5);
        width: min(560px, calc(100vw - 32px));
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Close the organisation"
        subtitle="Stop using the platform. Everything stops at once; the data is deleted after a grace period."
      />

      <app-stat-tiles [tiles]="tiles()" label="What closing would affect" />

      @if (state.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      @if (closed(); as c) {
        <section class="card">
          <div class="card-body">
            <p><span class="chip warn">Closed</span> Your organisation is closed.</p>
            <p>
              Platform staff can reopen it until {{ c.graceEndsAtUtc | date: 'medium' }}; after that
              its data is deleted. You are being signed out.
            </p>
          </div>
        </section>
      } @else if (state.value(); as s) {
        <section class="card">
          <header class="card-head">
            <h3>
              {{ s.name }} <span class="muted small">({{ s.slug }})</span>
            </h3>
            <span class="spacer"></span>
            <app-mfa-hint [permission]="P.TenantClose" />
          </header>
          <div class="card-body">
            <p>Closing the organisation:</p>
            <ul class="consequences">
              <li>engages its kill switch — no new orders on any of its accounts;</li>
              <li>
                stops every member's sign-in and ends their sessions; personal access tokens stop
                working;
              </li>
              <li>
                disconnects its terminals: their {{ s.activeMachineCredentials }} machine
                credential(s) and any pending enrollment tokens are revoked;
              </li>
              <li>
                keeps its data for {{ s.graceDays }} days, while platform staff can reopen it (its
                kill switch then stays engaged until an Owner releases it, and terminals are
                connected again);
              </li>
              <li>
                then deletes its data for good. Its audit trail is kept until its retention period
                passes.
              </li>
            </ul>
            <p class="note">
              Want a copy first?
              <a routerLink="/organisation/data-export">Export your data</a> before closing — once
              it is closed nobody can sign in to download it.
            </p>

            @if (s.blockers.length) {
              <ul class="errors" role="alert">
                @for (b of s.blockers; track b) {
                  <li>{{ b }}</li>
                }
              </ul>
            }
            @if (s.needsSecondOwner) {
              <p class="note warn">
                Your organisation has {{ s.owners }} Owners: closing it needs another Owner's
                approval (they find it under Approvals).
              </p>
            }

            @if (canClose()) {
              <div class="actions-row">
                <button
                  type="button"
                  class="btn btn-danger"
                  [disabled]="!s.canClose"
                  (click)="open.set(true)"
                >
                  Close {{ s.name }}…
                </button>
              </div>
            }
          </div>
        </section>
      } @else if (!state.error()) {
        <section class="card"><p class="pad muted">Loading…</p></section>
      }

      @if (open() && state.value()) {
        @let s = state.value()!;
        <div class="overlay" role="presentation">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="close-org-title"
            tabindex="-1"
            appModalA11y
            (dismiss)="cancel()"
          >
            <h3 id="close-org-title">Close {{ s.name }}?</h3>
            <p>This stops trading and sign-in for everyone in the organisation at once.</p>
            <label class="field">
              <span class="label"
                >Type the organisation's handle <code>{{ s.slug }}</code> to confirm</span
              >
              <input
                class="input"
                name="confirm"
                autocomplete="off"
                [ngModel]="typed()"
                (ngModelChange)="typed.set($event)"
              />
            </label>
            <label class="field">
              <span class="label">Why are you closing it?</span>
              <textarea
                class="textarea"
                name="reason"
                rows="3"
                maxlength="500"
                [ngModel]="reason()"
                (ngModelChange)="reason.set($event)"
              ></textarea>
            </label>
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-secondary"
                data-autofocus
                [disabled]="busy()"
                (click)="cancel()"
              >
                Cancel
              </button>
              <button
                type="button"
                class="btn btn-danger"
                [disabled]="busy() || !confirmOk()"
                (click)="close()"
              >
                {{ busy() ? 'Closing…' : 'Close the organisation' }}
              </button>
            </div>
          </div>
        </div>
      }

      <app-audit-trail
        heading="Closing and export activity"
        [actions]="['tenant.closure.', 'tenant.export.']"
        empty="This organisation has never been closed, refused a closure or exported its data. Each attempt, refusal and export is recorded here."
      />
    </div>
  `,
})
export class CloseOrganisationPageComponent {
  private readonly api = inject(LifecycleApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;

  readonly state = iamResource<TenantClosureState | null>(
    () => this.api.closureState(),
    null,
    'Could not load the organisation.',
  );
  readonly canClose = computed(() => this.auth.hasPermission(Permission.TenantClose));
  readonly tiles = computed<StatTile[]>(() => {
    const st = this.state.value();
    const n = (v: number | undefined) => (v == null ? '…' : String(v));
    return [
      {
        label: 'Can it be closed now?',
        value: !st ? '…' : st.canClose ? 'Yes' : 'No',
        caption: st
          ? st.canClose
            ? 'nothing blocks it'
            : plural(st.blockers.length, 'reason', 'reasons') + ' below'
          : null,
        tone: st ? (st.canClose ? 'warn' : 'good') : null,
      },
      {
        label: 'Open positions',
        value: n(st?.openPositions),
        caption: `${n(st?.workingOrders)} working orders — must be 0`,
        tone: st && st.openPositions + st.workingOrders > 0 ? 'warn' : null,
        route: '/positions',
      },
      {
        label: 'Members',
        value: n(st?.members),
        caption: `${n(st?.owners)} Owner(s)${st?.needsSecondOwner ? ' — a second Owner approves' : ''}`,
        route: '/iam/members',
      },
      {
        label: 'Terminal credentials',
        value: n(st?.activeMachineCredentials),
        caption: 'revoked at once on closing',
        route: '/organisation/terminals',
      },
      {
        label: 'Grace period',
        value: st ? `${st.graceDays} days` : '…',
        caption: 'staff can reopen it until then',
      },
    ];
  });
  readonly open = signal(false);
  readonly typed = signal('');
  readonly reason = signal('');
  readonly busy = signal(false);
  readonly closed = signal<TenantClosure | null>(null);
  readonly confirmOk = computed(() =>
    closeConfirmationOk(this.state.value(), this.typed(), this.reason()),
  );

  constructor() {
    this.state.reload();
  }

  cancel(): void {
    if (this.busy()) return;
    this.open.set(false);
  }

  close(): void {
    const s = this.state.value();
    if (!s || !this.confirmOk()) return;
    this.busy.set(true);
    this.api.close({ confirmSlug: this.typed().trim(), reason: this.reason().trim() }).subscribe({
      next: (res) => {
        this.busy.set(false);
        const outcome = closeOutcome(res);
        if (outcome.kind === 'closed') {
          this.open.set(false);
          this.closed.set(outcome.closure);
          this.notify.success('The organisation is closed.');
          // Its sessions are ended: sign out of the console now.
          setTimeout(() => this.auth.logout(), 4000);
        } else if (outcome.kind === 'approval') {
          // The approval interceptor has announced it; the request waits in Approvals.
          this.open.set(false);
        } else {
          this.notify.error(outcome.message);
        }
      },
      error: (e) => {
        this.busy.set(false);
        this.notify.error(errorText(e, 'The organisation could not be closed.'));
      },
    });
  }
}
