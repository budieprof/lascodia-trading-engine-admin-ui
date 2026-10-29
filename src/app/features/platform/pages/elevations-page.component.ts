import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import {
  PERMISSION_CATALOG,
  Permission,
  type PermissionDefinition,
} from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, groupCatalog, reportable, toggled, when } from '@features/iam/iam.logic';
import type { AccessElevation, TenantDto } from '@features/iam/iam.types';
import { MAX_ELEVATION_MINUTES } from '@features/iam/iam.types';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { elevationActions, elevationErrors } from '../platform.logic';
import { ago, countBy, plural } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';

type Pending = { kind: 'approve' | 'end'; elevation: AccessElevation };

/**
 * Elevated access (U3.6, ADR-0031 §6, contract C3.5): platform staff reach an organisation's data only
 * through a recorded, time-limited elevation — a reason, at most 240 minutes, the permissions needed —
 * approved by ANOTHER staff member holding `platform.elevation.approve`, and recorded in that
 * organisation's own audit log. It ends on its own, or earlier from here.
 */
@Component({
  selector: 'app-platform-elevations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    ConfirmDialogComponent,
    MfaHintComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Elevated access"
        subtitle="Time-limited access to an organisation's data, approved by a second staff member and recorded in its audit log."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="elevations.reload()"
          [disabled]="elevations.loading()"
        >
          {{ elevations.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Elevated access summary" />

      <section class="card">
        <header class="card-head"><h3>Request access</h3></header>
        <form class="card-body" (ngSubmit)="request()">
          <div class="form-grid">
            <label class="field">
              <span class="label">Organisation</span>
              @if (tenants.value().length) {
                <select
                  class="select"
                  name="tenant"
                  [ngModel]="tenantId()"
                  (ngModelChange)="tenantId.set($event)"
                >
                  <option [ngValue]="null">Choose…</option>
                  @for (t of tenants.value(); track t.id) {
                    <option [ngValue]="t.id">{{ t.name }} ({{ t.slug }})</option>
                  }
                </select>
              } @else {
                <input
                  class="input"
                  type="number"
                  min="1"
                  name="tenant"
                  placeholder="Organisation id"
                  [ngModel]="tenantId()"
                  (ngModelChange)="tenantId.set(+$event || null)"
                />
              }
            </label>
            <label class="field">
              <span class="label">For how long (minutes, at most {{ maxMinutes }})</span>
              <input
                class="input"
                type="number"
                min="1"
                [max]="maxMinutes"
                name="minutes"
                [ngModel]="minutes()"
                (ngModelChange)="minutes.set(+$event)"
              />
            </label>
          </div>
          <label class="field">
            <span class="label">Why (goes into the organisation's audit log)</span>
            <input
              class="input"
              name="reason"
              [ngModel]="reason()"
              (ngModelChange)="reason.set($event)"
              placeholder="e.g. Support ticket 4411: positions not reconciling"
            />
          </label>
          <fieldset class="matrix">
            <legend class="label">Permissions needed · {{ chosen().size }} selected</legend>
            @for (g of groups(); track g.category) {
              <div>
                <span class="matrix-cat">{{ g.category }}</span>
                <div class="matrix-checks">
                  @for (p of g.permissions; track p.key) {
                    <label class="check" [title]="p.description">
                      <input
                        type="checkbox"
                        [checked]="chosen().has(p.key)"
                        (change)="toggle(p.key)"
                      />
                      <span>{{ p.key }}</span>
                    </label>
                  }
                </div>
              </div>
            }
          </fieldset>
          @if (submitted() && errors().length) {
            <ul class="errors" role="alert">
              @for (e of errors(); track e) {
                <li>{{ e }}</li>
              }
            </ul>
          }
          <div class="actions-row">
            <button type="submit" class="btn btn-primary" [disabled]="busy()">
              {{ busy() ? 'Sending…' : 'Request access' }}
            </button>
          </div>
        </form>
      </section>

      <section class="card">
        <header class="card-head"><h3>Requests</h3></header>
        @if (elevations.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (elevations.loaded() && elevations.value().length === 0) {
          <p class="pad small muted">
            No elevated access has been requested. Platform staff ask for it here when they must act
            inside a customer organisation (at most 240 minutes, only the permissions ticked);
            another staff member approves, and it ends by itself. Viewing as someone, read-only,
            needs none — see Impersonation.
          </p>
        } @else if (elevations.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Who</th>
                  <th>Organisation</th>
                  <th>Why</th>
                  <th>Window</th>
                  <th>Status</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (e of elevations.value(); track e.id) {
                  @let can = actions(e);
                  <tr>
                    <td>{{ e.staffName || '#' + e.staffUserId }}</td>
                    <td>{{ e.tenantName || '#' + e.tenantId }}</td>
                    <td>
                      {{ e.reason }}<span class="sub">{{ e.permissions.join(', ') }}</span>
                    </td>
                    <td class="small">
                      @if (e.startsAtUtc) {
                        {{ when(e.startsAtUtc) }} – {{ when(e.endsAtUtc) }}
                      } @else {
                        {{ e.minutes ?? '—' }} minutes, from approval
                      }
                    </td>
                    <td>
                      <span
                        class="chip"
                        [class.warn]="e.status === 'Pending'"
                        [class.ok]="e.status === 'Active'"
                        >{{ e.status }}</span
                      >
                      @if (e.approvedBy) {
                        <span class="sub">approved by {{ e.approvedBy }}</span>
                      }
                    </td>
                    <td class="actions">
                      @if (can.open) {
                        <button type="button" class="btn btn-sm btn-primary" (click)="open(e)">
                          Open organisation
                        </button>
                      }
                      @if (can.approve) {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="pending.set({ kind: 'approve', elevation: e })"
                        >
                          Approve
                        </button>
                      }
                      @if (can.end) {
                        <button
                          type="button"
                          class="btn btn-sm btn-danger"
                          (click)="pending.set({ kind: 'end', elevation: e })"
                        >
                          End
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

      <app-confirm-dialog
        [open]="pending() !== null"
        [title]="pending()?.kind === 'approve' ? 'Approve this access?' : 'End this access?'"
        [message]="pendingMessage()"
        [confirmLabel]="pending()?.kind === 'approve' ? 'Approve' : 'End access'"
        [confirmVariant]="pending()?.kind === 'approve' ? 'primary' : 'destructive'"
        [loading]="busy()"
        (confirm)="run()"
        (cancelled)="pending.set(null)"
      >
        @if (pending()?.kind === 'approve') {
          <app-mfa-hint [permission]="P.PlatformElevationApprove" />
        }
      </app-confirm-dialog>

      <app-audit-trail
        heading="Elevation history"
        [actions]="['platform.elevation.']"
        empty="No elevation has been requested, approved, rejected or ended yet. Each step is recorded here and in the organisation's own audit log."
      />
    </div>
  `,
})
export class ElevationsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly when = when;
  protected readonly maxMinutes = MAX_ELEVATION_MINUTES;

  readonly elevations = iamResource(
    () => this.iam.elevations(),
    [] as AccessElevation[],
    'Could not load elevated access.',
  );
  /** The organisation list needs `platform.tenants.manage`; without it an id is typed instead. */
  readonly tenants = iamResource(
    () =>
      this.auth.hasPermission(Permission.PlatformTenantsManage)
        ? this.iam.tenants().pipe(catchError(() => of([] as TenantDto[])))
        : of([] as TenantDto[]),
    [] as TenantDto[],
  );
  /** Tenant data permissions only — no platform or access-tier keys. */
  readonly groups = computed(() =>
    groupCatalog(
      PERMISSION_CATALOG.filter(
        (p: PermissionDefinition) =>
          !p.deprecated && !p.key.startsWith('platform.') && !p.key.startsWith('access.'),
      ),
    ),
  );

  readonly tenantId = signal<number | null>(null);
  readonly minutes = signal(60);
  readonly reason = signal('');
  readonly chosen = signal<Set<string>>(new Set());
  readonly submitted = signal(false);
  readonly errors = computed(() =>
    elevationErrors(this.tenantId(), this.reason(), this.minutes(), [...this.chosen()]),
  );
  readonly busy = signal(false);

  readonly pending = signal<Pending | null>(null);
  readonly pendingMessage = computed(() => {
    const p = this.pending();
    if (!p) return '';
    const e = p.elevation;
    return p.kind === 'approve'
      ? `${e.staffName || 'They'} get ${e.permissions.join(', ')} in ${e.tenantName || 'that organisation'} for ${e.minutes ?? '?'} minutes, recorded in its audit log. Reason: ${e.reason}`
      : 'The access ends now.';
  });
  private readonly me = computed(() => {
    const id = Number(this.auth.user()?.passportId);
    return Number.isInteger(id) && id > 0 ? id : null;
  });

  readonly tiles = computed<StatTile[]>(() => {
    const list = this.elevations.value();
    const c = countBy(list, (e) => String(e.status));
    const last =
      list
        .map((e) => e.requestedAtUtc ?? '')
        .sort()
        .at(-1) || null;
    return [
      {
        label: 'Active now',
        value: this.elevations.loaded() ? String(c['Active'] ?? 0) : '…',
        caption: c['Active']
          ? 'staff can act inside an organisation'
          : 'no staff access inside organisations',
        tone: c['Active'] ? 'warn' : 'good',
      },
      {
        label: 'Waiting for approval',
        value: this.elevations.loaded() ? String(c['Pending'] ?? 0) : '…',
        caption: 'another staff member approves',
        tone: c['Pending'] ? 'warn' : null,
      },
      {
        label: 'Requests so far',
        value: this.elevations.loaded() ? String(list.length) : '…',
        caption: last ? `latest ${ago(last)}` : 'none ever made',
      },
      {
        label: 'Longest allowed',
        value: '240 min',
        caption: `${plural((c['Ended'] ?? 0) + (c['Expired'] ?? 0), 'elevation')} ended or expired`,
      },
    ];
  });

  constructor() {
    this.elevations.reload();
    this.tenants.reload();
  }

  actions(e: AccessElevation) {
    return elevationActions(
      e,
      this.me(),
      this.auth.hasPermission(Permission.PlatformElevationApprove),
    );
  }

  toggle(key: string): void {
    this.chosen.update((s) => toggled(s, key));
  }

  request(): void {
    this.submitted.set(true);
    if (this.errors().length || this.busy()) return;
    this.busy.set(true);
    this.iam
      .requestElevation({
        tenantId: this.tenantId()!,
        reason: this.reason().trim(),
        minutes: this.minutes(),
        permissions: [...this.chosen()].sort(),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.submitted.set(false);
          this.reason.set('');
          this.chosen.set(new Set());
          this.notify.success('Access requested. Another staff member has to approve it.');
          this.elevations.reload();
        },
        error: (e) => {
          this.busy.set(false);
          if (reportable(e)) this.notify.error(errorText(e, 'The request was not sent.'));
        },
      });
  }

  run(): void {
    const p = this.pending();
    if (!p || this.busy()) return;
    this.busy.set(true);
    const call =
      p.kind === 'approve'
        ? this.iam.approveElevation(p.elevation.id)
        : this.iam.endElevation(p.elevation.id);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.pending.set(null);
        this.notify.success(p.kind === 'approve' ? 'Access approved.' : 'Access ended.');
        this.elevations.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.pending.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'That did not work.'));
      },
    });
  }

  /** Move the session into the organisation the active elevation covers (reloads the console). */
  async open(e: AccessElevation): Promise<void> {
    try {
      await this.auth.switchTenant(e.tenantId);
    } catch (err) {
      const message =
        err instanceof HttpErrorResponse
          ? (err.error as { message?: string } | null)?.message
          : null;
      this.notify.error(message || 'Could not open that organisation.');
    }
  }
}
