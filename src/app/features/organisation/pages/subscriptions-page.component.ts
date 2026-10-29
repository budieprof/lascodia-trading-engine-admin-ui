import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { PagedData } from '@core/api/api.types';
import { LscCanDirective } from '@core/auth/can.directive';
import { Permission } from '@core/auth/permissions.generated';
import { NotificationService } from '@core/notifications/notification.service';
import { AccountScopeService } from '@core/scope/account-scope.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { errorText } from '@features/iam/iam.logic';
import { iamResource, type IamResource } from '@features/iam/shared/iam-resource';
import { OrganisationApiService } from '../organisation-api.service';
import { failureMessage, isMissingEndpoint } from '../organisation.logic';
import type {
  StrategyBinding,
  StrategyOwnership,
  StrategySubscriptions,
  StrategySummary,
} from '../organisation.types';
import {
  MAX_LOT_MULTIPLIER,
  changeSummary,
  draftErrors,
  draftFrom,
  draftToInputs,
  groupSubscriptions,
  reachWarning,
  subscriptionRule,
  type BindingDraft,
} from '../subscriptions.logic';
import { accountLabel, accountRefs } from '../terminals.logic';
import { RouterLink } from '@angular/router';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';

/** Strategies per page in the platform and private lists. */
export const STRATEGY_PAGE_SIZE = 25;

/** The strategy whose subscriptions are being edited. */
interface EditTarget {
  id: number;
  name: string;
  symbol: string;
  isScript: boolean;
  isPlatform: boolean;
}

/** One list of strategies (platform or private): its query and its page. */
class StrategyList {
  readonly search = signal('');
  readonly status = signal<string | null>('Active');
  readonly page = signal(1);
  readonly result: IamResource<PagedData<StrategySummary> | null>;

  constructor(api: OrganisationApiService, ownership: StrategyOwnership) {
    this.result = iamResource<PagedData<StrategySummary> | null>(
      () =>
        api.strategies({
          ownership,
          search: this.search(),
          status: this.status(),
          page: this.page(),
          pageSize: STRATEGY_PAGE_SIZE,
        }),
      null,
      'Could not load the strategies.',
    );
  }

  readonly pages = (): number => {
    const total = this.result.value()?.pager?.totalItemCount ?? 0;
    return Math.max(1, Math.ceil(total / STRATEGY_PAGE_SIZE));
  };

  go(page: number): void {
    this.page.set(Math.min(Math.max(1, page), this.pages()));
    this.result.reload();
  }

  query(): void {
    this.page.set(1);
    this.result.reload();
  }
}

/**
 * Strategy subscriptions (multi-tenancy Phase 7, T7.4; engine R6R.4 opt-in signals). Which of the
 * organisation's accounts receive which strategies' signals: its subscriptions by strategy, the
 * platform strategies it may subscribe to, and its own private strategies listed apart. Changing a
 * strategy's subscriptions replaces the organisation's own set for it (`PUT strategy/{id}/account-
 * bindings`, `access.operator`); a change that touches a real-money account, or that opens or closes
 * House's fan-out, says so and asks before it is sent.
 */
