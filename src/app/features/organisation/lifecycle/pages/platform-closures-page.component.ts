import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, defer, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { errorText } from '@features/iam/iam.logic';
import { IamApiService } from '@features/iam/iam-api.service';
import type { TenantDto } from '@features/iam/iam.types';
import { ago, countBy } from '@features/iam/shared/admin-context.logic';
import { AuditTrailComponent } from '@features/iam/shared/audit-trail.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { MfaHintComponent } from '@features/iam/shared/mfa-hint.component';
import { LifecycleApiService } from '../lifecycle-api.service';
import {
  closureStatusLabel,
  closureTone,
  daysUntil,
  planSummary,
  purgeConfirmationOk,
} from '../lifecycle.logic';
import type { TenantClosure, TenantClosureState } from '../lifecycle.types';
import { PlansApiService } from '@features/platform/plans-api.service';
import type { TenantUsage } from '@features/platform/plans.types';

type Dialog = 'reopen' | 'purge' | null;

/**
 * Closed organisations, for platform staff (engine multi-tenancy Phase 7, LC.3, `/platform/closures`):
 * each closure with what it did at once, its grace period, a reopening (`platform.tenants.manage`), the
 * deletion plan — a dry run listing every table and how many rows, who is removed, what is kept and
 * anything that blocks it (`platform.tenants.purge`) — and the confirmation of the deletion (typed handle,
 * step-up; only after the grace period and with a plan free of blockers). House is never closed.
 */
