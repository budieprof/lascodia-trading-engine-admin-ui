import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

/** One learner architecture's row on the Architecture tab's leaderboard. */
export interface ArchLeaderboardRow {
  architecture: string;
  color: string;
  count: number;
  active: number;
  training: number;
  superseded: number;
  failed: number;
  activationRate: number;
  avgAccuracy: number;
  medianAccuracy: number;
  bestAccuracy: number;
  accuracies: readonly number[];
  avgRMSE: number;
  totalSamples: number;
  latestTrainedAt: string | null;
}

/** The per-architecture leaderboard: model counts by status, accuracy spread, RMSE and recency. */
@Component({
  selector: 'app-ml-arch-leaderboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe],
  styleUrl: './ml-arch-leaderboard.component.scss',
  template: `
    <section class="arch-board">
      <header class="arch-board-head">
        <h3>Per-architecture leaderboard</h3>
        <span class="muted small">
          Sortable by total models · default order: most models first
        </span>
      </header>
      <div class="arch-board-scroll">
        <table class="arch-table sticky">
          <thead>
            <tr>
              <th>Architecture</th>
              <th class="num">Total</th>
              <th class="num">Active</th>
              <th class="num">Training</th>
              <th class="num">Superseded</th>
              <th class="num">Failed</th>
              <th class="num">Activation %</th>
              <th class="num">Avg accuracy</th>
              <th class="num">Median accuracy</th>
              <th class="num">Best accuracy</th>
              <th class="num">Avg RMSE</th>
              <th class="num">Total samples</th>
              <th class="num">Latest trained</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.architecture) {
              <tr>
                <td class="mono">
                  <span class="arch-dot" [style.background]="row.color"></span>
                  {{ row.architecture }}
                </td>
                <td class="num mono">{{ row.count | number }}</td>
                <td class="num mono" [class.good]="row.active > 0">{{ row.active }}</td>
                <td class="num mono">{{ row.training }}</td>
                <td class="num mono muted">{{ row.superseded }}</td>
                <td class="num mono" [class.bad]="row.failed > 0">
                  {{ row.failed }}
                </td>
                <td class="num mono" [class.good]="row.activationRate >= 0.05">
                  {{ formatPct(row.activationRate) }}
                </td>
                <td
                  class="num mono"
                  [class.good]="row.accuracies.length > 0 && row.avgAccuracy >= 0.55"
                  [class.warn]="row.accuracies.length > 0 && row.avgAccuracy < 0.52"
                >
                  {{ row.accuracies.length > 0 ? formatPct(row.avgAccuracy) : '—' }}
                </td>
                <td class="num mono">
                  {{ row.accuracies.length > 0 ? formatPct(row.medianAccuracy) : '—' }}
                </td>
                <td class="num mono" [class.good]="row.accuracies.length > 0">
                  {{ row.accuracies.length > 0 ? formatPct(row.bestAccuracy) : '—' }}
                </td>
                <td class="num mono">
                  {{ row.avgRMSE > 0 ? row.avgRMSE.toFixed(3) : '—' }}
                </td>
                <td class="num mono muted">
                  {{ row.totalSamples | number }}
                </td>
                <td class="muted">
                  {{ row.latestTrainedAt ? (row.latestTrainedAt | date: 'MMM d, HH:mm') : '—' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class MlArchLeaderboardComponent {
  readonly rows = input.required<readonly ArchLeaderboardRow[]>();

  protected formatPct(v: number): string {
    if (!Number.isFinite(v)) return '—';
    return `${(v * 100).toFixed(1)}%`;
  }
}
