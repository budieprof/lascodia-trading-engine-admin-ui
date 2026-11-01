import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { iamResource } from '@features/iam/shared/iam-resource';
import { FeatureStateComponent } from '@shared/components/feedback/feature-state.component';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';

import { SurveillanceAlertDrawerComponent } from '../components/alert-drawer.component';
import { JobStatusComponent } from '../components/job-status.component';
import { SurveillanceApiService } from '../surveillance-api.service';
import { SEVERITIES, STATUSES, resolutionLabel, severityTone, statusLabel } from '../surveillance.logic';
import type {
  SurveillanceAlertPage,
  SurveillanceConfiguration,
  SurveillanceOperations,
  SurveillanceSeverity,
  SurveillanceStatus,
} from '../surveillance.types';

const EMPTY_PAGE: SurveillanceAlertPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 50,
  statusCounts: {},
  activeByDetector: {},
  notice: '',
};

/**
 * Trade surveillance (gaps program): the organisation's surveillance alerts — wash trades, self-matches,
 * layering, order-to-trade ratio, marking the close, off-market prices, concentration, after-loss
 * doubling, unusual P&L — filtered, with a drawer for the evidence and the review. Needs
 * `surveillance.view`; reviewing needs `surveillance.review`. Observe only.
 */
@Component({
  selector: 'app-surveillance-alerts-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageHeaderComponent, FeatureStateComponent, SurveillanceAlertDrawerComponent, JobStatusComponent],
  styleUrls: ['../../iam/shared/iam-page.scss', './surveillance-page.scss'],
  template: `
    <div class="page">
      <app-page-header
        title="Trade surveillance"
        subtitle="Patterns in the organisation's own orders and fills for a person to review — observe only."
      />

      @if (config.value(); as c) {
        @if (!c.enabled) {
          <app-feature-state
            title="Trade surveillance"
            summary="Scans every organisation's orders, fills and positions for market-abuse patterns and raises alerts here. It never blocks, changes or closes a trade."
            kind="off"
            switchKey="Surveillance:Enabled"
            detail="Switched off: no new scans run. Alerts already raised stay reviewable."
            [links]="[{ label: 'Surveillance settings', route: '/surveillance/settings' }]"
          />
        }
      }

      <section class="card status-strip">
        <app-surveillance-job-status
          title="Scan"
          [status]="ops.value()?.scan ?? null"
          [canRun]="ops.value()?.canManage ?? false"
          runLabel="Scan now"
          job="scan"
          (requested)="ops.reload()"
        />
        <a routerLink="/surveillance/settings" class="btn btn-sm btn-ghost">Settings & detectors</a>
      </section>

      <div class="tiles">
        @for (s of statuses; track s) {
          <button
            type="button"
            class="tile"
            [class.on]="status() === s"
            [attr.aria-pressed]="status() === s"
            (click)="setStatus(status() === s ? null : s)"
          >
            <span class="t-label">{{ label(s) }}</span>
            <span class="t-value">{{ page.value().statusCounts[s] ?? 0 }}</span>
          </button>
        }
      </div>

      <section class="card">
        <div class="filters">
          <label class="field">
            <span class="label">Detector</span>
            <select class="input" name="detector" [ngModel]="detector()" (ngModelChange)="detector.set($event); reload()">
              <option [ngValue]="null">All detectors</option>
              @for (d of config.value()?.detectors ?? []; track d.key) {
                <option [ngValue]="d.key">
                  {{ d.name }} ({{ page.value().activeByDetector[d.key] ?? 0 }} active)
                </option>
              }
            </select>
          </label>
          <label class="field">
            <span class="label">At least</span>
            <select class="input" name="severity" [ngModel]="minSeverity()" (ngModelChange)="minSeverity.set($event); reload()">
              <option [ngValue]="null">Any severity</option>
              @for (s of severities; track s) {
                <option [ngValue]="s">{{ s }}</option>
              }
            </select>
          </label>
          <label class="field">
            <span class="label">Symbol</span>
            <input class="input" name="symbol" placeholder="e.g. EURUSD" [ngModel]="symbol()" (ngModelChange)="symbol.set($event)" (keydown.enter)="reload()" />
          </label>
          <label class="check">
            <input type="checkbox" name="mine" [ngModel]="mine()" (ngModelChange)="mine.set($event); reload()" />
            Assigned to me
          </label>
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm btn-ghost" [disabled]="page.loading()" (click)="reload()">Refresh</button>
        </div>

        @if (page.error(); as err) {
          <p class="alert" role="alert">{{ err }}</p>
        }
        <div class="table-wrap">
          <table class="grid">
            <thead>
              <tr>
                <th>Detected (UTC)</th>
                <th>Severity</th>
                <th>Detector</th>
                <th>What was seen</th>
                <th>Account</th>
                <th>Symbol</th>
                <th>Status</th>
                <th>Reviewer</th>
              </tr>
            </thead>
            <tbody>
              @for (a of page.value().items; track a.id) {
                <tr class="row" tabindex="0" (click)="open(a.id)" (keydown.enter)="open(a.id)">
                  <td class="nowrap">{{ a.detectedAtUtc.slice(0, 16).replace('T', ' ') }}</td>
                  <td><span class="pill" [class]="'pill ' + tone(a.severity)">{{ a.severity }}</span></td>
                  <td>{{ a.detectorName }}</td>
                  <td class="title">{{ a.title }}</td>
                  <td>{{ a.account ?? '—' }}</td>
                  <td>{{ a.symbol ?? '—' }}</td>
                  <td>
                    {{ label(a.status) }}
                    @if (a.resolution) {
                      <span class="sub">· {{ resolution(a.resolution) }}</span>
                    }
                  </td>
                  <td class="small">{{ a.assignedToDisplay || a.assignedTo || '—' }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="8" class="empty">
                    @if (!page.loaded()) {
                      Loading…
                    } @else if (filtered()) {
                      <strong>No alert matches these filters.</strong>
                    } @else {
                      <strong>No surveillance alerts yet.</strong>
                      The scan looks at the last {{ config.value()?.lookbackHours ?? 24 }} h of the
                      organisation's orders and fills every
                      {{ ((config.value()?.pollIntervalSeconds ?? 900) / 60).toFixed(0) }} minutes;
                      a pattern it finds appears here for review.
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (page.value().total > page.value().pageSize) {
          <div class="pager">
            <button type="button" class="btn btn-sm btn-ghost" [disabled]="pageNo() <= 1" (click)="go(pageNo() - 1)">Previous</button>
            <span>Page {{ pageNo() }} of {{ pages() }} · {{ page.value().total }} alerts</span>
            <button type="button" class="btn btn-sm btn-ghost" [disabled]="pageNo() >= pages()" (click)="go(pageNo() + 1)">Next</button>
          </div>
        }
        <p class="foot">{{ page.value().notice }}</p>
      </section>

      @if (selected(); as id) {
        <app-surveillance-alert-drawer [alertId]="id" (closed)="selected.set(null)" (changed)="reload()" />
      }
    </div>
  `,
})
export class SurveillanceAlertsPageComponent {
  private readonly api = inject(SurveillanceApiService);