@Component({
  selector: 'app-platform-closures-page',
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
      tr.selected td {
        background: var(--bg-secondary);
      }
      .facts {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: var(--space-1) var(--space-4);
        margin: 0;
      }
      .facts dt {
        color: var(--text-secondary);
      }
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
      ol.steps {
        list-style: decimal;
        margin: 0;
        padding-left: var(--space-5);
        display: grid;
        gap: var(--space-2);
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Closed organisations"
        subtitle="Organisations their owners closed: reopen one within its grace period, or review and confirm the deletion of its data."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="reloadAll()"
          [disabled]="closures.loading()"
        >
          {{ closures.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Closures summary" />

      <section class="card">
        <header class="card-head"><h3>Closed organisations</h3></header>
        @if (closures.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (closures.loaded() && closures.value().length === 0 && !closures.error()) {
          <p class="pad small muted">
            No organisation has been closed. A closure appears here the moment an organisation's
            Owner closes it from <a routerLink="/organisation/close">Close organisation</a>; it then
            waits out its {{ graceDays() ?? 30 }}-day grace period before its data can be deleted.
          </p>
        }
        @if (closures.value().length) {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Closed</th>
                  <th scope="col">Status</th>
                  <th scope="col">Grace period ends</th>
                  <th scope="col"><span class="sr-only">Open</span></th>
                </tr>
              </thead>
              <tbody>
                @for (c of closures.value(); track c.id) {
                  <tr [class.selected]="selected()?.tenantId === c.tenantId">
                    <td>
                      {{ c.name || 'Organisation #' + c.tenantId }}
                      <div class="sub">{{ c.slug }} · {{ c.reason }}</div>
                    </td>
                    <td>
                      {{ c.closedAtUtc | date: 'medium' }}
                      <div class="sub">by {{ c.requestedBy }}</div>
                    </td>
                    <td>
                      <span [class]="'chip ' + tone(c.status)">{{ statusLabel(c.status) }}</span>
                    </td>
                    <td>
                      {{ c.graceEndsAtUtc | date: 'mediumDate' }}
                      @if (daysLeft(c.graceEndsAtUtc) > 0) {
                        <div class="sub">{{ daysLeft(c.graceEndsAtUtc) }} day(s) left</div>
                      }
                    </td>
                    <td>
                      <button type="button" class="btn btn-secondary btn-sm" (click)="select(c)">
                        Details
                      </button>
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
            <h3>Every organisation</h3>
            <span class="spacer"></span>
            <a class="small" routerLink="/platform/organisations">Organisations</a>
          </header>
          @if (tenants.value().length === 0) {
            <p class="pad small muted">
              {{
                canSeeTenants()
                  ? 'Loading…'
                  : 'Listing organisations needs platform.tenants.manage.'
              }}
            </p>
          } @else {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Organisation</th>
                    <th>State</th>
                    <th>Can it be closed?</th>
                  </tr>
                </thead>
                <tbody>
                  @for (t of tenants.value(); track t.id) {
                    <tr>
                      <td>
                        {{ t.name
                        }}<span class="sub"
                          >{{ t.slug }} · {{ t.kind }} · {{ t.activeMembers ?? 0 }} active
                          members</span
                        >
                      </td>
                      <td>
                        <span
                          class="chip"
                          [class.ok]="t.status === 'Active'"
                          [class.warn]="t.status === 'Suspended'"
                          [class.bad]="t.status === 'Closed'"
                          >{{ t.status }}</span
                        >
                      </td>
                      <td class="small">{{ closable(t) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
          @if (own.value(); as o) {
            @if (o.blockers.length) {
              <div class="card-body">
                <p class="small">
                  <strong>{{ o.name }}</strong> (the organisation you act in) today:
                </p>
                <ul class="errors">
                  @for (b of o.blockers; track b) {
                    <li>{{ b }}</li>
                  }
                </ul>
                <p class="small muted">
                  {{ o.members }} members · {{ o.owners }} Owner(s) ·
                  {{ o.activeMachineCredentials }} terminal credentials · {{ o.openPositions }} open
                  positions · {{ o.workingOrders }} working orders
                </p>
              </div>
            }
          }
        </section>

        <section class="card">
          <header class="card-head"><h3>What closing does, step by step</h3></header>
          <div class="card-body small">
            <ol class="steps">
              <li>
                An Owner closes the organisation (step-up sign-in; a second Owner approves when
                there is more than one). It is refused for House and while positions or working
                orders are open.
              </li>
              <li>
                At once: the organisation kill switch is engaged, terminal credentials, enrollment
                tokens, API tokens and invitations are revoked, sessions end and its
                identity-provider organisation is disabled.
              </li>
              <li>
                For {{ graceDays() ?? 30 }} days (<code>Tenancy:Closure:GraceDays</code>) platform
                staff can reopen it here — the kill switch stays engaged until someone releases it.
              </li>
              <li>
                After that, staff review a dry-run deletion plan (every table and row count, who is
                removed, what is kept) and confirm with the organisation's handle. The engine
                deletes its data; audit events, the closure record and platform rows are kept.
              </li>
            </ol>
          </div>
        </section>
      </div>

      @if (usage.value(); as u) {
        <section class="card">
          <header class="card-head">
            <h3>What a deletion covers — {{ u.tenantName }} today</h3>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <tbody>
                @for (i of u.items; track i.key) {
                  <tr>
                    <td>{{ i.label }}</td>
                    <td>
                      <strong>{{ i.used }}</strong>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="pad small muted">
            A deletion removes every row the organisation owns — these counts plus its orders,
            positions, signals, settings, alerts and conversations — in dependency order, and keeps
            its audit events, the closure record and platform rows.
            {{
              u.kind === 'House'
                ? 'House itself is never deleted; these are its figures for scale.'
                : ''
            }}
          </p>
        </section>
      }

      <app-audit-trail
        heading="Closure activity"
        [actions]="['tenant.closure.', 'platform.tenant.']"
        empty="No organisation has been closed, reopened, suspended or deleted yet. Each closure, refusal, reopening, deletion plan and deletion is recorded here."
      />

      @if (selected(); as c) {
        <section class="card">
          <header class="card-head">
            <h3>
              {{ c.name || 'Organisation #' + c.tenantId }}
              <span class="muted small">{{ c.slug }}</span>
            </h3>
            <span class="spacer"></span>
            <span [class]="'chip ' + tone(c.status)">{{ statusLabel(c.status) }}</span>
          </header>
          <div class="card-body">
            <dl class="facts">
              <dt>Closed</dt>
              <dd>
                {{ c.closedAtUtc | date: 'medium' }} by {{ c.requestedBy }}
                @if (c.approvedBy) {
                  (approved by {{ c.approvedBy }})
                }
              </dd>
              <dt>Reason</dt>
              <dd>{{ c.reason || '—' }}</dd>
              <dt>At once</dt>
              <dd>
                kill switch engaged; {{ c.effects?.machineCredentialsRevoked ?? 0 }} machine
                credential(s), {{ c.effects?.enrollmentTokensRevoked ?? 0 }} enrollment token(s),
                {{ c.effects?.accessTokensRevoked ?? 0 }} access token(s) revoked;
                {{ c.effects?.consoleSessionsEnded ?? 0 }} session(s) ended
              </dd>
              <dt>Grace period</dt>
              <dd>until {{ c.graceEndsAtUtc | date: 'medium' }}</dd>
              @if (c.reopenedAtUtc) {
                <dt>Reopened</dt>
                <dd>
                  {{ c.reopenedAtUtc | date: 'medium' }} by {{ c.reopenedBy }}: {{ c.reopenReason }}
                </dd>
              }
              @if (c.purgeCompletedAtUtc) {
                <dt>Deletion</dt>
                <dd>
                  {{ c.purgeCompletedAtUtc | date: 'medium' }}
                  @if (c.purgeReport; as r) {
                    — {{ r.rows.toLocaleString() }} row(s) deleted,
                    {{ r.peopleRemoved.length }} person(s) removed
                  }
                </dd>
              }
              @if (c.purgeError) {
                <dt>Stopped</dt>
                <dd class="errors">{{ c.purgeError }}</dd>
              }
            </dl>

            @if (c.plan; as plan) {
              <h4>Deletion plan (dry run, {{ plan.generatedAtUtc | date: 'medium' }})</h4>
              <p [class.errors]="!plan.canRun">{{ summary(plan) }}</p>
              @if (plan.blockers.length) {
                <ul class="errors" role="alert">
                  @for (b of plan.blockers; track b.table + b.column) {
                    <li>
                      {{ b.table }}.{{ b.column }} → {{ b.referencesTable }} ({{ b.rows }}):
                      {{ b.why }}
                    </li>
                  }
                </ul>
              }
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Order</th>
                      <th scope="col">Table</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of plan.steps; track s.table; let i = $index) {
                      <tr>
                        <td>{{ i + 1 }}</td>
                        <td>{{ s.table }}</td>
                        <td>{{ s.ownership }}</td>
                        <td>{{ s.rows.toLocaleString() }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (plan.people.length) {
                <p class="small">
                  People:
                  @for (p of plan.people; track p.adminUserId; let last = $last) {
                    {{ p.username }} ({{ p.action }}){{ last ? '' : ', ' }}
                  }
                </p>
              }
              @for (n of plan.notes; track n) {
                <p class="note">{{ n }}</p>
              }
            }

            <div class="actions-row">
              @if (c.canReopen && can(P.PlatformTenantsManage)) {
                <button
                  type="button"
                  class="btn btn-secondary"
                  [disabled]="busy()"
                  (click)="openDialog('reopen')"
                >
                  Reopen…
                </button>
              }
              @if (
                (c.status === 'Closed' || c.status === 'PurgeFailed') && can(P.PlatformTenantsPurge)
              ) {
                <button
                  type="button"
                  class="btn btn-secondary"
                  [disabled]="busy()"
                  (click)="plan(c)"
                >
                  {{ busy() ? 'Working…' : 'Make a deletion plan (dry run)' }}
                </button>
              }
              @if (c.canSchedulePurge && c.plan?.canRun && can(P.PlatformTenantsPurge)) {
                <button
                  type="button"
                  class="btn btn-danger"
                  [disabled]="busy()"
                  (click)="openDialog('purge')"
                >
                  Delete its data…
                </button>
                <app-mfa-hint [permission]="P.PlatformTenantsPurge" />
              }
            </div>
            @if (!c.canSchedulePurge && c.status === 'Closed') {
              <p class="note">
                The deletion can be confirmed once the grace period is over ({{
                  daysLeft(c.graceEndsAtUtc)
                }}
                day(s) left).
              </p>
            }
          </div>
        </section>
      }

      @if (dialog(); as d) {
        @let c = selected()!;
        <div class="overlay" role="presentation">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="closure-dialog-title"
            tabindex="-1"
            appModalA11y
            (dismiss)="closeDialog()"
          >
            @if (d === 'reopen') {
              <h3 id="closure-dialog-title">
                Reopen {{ c.name || 'organisation #' + c.tenantId }}?
              </h3>
              <p>
                Members can sign in again. Its kill switch stays engaged until an Owner releases it,
                and its terminals must be connected again with new enrollment tokens.
              </p>
              <label class="field">
                <span class="label">Why?</span>
                <textarea
                  class="textarea"
                  name="reopenReason"
                  rows="3"
                  maxlength="500"
                  [ngModel]="text()"
                  (ngModelChange)="text.set($event)"
                ></textarea>
              </label>
              <div class="actions-row">
                <button
                  type="button"
                  class="btn btn-secondary"
                  data-autofocus
                  [disabled]="busy()"
                  (click)="closeDialog()"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn-primary"
                  [disabled]="busy() || !text().trim()"
                  (click)="reopen(c)"
                >
                  Reopen
                </button>
              </div>
            } @else {
              <h3 id="closure-dialog-title">
                Delete the data of {{ c.name || 'organisation #' + c.tenantId }} for good?
              </h3>
              <p>{{ c.plan ? summary(c.plan) : '' }} This cannot be undone.</p>
              <label class="field">
                <span class="label"
                  >Type the organisation's handle <code>{{ c.plan?.slug }}</code> to confirm</span
                >
                <input
                  class="input"
                  name="purgeSlug"
                  autocomplete="off"
                  [ngModel]="text()"
                  (ngModelChange)="text.set($event)"
                />
              </label>
              <div class="actions-row">
                <button
                  type="button"
                  class="btn btn-secondary"
                  data-autofocus
                  [disabled]="busy()"
                  (click)="closeDialog()"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  class="btn btn-danger"
                  [disabled]="busy() || !purgeOk()"
                  (click)="schedulePurge(c)"
                >
                  Delete its data
                </button>
              </div>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class PlatformClosuresPageComponent {
  private readonly api = inject(LifecycleApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly P = Permission;
  protected readonly statusLabel = closureStatusLabel;
  protected readonly tone = closureTone;
  protected readonly summary = planSummary;
  protected readonly daysLeft = (iso: string) => daysUntil(iso);

  readonly closures = iamResource<TenantClosure[]>(
    () => this.api.closures(),
    [],
    'Could not load closed organisations.',
  );
  private readonly iam = inject(IamApiService);
  readonly canSeeTenants = computed(() =>
    this.auth.hasPermission(Permission.PlatformTenantsManage),
  );
  readonly tenants = iamResource<TenantDto[]>(
    () =>
      this.canSeeTenants()
        ? this.iam.tenants().pipe(catchError(() => of([] as TenantDto[])))
        : of([] as TenantDto[]),
    [],
  );
  /** The acting organisation's own closing state — its blockers and the grace period in force. */
  readonly own = iamResource<TenantClosureState | null>(
    () => defer(() => this.api.closureState()).pipe(catchError(() => of(null))),
    null,
  );
  private readonly plansApi = inject(PlansApiService);
  readonly usage = iamResource<TenantUsage | null>(
    () => defer(() => this.plansApi.myUsage()).pipe(catchError(() => of(null))),
    null,
  );
  readonly graceDays = computed(() => this.own.value()?.graceDays ?? null);
  readonly tiles = computed<StatTile[]>(() => {
    const rows = this.closures.value();
    const tenants = this.tenants.value();
    const byStatus = countBy(tenants, (t) => t.status);
    const inGrace = rows.filter((c) => daysUntil(c.graceEndsAtUtc) > 0).length;
    const latest =
      rows
        .map((c) => c.closedAtUtc)
        .sort()
        .at(-1) ?? null;
    return [
      {
        label: 'Closed organisations',
        value: this.closures.loaded() ? String(rows.length) : '…',
        caption: latest ? `latest closed ${ago(latest)}` : 'none has ever been closed',
      },
      {
        label: 'In their grace period',
        value: this.closures.loaded() ? String(inGrace) : '…',
        caption: `can still be reopened (${this.graceDays() ?? 30} days)`,
        tone: inGrace ? 'warn' : null,
      },
      {
        label: 'Active organisations',
        value: tenants.length ? String(byStatus['Active'] ?? 0) : '—',
        caption: `of ${tenants.length} · ${byStatus['Suspended'] ?? 0} suspended`,
        route: '/platform/organisations',
      },
      {
        label: 'Data deletions',
        value: this.closures.loaded()
          ? String(rows.filter((c) => /purg/i.test(c.status)).length)
          : '…',
        caption: 'scheduled or finished',
      },
    ];
  });
  readonly selected = signal<TenantClosure | null>(null);
  readonly dialog = signal<Dialog>(null);
  readonly text = signal('');
  readonly busy = signal(false);
  readonly purgeOk = computed(() => {
    const c = this.selected();
    return purgeConfirmationOk(c, c?.plan?.slug ?? '', this.text());
  });

  constructor() {
    this.reloadAll();
  }

  reloadAll(): void {
    this.closures.reload();
    this.tenants.reload();
    this.own.reload();
    this.usage.reload();
  }

  closable(t: TenantDto): string {
    if (t.kind === 'House') return 'Never — House is the platform operator and is never closed.';
    if (t.status === 'Closed') return 'Already closed — see above.';
    return 'Yes, by its Owner, once nothing is open.';
  }

  can(key: string): boolean {
    return this.auth.hasPermission(key);
  }

  select(c: TenantClosure): void {
    this.selected.set(c);
    this.api.closure(c.tenantId).subscribe({
      next: (full) => this.selected.set(full),
      error: (e) => this.notify.error(errorText(e, 'Could not load this closure.')),
    });
  }

  openDialog(d: Exclude<Dialog, null>): void {
    this.text.set('');
    this.dialog.set(d);
  }

  closeDialog(): void {
    if (!this.busy()) this.dialog.set(null);
  }

  plan(c: TenantClosure): void {
    this.busy.set(true);
    this.api.planPurge(c.tenantId).subscribe({
      next: (plan) => {
        this.busy.set(false);
        this.notify.info(
          plan.canRun
            ? 'Deletion plan made.'
            : 'Deletion plan made: something blocks the deletion.',
        );
        this.select(c);
      },
      error: (e) => this.fail(e, 'Could not make the deletion plan.'),
    });
  }

  reopen(c: TenantClosure): void {
    this.busy.set(true);
    this.api.reopen(c.tenantId, this.text().trim()).subscribe({
      next: (updated) => this.done(updated, 'Reopened.'),
      error: (e) => this.fail(e, 'Could not reopen the organisation.'),
    });
  }

  schedulePurge(c: TenantClosure): void {
    if (!this.purgeOk()) return;
    this.busy.set(true);
    this.api.schedulePurge(c.tenantId, this.text().trim()).subscribe({
      next: (updated) => this.done(updated, 'Deletion confirmed: it runs within minutes.'),
      error: (e) => this.fail(e, 'Could not confirm the deletion.'),
    });
  }

  private done(updated: TenantClosure, message: string): void {
    this.busy.set(false);
    this.dialog.set(null);
    this.selected.set(updated);
    this.notify.success(message);
    this.closures.reload();
  }

  private fail(e: unknown, fallback: string): void {
    this.busy.set(false);
    this.notify.error(errorText(e, fallback));
  }
}
