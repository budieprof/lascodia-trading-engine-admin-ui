import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { catchError, of } from 'rxjs';

import { NotificationService } from '@core/notifications/notification.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { IamApiService } from '@features/iam/iam-api.service';
import type { TenantDto } from '@features/iam/iam.types';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { MarketDataEntitlementsApiService } from '../md-entitlements-api.service';
import {
  draftFromEntitlement,
  emptyGrantDraft,
  filterEntitlements,
  grantBody,
  grantErrors,
  statusTone,
  updateBody,
  usagesText,
  validityText,
} from '../md-entitlements.logic';
import type {
  GrantDraft,
  MarketDataEntitlementDto,
  MarketDataFeedCatalog,
} from '../md-entitlements.types';

/**
 * Market-data entitlements (engine C6, platform staff, `platform.data.manage`): which organisation may read which feed —
 * the CME depth and trades, each FX venue — for display (people) and non-display (machines, algorithms), and until when.
 * Every organisation has the default feeds (the broker's ticks and DOM) without a grant, House has every feed, and an
 * organisation's plan bounds what can be granted. Revoking ends live chart subscriptions within seconds. Every change is
 * recorded in the organisation's audit log.
 */
@Component({
  selector: 'app-md-entitlements-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent],
  styleUrl: '../../../iam/shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Market-data entitlements"
        subtitle="Which organisation may read which feed — display (people) and non-display (machines)."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="reload()"
          [disabled]="rows.loading()"
        >
          {{ rows.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button type="button" class="btn btn-primary" (click)="startGrant()">Grant a feed</button>
      </app-page-header>

      @if (catalog.value(); as c) {
        <p class="note">
          Every organisation reads
          <strong>{{ c.defaultFeeds.length ? c.defaultFeeds.join(', ') : 'no feed' }}</strong>
          without a grant (within its plan).
          {{
            c.houseAllFeeds
              ? 'House reads every feed.'
              : 'House needs grants like any organisation.'
          }}
          Everything else needs a grant here, inside the organisation's plan.
        </p>
      }

      @if (editing(); as e) {
        <section class="card">
          <header class="card-head">
            <h3>{{ e.id === null ? 'Grant a feed' : 'Change ' + e.label }}</h3>
          </header>
          <form class="card-body" (ngSubmit)="save()">
            @if (e.id === null) {
              <div class="form-grid">
                <label class="field">
                  <span class="label">Organisation</span>
                  @if (tenants().length) {
                    <select
                      class="select"
                      name="tenant"
                      [ngModel]="draft().tenantId"
                      (ngModelChange)="patch({ tenantId: $event === null ? null : +$event })"
                    >
                      <option [ngValue]="null">Choose…</option>
                      @for (t of tenants(); track t.id) {
                        <option [ngValue]="t.id">
                          {{ t.name }} ({{ t.slug }}){{ t.planName ? ' — ' + t.planName : '' }}
                        </option>
                      }
                    </select>
                  } @else {
                    <input
                      class="input"
                      type="number"
                      min="1"
                      name="tenantId"
                      placeholder="Organisation id"
                      [ngModel]="draft().tenantId"
                      (ngModelChange)="
                        patch({ tenantId: $event === '' || $event === null ? null : +$event })
                      "
                    />
                  }
                </label>
                <label class="field">
                  <span class="label">Feed</span>
                  <input
                    class="input"
                    name="feed"
                    list="md-feeds"
                    placeholder="cme-l2, cme-trades, venue:lmax…"
                    [ngModel]="draft().feedId"
                    (ngModelChange)="patch({ feedId: $event })"
                  />
                  <datalist id="md-feeds">
                    @for (f of catalog.value()?.feeds ?? []; track f.feedId) {
                      <option [value]="f.feedId">{{ f.name }}</option>
                    }
                  </datalist>
                </label>
              </div>
            }
            <div class="row">
              <label class="check">
                <input
                  type="checkbox"
                  name="display"
                  [ngModel]="draft().display"
                  (ngModelChange)="patch({ display: $event })"
                />
                Display — people view it (charts, ladder, history)
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  name="nonDisplay"
                  [ngModel]="draft().nonDisplay"
                  (ngModelChange)="patch({ nonDisplay: $event })"
                />
                Non-display — machines and algorithms consume it
              </label>
            </div>
            <div class="form-grid">
              <label class="field">
                <span class="label">Starts (UTC day, empty = now)</span>
                <input
                  class="input"
                  type="date"
                  name="from"
                  [ngModel]="draft().validFrom"
                  (ngModelChange)="patch({ validFrom: $event ?? '' })"
                />
              </label>
              <label class="field">
                <span class="label">Ends (UTC day, exclusive; empty = until revoked)</span>
                <input
                  class="input"
                  type="date"
                  name="to"
                  [ngModel]="draft().validTo"
                  (ngModelChange)="patch({ validTo: $event ?? '' })"
                />
              </label>
              <label class="field">
                <span class="label">Reason (contract, order form, trial)</span>
                <input
                  class="input"
                  name="reason"
                  maxlength="512"
                  [ngModel]="draft().reason"
                  (ngModelChange)="patch({ reason: $event })"
                />
              </label>
            </div>
            @if (submitted() && errors().length) {
              <ul class="errors" role="alert">
                @for (err of errors(); track err) {
                  <li>{{ err }}</li>
                }
              </ul>
            }
            <div class="actions-row">
              <button type="button" class="btn btn-secondary" (click)="editing.set(null)">
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" [disabled]="busy()">
                {{ busy() ? 'Saving…' : e.id === null ? 'Grant' : 'Save' }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (revoking(); as r) {
        <section class="card" aria-label="Revoke licence">
          <header class="card-head">
            <h3>Revoke {{ r.feedId }} for {{ r.tenantName || r.tenantSlug }}?</h3>
          </header>
          <form class="card-body" (ngSubmit)="revoke()">
            <p class="note warn">
              Live chart subscriptions of the organisation to this feed end within seconds, and its
              history and chart reads of the feed are refused from the next request.
            </p>
            <label class="field">
              <span class="label">Reason</span>
              <input
                class="input"
                name="revokeReason"
                maxlength="512"
                [ngModel]="revokeReason()"
                (ngModelChange)="revokeReason.set($event)"
              />
            </label>
            <div class="actions-row">
              <button
                type="button"
                class="btn btn-secondary"
                data-autofocus
                (click)="revoking.set(null)"
              >
                Keep it
              </button>
              <button
                type="submit"
                class="btn btn-danger"
                [disabled]="busy() || !revokeReason().trim()"
              >
                {{ busy() ? 'Revoking…' : 'Revoke' }}
              </button>
            </div>
          </form>
        </section>
      }

      <section class="card">
        <header class="card-head">
          <input
            class="input search"
            type="search"
            aria-label="Search organisations and feeds"
            placeholder="Search organisation or feed"
            [ngModel]="search()"
            (ngModelChange)="search.set($event)"
          />
          <label class="check">
            <input
              type="checkbox"
              [ngModel]="includeRevoked()"
              (ngModelChange)="includeRevoked.set($event); reload()"
            />
            Show revoked
          </label>
          <span class="spacer"></span>
        </header>
        @if (rows.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (rows.loaded() && visible().length === 0) {
          <p class="pad muted">
            No grants{{ search() ? ' match' : '' }}. Organisations read only their default feeds
            (and House every feed).
          </p>
        } @else if (visible().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Organisation</th>
                  <th>Feed</th>
                  <th>Use</th>
                  <th>Valid</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th>Granted</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of visible(); track r.id) {
                  <tr>
                    <td>
                      {{ r.tenantName || 'Organisation ' + r.tenantId }}
                      <span class="sub"
                        ><code>{{ r.tenantSlug }}</code></span
                      >
                    </td>
                    <td>
                      <code>{{ r.feedId }}</code>
                      <span class="sub">{{ r.feedName }}</span>
                    </td>
                    <td class="small">{{ usages(r) }}</td>
                    <td class="small">{{ validity(r) }}</td>
                    <td>
                      <span [class]="'chip ' + tone(r.status)">{{ r.status }}</span>
                      @if (r.outsidePlan && r.status !== 'Revoked') {
                        <span
                          class="chip warn"
                          title="The organisation's plan does not include this feed: it is not served until it does."
                        >
                          Outside plan
                        </span>
                      }
                    </td>
                    <td class="small">{{ r.reason || '—' }}</td>
                    <td class="small">
                      {{ at(r.createdAtUtc) }}
                      <span class="sub">{{ r.grantedBy || '' }}</span>
                    </td>
                    <td class="actions">
                      @if (r.status !== 'Revoked') {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="startEdit(r)"
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          class="btn btn-sm btn-danger"
                          (click)="startRevoke(r)"
                        >
                          Revoke
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
    </div>
  `,
})
export class MarketDataEntitlementsPageComponent {
  private readonly api = inject(MarketDataEntitlementsApiService);
  private readonly iam = inject(IamApiService);
  private readonly notify = inject(NotificationService);

  protected readonly usages = usagesText;
  protected readonly validity = validityText;
  protected readonly tone = statusTone;
  protected readonly at = when;

  readonly includeRevoked = signal(false);
  readonly search = signal('');
  readonly rows = iamResource(
    () => this.api.list({ includeRevoked: this.includeRevoked() }),
    [] as MarketDataEntitlementDto[],
    'Could not load the entitlements.',
  );
  readonly catalog = iamResource(
    () => this.api.feeds(),
    null as MarketDataFeedCatalog | null,
    'Could not load the feeds.',
  );
  /** Organisations to choose from (platform.tenants.manage); without it the form takes an id. */
  readonly tenants = signal<TenantDto[]>([]);
  readonly visible = computed(() => filterEntitlements(this.rows.value(), this.search()));

  readonly editing = signal<{ id: number | null; label: string } | null>(null);
  readonly draft = signal<GrantDraft>(emptyGrantDraft());
  readonly submitted = signal(false);
  readonly errors = computed(() => {
    const e = this.editing();
    return e ? grantErrors(this.draft(), e.id === null) : [];
  });
  readonly busy = signal(false);
  readonly revoking = signal<MarketDataEntitlementDto | null>(null);
  readonly revokeReason = signal('');

  constructor() {
    this.reload();
    this.catalog.reload();
    this.iam
      .tenants()
      .pipe(catchError(() => of([] as TenantDto[])))
      .subscribe((t) => this.tenants.set(t.filter((x) => x.status !== 'Closed')));
  }

  reload(): void {
    this.rows.reload();
  }

  startGrant(): void {
    this.submitted.set(false);
    this.draft.set(emptyGrantDraft());
    this.editing.set({ id: null, label: '' });
  }

  startEdit(r: MarketDataEntitlementDto): void {
    this.submitted.set(false);
    this.draft.set(draftFromEntitlement(r));
    this.editing.set({ id: r.id, label: `${r.feedId} for ${r.tenantName || r.tenantSlug}` });
  }

  startRevoke(r: MarketDataEntitlementDto): void {
    this.revokeReason.set('');
    this.revoking.set(r);
  }

  patch(change: Partial<GrantDraft>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  save(): void {
    const e = this.editing();
    this.submitted.set(true);
    if (!e || this.errors().length || this.busy()) return;
    this.busy.set(true);
    const call =
      e.id === null
        ? this.api.grant(grantBody(this.draft()))
        : this.api.update(e.id, updateBody(this.draft()));
    call.subscribe({
      next: (row) => {
        this.busy.set(false);
        this.editing.set(null);
        this.notify.success(
          `${row.feedId} ${e.id === null ? 'granted to' : 'saved for'} ${row.tenantName || row.tenantSlug}.`,
        );
        this.reload();
      },
      error: (err) => {
        this.busy.set(false);
        if (reportable(err)) this.notify.error(errorText(err, 'The licence was not saved.'));
      },
    });
  }

  revoke(): void {
    const r = this.revoking();
    const reason = this.revokeReason().trim();
    if (!r || !reason || this.busy()) return;
    this.busy.set(true);
    this.api.revoke(r.id, reason).subscribe({
      next: () => {
        this.busy.set(false);
        this.revoking.set(null);
        this.notify.success(`${r.feedId} revoked for ${r.tenantName || r.tenantSlug}.`);
        this.reload();
      },
      error: (err) => {
        this.busy.set(false);
        if (reportable(err)) this.notify.error(errorText(err, 'The licence was not revoked.'));
      },
    });
  }
}
