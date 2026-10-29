import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { PropAccountFitComponent } from '../components/prop-account-fit.component';
import { PropDashboardViewComponent } from '../components/prop-dashboard-view.component';
import { PropGateComponent } from '../components/prop-gate.component';
import { PropSetupComponent } from '../components/prop-setup.component';
import { PropApiService } from '../prop-api.service';
import type { PropDashboard, PropOverview } from '../prop.types';

/**
 * "My challenge" (`prop.self`): the signed-in trader's own enrolments — those of the trading account
 * they signed in with, or of the trader their console user is linked to. Nobody else's. With nothing
 * linked it explains what the page shows and how a trader gets linked; firm staff (`prop.read`) also
 * see the module's figures.
 */
@Component({
  selector: 'app-prop-me-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    PageHeaderComponent,
    PropGateComponent,
    PropDashboardViewComponent,
    FeatureStateComponent,
    PropSetupComponent,
    PropAccountFitComponent,
  ],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      .gate-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .shows {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
      }
      .shows div {
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        background: var(--bg-primary);
      }
      .lead {
        margin: 0;
      }
      .shows strong {
        display: block;
        font-size: var(--text-sm);
        margin-bottom: 2px;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="My challenge"
        subtitle="Your progress against every rule of your program."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="mine.reload()"
          [disabled]="mine.loading()"
        >
          {{ mine.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>
      <app-prop-gate (ready)="mine.reload()">
        <div class="gate-body">
          @if (mine.error(); as err) {
            <section class="card">
              <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
            </section>
          }
          @for (d of mine.value(); track d.enrollment.id) {
            <app-prop-dashboard-view [dashboard]="d" />
          } @empty {
            @if (mine.loaded() && !mine.error()) {
              @if (isStaff()) {
                <app-prop-setup
                  [showChecklist]="false"
                  [autoload]="true"
                  (loaded)="overview.set($event)"
                />
              }
              <app-feature-state
                title="No challenge is linked to you"
                kind="waiting"
                stateLabel="Nothing linked"
                summary="This page shows a trader their own challenge: where they stand against every rule of their program, live — and nothing about anyone else."
                [detail]="detail()"
                [requirements]="requirements()"
                [links]="links()"
              />
              <section class="card">
                <header class="card-head"><h3>What a trader sees here</h3></header>
                <div class="shows">
                  <div>
                    <strong>Progress tiles</strong>
                    <span class="small muted"
                      >Profit against the target, daily loss left, distance to the drawdown floor,
                      trading days, consistency.</span
                    >
                  </div>
                  <div>
                    <strong>Equity curve with the rule lines</strong>
                    <span class="small muted"
                      >Equity and balance with the overall floor, the day's floor and the profit
                      target drawn on it.</span
                    >
                  </div>
                  <div>
                    <strong>Day by day</strong>
                    <span class="small muted"
                      >Each trading day's start, low and end, realised profit and positions
                      opened.</span
                    >
                  </div>
                  <div>
                    <strong>Breaches and payouts</strong>
                    <span class="small muted"
                      >Every warning and breach with the numbers behind it, and the trader's payout
                      statements.</span
                    >
                  </div>
                </div>
              </section>
              @if (isStaff()) {
                <p class="lead small muted">
                  Below: what a trader's challenge would show on each of your live accounts, from
                  their real equity record — the same rule checks “My challenge” runs once an
                  account is enrolled.
                </p>
                <app-prop-account-fit [autoload]="true" />
              }
            }
          }
        </div>
      </app-prop-gate>
    </div>
  `,
})
export class PropMePageComponent {
  private readonly api = inject(PropApiService);
  private readonly auth = inject(AuthService);

  readonly isStaff = computed(() => this.auth.hasPermission(Permission.PropRead));
  readonly mine = iamResource<PropDashboard[]>(
    () => this.api.myDashboards(),
    [],
    'Could not load your challenge.',
  );
  readonly overview = signal<PropOverview | null>(null);
  /** The steps that put a challenge on this page, with the statuses the engine reports. */
  readonly requirements = computed(() => {
    const o = this.overview();
    const reqs = [
      {
        label: 'An enrolment for your trading account or your trader record',
        ok: false as boolean | null,
        detail: 'The engine found none for your sign-in.',
      },
    ];
    if (o)
      reqs.unshift(
        {
          label: 'A challenge program defined',
          ok: o.activePrograms > 0,
          detail: o.activePrograms
            ? `${o.activePrograms} active program(s).`
            : 'No program yet — the firm defines one on Programs.',
        },
        {
          label: 'Traders linked to a console login',
          ok: o.linkedTraders > 0,
          detail: o.traders
            ? `${o.linkedTraders} of ${o.traders} trader(s) can sign in to see this page.`
            : 'No trader record yet.',
        },
        {
          label: 'Accounts enrolled',
          ok: (o.enrollmentsByState['Active'] ?? 0) + (o.enrollmentsByState['Funded'] ?? 0) > 0,
          detail: `${(o.enrollmentsByState['Active'] ?? 0) + (o.enrollmentsByState['Funded'] ?? 0)} running of ${o.accounts.length} active account(s).`,
        },
      );
    return reqs;
  });
  readonly detail = computed(() =>
    this.isStaff()
      ? 'You are signed in as firm staff. A trader sees this page once the firm links their console user to their trader record (Traders → Edit → Console user), or when they sign in with an enrolled trading account.'
      : 'Sign in with your challenge trading account, or ask the firm to link your console user to your trader record.',
  );
  readonly links = computed(() =>
    this.isStaff()
      ? [
          { label: 'Traders (link a console user)', route: '/prop/traders' },
          { label: 'Enrolments', route: '/prop/enrollments' },
          { label: 'Firm console', route: '/prop/console' },
        ]
      : [],
  );
}