  protected readonly statuses = STATUSES;
  protected readonly severities = SEVERITIES;
  protected readonly label = statusLabel;
  protected readonly resolution = resolutionLabel;
  protected readonly tone = severityTone;

  readonly status = signal<SurveillanceStatus | null>('Open');
  readonly detector = signal<string | null>(null);
  readonly minSeverity = signal<SurveillanceSeverity | null>(null);
  readonly symbol = signal('');
  readonly mine = signal(false);
  readonly pageNo = signal(1);
  readonly selected = signal<number | null>(null);

  readonly page = iamResource(
    () =>
      this.api.alerts({
        status: this.status(),
        detector: this.detector(),
        minSeverity: this.minSeverity(),
        symbol: this.symbol().trim() || null,
        mine: this.mine(),
        page: this.pageNo(),
        pageSize: 50,
      }),
    EMPTY_PAGE,
    'Could not load the surveillance alerts.',
  );
  readonly config = iamResource<SurveillanceConfiguration | null>(
    () => this.api.configuration(),
    null,
    'Could not load the detectors.',
  );
  readonly ops = iamResource<SurveillanceOperations | null>(() => this.api.operations(), null, 'Could not load the scan status.');

  readonly filtered = computed(
    () => !!(this.status() || this.detector() || this.minSeverity() || this.symbol().trim() || this.mine()),
  );
  readonly pages = computed(() => Math.max(1, Math.ceil(this.page.value().total / this.page.value().pageSize)));

  constructor() {
    this.page.reload();
    this.config.reload();
    this.ops.reload();
  }

  reload(): void {
    this.pageNo.set(1);
    this.page.reload();
  }

  setStatus(s: SurveillanceStatus | null): void {
    this.status.set(s);
    this.reload();
  }

  go(n: number): void {
    this.pageNo.set(n);
    this.page.reload();
  }

  open(id: number): void {
    this.selected.set(id);
  }
}