@Component({
  selector: 'app-org-subscriptions-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    LscCanDirective,
    PageHeaderComponent,
    ModalA11yDirective,
    RouterLink,
    StatTilesComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .accounts {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
      }
      .pager {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-4);
        font-size: var(--text-xs);
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(6px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .dialog {
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        box-shadow: var(--shadow-lg);
        width: min(680px, calc(100vw - 32px));
        max-height: calc(100vh - 48px);
        overflow: auto;
      }
      .dialog h3 {
        margin: 0;
        font-size: var(--text-base);
      }
      .mult {
        width: 80px;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Strategy subscriptions"
        subtitle="Which of your accounts receive which strategies' signals."
      >
        <button type="button" class="btn btn-secondary" (click)="reload()" [disabled]="loading()">
          {{ loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Subscriptions summary" />

      @if (unavailable()) {
        <section class="card">
          <p class="pad muted">
            Strategy subscriptions are not available on this engine yet. Ask platform staff to
            update it.
          </p>
        </section>
      } @else {
        <section class="card">
          <header class="card-head"><h3>Your subscriptions</h3></header>
          @if (subscriptionsError(); as err) {
            <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
          }
          @if (subscriptions(); as s) {
            <p class="pad note">{{ rule(s.requireSubscription) }}</p>
          }
          @if (grouped().length) {
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Accounts</th>
                    <th><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (g of grouped(); track g.strategyId) {
                    <tr>
                      <td>
                        {{ g.name }}
                        <span class="sub">
                          {{ g.symbol }} {{ g.timeframe }} · {{ g.status }} ·
                          {{ g.isPlatform ? 'Platform' : 'Private'
                          }}{{ g.isScript ? ' · script' : '' }}
                        </span>
                      </td>
                      <td>
                        <span class="accounts">
                          @for (a of g.accounts; track a.tradingAccountId) {
                            <span class="chip" [class.ok]="a.isEnabled" [class.warn]="!a.isEnabled">
                              {{ a.accountName || a.accountLogin }} ×{{ a.lotMultiplier
                              }}{{ a.isEnabled ? '' : ' (paused)' }}
                            </span>
                          }
                        </span>
                      </td>
                      <td class="actions">
                        <button
                          *lscCan="P.AccessOperator"
                          type="button"
                          class="btn btn-sm btn-secondary"
                          (click)="
                            openEditor({
                              id: g.strategyId,
                              name: g.name,
                              symbol: g.symbol,
                              isScript: g.isScript,
                              isPlatform: g.isPlatform,
                            })
                          "
                        >
                          Change…
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else if (subscriptions()) {
            <p class="pad muted">No account of the organisation is subscribed to a strategy yet.</p>
          }
        </section>

        @for (section of sections; track section.ownership) {
          <section class="card">
            <header class="card-head">
              <h3>{{ section.title }}</h3>
              <span class="spacer"></span>
              <input
                class="input search"
                [name]="'search-' + section.ownership"
                placeholder="Name or symbol"
                [ngModel]="section.list.search()"
                (ngModelChange)="section.list.search.set($event)"
                (keydown.enter)="section.list.query()"
              />
              <select
                class="select search"
                [name]="'status-' + section.ownership"
                [ngModel]="section.list.status()"
                (ngModelChange)="section.list.status.set($event); section.list.query()"
              >
                <option [ngValue]="'Active'">Active</option>
                <option [ngValue]="'Paused'">Paused</option>
                <option [ngValue]="null">Any status</option>
              </select>
              <button type="button" class="btn btn-sm btn-secondary" (click)="section.list.query()">
                Search
              </button>
            </header>
            @if (section.list.result.error(); as err) {
              <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
            }
            @if (section.list.result.value()?.data?.length) {
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Strategy</th>
                      <th>Status</th>
                      <th>Your accounts</th>
                      <th><span class="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (st of section.list.result.value()!.data; track st.id) {
                      <tr>
                        <td>
                          {{ st.name }}
                          <span class="sub">#{{ st.id }} · {{ st.symbol }} {{ st.timeframe }}</span>
                        </td>
                        <td>{{ st.status }}</td>
                        <td>{{ subscribedCount(st.id) || '—' }}</td>
                        <td class="actions">
                          <button
                            *lscCan="P.AccessOperator"
                            type="button"
                            class="btn btn-sm btn-secondary"
                            (click)="openEditor(target(st, section.ownership))"
                          >
                            {{ subscribedCount(st.id) ? 'Change…' : 'Subscribe…' }}
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <div class="pager">
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  [disabled]="section.list.page() <= 1 || section.list.result.loading()"
                  (click)="section.list.go(section.list.page() - 1)"
                >
                  Previous
                </button>
                <span>Page {{ section.list.page() }} of {{ section.list.pages() }}</span>
                <button
                  type="button"
                  class="btn btn-sm btn-secondary"
                  [disabled]="
                    section.list.page() >= section.list.pages() || section.list.result.loading()
                  "
                  (click)="section.list.go(section.list.page() + 1)"
                >
                  Next
                </button>
              </div>
            } @else if (section.list.result.loaded() && !section.list.result.error()) {
              <p class="pad muted">{{ section.empty }}</p>
            }
          </section>
        }
      }

      @if (editing(); as t) {
        <div class="overlay" role="presentation" (click)="closeEditor()">
          <div
            class="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="subscriptions-title"
            tabindex="-1"
            appModalA11y
            (dismiss)="closeEditor()"
            (click)="$event.stopPropagation()"
            (keydown)="$event.stopPropagation()"
          >
            <form class="card-body" (ngSubmit)="save()">
              <h3 id="subscriptions-title">Subscriptions — {{ t.name }}</h3>
              <p class="muted small">
                Tick the accounts that should receive this strategy's signals. The lot multiplier
                scales the size worked out for the account before its own limits apply (above 0, at
                most {{ maxMultiplier }}).
              </p>
              @if (editorLoading()) {
                <p class="muted">Loading…</p>
              } @else if (editorError(); as err) {
                <p class="errors" role="alert">{{ err }}</p>
              } @else if (!drafts().length) {
                <p class="muted">You cannot see any trading account of the organisation.</p>
              } @else {
                <div class="table-wrap">
                  <table class="grid">
                    <thead>
                      <tr>
                        <th>Subscribed</th>
                        <th>Account</th>
                        <th>Lot multiplier</th>
                        <th>Paused</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (d of drafts(); track d.account.id; let i = $index) {
                        <tr>
                          <td>
                            <input
                              type="checkbox"
                              [name]="'sub-' + d.account.id"
                              [attr.aria-label]="'Subscribe ' + accountLabel(d.account)"
                              [ngModel]="d.subscribed"
                              (ngModelChange)="patchDraft(i, { subscribed: $event })"
                            />
                          </td>
                          <td>{{ accountLabel(d.account) }}</td>
                          <td>
                            <input
                              class="input mult"
                              inputmode="decimal"
                              [name]="'mult-' + d.account.id"
                              [attr.aria-label]="'Lot multiplier for ' + accountLabel(d.account)"
                              [disabled]="!d.subscribed"
                              [ngModel]="d.lotMultiplier"
                              (ngModelChange)="patchDraft(i, { lotMultiplier: $event })"
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              [name]="'paused-' + d.account.id"
                              [attr.aria-label]="'Pause ' + accountLabel(d.account)"
                              [disabled]="!d.subscribed"
                              [ngModel]="!d.isEnabled"
                              (ngModelChange)="patchDraft(i, { isEnabled: !$event })"
                            />
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (warning(); as w) {
                  <p class="note warn">{{ w }}</p>
                }
                @if (change().realAccounts.length) {
                  <label class="check">
                    <input
                      type="checkbox"
                      name="confirmReal"
                      [ngModel]="confirmReal()"
                      (ngModelChange)="confirmReal.set($event)"
                    />
                    This changes what real-money account(s) trade:
                    {{ realNames() }}. I mean to do that.
                  </label>
                }
                @if (submitted() && problems().length) {
                  <ul class="errors" role="alert">
                    @for (p of problems(); track p) {
                      <li>{{ p }}</li>
                    }
                  </ul>
                }
                @if (saveError(); as err) {
                  <p class="errors" role="alert">{{ err }}</p>
                }
              }
              <div class="actions-row">
                <button
                  type="button"
                  class="btn btn-secondary"
                  data-autofocus
                  [disabled]="busy()"
                  (click)="closeEditor()"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn btn-primary"
                  [disabled]="busy() || editorLoading() || !!editorError() || change().none"
                >
                  {{ busy() ? 'Saving…' : 'Save subscriptions' }}
                </button>
              </div>
            </form>
          </div>
        </div>
      }

      <section class="card">
        <header class="card-head">
          <h3>What each account receives</h3>
          <span class="spacer"></span>
          <a class="small" routerLink="/trading-accounts">Trading accounts</a>
        </header>
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th>Subscribed to</th>
                <th>Also receives</th>
              </tr>
            </thead>
            <tbody>
              @for (a of accountRows(); track a.id) {
                <tr>
                  <td>
                    {{ a.name || a.login || 'Account #' + a.id }}
                    <span class="sub">{{ a.login }} · {{ a.brokerServer || '—' }}</span>
                  </td>
                  <td class="small">{{ a.isPaper ? 'Paper' : a.accountType }}</td>
                  <td class="small">{{ a.subs.length ? a.subs.join(', ') : '—' }}</td>
                  <td class="small muted">
                    {{
                      subscriptions()?.requireSubscription
                        ? 'nothing else — subscriptions are required'
                        : 'every unsubscribed strategy whose symbol its EA streams'
                    }}
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="4" class="small muted">
                    No trading account is in your current account scope.
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
})
export class SubscriptionsPageComponent {
  private readonly api = inject(OrganisationApiService);
  private readonly notify = inject(NotificationService);
  private readonly scope = inject(AccountScopeService);

  protected readonly P = Permission;
  protected readonly accountLabel = accountLabel;
  protected readonly rule = subscriptionRule;
  protected readonly maxMultiplier = MAX_LOT_MULTIPLIER;

  readonly accounts = computed(() => accountRefs(this.scope.accounts()));

  readonly subscriptions = signal<StrategySubscriptions | null>(null);
  readonly subscriptionsError = signal<string | null>(null);
  readonly subscriptionsLoading = signal(false);
  /** The engine predates subscriptions (no endpoint): say so rather than show an error. */
  readonly unavailable = signal(false);
  readonly grouped = computed(() => groupSubscriptions(this.subscriptions()?.subscriptions ?? []));
  private readonly counts = computed(() => {
    const m = new Map<number, number>();
    for (const s of this.subscriptions()?.subscriptions ?? []) {
      m.set(s.strategyId, (m.get(s.strategyId) ?? 0) + 1);
    }
    return m;
  });

  readonly platformList = new StrategyList(this.api, 'Platform');
  readonly privateList = new StrategyList(this.api, 'Private');
  protected readonly sections = [
    {
      ownership: 'Platform' as StrategyOwnership,
      title: 'Platform strategies',
      empty: 'No platform strategy matches.',
      list: this.platformList,
    },
    {
      ownership: 'Private' as StrategyOwnership,
      title: 'Your private strategies',
      empty: 'The organisation has no strategy of its own that matches.',
      list: this.privateList,
    },
  ];

  readonly editing = signal<EditTarget | null>(null);
  readonly current = signal<StrategyBinding[]>([]);
  readonly drafts = signal<BindingDraft[]>([]);
  readonly editorLoading = signal(false);
  readonly editorError = signal<string | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly confirmReal = signal(false);
  readonly submitted = signal(false);
  readonly busy = signal(false);

  readonly change = computed(() => changeSummary(this.current(), this.drafts()));
  readonly realNames = computed(() =>
    this.change()
      .realAccounts.map((a) => accountLabel(a))
      .join(', '),
  );
  readonly warning = computed(() => {
    const t = this.editing();
    const s = this.subscriptions();
    if (!t || !s) return null;
    return reachWarning(
      s.requireSubscription,
      t,
      this.current().length,
      this.drafts().filter((d) => d.subscribed).length,
    );
  });
  readonly problems = computed(() => {
    const out = draftErrors(this.drafts());
    if (this.change().realAccounts.length && !this.confirmReal()) {
      out.push('Confirm the change to the real-money account(s) first.');
    }
    return out;
  });

  readonly accountRows = computed(() => {
    const subs = this.subscriptions()?.subscriptions ?? [];
    return this.accounts().map((a) => ({
      ...a,
      subs: subs
        .filter((x) => x.tradingAccountId === a.id)
        .map(
          (x) =>
            `${x.strategyName}${x.isEnabled ? '' : ' (paused)'}${x.lotMultiplier !== 1 ? ' ×' + x.lotMultiplier : ''}`,
        ),
    }));
  });
  readonly tiles = computed<StatTile[]>(() => {
    const s = this.subscriptions();
    const subs = s?.subscriptions ?? [];
    const strategies = new Set(subs.map((x) => x.strategyId)).size;
    const paused = subs.filter((x) => !x.isEnabled).length;
    const accountsWith = new Set(subs.map((x) => x.tradingAccountId)).size;
    const plat = this.platformList.result.value()?.pager?.totalItemCount;
    const priv = this.privateList.result.value()?.pager?.totalItemCount;
    return [
      {
        label: 'Subscriptions',
        value: s ? String(subs.length) : '…',
        caption: `${strategies} strateg${strategies === 1 ? 'y' : 'ies'} · ${paused} paused`,
      },
      {
        label: 'Accounts subscribed',
        value: s ? `${accountsWith} of ${this.accounts().length}` : '…',
        caption: 'in your account scope',
      },
      {
        label: 'Delivery rule',
        value: !s ? '…' : s.requireSubscription ? 'Opt-in' : 'Fan-out',
        caption: !s
          ? null
          : s.requireSubscription
            ? 'only subscribed accounts receive signals'
            : 'unsubscribed strategies reach every account streaming the symbol',
      },
      {
        label: 'Platform strategies',
        value: plat == null ? '…' : String(plat),
        caption: 'matching the filter below',
      },
      {
        label: 'Your private strategies',
        value: priv == null ? '…' : String(priv),
        caption: 'matching the filter below',
        route: '/strategies',
      },
    ];
  });

  constructor() {
    this.reload();
  }

  readonly loading = computed(
    () =>
      this.subscriptionsLoading() ||
      this.platformList.result.loading() ||
      this.privateList.result.loading(),
  );

  reload(): void {
    this.loadSubscriptions();
    this.platformList.result.reload();
    this.privateList.result.reload();
  }

  private loadSubscriptions(): void {
    this.subscriptionsLoading.set(true);
    this.api.strategySubscriptions().subscribe({
      next: (v) => {
        this.subscriptionsLoading.set(false);
        this.unavailable.set(false);
        this.subscriptions.set(v);
        this.subscriptionsError.set(null);
      },
      error: (e) => {
        this.subscriptionsLoading.set(false);
        // An engine without the endpoint answers a plain 404 (not the envelope's "not found").
        this.unavailable.set(isMissingEndpoint(e));
        this.subscriptionsError.set(errorText(e, 'Could not load the subscriptions.'));
      },
    });
  }

  subscribedCount(strategyId: number): number {
    return this.counts().get(strategyId) ?? 0;
  }

  target(st: StrategySummary, ownership: StrategyOwnership): EditTarget {
    return {
      id: st.id,
      name: st.name ?? `Strategy ${st.id}`,
      symbol: st.symbol ?? '',
      isScript: st.authoringMode === 'Script',
      isPlatform: ownership === 'Platform',
    };
  }

  openEditor(t: EditTarget): void {
    this.editing.set(t);
    this.current.set([]);
    this.drafts.set([]);
    this.confirmReal.set(false);
    this.submitted.set(false);
    this.editorError.set(null);
    this.saveError.set(null);
    this.editorLoading.set(true);
    this.api.strategyBindings(t.id).subscribe({
      next: (bindings) => {
        if (this.editing()?.id !== t.id) return;
        this.current.set(bindings);
        this.drafts.set(draftFrom(this.accounts(), bindings));
        this.editorLoading.set(false);
      },
      error: (e) => {
        if (this.editing()?.id !== t.id) return;
        this.editorLoading.set(false);
        this.editorError.set(errorText(e, "Could not read this strategy's subscriptions."));
      },
    });
  }

  closeEditor(): void {
    if (this.busy()) return;
    this.editing.set(null);
  }

  patchDraft(index: number, patch: Partial<BindingDraft>): void {
    this.drafts.update((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  save(): void {
    const t = this.editing();
    this.submitted.set(true);
    if (!t || this.busy() || this.change().none || this.problems().length) return;
    this.busy.set(true);
    this.saveError.set(null);
    this.api.replaceStrategyBindings(t.id, draftToInputs(this.drafts())).subscribe({
      next: () => {
        this.busy.set(false);
        this.editing.set(null);
        this.notify.success(`Subscriptions of ${t.name} saved.`);
        this.loadSubscriptions();
      },
      error: (e) => {
        this.busy.set(false);
        this.saveError.set(failureMessage(e, 'The subscriptions were not saved.'));
      },
    });
  }
}
