import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { plural } from '@features/iam/shared/admin-context.logic';
import { planFeedsText } from '@features/market-data/entitlements/md-entitlements.logic';
import { PlansApiService } from '../plans-api.service';
import {
  LIMIT_LABELS,
  draftFromPlan,
  emptyPlanDraft,
  featureList,
  limitText,
  parseLimit,
  planBody,
  planErrors,
  usdText,
} from '../plans.logic';
import {
  PLAN_LIMIT_FIELDS,
  type PlanDto,
  type PlanLimitField,
  type SavePlanBody,
} from '../plans.types';

type PlanFeatureKey =
  | 'allowsSso'
  | 'allowsScim'
  | 'allowsPersonalAccessTokens'
  | 'allowsPropModule'
  | 'allowsBrokerModule'
  | 'allowsFundModule';

/**
 * Plans (engine multi-tenancy Phase 7, `platform.plans.manage`): what an organisation may use —
 * accounts, connected EA terminals, people, research jobs, strategies, scripts, LLM dollars — and which
 * features. House's plan is fixed (House is always unlimited); exactly one plan is the default new
 * organisations get. Lowering a limit removes nothing in use. Every change is audited by the engine.
 */
@Component({
  selector: 'app-platform-plans-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent, StatTilesComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './org-plans-page.scss'],
  styles: [
    `
      .matrix-table {
        table-layout: auto;
      }
      .matrix-table .rowhead {
        text-align: left;
        width: 220px;
        min-width: 180px;
        font-size: var(--text-xs);
        font-weight: var(--font-medium);
        color: var(--text-secondary);
        text-transform: none;
        letter-spacing: 0;
        background: transparent;
      }
      .matrix-table thead th.rowhead {
        background: var(--bg-primary);
      }
      .matrix-table th.plan-col {
        text-align: right;
        vertical-align: top;
        min-width: 170px;
        white-space: normal;
        text-transform: none;
        letter-spacing: 0;
      }
      .plan-name {
        display: block;
        font-size: var(--text-sm);
        font-weight: var(--font-semibold);
        color: var(--text-primary);
      }
      .plan-chips {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        margin-top: 4px;
      }
      .plan-desc {
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        margin-top: 4px;
        font-size: 11px;
        font-weight: var(--font-regular, 400);
        line-height: 1.4;
        color: var(--text-tertiary);
      }
      .matrix-table tr.group-row td {
        padding-top: var(--space-3);
        padding-bottom: 4px;
        font-size: 10.5px;
        font-weight: var(--font-semibold);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-tertiary);
        background: var(--bg-primary);
      }
      .matrix-table tbody tr.group-row:hover td {
        background: var(--bg-primary);
      }
      .matrix-table td.num {
        white-space: normal;
      }
      .yes {
        color: var(--profit);
        font-weight: var(--font-semibold);
      }
      .strong {
        font-weight: var(--font-semibold);
      }
      .actions-line td {
        white-space: nowrap;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Plans"
        subtitle="Limits and features for organisations. Empty limits are unlimited."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="plans.reload()"
          [disabled]="plans.loading()"
        >
          {{ plans.loading() ? 'Loading…' : 'Refresh' }}
        </button>
        <button type="button" class="btn btn-primary" (click)="startCreate()">New plan</button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Plans summary" />

      @if (editing(); as e) {
        <section class="card">
          <header class="card-head">
            <h3>{{ e.id === null ? 'New plan' : 'Edit ' + e.name }}</h3>
            <span class="spacer"></span>
            <span class="hint">Lowering a limit removes nothing in use.</span>
          </header>
          <form class="card-body" (ngSubmit)="save()">
            <fieldset class="group">
              <p class="section-label">Plan</p>
              <div class="form-grid">
                @if (e.id === null) {
                  <label class="field">
                    <span class="label">Slug (permanent)</span>
                    <input
                      class="input"
                      name="slug"
                      placeholder="pro"
                      [ngModel]="draft().slug"
                      (ngModelChange)="patch({ slug: $event })"
                    />
                  </label>
                }
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
                  <span class="label">Description</span>
                  <input
                    class="input"
                    name="description"
                    [ngModel]="draft().description ?? ''"
                    (ngModelChange)="patch({ description: $event })"
                  />
                </label>
              </div>
            </fieldset>

            <fieldset class="group">
              <p class="section-label">Limits — leave empty for unlimited</p>
              <div class="form-grid">
                @for (f of limitFields; track f) {
                  <label class="field">
                    <span class="label">{{ labels[f] }}</span>
                    <input
                      class="input"
                      type="number"
                      min="0"
                      step="1"
                      [name]="f"
                      placeholder="Unlimited"
                      [ngModel]="draft()[f]"
                      (ngModelChange)="setLimit(f, $event)"
                    />
                  </label>
                }
                <label class="field">
                  <span class="label">LLM budget per month (USD)</span>
                  <input
                    class="input"
                    type="number"
                    min="0"
                    step="0.01"
                    name="llm"
                    placeholder="Unlimited"
                    [ngModel]="draft().maxMonthlyLlmUsd"
                    (ngModelChange)="patch({ maxMonthlyLlmUsd: parse($event) })"
                  />
                </label>
                <label class="field">
                  <span class="label">Log retention (days)</span>
                  <input
                    class="input"
                    type="number"
                    min="1"
                    step="1"
                    name="retention"
                    placeholder="Platform's retention"
                    [ngModel]="draft().logRetentionDays"
                    (ngModelChange)="patch({ logRetentionDays: parse($event) })"
                  />
                </label>
              </div>
            </fieldset>

            <fieldset class="group">
              <p class="section-label">Market data</p>
              <label class="field">
                <span class="label">Market-data feeds (empty = every feed)</span>
                <input
                  class="input"
                  name="marketDataFeeds"
                  placeholder="broker-ticks, broker-dom, cme-l2, cme-trades, venue:*"
                  [ngModel]="draft().marketDataFeeds ?? ''"
                  (ngModelChange)="patch({ marketDataFeeds: $event })"
                />
              </label>
              <p class="note">
                Market-data feeds bound what the plan's organisations can be granted and are served
                (House is never bounded). The LLM budget applies once LLM spend is measured per
                organisation, and log retention once per-organisation retention is switched on; both
                are recorded on the plan now.
              </p>
            </fieldset>

            <fieldset class="group">
              <p class="section-label">Features</p>
              <div class="row">
                <label class="toggle" [class.on]="draft().allowsSso">
                  <input
                    type="checkbox"
                    name="sso"
                    [ngModel]="draft().allowsSso"
                    (ngModelChange)="patch({ allowsSso: $event })"
                  />
                  Single sign-on
                </label>
                <label class="toggle" [class.on]="draft().allowsScim">
                  <input
                    type="checkbox"
                    name="scim"
                    [ngModel]="draft().allowsScim"
                    (ngModelChange)="patch({ allowsScim: $event })"
                  />
                  SCIM provisioning
                </label>
                <label class="toggle" [class.on]="draft().allowsPersonalAccessTokens">
                  <input
                    type="checkbox"
                    name="pat"
                    [ngModel]="draft().allowsPersonalAccessTokens"
                    (ngModelChange)="patch({ allowsPersonalAccessTokens: $event })"
                  />
                  Personal access tokens
                </label>
                <label class="toggle" [class.on]="draft().allowsPropModule === true">
                  <input
                    type="checkbox"
                    name="prop"
                    [ngModel]="draft().allowsPropModule"
                    (ngModelChange)="patch({ allowsPropModule: $event })"
                  />
                  Prop-firm module
                </label>
                <label class="toggle" [class.on]="draft().allowsBrokerModule === true">
                  <input
                    type="checkbox"
                    name="brokerModule"
                    [ngModel]="draft().allowsBrokerModule ?? false"
                    (ngModelChange)="patch({ allowsBrokerModule: $event })"
                  />
                  Broker dealing desk (module)
                </label>
                <label class="toggle" [class.on]="draft().allowsFundModule === true">
                  <input
                    type="checkbox"
                    name="fund"
                    [ngModel]="draft().allowsFundModule === true"
                    (ngModelChange)="patch({ allowsFundModule: $event })"
                  />
                  Fund module (best execution, performance statements, compliance exports)
                </label>
              </div>
              <label class="check">
                <input
                  type="checkbox"
                  name="default"
                  [ngModel]="draft().isDefault"
                  [disabled]="e.wasDefault"
                  (ngModelChange)="patch({ isDefault: $event })"
                />
                Default plan for new organisations
              </label>
              @if (e.wasDefault) {
                <p class="note">
                  This is the default plan. To change that, make another plan the default.
                </p>
              }
            </fieldset>

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
                {{ busy() ? 'Saving…' : e.id === null ? 'Create' : 'Save' }}
              </button>
            </div>
          </form>
        </section>
      }

      <section class="card">
        <header class="card-head">
          <h3>Plan comparison</h3>
          @if (plans.loaded()) {
            <span class="count">{{ plans.value().length }}</span>
          }
          <span class="spacer"></span>
          <span class="hint">One column per plan · empty limits are unlimited</span>
        </header>
        @if (plans.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (plans.loaded() && plans.value().length === 0) {
          <p class="empty">
            <strong>No plans.</strong>
            Plans set what an organisation may use. Create one with <em>New plan</em>; the first
            becomes the default new organisations get.
          </p>
        } @else if (plans.value().length > 0) {
          <div class="table-wrap">
            <table class="grid matrix-table">
              <thead>
                <tr>
                  <th class="rowhead"><span class="sr-only">Limit or feature</span></th>
                  @for (p of plans.value(); track p.id) {
                    <th class="plan-col" scope="col">
                      <span class="plan-name">{{ p.name }}</span>
                      <span class="plan-chips">
                        @if (p.isDefault) {
                          <span class="chip info">Default</span>
                        }
                        @if (p.isHousePlan) {
                          <span class="chip">House</span>
                        }
                        <span class="ident">{{ p.slug }}</span>
                      </span>
                      @if (p.description) {
                        <span class="plan-desc" [attr.title]="p.description">{{
                          p.description
                        }}</span>
                      }
                    </th>
                  }
                </tr>
              </thead>
              <tbody>
                <tr class="group-row">
                  <td [attr.colspan]="plans.value().length + 1">Limits</td>
                </tr>
                @for (r of limitRows; track r.field) {
                  <tr>
                    <th scope="row" class="rowhead">{{ r.label }}</th>
                    @for (p of plans.value(); track p.id) {
                      <td class="num" [class.dim]="p[r.field] === null">
                        {{ limit(p[r.field]) }}
                      </td>
                    }
                  </tr>
                }
                <tr>
                  <th scope="row" class="rowhead">LLM / month</th>
                  @for (p of plans.value(); track p.id) {
                    <td class="num" [class.dim]="p.maxMonthlyLlmUsd === null">
                      {{ usd(p.maxMonthlyLlmUsd) }}
                    </td>
                  }
                </tr>
                <tr>
                  <th scope="row" class="rowhead">Retention</th>
                  @for (p of plans.value(); track p.id) {
                    <td class="num" [class.dim]="p.logRetentionDays === null">
                      {{ p.logRetentionDays === null ? 'Platform' : p.logRetentionDays + ' d' }}
                    </td>
                  }
                </tr>
                <tr class="group-row">
                  <td [attr.colspan]="plans.value().length + 1">Features</td>
                </tr>
                @for (r of featureRows; track r.key) {
                  <tr>
                    <th scope="row" class="rowhead">{{ r.label }}</th>
                    @for (p of plans.value(); track p.id) {
                      <td class="num">
                        @if (p[r.key] === true) {
                          <span class="yes" aria-label="Included">✓</span>
                        } @else {
                          <span class="dim" aria-label="Not included">—</span>
                        }
                      </td>
                    }
                  </tr>
                }
                <tr>
                  <th scope="row" class="rowhead">Data feeds</th>
                  @for (p of plans.value(); track p.id) {
                    <td class="num small">
                      {{ p.isHousePlan ? 'Every feed' : feedsText(p.marketDataFeeds) }}
                    </td>
                  }
                </tr>
                <tr class="group-row">
                  <td [attr.colspan]="plans.value().length + 1">In use</td>
                </tr>
                <tr>
                  <th scope="row" class="rowhead">Organisations</th>
                  @for (p of plans.value(); track p.id) {
                    <td class="num strong" [class.dim]="p.organisations === 0">
                      {{ p.organisations }}
                    </td>
                  }
                </tr>
                <tr class="actions-line">
                  <th scope="row" class="rowhead"><span class="sr-only">Actions</span></th>
                  @for (p of plans.value(); track p.id) {
                    <td class="num">
                      @if (!p.isHousePlan) {
                        <button
                          type="button"
                          class="btn btn-sm btn-ghost"
                          [attr.aria-label]="'Edit ' + p.name"
                          (click)="startEdit(p)"
                        >
                          Edit
                        </button>
                        @if (!p.isDefault && p.organisations === 0) {
                          <button
                            type="button"
                            class="btn btn-sm btn-ghost-danger"
                            [attr.aria-label]="'Delete ' + p.name"
                            (click)="deleting.set(p)"
                          >
                            Delete
                          </button>
                        }
                      } @else {
                        <span class="dim small">Fixed</span>
                      }
                    </td>
                  }
                </tr>
              </tbody>
            </table>
          </div>
          <p class="foot">
            House's plan is fixed: House is never limited. Updated
            {{ updatedNote() }}.
          </p>
        }
      </section>

      <app-confirm-dialog
        [open]="deleting() !== null"
        [title]="'Delete ' + (deleting()?.name ?? '') + '?'"
        message="No organisation is on it. Its slug stays reserved so old usage exports keep their meaning."
        confirmLabel="Delete"
        confirmVariant="destructive"
        [loading]="busy()"
        (confirm)="remove()"
        (cancelled)="deleting.set(null)"
      />
    </div>
  `,
})
export class PlansPageComponent {
  private readonly api = inject(PlansApiService);
  private readonly notify = inject(NotificationService);

  protected readonly limitFields = PLAN_LIMIT_FIELDS;
  protected readonly labels = LIMIT_LABELS;
  protected readonly limit = limitText;
  protected readonly usd = usdText;
  protected readonly features = featureList;
  protected readonly parse = parseLimit;
  protected readonly feedsText = planFeedsText;

  readonly plans = iamResource(() => this.api.plans(), [] as PlanDto[], 'Could not load plans.');

  /** Rows of the comparison table (one column per plan). */
  protected readonly limitRows = PLAN_LIMIT_FIELDS.map((field) => ({
    field,
    label: LIMIT_LABELS[field],
  }));
  protected readonly featureRows: readonly { key: PlanFeatureKey; label: string }[] = [
    { key: 'allowsSso', label: 'Single sign-on' },
    { key: 'allowsScim', label: 'SCIM provisioning' },
    { key: 'allowsPersonalAccessTokens', label: 'Personal access tokens' },
    { key: 'allowsPropModule', label: 'Prop-firm module' },
    { key: 'allowsBrokerModule', label: 'Broker dealing desk' },
    { key: 'allowsFundModule', label: 'Fund module' },
  ];

  readonly tiles = computed<StatTile[]>(() => {
    const all = this.plans.value();
    const loaded = this.plans.loaded();
    const sellable = all.filter((p) => !p.isHousePlan);
    const def = all.find((p) => p.isDefault) ?? null;
    const orgs = all.reduce((n, p) => n + p.organisations, 0);
    const unused = sellable.filter((p) => p.organisations === 0);
    const top = [...sellable].sort((a, b) => b.organisations - a.organisations)[0] ?? null;
    return [
      {
        label: 'Plans',
        value: loaded ? String(all.length) : '…',
        caption: loaded
          ? `${plural(sellable.length, 'assignable plan')} + House's own`
          : 'loading the plans',
      },
      {
        label: 'Default plan',
        value: def ? def.name : loaded ? 'None' : '…',
        caption: def ? 'what a new organisation gets' : 'new organisations get no plan',
        tone: loaded && !def ? 'bad' : null,
      },
      {
        label: 'Organisations on a plan',
        value: loaded ? String(orgs) : '…',
        caption:
          top && top.organisations > 0
            ? `most on ${top.name} (${top.organisations})`
            : 'none on an assignable plan yet',
      },
      {
        label: 'Unused plans',
        value: loaded ? String(unused.length) : '…',
        caption: unused.length
          ? unused.map((p) => p.name).join(', ') + ' — no organisation on it'
          : 'every plan has an organisation',
        tone: unused.length ? 'warn' : loaded ? 'good' : null,
      },
    ];
  });

  /** The plan being edited (`id` null = a new one); `wasDefault` = it is the default now. */
  readonly editing = signal<{ id: number | null; name: string; wasDefault: boolean } | null>(null);
  readonly draft = signal<SavePlanBody>(emptyPlanDraft());
  readonly submitted = signal(false);
  readonly errors = computed(() => {
    const e = this.editing();
    return e ? planErrors(this.draft(), e.id === null) : [];
  });
  readonly busy = signal(false);
  readonly deleting = signal<PlanDto | null>(null);

  readonly updatedNote = computed(() => {
    const latest = this.plans
      .value()
      .map((p) => p.updatedAtUtc ?? p.createdAtUtc ?? null)
      .filter((d): d is string => !!d)
      .sort()
      .at(-1);
    return latest ? when(latest) : 'never';
  });

  constructor() {
    this.plans.reload();
  }

  startCreate(): void {
    this.submitted.set(false);
    this.draft.set(emptyPlanDraft());
    this.editing.set({ id: null, name: '', wasDefault: false });
  }

  startEdit(p: PlanDto): void {
    this.submitted.set(false);
    this.draft.set(draftFromPlan(p));
    this.editing.set({ id: p.id, name: p.name, wasDefault: p.isDefault });
  }

  patch(change: Partial<SavePlanBody>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  setLimit(field: PlanLimitField, value: string | number | null): void {
    this.patch({ [field]: parseLimit(value) } as Partial<SavePlanBody>);
  }

  save(): void {
    const e = this.editing();
    this.submitted.set(true);
    if (!e || this.errors().length || this.busy()) return;
    const creating = e.id === null;
    const body = planBody(this.draft(), creating);
    this.busy.set(true);
    const call = creating ? this.api.createPlan(body) : this.api.updatePlan(e.id!, body);
    call.subscribe({
      next: (plan) => {
        this.busy.set(false);
        this.editing.set(null);
        this.notify.success(`Plan ${plan.name} ${creating ? 'created' : 'saved'}.`);
        this.plans.reload();
      },
      error: (err) => {
        this.busy.set(false);
        if (reportable(err)) this.notify.error(errorText(err, 'The plan was not saved.'));
      },
    });
  }

  remove(): void {
    const p = this.deleting();
    if (!p || this.busy()) return;
    this.busy.set(true);
    this.api.deletePlan(p.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.deleting.set(null);
        this.notify.success(`Plan ${p.name} deleted.`);
        this.plans.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.deleting.set(null);
        if (reportable(err)) this.notify.error(errorText(err, 'The plan was not deleted.'));
      },
    });
  }
}
