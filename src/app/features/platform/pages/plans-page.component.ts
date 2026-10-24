import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { NotificationService } from '@core/notifications/notification.service';
import { ConfirmDialogComponent } from '@shared/components/confirm-dialog/confirm-dialog.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { errorText, reportable, when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
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
  imports: [FormsModule, PageHeaderComponent, ConfirmDialogComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
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

      @if (editing(); as e) {
        <section class="card">
          <header class="card-head">
            <h3>{{ e.id === null ? 'New plan' : 'Edit ' + e.name }}</h3>
          </header>
          <form class="card-body" (ngSubmit)="save()">
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
            <div class="form-grid">
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
            </div>
            <p class="note">
              Market-data feeds bound what the plan's organisations can be granted and are served
              (House is never bounded). The LLM budget applies once LLM spend is measured per
              organisation, and log retention once per-organisation retention is switched on; both
              are recorded on the plan now.
            </p>

            <div class="row">
              <label class="check">
                <input
                  type="checkbox"
                  name="sso"
                  [ngModel]="draft().allowsSso"
                  (ngModelChange)="patch({ allowsSso: $event })"
                />
                Single sign-on
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  name="scim"
                  [ngModel]="draft().allowsScim"
                  (ngModelChange)="patch({ allowsScim: $event })"
                />
                SCIM provisioning
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  name="pat"
                  [ngModel]="draft().allowsPersonalAccessTokens"
                  (ngModelChange)="patch({ allowsPersonalAccessTokens: $event })"
                />
                Personal access tokens
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  name="fund"
                  [ngModel]="draft().allowsFundModule === true"
                  (ngModelChange)="patch({ allowsFundModule: $event })"
                />
                Fund module (best execution, performance statements, compliance exports)
              </label>
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
            </div>
            @if (e.wasDefault) {
              <p class="note">
                This is the default plan. To change that, make another plan the default.
              </p>
            }

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
        @if (plans.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        } @else if (plans.loaded() && plans.value().length === 0) {
          <p class="pad muted">No plans.</p>
        } @else if (plans.value().length > 0) {
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Accounts</th>
                  <th>Terminals</th>
                  <th>People</th>
                  <th>Jobs at a time</th>
                  <th>Strategies</th>
                  <th>Scripts</th>
                  <th>LLM / month</th>
                  <th>Retention</th>
                  <th>Features</th>
                  <th>Data feeds</th>
                  <th>Organisations</th>
                  <th><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                @for (p of plans.value(); track p.id) {
                  <tr>
                    <td>
                      {{ p.name }}
                      @if (p.isDefault) {
                        <span class="chip info">Default</span>
                      }
                      @if (p.isHousePlan) {
                        <span class="chip">House</span>
                      }
                      <span class="sub"
                        ><code>{{ p.slug }}</code
                        >{{ p.description ? ' · ' + p.description : '' }}</span
                      >
                    </td>
                    <td class="small">{{ limit(p.maxTradingAccounts) }}</td>
                    <td class="small">{{ limit(p.maxActiveEaInstances) }}</td>
                    <td class="small">{{ limit(p.maxMembers) }}</td>
                    <td class="small">{{ limit(p.maxConcurrentResearchJobs) }}</td>
                    <td class="small">{{ limit(p.maxStrategies) }}</td>
                    <td class="small">{{ limit(p.maxScripts) }}</td>
                    <td class="small">{{ usd(p.maxMonthlyLlmUsd) }}</td>
                    <td class="small">
                      {{ p.logRetentionDays === null ? 'Platform' : p.logRetentionDays + ' d' }}
                    </td>
                    <td class="small">{{ features(p) }}</td>
                    <td class="small">
                      {{ p.isHousePlan ? 'Every feed' : feedsText(p.marketDataFeeds) }}
                    </td>
                    <td class="small">{{ p.organisations }}</td>
                    <td class="actions">
                      @if (!p.isHousePlan) {
                        <button
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="startEdit(p)"
                        >
                          Edit
                        </button>
                        @if (!p.isDefault && p.organisations === 0) {
                          <button
                            type="button"
                            class="btn btn-sm btn-danger"
                            (click)="deleting.set(p)"
                          >
                            Delete
                          </button>
                        }
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="pad muted small">
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
