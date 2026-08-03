import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { AlgoEngineerService } from '@core/services/algo-engineer.service';
import type { AlgoEngineerScorecardRowDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/** Change scorecard (ADR-0020 §F) — the algo-engineer agent's shipped changes, predicted vs realised. */
@Component({
  selector: 'app-algo-engineer-scorecard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    ErrorStateComponent,
    EmptyStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Algo-Engineer — Change Scorecard"
        subtitle="Each change the agent proposed/shipped, graded against its own forecast (ADR-0020)"
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load the change scorecard"
          message="The engine returned an error. Verify it is reachable and the algo-engineer endpoints are deployed."
          (retry)="resource.refresh()"
        />
      } @else {
        <section class="kpis">
          <app-metric-card
            label="Tracked changes"
            [value]="rows().length"
            format="number"
            dotColor="#8b5cf6"
          />
          <app-metric-card
            label="Diverged"
            [value]="divergedCount()"
            format="number"
            [dotColor]="divergedCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Accruing"
            [value]="accruingCount()"
            format="number"
            dotColor="#FF9500"
          />
        </section>

        @if (rows().length === 0) {
          <app-empty-state
            title="No tracked changes yet"
            description="Once the agent's proposals are deployed, their outcome scorecards appear here."
          />
        } @else {
          <section class="card">
            <table class="scorecard-table">
              <thead>
                <tr>
                  <th>Change</th>
                  <th>Summary</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th class="num">Predicted Δ</th>
                  <th class="num">Realised Δ</th>
                  <th class="num">Counterfactual Δ</th>
                  <th class="num">Forecast err</th>
                  <th class="num">Sample</th>
                  <th>Horizon</th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.changeSetId) {
                  <tr>
                    <td>
                      <code>{{ row.sha.slice(0, 8) }}</code>
                    </td>
                    <td class="summary">{{ row.summary }}</td>
                    <td>{{ row.changeSetStatus }}</td>
                    <td>
                      <span class="dot" [style.background]="statusColor(row.outcomeStatus)"></span>
                      {{ row.outcomeStatus }}
                    </td>
                    <td class="num">{{ row.predictedDelta | number: '1.2-3' }}</td>
                    <td class="num">
                      {{ row.realizedDelta === null ? '—' : (row.realizedDelta | number: '1.2-3') }}
                    </td>
                    <td class="num">
                      {{
                        row.counterfactualDelta === null
                          ? '—'
                          : (row.counterfactualDelta | number: '1.2-3')
                      }}
                    </td>
                    <td class="num">
                      {{ row.forecastError === null ? '—' : (row.forecastError | number: '1.2-3') }}
                    </td>
                    <td class="num">{{ row.realizedSampleAccrued }}</td>
                    <td>{{ row.horizonExpiresAtUtc | relativeTime }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }
    </div>
  `,
  styles: [
    `
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
        margin-bottom: 16px;
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        overflow-x: auto;
      }
      .scorecard-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .scorecard-table th,
      .scorecard-table td {
        padding: 8px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        white-space: nowrap;
      }
      .scorecard-table th {
        font-weight: var(--font-bold);
        color: var(--text-secondary);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }
      .scorecard-table .num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .scorecard-table .summary {
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-right: 4px;
        vertical-align: middle;
      }
    `,
  ],
})
export class AlgoEngineerScorecardPageComponent {
  private readonly algoEngineer = inject(AlgoEngineerService);

  protected readonly resource = createPolledResource(
    () =>
      this.algoEngineer.getScorecard(false, 100).pipe(
        map((res) => res.data ?? []),
        catchError(() => of<AlgoEngineerScorecardRowDto[]>([])),
      ),
    { intervalMs: 60_000 },
  );

  protected readonly rows = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(() => this.resource.loading() && this.rows().length === 0);
  protected readonly divergedCount = computed(
    () => this.rows().filter((r) => r.outcomeStatus === 'Diverged').length,
  );
  protected readonly accruingCount = computed(
    () => this.rows().filter((r) => r.outcomeStatus === 'Accruing').length,
  );

  protected statusColor(status: string): string {
    switch (status) {
      case 'Confirmed':
        return '#34C759';
      case 'Diverged':
        return '#FF3B30';
      case 'Accruing':
        return '#FF9500';
      default:
        return '#8E8E93';
    }
  }
}
