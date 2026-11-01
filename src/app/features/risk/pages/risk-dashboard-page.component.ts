import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { createPolledResource } from '@core/polling/polled-resource';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { TabsComponent, type TabItem } from '@shared/components/ui/tabs/tabs.component';

import { RiskApiService } from '../risk-api.service';
import { modeExplainer, modeTone } from '../risk.logic';
import { RiskOverviewComponent } from '../components/risk-overview.component';
import { RiskStressComponent } from '../components/risk-stress.component';
import { RiskScenariosComponent } from '../components/risk-scenarios.component';
import { RiskExposureComponent } from '../components/risk-exposure.component';
import { RiskWhatIfComponent } from '../components/risk-what-if.component';
import { RiskControlsComponent } from '../components/risk-controls.component';

/**
 * Portfolio risk (gaps program, risk vertical; route `/risk`, `risk.read`): VaR / CVaR tiles and history, the margin and
 * stop-out forecast, stress results with per-position drill-down, the scenario library and editor, the exposure book
 * netted with positions, a read-only what-if, and the console controls (typed settings, the Observe-mode verdicts of the
 * stress pre-trade check, the risk workers with run-now).
 */
@Component({
  selector: 'app-risk-dashboard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    PageHeaderComponent,
    FeatureStateComponent,
    TabsComponent,
    RiskOverviewComponent,
    RiskStressComponent,
    RiskScenariosComponent,
    RiskExposureComponent,
    RiskWhatIfComponent,
    RiskControlsComponent,
  ],
  styleUrl: '../risk.scss',
  template: `
    <div class="page">
      <app-page-header
        title="Portfolio risk"
        subtitle="Value at risk, stress tests, the margin forecast and the exposure book — per account or for the whole organisation."
      >
        <label class="scope">
          <span class="sr-only">Scope</span>
          <select class="select" [ngModel]="accountId()" (ngModelChange)="accountId.set($event)" aria-label="Account or organisation book">
            <option [ngValue]="null">Organisation book (USD)</option>
            @for (a of accounts(); track a.tradingAccountId) {
              <option [ngValue]="a.tradingAccountId">{{ a.accountName || a.accountId }} · {{ a.accountId }}{{ a.isPaper ? ' (paper)' : '' }}</option>
            }
          </select>
        </label>
        <button type="button" class="btn btn-secondary" (click)="overview.refresh()" [disabled]="overview.refreshing()">
          {{ overview.refreshing() ? 'Refreshing…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (overview.error() && !overview.value()) {
        <section class="card"><p class="pad" role="alert"><span class="chip bad">Could not load</span> The risk overview did not load. Refresh to try again.</p></section>
      }

      @if (overview.value(); as o) {
        <p class="mode-line">
          <span [class]="'chip ' + modeTone(o.stressMode)">Stress pre-trade check: {{ o.stressMode }}</span>
          <span class="small muted">{{ modeExplainer(o.stressMode) }} Limits: worst scenario ≤ {{ o.maxScenarioLossPct }} % of equity, stop-out ≥ {{ o.minStopOutSigma }} one-day σ.</span>
        </p>
        @if (!o.snapshotsEnabled || (!o.book && noSnapshotYet())) {
          <app-feature-state
            title="Portfolio risk history"
            [kind]="o.snapshotsEnabled ? 'waiting' : 'off'"
            [stateLabel]="o.snapshotsEnabled ? 'Waiting for the first snapshot' : 'History off'"
            switchKey="PortfolioRisk:Snapshot:Enabled"
            summary="The portfolio risk worker stores VaR / CVaR, exposure and the stop-out forecast for every active account at the snapshot interval; this page charts that history."
            [detail]="o.snapshotsEnabled ? 'Snapshots are on; the first one is written within ' + o.snapshotIntervalSeconds + ' s of the worker running. The Controls tab shows the worker and can take one now.' : 'Turn PortfolioRisk:Snapshot:Enabled on in the Controls tab.'"
          />
        }
      }

      <ui-tabs [tabs]="tabs" [(activeTab)]="tab" />

      @switch (tab()) {
        @case ('overview') {
          <app-risk-overview [overview]="overview.value()" [loading]="overview.loading()" [accountId]="accountId()" (selectAccount)="accountId.set($event)" />
        }
        @case ('stress') {
          <app-risk-stress [accountId]="accountId()" [canManage]="canManage()" />
        }
        @case ('scenarios') {
          <app-risk-scenarios [canManage]="canManage()" [canManagePlatform]="canManagePlatform()" />
        }
        @case ('exposure') {
          <app-risk-exposure [accountId]="accountId()" />
        }
        @case ('whatif') {
          <app-risk-what-if [accountId]="accountId()" [accounts]="accounts()" />
        }
        @case ('controls') {
          <app-risk-controls [canManage]="canManage()" (changed)="overview.refresh()" />
        }
      }
    </div>
  `,
})
export class RiskDashboardPageComponent {
  private readonly api = inject(RiskApiService);
  private readonly auth = inject(AuthService);

  protected readonly modeTone = modeTone;
  protected readonly modeExplainer = modeExplainer;

  readonly overview = createPolledResource(() => this.api.overview(), { intervalMs: 60_000 });
  readonly accountId = signal<number | null>(null);
  readonly tab = signal('overview');

  readonly tabs: TabItem[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Stress tests', value: 'stress' },
    { label: 'Scenario library', value: 'scenarios' },
    { label: 'Exposure', value: 'exposure' },
    { label: 'What-if', value: 'whatif' },
    { label: 'Controls', value: 'controls' },
  ];

  readonly accounts = computed(() => this.overview.value()?.accounts ?? []);
  readonly noSnapshotYet = computed(() => this.accounts().every((a) => !a.latest));
  readonly canManage = computed(() => this.auth.hasPermission(Permission.RiskManage));
  readonly canManagePlatform = computed(() => this.auth.hasPermission(Permission.PlatformDataManage));
}
