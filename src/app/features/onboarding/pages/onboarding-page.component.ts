import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { catchError, of } from 'rxjs';

import { iamResource } from '@features/iam/shared/iam-resource';
import { ago } from '@features/iam/shared/admin-context.logic';
import { StatTilesComponent, type StatTile } from '@features/iam/shared/stat-tiles.component';
import { OrganisationApiService } from '@features/organisation/organisation-api.service';
import type { TerminalSetup } from '@features/organisation/connect/terminal-wizard.types';
import { PlansApiService } from '@features/platform/plans-api.service';
import type { TenantUsage } from '@features/platform/plans.types';
import { OnboardingApiService } from '../onboarding-api.service';
import { progressText } from '../onboarding.logic';
import type { OnboardingItem, TenantOnboarding } from '../onboarding.types';

/**
 * Getting the organisation going (engine multi-tenancy Phase 7, LC.1, `GET /tenant/onboarding`,
 * `tenant.usage.read`): connect a terminal, choose strategies, require a second factor, invite people —
 * each worked out from what exists, with a link to the page where it is done (shown only when the person may
 * open it). A new self-served organisation lands here after sign-in until the steps are done.
 */
@Component({
  selector: 'app-onboarding-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeaderComponent, StatTilesComponent],
  styleUrls: ['../../iam/shared/iam-page.scss'],
  styles: [
    `
      .steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .step {
        display: grid;
        grid-template-columns: 28px 1fr auto;
        gap: var(--space-3);
        align-items: start;
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .step.done {
        opacity: 0.75;
      }
      .tick {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 2px solid var(--border);
        font-size: var(--text-xs);
      }
      .step.done .tick {
        background: var(--profit);
        border-color: var(--profit);
        color: #fff;
      }
      .step h4 {
        margin: 0 0 var(--space-1);
      }
      .step p {
        margin: 0;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Get started"
        subtitle="A few steps to get your organisation trading, and where it stands now."
      >
        <a class="btn btn-secondary" routerLink="/docs/getting-started">Read the guide</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="reloadAll()"
          [disabled]="checklist.loading()"
        >
          {{ checklist.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      <app-stat-tiles [tiles]="tiles()" label="Organisation summary" />

      @if (checklist.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      @if (checklist.value(); as c) {
        <section class="card">
          <header class="card-head">
            <h3>{{ c.name }}</h3>
            <span class="spacer"></span>
            <span class="chip" [class.ok]="c.completed >= c.total">{{
              progress(c.completed, c.total)
            }}</span>
          </header>
          <div class="card-body">
            <ol class="steps">
              @for (item of c.items; track item.key) {
                <li class="step" [class.done]="item.done">
                  <span class="tick" aria-hidden="true">{{ item.done ? '✓' : '' }}</span>
                  <div>
                    <h4>
                      {{ item.title }}
                      <span class="sr-only">{{ item.done ? '(done)' : '(to do)' }}</span>
                    </h4>
                    <p class="small muted">{{ item.detail || item.description }}</p>
                  </div>
                  @if (canOpen(item)) {
                    <a class="btn btn-secondary btn-sm" [routerLink]="item.route">{{
                      item.done ? 'Open' : 'Start'
                    }}</a>
                  } @else if (!item.done) {
                    <span class="small muted">Ask an administrator</span>
                  }
                </li>
              }
            </ol>
          </div>
        </section>
        @if (usage.value(); as u) {
          <section class="card">
            <header class="card-head">
              <h3>What {{ c.name }} holds today</h3>
              <span class="spacer"></span>
              <a class="small" routerLink="/iam/plan">Plan & usage</a>
            </header>
            <div class="table-wrap">
              <table class="grid">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>In use</th>
                    <th>Plan allows</th>
                  </tr>
                </thead>
                <tbody>
                  @for (i of u.items; track i.key) {
                    <tr>
                      <td>{{ i.label }}</td>
                      <td>
                        <strong>{{ i.used }}</strong>
                      </td>
                      <td class="small">
                        {{ i.limit == null ? 'no limit' : i.limit }}
                        @if (i.overLimit) {
                          <span class="chip bad">over</span>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
        <p class="note">
          {{ planNote() }}
          <a routerLink="/iam/plan">See your plan</a>.
          @if (canSeePlans) {
            Need more? <a routerLink="/organisation/billing">See plans</a>.
          }
        </p>
      }
    </div>
  `,
})
export class OnboardingPageComponent {
  private readonly api = inject(OnboardingApiService);
  private readonly auth = inject(AuthService);

  protected readonly progress = progressText;
  /** The plans (and self-serve upgrade) live on Usage & billing, for whoever may read it. */
  protected readonly canSeePlans = this.auth.canSeePath('organisation/billing');

  readonly checklist = iamResource<TenantOnboarding | null>(
    () => this.api.onboarding(),
    null,
    'Could not load the checklist.',
  );

  private readonly plans = inject(PlansApiService);
  private readonly org = inject(OrganisationApiService);
  readonly usage = iamResource<TenantUsage | null>(
    () => this.plans.myUsage().pipe(catchError(() => of(null))),
    null,
  );
  readonly setup = iamResource<TerminalSetup | null>(
    () => this.org.terminalSetup().pipe(catchError(() => of(null))),
    null,
  );
  /** The plan and the demo-only rule as the engine states them — never assumed. */
  readonly planNote = computed(() => {
    const u = this.usage.value();
    const s = this.setup.value();
    const plan = u?.plan?.name
      ? `Your organisation is on the ${u.plan.name} plan`
      : 'Your plan could not be read';
    const demo =
      s == null
        ? ''
        : s.demoAccountsOnly
          ? ' and may connect demo accounts only'
          : ' and may connect demo and real accounts';
    return `${plan}${demo}.`;
  });
  readonly tiles = computed<StatTile[]>(() => {
    const c = this.checklist.value();
    const used = (k: string) => this.usage.value()?.items.find((i) => i.key === k)?.used;
    const n = (v: number | undefined) => (v == null ? '—' : String(v));
    return [
      {
        label: 'Steps done',
        value: c ? `${c.completed} of ${c.total}` : '…',
        caption: c ? (c.completed >= c.total ? 'all done' : `${c.total - c.completed} left`) : null,
        tone: c ? (c.completed >= c.total ? 'good' : 'warn') : null,
      },
      {
        label: 'Terminals connected',
        value: n(used('activeEaInstances')),
        caption: this.setup.value()?.latestEa
          ? `latest EA ${this.setup.value()!.latestEa!.version}`
          : 'MetaTrader 5 with the Lascodia EA',
        route: '/organisation/terminals',
      },
      {
        label: 'Trading accounts',
        value: n(used('tradingAccounts')),
        caption: 'known to the engine',
        route: '/trading-accounts',
      },
      {
        label: 'Strategies',
        value: n(used('strategies')),
        caption: `${n(used('scripts'))} saved scripts`,
        route: '/strategies',
      },
      {
        label: 'People',
        value: n(used('members')),
        caption: 'members and pending invitations',
        route: '/iam/members',
      },
      {
        label: 'Organisation since',
        value: c?.createdAtUtc ? ago(c.createdAtUtc) : '—',
        caption: c?.createdAtUtc ? new Date(c.createdAtUtc).toLocaleDateString() : null,
      },
    ];
  });

  constructor() {
    this.reloadAll();
  }

  reloadAll(): void {
    this.checklist.reload();
    this.usage.reload();
    this.setup.reload();
  }

  canOpen(item: OnboardingItem): boolean {
    return this.auth.canSeePath(item.route);
  }
}
