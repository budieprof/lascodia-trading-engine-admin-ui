import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
  type OnInit,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { when } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PropApiService } from '../prop-api.service';
import {
  PROP_SETTING_LABELS,
  runningCount,
  setupKind,
  setupRequirements,
} from '../prop-overview.logic';
import { money } from '../prop.logic';
import type { PropOverview } from '../prop.types';

/**
 * The prop module at a glance, on every firm page: summary tiles, the setup checklist with each step's real status
 * (`GET prop/overview`, or counted from the lists on an older engine), and optionally the live `Prop:*` settings and
 * the accounts the module could enrol. Loads when the page's gate says the module is available (`load()`).
 */
@Component({
  selector: 'app-prop-setup',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, FeatureStateComponent],
  styleUrl: '../../iam/shared/iam-page.scss',
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
        gap: var(--space-3);
      }
      .tile {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        min-width: 0;
      }
      .tile-label {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .tile-value {
        font-size: var(--text-xl);
        font-weight: var(--font-semibold);
        font-variant-numeric: tabular-nums;
        margin: 2px 0;
      }
      .tile-sub {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .two {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: var(--space-3);
      }
      @media (max-width: 1100px) {
        .two {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
  template: `
    @if (overview.error(); as err) {
      <section class="card">
        <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
      </section>
    }
    @if (data(); as o) {
      @if (showTiles()) {
        <section class="tiles" aria-label="Prop module summary">
          <div class="tile">
            <div class="tile-label">Programs</div>
            <div class="tile-value">{{ o.activePrograms }}</div>
            <div class="tile-sub">active · {{ o.archivedPrograms }} archived</div>
          </div>
          <div class="tile">
            <div class="tile-label">Traders</div>
            <div class="tile-value">{{ o.traders }}</div>
            <div class="tile-sub">
              {{ o.activeTraders }} active · {{ o.linkedTraders }} with a login
            </div>
          </div>
          <div class="tile">
            <div class="tile-label">Running enrolments</div>
            <div class="tile-value">{{ running() }}</div>
            <div class="tile-sub">
              {{ o.enrollmentsByState['Passed'] ?? 0 }} passed ·
              {{ o.enrollmentsByState['Failed'] ?? 0 }} failed
            </div>
          </div>
          <div class="tile">
            <div class="tile-label">Breaches, last 24 h</div>
            <div class="tile-value">{{ o.breaches24h }}</div>
            <div class="tile-sub">
              {{ o.warnings24h }} warnings ·
              {{ o.breachesTotal === null ? 'total n/a' : o.breachesTotal + ' ever' }}
            </div>
          </div>
          <div class="tile">
            <div class="tile-label">Payouts to approve</div>
            <div class="tile-value">{{ o.payoutsByStatus['Draft'] ?? 0 }}</div>
            <div class="tile-sub">
              {{ o.payoutsByStatus['Approved'] ?? 0 }} approved ·
              {{ money(o.approvedNetPayouts) }} net
            </div>
          </div>
          <div class="tile">
            <div class="tile-label">Accounts that could enrol</div>
            <div class="tile-value">{{ enrollable() }}</div>
            <div class="tile-sub">
              of {{ o.accounts.length }} active · {{ freshCount() }} synced now
            </div>
          </div>
        </section>
      }

      @if (showChecklist()) {
        <app-feature-state
          title="Prop-firm module"
          [kind]="kind()"
          [stateLabel]="stateLabel()"
          switchKey="Prop:Evaluation:Enabled"
          summary="Run funded-trader challenges on your own trading accounts: programs set the phases and rules (profit target, daily loss, drawdown, trading days, conduct), the engine judges every enrolled account every few seconds, a breach halts the account through its kill switch, and funded traders get profit-split statements. The platform never moves money."
          [detail]="intro()"
          [requirements]="requirements()"
          [links]="links"
        />
      }

      @if (showSettings() || showAccounts()) {
        <div class="two">
          @if (showSettings()) {
            <section class="card">
              <header class="card-head">
                <h3>Live configuration</h3>
                <span class="muted small">{{
                  o.source === 'engine' ? 'engine settings, read now' : 'read from engine config'
                }}</span>
                <span class="spacer"></span>
                <a class="small" routerLink="/engine-config" [queryParams]="{ search: 'Prop:' }"
                  >Open settings</a
                >
              </header>
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Setting</th>
                      <th>Value</th>
                      <th>What it does</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (s of o.settings; track s.key) {
                      <tr>
                        <td>
                          {{ labels[s.key] ?? s.key }}
                          <span class="sub"
                            ><code>{{ s.key }}</code></span
                          >
                        </td>
                        <td>
                          <strong>{{ s.value }}</strong>
                        </td>
                        <td class="small">{{ s.meaning }}</td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="3" class="muted">
                          The settings could not be read with your access (they need engine
                          configuration access).
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <p class="pad small muted">
                Last evaluation:
                {{
                  o.lastEvaluatedAtUtc
                    ? when(o.lastEvaluatedAtUtc)
                    : 'never — nothing is enrolled, so the evaluator has nothing to judge'
                }}.
                @if (o.highImpactEventsNext7d !== null) {
                  {{ o.highImpactEventsNext7d }} high-impact releases in the next 7 days (what a
                  no-news-trading rule watches).
                }
              </p>
            </section>
          }
          @if (showAccounts()) {
            <section class="card">
              <header class="card-head">
                <h3>Your trading accounts</h3>
                <span class="muted small">active, not paper</span>
              </header>
              <div class="table-wrap">
                <table class="grid">
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th class="num">Balance</th>
                      <th class="num">Equity</th>
                      <th>Synced</th>
                      <th>Prop</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (a of o.accounts; track a.id) {
                      <tr>
                        <td>
                          {{ a.label }}
                          <span class="sub">{{ a.accountType }} · {{ a.currency }}</span>
                        </td>
                        <td class="num">{{ money(a.balance) }}</td>
                        <td class="num">{{ money(a.equity) }}</td>
                        <td class="small">
                          <span class="chip" [class.ok]="a.fresh" [class.warn]="!a.fresh">{{
                            a.fresh ? 'fresh' : 'stale'
                          }}</span>
                          <span class="sub">{{ when(a.lastSyncedAtUtc) }}</span>
                        </td>
                        <td class="small">
                          @if (a.runningEnrollmentId) {
                            <a [routerLink]="['/prop/enrollments', a.runningEnrollmentId]">{{
                              a.runningProgram ?? 'Enrolled'
                            }}</a>
                          } @else {
                            <span class="muted">not enrolled</span>
                          }
                        </td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="5" class="muted">
                          No active trading account. Accounts appear when an EA terminal signs in.
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          }
        </div>
      }
    } @else if (overview.loading()) {
      <p class="pad muted">Loading the module overview…</p>
    }
  `,
})
export class PropSetupComponent implements OnInit {
  private readonly api = inject(PropApiService);

  /** Page-specific sentence under the module description (what this page is for, what to do first). */
  readonly intro = input<string | null>(null);
  /** Load on first render (for a component the page shows only after its own data arrived). */
  readonly autoload = input(false);
  readonly showTiles = input(true);
  readonly showChecklist = input(true);
  readonly showSettings = input(false);
  readonly showAccounts = input(false);
  /** Figures another instance on the page already loaded (this one then never fetches). */
  readonly given = input<PropOverview | null>(null);
  readonly loaded = output<PropOverview>();

  protected readonly money = money;
  protected readonly labels = PROP_SETTING_LABELS;
  protected readonly when = when;
  protected readonly links = [
    { label: 'Prop API reference', route: '/docs/api' },
    { label: 'Payout approvals (four-eyes)', route: '/docs/fund-guide' },
    { label: 'Prop settings', route: '/engine-config', query: { search: 'Prop:' } },
  ];

  readonly overview = iamResource<PropOverview | null>(
    () => this.api.overview(),
    null,
    'Could not load the prop module overview.',
  );
  readonly data = computed(() => this.given() ?? this.overview.value());
  readonly running = computed(() => {
    const o = this.data();
    return o ? runningCount(o) : 0;
  });
  readonly enrollable = computed(
    () => this.data()?.accounts.filter((a) => !a.runningEnrollmentId).length ?? 0,
  );
  readonly freshCount = computed(() => this.data()?.accounts.filter((a) => a.fresh).length ?? 0);
  readonly requirements = computed(() => {
    const o = this.data();
    return o ? setupRequirements(o) : [];
  });
  readonly kind = computed(() => {
    const o = this.data();
    return o ? setupKind(o) : 'waiting';
  });
  readonly stateLabel = computed(() => {
    switch (this.kind()) {
      case 'on':
        return 'Running';
      case 'off':
        return 'Evaluation off';
      case 'partial':
        return 'Partly set up';
      default:
        return 'Switched on · not set up';
    }
  });

  ngOnInit(): void {
    if (this.autoload()) this.load();
  }

  /** Called by the page once the module is available. */
  load(): void {
    if (!this.given()) this.overview.reload();
  }

  constructor() {
    // Hand the figures to the page (its empty states quote them).
    effect(() => {
      const o = this.overview.value();
      if (o) untracked(() => this.loaded.emit(o));
    });
  }
}
