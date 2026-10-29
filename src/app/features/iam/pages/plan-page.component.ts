import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { BillingApiService } from '@features/billing/billing-api.service';
import type { BillingSubscription } from '@features/billing/billing.types';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { PlansApiService } from '@features/platform/plans-api.service';
import { PlanUsagePanelComponent } from '@features/platform/components/plan-usage-panel.component';
import type { TenantUsage } from '@features/platform/plans.types';
import { iamResource } from '../shared/iam-resource';
import { AuditTrailComponent } from '../shared/audit-trail.component';
import { StatTilesComponent, type StatTile } from '../shared/stat-tiles.component';

/**
 * Plan & usage (engine multi-tenancy Phase 7, `GET /tenant/usage`, `tenant.usage.read`): what the
 * organisation's plan allows — accounts, terminals, people, research jobs, strategies, scripts,
 * features — and how much is in use. Creations over a limit are refused with a message naming the
 * limit; platform staff change the plan.
 */
@Component({
  selector: 'app-iam-plan-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    PageHeaderComponent,
    PlanUsagePanelComponent,
    StatTilesComponent,
    AuditTrailComponent,
  ],
  styleUrl: '../shared/iam-page.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Plan & usage"
        subtitle="What your organisation's plan allows and how much of it is in use."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="usage.reload(); sub.reload()"
          [disabled]="usage.loading()"
        >
          {{ usage.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Plan summary" />

      <section class="card">
        @if (usage.error(); as err) {
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        }
        @if (usage.value(); as u) {
          <app-plan-usage-panel [usage]="u" />
        } @else if (!usage.error()) {
          <p class="pad muted">Loading…</p>
        }
      </section>

      @if (sub.value(); as b) {
        <section class="card">
          <header class="card-head">
            <h3>Plans on offer</h3>
            <span class="spacer"></span>
            <a class="small" routerLink="/organisation/billing">Usage & billing</a>
          </header>
          <div class="table-wrap">
            <table class="grid">
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Price</th>
                  <th>Accounts</th>
                  <th>Terminals</th>
                  <th>People</th>
                  <th>Strategies</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>{{ b.currentPlan?.name ?? usage.value()?.plan?.name ?? '—' }}</strong>
                    <span class="chip ok">yours</span>
                  </td>
                  <td class="small" colspan="5">the limits shown above</td>
                </tr>
                @for (o of otherOffers(); track o.slug) {
                  <tr>
                    <td>
                      {{ o.name }}
                      @if (o.isDefault) {
                        <span class="chip info">default</span>
                      }
                      <span class="sub">{{ o.description || '' }}</span>
                    </td>
                    <td class="small">
                      {{
                        o.priceAmount
                          ? o.priceAmount +
                            ' ' +
                            (o.currency ?? '').toUpperCase() +
                            ' / ' +
                            (o.interval ?? 'month')
                          : 'free'
                      }}
                    </td>
                    <td class="small">{{ lim(o.maxTradingAccounts) }}</td>
                    <td class="small">{{ lim(o.maxActiveEaInstances) }}</td>
                    <td class="small">{{ lim(o.maxMembers) }}</td>
                    <td class="small">{{ lim(o.maxStrategies) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <p class="pad small muted">
            {{
              b.selfServeEnabled
                ? 'An Owner can change plan with a card from Usage & billing.'
                : 'Changing plan is done by platform staff: self-serve card billing is not set up on this platform.'
            }}
          </p>
        </section>
      }

      <app-audit-trail
        heading="Plan changes and refusals"
        [actions]="['platform.tenant.plan_changed', 'platform.quota.refused']"
        empty="This organisation's plan has never been changed and nothing has been refused for going over a limit."
      />

      <p class="note">
        Something you try to add over a limit is refused with a message saying which limit. Nothing
        in use is ever removed when a plan changes. To move to a larger plan, contact platform
        staff.
      </p>
    </div>
  `,
})
export class PlanPageComponent {
  private readonly plans = inject(PlansApiService);

  readonly usage = iamResource<TenantUsage | null>(
    () => this.plans.myUsage(),
    null,
    'Could not load your plan and usage.',
  );

  private readonly billing = inject(BillingApiService);
  private readonly auth = inject(AuthService);
  readonly sub = iamResource<BillingSubscription | null>(
    () =>
      this.auth.hasPermission(Permission.TenantBillingRead)
        ? this.billing.subscription().pipe(catchError(() => of(null)))
        : of(null),
    null,
  );
  readonly otherOffers = computed(() =>
    (this.sub.value()?.offers ?? []).filter((o) => !o.isCurrent),
  );
  readonly tiles = computed<StatTile[]>(() => {
    const u = this.usage.value();
    const items = u?.items ?? [];
    const limited = items.filter((i) => i.limit != null);
    const tight = limited.filter((i) => i.limit != null && i.used >= i.limit * 0.8).length;
    const feats = u ? Object.values(u.features).filter(Boolean).length : 0;
    return [
      {
        label: 'Plan',
        value: u?.plan?.name ?? '…',
        caption: u?.unlimited
          ? 'no limit applies'
          : u?.plan?.viaDefault
            ? 'the default plan'
            : 'assigned by platform staff',
      },
      {
        label: 'Limits near or over',
        value: u ? String(tight) : '…',
        caption: u
          ? limited.length
            ? `of ${limited.length} limited items (80 % or more)`
            : 'nothing is limited'
          : null,
        tone: u ? (tight ? 'warn' : 'good') : null,
      },
      {
        label: 'Features included',
        value: u ? `${feats} of ${Object.keys(u.features).length}` : '…',
        caption: 'sign-on, directory, tokens, modules',
      },
      {
        label: 'AI spend this month',
        value: u?.llm.available ? `$${(u.llm.monthToDateUsd ?? 0).toFixed(2)}` : '—',
        caption:
          u?.llm.monthlyLimitUsd != null
            ? `of $${u.llm.monthlyLimitUsd} a month`
            : 'no monthly budget',
        route: '/organisation/llm',
      },
    ];
  });

  constructor() {
    this.usage.reload();
    this.sub.reload();
  }

  lim(n: number | null): string {
    return n == null ? 'unlimited' : String(n);
  }
}
