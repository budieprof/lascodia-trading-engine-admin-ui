import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PlansApiService } from '@features/platform/plans-api.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { BillingApiService } from '../billing-api.service';
import { monthLabel, recentMonths } from '../billing.logic';
import {
  ALLOWABLE_UNITS,
  type AddOnForm,
  type UnitForm,
  addOnBody,
  addOnFormFrom,
  amount,
  grantsLabel,
  planAllowancesBody,
  priceLabel,
  unitFormFrom,
  usd,
} from '../add-ons.logic';
import type { AddOn, TenantAddOn, UnitCostReport } from '../add-ons.types';

/**
 * Platform billing → "Add-ons & unit costs" (freemium program): what each priced unit cost the platform this month (price
 * above it), the add-on catalogue and what each grants, each plan's allowance per unit, and giving or ending an add-on
 * for one organisation. Reads `platform.usage.read`; changes `platform.billing.manage`, each behind a confirmation.
 */
@Component({
  selector: 'app-billing-add-ons-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ConfirmDialogComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-width: 0;
      }
      .form-grid {
        display: grid;
        gap: 0.6rem;
        padding: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(min(13rem, 100%), 1fr));
      }
      .form-grid label {
        display: grid;
        gap: 0.25rem;
      }
      .actions {
        display: flex;
        gap: 0.5rem;
        padding: 0 1rem 1rem;
        flex-wrap: wrap;
        align-items: center;
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
  template: `
    <!-- ── Unit costs ── -->
    <section class="card">
      <header class="card-head">
        <h3>What each unit costs</h3>
        <span class="spacer"></span>
        <select
          class="select"
          aria-label="Month"
          [ngModel]="costMonth()"
          (ngModelChange)="costMonth.set($event); costs.reload()"
        >
          @for (m of months; track m) {
            <option [ngValue]="m">{{ monthLabel(m) }}</option>
          }
        </select>
      </header>
      @if (costs.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      } @else if (costs.value(); as r) {
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Unit</th>
                <th class="num">Counted</th>
                <th class="num">Organisations</th>
                <th class="num">AI cost</th>
                <th class="num">Compute hours</th>
                <th class="num">Compute cost</th>
                <th class="num">Cost per unit</th>
              </tr>
            </thead>
            <tbody>
              @for (u of r.units; track u.unit) {
                <tr>
                  <td>{{ u.label }}</td>
                  <td class="num">{{ amount(u.quantity) }}</td>
                  <td class="num">{{ u.organisations }}</td>
                  <td class="num">{{ usd(u.aiCostUsd) }}</td>
                  <td class="num">{{ amount(u.computeHours) }}</td>
                  <td class="num">
                    {{ u.computeCostUsd === null ? 'rate not set' : usd(u.computeCostUsd) }}
                  </td>
                  <td class="num">
                    <strong>{{ usd(u.costPerUnitUsd) }}</strong>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <p class="pad muted small">{{ r.note }}</p>
      } @else {
        <p class="pad muted">Loading…</p>
      }
    </section>

    <!-- ── Add-ons ── -->
    <section class="card">
      <header class="card-head">
        <h3>Add-ons</h3>
        <span class="spacer"></span>
        @if (canManage()) {
          <button type="button" class="btn btn-sm btn-secondary" (click)="edit(null)">
            New add-on
          </button>
        }
      </header>
      @if (addOns.error(); as err) {
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      } @else {
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Add-on</th>
                <th>Price</th>
                <th>Trial</th>
                <th>Grants</th>
                <th>Offered</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (a of addOns.value(); track a.id) {
                <tr>
                  <td>
                    {{ a.name }} <code class="small">{{ a.slug }}</code>
                  </td>
                  <td>{{ priceLabel(a) || '—' }}</td>
                  <td>{{ a.trialDays ? a.trialDays + ' days' : '—' }}</td>
                  <td class="small">{{ grantsLabel(a.grants) }}</td>
                  <td>
                    <span class="chip" [class]="a.isActive ? 'ok' : ''">{{
                      a.isActive ? 'Yes' : 'No'
                    }}</span>
                  </td>
                  <td>
                    @if (canManage()) {
                      <button type="button" class="btn btn-sm btn-secondary" (click)="edit(a)">
                        Edit
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      @if (form(); as f) {
        <div class="form-grid">
          <label
            >Slug
            <input
              class="input"
              [disabled]="editingExisting()"
              [ngModel]="f.slug"
              (ngModelChange)="patch({ slug: $event })"
          /></label>
          <label
            >Name <input class="input" [ngModel]="f.name" (ngModelChange)="patch({ name: $event })"
          /></label>
          <label
            >Price, US$ a month (shown only)
            <input
              class="input"
              inputmode="decimal"
              [ngModel]="f.price"
              (ngModelChange)="patch({ price: $event })"
          /></label>
          <label
            >Free trial, days (0 = none)
            <input
              class="input"
              inputmode="numeric"
              [ngModel]="f.trialDays"
              (ngModelChange)="patch({ trialDays: $event })"
          /></label>
          <label
            >Description
            <input
              class="input"
              [ngModel]="f.description"
              (ngModelChange)="patch({ description: $event })"
          /></label>
          @for (u of units; track u.key) {
            <label
              >Grants: {{ u.label }}
              <input
                class="input"
                inputmode="decimal"
                placeholder="not granted"
                [ngModel]="f.grants[u.key]"
                (ngModelChange)="patchGrant(u.key, $event)"
            /></label>
          }
          <label
            ><span
              ><input
                type="checkbox"
                [ngModel]="f.isActive"
                (ngModelChange)="patch({ isActive: $event })"
              />
              Offered to organisations</span
            ></label
          >
        </div>
        <div class="actions">
          <button
            type="button"
            class="btn btn-sm btn-primary"
            [disabled]="busy()"
            (click)="askSaveAddOn()"
          >
            Save add-on
          </button>
          <button type="button" class="btn btn-sm btn-secondary" (click)="form.set(null)">
            Cancel
          </button>
          <span class="muted small"
            >The price charged comes from Stripe / Paystack (Billing:…:addon-{{
              f.slug || 'slug'
            }}); this one is shown on the page.</span
          >
        </div>
      }
    </section>

    <!-- ── Plan allowances ── -->
    <section class="card">
      <header class="card-head">
        <h3>Plan allowances</h3>
        <span class="spacer"></span>
        <select
          class="select"
          aria-label="Plan"
          [ngModel]="planId()"
          (ngModelChange)="pickPlan($event)"
        >
          <option [ngValue]="null">Choose a plan…</option>
          @for (p of plans.value(); track p.id) {
            <option [ngValue]="p.id">{{ p.name }}</option>
          }
        </select>
      </header>
      @if (allowanceForm(); as af) {
        <div class="form-grid">
          @for (u of units; track u.key) {
            <label
              >{{ u.label }}
              <input
                class="input"
                inputmode="decimal"
                placeholder="unlimited"
                [ngModel]="af[u.key]"
                (ngModelChange)="patchAllowance(u.key, $event)"
                [disabled]="!canManage()"
            /></label>
          }
        </div>
        <div class="actions">
          @if (canManage()) {
            <button
              type="button"
              class="btn btn-sm btn-primary"
              [disabled]="busy()"
              (click)="askSaveAllowances()"
            >
              Save allowances
            </button>
          }
          <span class="muted small"
            >Empty = unlimited. Add-ons add to these. House is never limited.</span
          >
        </div>
      } @else {
        <p class="pad muted">Choose a plan to see its allowance per unit.</p>
      }
    </section>

    <!-- ── One organisation's add-ons ── -->
    <section class="card">
      <header class="card-head">
        <h3>An organisation's add-ons</h3>
        <span class="spacer"></span>
        <select
          class="select"
          aria-label="Organisation"
          [ngModel]="tenantId()"
          (ngModelChange)="pickTenant($event)"
        >
          <option [ngValue]="null">Choose an organisation…</option>
          @for (t of tenants.value(); track t.id) {
            <option [ngValue]="t.id">{{ t.name }}</option>
          }
        </select>
      </header>
      @if (tenantId() !== null) {
        @if (held.value().length === 0) {
          <p class="pad muted">{{ held.loaded() ? 'No add-ons.' : 'Loading…' }}</p>
        } @else {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Add-on</th>
                  <th>How</th>
                  <th>Started</th>
                  <th>Ends</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (h of held.value(); track h.id) {
                  <tr>
                    <td>{{ h.addOnSlug }}</td>
                    <td>{{ h.source }}</td>
                    <td class="small">{{ when(h.startedAtUtc) }}</td>
                    <td class="small">
                      {{
                        h.endedAtUtc
                          ? 'ended ' + when(h.endedAtUtc)
                          : h.endsAtUtc
                            ? when(h.endsAtUtc)
                            : 'until ended'
                      }}
                    </td>
                    <td>
                      <span class="chip" [class]="h.inForce ? 'ok' : ''">{{
                        h.inForce ? 'On' : 'Off'
                      }}</span>
                    </td>
                    <td>
                      @if (canManage() && h.inForce) {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="pendingEnd.set(h)"
                        >
                          End now
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
        @if (canManage()) {
          <div class="form-grid">
            <label
              >Add-on
              <select
                class="select"
                [ngModel]="grantSlug()"
                (ngModelChange)="grantSlug.set($event)"
              >
                @for (a of addOns.value(); track a.id) {
                  <option [ngValue]="a.slug">{{ a.name }}</option>
                }
              </select>
            </label>
            <label
              >Until (optional)
              <input
                class="input"
                type="date"
                [ngModel]="grantUntil()"
                (ngModelChange)="grantUntil.set($event)"
            /></label>
            <label
              >Note
              <input class="input" [ngModel]="grantNote()" (ngModelChange)="grantNote.set($event)"
            /></label>
          </div>
          <div class="actions">
            <button
              type="button"
              class="btn btn-sm btn-primary"
              [disabled]="busy() || !grantSlug()"
              (click)="pendingGrant.set(true)"
            >
              Give add-on
            </button>
          </div>
        }
      }
    </section>

    <app-confirm-dialog
      [open]="confirmOpen()"
      [title]="confirmTitle()"
      [message]="confirmMessage()"
      [loading]="busy()"
      (confirm)="runConfirmed()"
      (cancelled)="clearPending()"
    />
  `,
})
export class AddOnsAdminComponent {
  private readonly api = inject(BillingApiService);
  private readonly plansApi = inject(PlansApiService);
  private readonly iamApi = inject(IamApiService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  protected readonly units = ALLOWABLE_UNITS;
  protected readonly months = recentMonths(13);
  protected readonly monthLabel = monthLabel;
  protected readonly amount = amount;
  protected readonly usd = usd;
  protected readonly when = when;
  protected readonly grantsLabel = grantsLabel;
  protected readonly priceLabel = priceLabel;

  readonly canManage = computed(() => this.auth.hasPermission(Permission.PlatformBillingManage));
  readonly costMonth = signal(this.months[0]);
  readonly costs = iamResource<UnitCostReport | null>(
    () => this.api.unitCosts(this.costMonth()),
    null,
    'Could not load unit costs.',
  );
  readonly addOns = iamResource<AddOn[]>(() => this.api.addOns(), [], 'Could not load add-ons.');
  readonly plans = iamResource(
    () => this.plansApi.plans().pipe(catchError(() => of([]))),
    [],
    'Could not load plans.',
  );
  readonly tenants = iamResource(
    () => this.iamApi.tenants().pipe(catchError(() => of([]))),
    [],
    'Could not load organisations.',
  );

  readonly busy = signal(false);
  readonly form = signal<AddOnForm | null>(null);
  readonly editingExisting = signal(false);
  readonly planId = signal<number | null>(null);
  readonly allowanceForm = signal<UnitForm | null>(null);
  readonly tenantId = signal<number | null>(null);
  readonly held = iamResource<TenantAddOn[]>(
    () => this.api.tenantAddOns(this.tenantId() ?? 0),
    [],
    'Could not load add-ons.',
  );
  readonly grantSlug = signal<string | null>(null);
  readonly grantUntil = signal('');
  readonly grantNote = signal('');

  readonly pendingSave = signal(false);
  readonly pendingAllowances = signal(false);
  readonly pendingGrant = signal(false);
  readonly pendingEnd = signal<TenantAddOn | null>(null);

  readonly confirmOpen = computed(
    () =>
      this.pendingSave() ||
      this.pendingAllowances() ||
      this.pendingGrant() ||
      this.pendingEnd() !== null,
  );
  readonly confirmTitle = computed(() =>
    this.pendingSave()
      ? 'Save add-on'
      : this.pendingAllowances()
        ? 'Save plan allowances'
        : this.pendingGrant()
          ? 'Give add-on'
          : 'End add-on',
  );
  readonly confirmMessage = computed(() => {
    if (this.pendingSave())
      return 'Organisations that hold this add-on get the new grants at once.';
    if (this.pendingAllowances())
      return 'Every organisation on this plan is held to these allowances (when enforcement is on).';
    if (this.pendingGrant())
      return `Give ${this.grantSlug()} to this organisation${this.grantUntil() ? ' until ' + this.grantUntil() : ' until ended'}?`;
    const h = this.pendingEnd();
    return h
      ? `End ${h.addOnSlug} for this organisation now? A paid subscription is not cancelled at the provider.`
      : '';
  });

  constructor() {
    this.costs.reload();
    this.addOns.reload();
    this.plans.reload();
    this.tenants.reload();
  }

  edit(a: AddOn | null): void {
    this.editingExisting.set(a !== null);
    this.form.set(addOnFormFrom(a));
  }

  patch(p: Partial<AddOnForm>): void {
    const f = this.form();
    if (f) this.form.set({ ...f, ...p });
  }

  patchGrant(key: string, value: string): void {
    const f = this.form();
    if (f) this.form.set({ ...f, grants: { ...f.grants, [key]: value } });
  }

  pickPlan(id: number | null): void {
    this.planId.set(id);
    this.allowanceForm.set(null);
    if (id === null) return;
    this.api.planAllowances(id).subscribe({
      next: (a) => this.allowanceForm.set(unitFormFrom(a)),
      error: (e) =>
        reportable(e) && this.notify.error(errorText(e, 'Could not load the plan allowances.')),
    });
  }

  patchAllowance(key: string, value: string): void {
    const f = this.allowanceForm();
    if (f) this.allowanceForm.set({ ...f, [key]: value });
  }

  pickTenant(id: number | null): void {
    this.tenantId.set(id);
    if (id !== null) this.held.reload();
    if (!this.grantSlug()) this.grantSlug.set(this.addOns.value()[0]?.slug ?? null);
  }

  askSaveAddOn(): void {
    const f = this.form();
    if (!f) return;
    const { error } = addOnBody(f);
    if (error) this.notify.error(error);
    else this.pendingSave.set(true);
  }

  askSaveAllowances(): void {
    const f = this.allowanceForm();
    if (!f) return;
    const { error } = planAllowancesBody(f);
    if (error) this.notify.error(error);
    else this.pendingAllowances.set(true);
  }

  clearPending(): void {
    this.pendingSave.set(false);
    this.pendingAllowances.set(false);
    this.pendingGrant.set(false);
    this.pendingEnd.set(null);
  }

  runConfirmed(): void {
    const done = (message: string) => () => {
      this.busy.set(false);
      this.clearPending();
      this.notify.success(message);
    };
    const failed = (fallback: string) => (e: unknown) => {
      this.busy.set(false);
      this.clearPending();
      if (reportable(e)) this.notify.error(errorText(e, fallback));
    };
    this.busy.set(true);

    if (this.pendingSave()) {
      const { slug, body } = addOnBody(this.form()!);
      this.api.saveAddOn(slug, body!).subscribe({
        next: () => {
          done('Add-on saved.')();
          this.form.set(null);
          this.addOns.reload();
        },
        error: failed('Could not save the add-on.'),
      });
    } else if (this.pendingAllowances()) {
      const id = this.planId()!;
      this.api.setPlanAllowances(id, planAllowancesBody(this.allowanceForm()!).body!).subscribe({
        next: (a) => {
          this.allowanceForm.set(unitFormFrom(a));
          done('Plan allowances saved.')();
        },
        error: failed('Could not save the allowances.'),
      });
    } else if (this.pendingGrant()) {
      const until = this.grantUntil()
        ? new Date(this.grantUntil() + 'T23:59:59Z').toISOString()
        : null;
      this.api
        .grantAddOn(this.tenantId()!, this.grantSlug()!, until, this.grantNote().trim() || null)
        .subscribe({
          next: () => {
            done('Add-on given.')();
            this.grantNote.set('');
            this.held.reload();
          },
          error: failed('Could not give the add-on.'),
        });
    } else if (this.pendingEnd()) {
      const h = this.pendingEnd()!;
      this.api.endAddOn(h.tenantId, h.id, null).subscribe({
        next: () => {
          done('Add-on ended.')();
          this.held.reload();
        },
        error: failed('Could not end the add-on.'),
      });
    } else this.busy.set(false);
  }
}
