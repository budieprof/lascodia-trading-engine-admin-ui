import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, memberLabel, reportable, when } from '@features/iam/iam.logic';
import type { CreateTenantBody, IamMember, TenantDto } from '@features/iam/iam.types';
import { iamResource } from '@features/iam/shared/iam-resource';
import { tenantErrors, tenantStatusAction } from '../platform.logic';

/**
 * Organisations (U3.6; t2-core `platform/tenants`, `platform.tenants.manage`): list, create a
 * Customer or Canary organisation, suspend (its members are refused; its EAs keep connecting so open
 * positions stay managed — suspension is not a kill switch) and reactivate. House is never
 * suspended. Every change is audited by the engine.
 */
@Component({
  selector: 'app-platform-organisations-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header title="Organisations" subtitle="Every organisation on the platform.">
        <input
          class="input search"
          type="search"
          placeholder="Search slug or name"
          aria-label="Search organisations"
          [ngModel]="search()"
          (ngModelChange)="search.set($event)"
          (keyup.enter)="tenants.reload()"
        />
        <button
          type="button"
          class="btn btn-secondary"
          (click)="tenants.reload()"
          [disabled]="tenants.loading()"
        >
          {{ tenants.loading() ? 'Loading…' : 'Search' }}
        </button>
        <button type="button" class="btn btn-primary" (click)="creating.set(!creating())">
          New organisation
        </button>
      </app-page-header>

      @if (creating()) {
        <section class="card">
          <header class="card-head"><h3>New organisation</h3></header>
          <form class="card-body" (ngSubmit)="create()">
            <div class="form-grid">
              <label class="field">
                <span class="label">Slug (permanent)</span>
                <input
                  class="input"
                  name="slug"
                  [ngModel]="draft().slug"
                  (ngModelChange)="patch({ slug: $event })"
                  placeholder="acme-capital"
                />
              </label>
              <label class="field">
                <span class="label">Name</span>
                <input
                  class="input"
                  name="name"
                  [ngModel]="draft().name"
                  (ngModelChange)="patch({ name: $event })"
                />
              </label>
              <label class="field">
                <span class="label">Kind</span>
                <select
                  class="select"
                  name="kind"
                  [ngModel]="draft().kind"
                  (ngModelChange)="patch({ kind: $event })"
                >
                  <option value="Customer">Customer</option>
                  <option value="Canary">Canary (isolation probe, demo accounts only)</option>
                </select>
              </label>
            </div>
            <label class="check">
              <input
                type="checkbox"
                name="learning"
                [ngModel]="draft().contributesToPlatformLearning"
                (ngModelChange)="patch({ contributesToPlatformLearning: $event })"
              />
              Its trading may feed platform-wide research and models
            </label>
            @if (submitted() && errors().length) {
              <ul class="errors" role="alert">
                @for (e of errors(); track e) {
                  <li>{{ e }}</li>
                }
              </ul>
            }
            <div class="actions-row">
              <button type="button" class="btn btn-secondary" (click)="creating.set(false)">
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy()">
                {{ busy() ? 'Creating…' : 'Create' }}
              </button>
            </div>
          </form>
        </section>
      }

      <section class="card">
        @if (tenants.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (tenants.loaded() && tenants.value().length === 0) {
          <p class="pad muted">No organisations match.</p>
        } @else if (tenants.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Members</th>
                  <th>Created</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (t of tenants.value(); track t.id) {
                  @let action = statusAction(t);
                  <tr [class.selected]="openMembersFor() === t.id">
                    <td>
                      {{ t.name }}
                      <span class="sub"
                        ><code>{{ t.slug }}</code> · #{{ t.id }}</span
                      >
                    </td>
                    <td>
                      <span class="chip" [class.info]="t.kind === 'House'">{{ t.kind }}</span>
                    </td>
                    <td>
                      <span
                        class="chip"
                        [class.ok]="t.status === 'Active'"
                        [class.bad]="t.status !== 'Active'"
                        >{{ t.status }}</span
                      >
                      @if (t.statusReason) {
                        <span class="sub">{{ t.statusReason }}</span>
                      }
                    </td>
                    <td class="small">{{ t.activeMembers ?? '—' }}</td>
                    <td class="small">{{ when(t.createdAtUtc) }}</td>
                    <td class="actions">
                      <button
                        type="button"
                        class="btn btn-sm btn-secondary"
                        (click)="toggleMembers(t)"
                      >
                        Members
                      </button>
                      @if (action === 'suspend') {
                        <button
                          type="button"
                          class="btn btn-sm btn-danger"
                          (click)="openStatus(t, 'suspend')"
                        >
                          Suspend
                        </button>
                      } @else if (action === 'reactivate') {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="openStatus(t, 'reactivate')"
                        >
                          Reactivate
                        </button>
                      }
                    </td>
                  </tr>
                  @if (openMembersFor() === t.id) {
                    <tr class="selected">
                      <td colspan="6">
                        @if (membersError(); as e) {
                          <span class="chip bad">Could not load</span> {{ e }}
                        } @else if (members().length === 0) {
                          <span class="muted small">No members.</span>
                        } @else {
                          @for (m of members(); track m.userId) {
                            <span class="sub">{{ label(m) }} — {{ m.status }}</span>
                          }
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
        [open]="statusChange() !== null"
        [title]="
          (statusChange()?.action === 'suspend' ? 'Suspend ' : 'Reactivate ') +
          (statusChange()?.tenant?.name ?? '') +
          '?'
        "
        [message]="
          statusChange()?.action === 'suspend'
            ? 'Its members are refused at once. Its EAs keep connecting so open positions stay managed — this is not a kill switch.'
            : 'Its members can sign in again.'
        "
        [confirmLabel]="statusChange()?.action === 'suspend' ? 'Suspend' : 'Reactivate'"
        [confirmVariant]="statusChange()?.action === 'suspend' ? 'destructive' : 'primary'"
        [loading]="busy()"
        (confirm)="changeStatus()"
        (cancelled)="statusChange.set(null)"
      >
        <label class="field">
          <span class="label"
            >Reason (recorded{{ statusChange()?.action === 'suspend' ? ', required' : '' }})</span
          >
          <input
            class="input"
            name="reason"
            [ngModel]="reason()"
            (ngModelChange)="reason.set($event)"
          />
        </label>
      </app-confirm-dialog>
    </div>
  `,
})
export class OrganisationsPageComponent {
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly when = when;

  readonly search = signal('');
  readonly tenants = iamResource(
    () => this.iam.tenants(this.search().trim() || undefined),
    [] as TenantDto[],
    'Could not load organisations.',
  );

  readonly creating = signal(false);
  readonly draft = signal<CreateTenantBody>({
    slug: '',
    name: '',
    kind: 'Customer',
    contributesToPlatformLearning: false,
  });
  readonly submitted = signal(false);
  readonly errors = computed(() => tenantErrors(this.draft()));
  readonly busy = signal(false);

  readonly openMembersFor = signal<number | null>(null);
  readonly members = signal<IamMember[]>([]);
  readonly membersError = signal<string | null>(null);

  readonly statusChange = signal<{ tenant: TenantDto; action: 'suspend' | 'reactivate' } | null>(
    null,
  );
  readonly reason = signal('');

  constructor() {
    this.tenants.reload();
  }

  statusAction(t: TenantDto) {
    return tenantStatusAction(t);
  }

  label(m: IamMember): string {
    return memberLabel(m);
  }

  patch(change: Partial<CreateTenantBody>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  create(): void {
    this.submitted.set(true);
    if (this.errors().length || this.busy()) return;
    const body = {
      ...this.draft(),
      slug: this.draft().slug.trim().toLowerCase(),
      name: this.draft().name.trim(),
    };
    this.busy.set(true);
    this.iam.createTenant(body).subscribe({
      next: () => {
        this.busy.set(false);
        this.submitted.set(false);
        this.creating.set(false);
        this.draft.set({
          slug: '',
          name: '',
          kind: 'Customer',
          contributesToPlatformLearning: false,
        });
        this.notify.success(`Organisation ${body.name} created.`);
        this.tenants.reload();
      },
      error: (e) => {
        this.busy.set(false);
        if (reportable(e)) this.notify.error(errorText(e, 'The organisation was not created.'));
      },
    });
  }

  toggleMembers(t: TenantDto): void {
    if (this.openMembersFor() === t.id) {
      this.openMembersFor.set(null);
      return;
    }
    this.openMembersFor.set(t.id);
    this.members.set([]);
    this.membersError.set(null);
    this.iam.tenantMembers(t.id).subscribe({
      next: (m) => this.members.set(m),
      error: (e) => this.membersError.set(errorText(e, 'Could not load members.')),
    });
  }

  openStatus(tenant: TenantDto, action: 'suspend' | 'reactivate'): void {
    this.reason.set('');
    this.statusChange.set({ tenant, action });
  }

  changeStatus(): void {
    const c = this.statusChange();
    if (!c || this.busy()) return;
    const reason = this.reason().trim();
    if (c.action === 'suspend' && !reason) {
      this.notify.error('Say why the organisation is suspended.');
      return;
    }
    this.busy.set(true);
    const call =
      c.action === 'suspend'
        ? this.iam.suspendTenant(c.tenant.id, reason)
        : this.iam.reactivateTenant(c.tenant.id, reason || null);
    call.subscribe({
      next: () => {
        this.busy.set(false);
        this.statusChange.set(null);
        this.notify.success(
          `${c.tenant.name} ${c.action === 'suspend' ? 'suspended' : 'reactivated'}.`,
        );
        this.tenants.reload();
      },
      error: (e) => {
        this.busy.set(false);
        this.statusChange.set(null);
        if (reportable(e)) this.notify.error(errorText(e, 'The status was not changed.'));
      },
    });
  }
}
