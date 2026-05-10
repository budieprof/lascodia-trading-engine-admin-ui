import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import type { CompositeMLLayerHealthDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

type LookbackDays = 1 | 7 | 30;

@Component({
  selector: 'app-layer-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    RouterLink,
    PageHeaderComponent,
    MetricCardComponent,
    CardSkeletonComponent,
    EmptyStateComponent,
    ErrorStateComponent,
    RelativeTimePipe,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="CompositeML — Layer Health"
        subtitle="Per-layer enabled fraction, cycle count, and config-hash churn"
      >
        <a routerLink="/composite-ml" class="btn btn-secondary">← Active Policies</a>
        <button
          type="button"
          class="btn btn-secondary"
          (click)="resource.refresh()"
          [disabled]="resource.loading()"
        >
          Refresh
        </button>
      </app-page-header>

      <div class="controls">
        <span class="control-label">Lookback</span>
        <div class="lookback-pills">
          @for (option of LOOKBACK_OPTIONS; track option) {
            <button
              type="button"
              [class.active]="lookback() === option"
              (click)="lookback.set(option)"
            >
              {{ option }}d
            </button>
          }
        </div>
      </div>

      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (resource.error()) {
        <app-error-state
          title="Could not load layer health"
          message="Engine returned an error. Layer-state recording may be paused — check System Health."
          (retry)="resource.refresh()"
        />
      } @else {
        <div class="kpis">
          <app-metric-card
            label="Total layers"
            [value]="layers().length"
            format="number"
            dotColor="#0071E3"
          />
          <app-metric-card
            label="Fully on"
            [value]="fullyOnCount()"
            format="number"
            dotColor="#34C759"
          />
          <app-metric-card
            label="Toggled mid-window"
            [value]="toggledCount()"
            format="number"
            [dotColor]="toggledCount() > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            label="Fully off"
            [value]="fullyOffCount()"
            format="number"
            [dotColor]="fullyOffCount() > 0 ? '#FF3B30' : '#34C759'"
          />
          <app-metric-card
            label="Config churn"
            [value]="churnCount()"
            format="number"
            [dotColor]="churnCount() > 0 ? '#AF52DE' : '#34C759'"
          />
        </div>

        @if (layers().length === 0) {
          <app-empty-state
            title="No layer state in this window"
            description="No cycles have recorded layer state in the selected lookback. Try a larger window, or check that the CompositeML generator is running."
          />
        } @else {
          <section class="card">
            <table class="layers-table">
              <thead>
                <tr>
                  <th>Layer</th>
                  <th>Status</th>
                  <th class="num">Enabled</th>
                  <th class="num">Cycles</th>
                  <th class="num">Config hashes</th>
                  <th>Last enabled</th>
                  <th>Last disabled</th>
                </tr>
              </thead>
              <tbody>
                @for (layer of sortedLayers(); track layer.layerName) {
                  <tr>
                    <td class="mono">{{ layer.layerName }}</td>
                    <td>
                      <span class="status-pill" [attr.data-status]="statusOf(layer)">
                        {{ statusLabel(layer) }}
                      </span>
                    </td>
                    <td class="num">
                      <div class="bar-cell">
                        <span class="bar-track">
                          <span
                            class="bar-fill"
                            [style.width.%]="layer.enabledFraction * 100"
                            [attr.data-status]="statusOf(layer)"
                          ></span>
                        </span>
                        <span class="bar-value">
                          {{ layer.enabledFraction * 100 | number: '1.0-1' }}%
                        </span>
                      </div>
                    </td>
                    <td class="num">{{ layer.cycleCount | number: '1.0-0' }}</td>
                    <td
                      class="num"
                      [class.warn]="layer.distinctConfigHashes > 1"
                      [class.bad]="layer.distinctConfigHashes > 3"
                    >
                      {{ layer.distinctConfigHashes }}
                    </td>
                    <td class="time">
                      @if (layer.lastEnabledAtUtc) {
                        <span [title]="layer.lastEnabledAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                          {{ layer.lastEnabledAtUtc | relativeTime }}
                        </span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="time">
                      @if (layer.lastDisabledAtUtc) {
                        <span [title]="layer.lastDisabledAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                          {{ layer.lastDisabledAtUtc | relativeTime }}
                        </span>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
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
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .controls {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
      .control-label {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        font-weight: var(--font-medium);
      }
      .lookback-pills {
        display: inline-flex;
        gap: 4px;
        background: var(--bg-secondary);
        padding: 4px;
        border-radius: var(--radius-md);
      }
      .lookback-pills button {
        background: transparent;
        border: none;
        padding: 6px 14px;
        border-radius: var(--radius-sm);
        font-size: var(--text-sm);
        color: var(--text-secondary);
        cursor: pointer;
        font-weight: var(--font-medium);
      }
      .lookback-pills button.active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: var(--space-3);
      }
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
      }
      .layers-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .layers-table th,
      .layers-table td {
        padding: 10px 12px;
        text-align: left;
        border-bottom: 1px solid var(--border);
        vertical-align: middle;
      }
      .layers-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .layers-table td.num,
      .layers-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .layers-table td.warn {
        color: #c93400;
      }
      .layers-table td.bad {
        color: #d70015;
        font-weight: var(--font-semibold);
      }
      .mono {
        font-family: var(--font-mono);
      }
      .muted {
        color: var(--text-tertiary);
      }
      .status-pill {
        display: inline-block;
        padding: 2px 8px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        border-radius: var(--radius-full);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .status-pill[data-status='on'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .status-pill[data-status='partial'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .status-pill[data-status='off'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .bar-cell {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 160px;
        justify-content: flex-end;
      }
      .bar-track {
        flex: 1;
        height: 8px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        overflow: hidden;
        max-width: 120px;
      }
      .bar-fill {
        display: block;
        height: 100%;
        border-radius: var(--radius-full);
        transition: width 0.3s ease;
      }
      .bar-fill[data-status='on'] {
        background: #34c759;
      }
      .bar-fill[data-status='partial'] {
        background: #ff9500;
      }
      .bar-fill[data-status='off'] {
        background: #ff3b30;
      }
      .bar-value {
        font-variant-numeric: tabular-nums;
        font-size: var(--text-xs);
        min-width: 48px;
        text-align: right;
        color: var(--text-secondary);
      }
      .time {
        color: var(--text-secondary);
        font-size: var(--text-xs);
      }
    `,
  ],
})
export class LayerHealthPageComponent {
  private readonly compositeMl = inject(CompositeMLService);

  protected readonly LOOKBACK_OPTIONS: readonly LookbackDays[] = [1, 7, 30] as const;

  protected readonly lookback = signal<LookbackDays>(7);

  protected readonly resource = createPolledResource(
    () =>
      this.compositeMl.getLayerHealth(this.lookback()).pipe(
        map((res) => res.data ?? []),
        catchError(() => of([] as CompositeMLLayerHealthDto[])),
      ),
    // 30s — health rolls forward continuously; matches Worker Health cadence.
    { intervalMs: 30_000 },
  );

  constructor() {
    // Force a refresh whenever the lookback selector changes so the
    // displayed window matches what the user picked. createPolledResource
    // doesn't re-fetch on dependency change by default.
    effect(() => {
      this.lookback();
      this.resource.refresh();
    });
  }

  protected readonly layers = computed(() => this.resource.value() ?? []);
  protected readonly loading = computed(
    () => this.resource.loading() && this.layers().length === 0,
  );

  protected readonly sortedLayers = computed(() =>
    [...this.layers()].sort((a, b) => a.enabledFraction - b.enabledFraction),
  );

  protected readonly fullyOnCount = computed(
    () => this.layers().filter((l) => l.enabledFraction >= 0.999).length,
  );
  protected readonly fullyOffCount = computed(
    () => this.layers().filter((l) => l.enabledFraction <= 0.001).length,
  );
  protected readonly toggledCount = computed(
    () =>
      this.layers().filter((l) => l.enabledFraction > 0.001 && l.enabledFraction < 0.999).length,
  );
  protected readonly churnCount = computed(
    () => this.layers().filter((l) => l.distinctConfigHashes > 1).length,
  );

  protected statusOf(layer: CompositeMLLayerHealthDto): 'on' | 'partial' | 'off' {
    if (layer.enabledFraction >= 0.999) return 'on';
    if (layer.enabledFraction <= 0.001) return 'off';
    return 'partial';
  }

  protected statusLabel(layer: CompositeMLLayerHealthDto): string {
    const status = this.statusOf(layer);
    if (status === 'on') return 'Always on';
    if (status === 'off') return 'Always off';
    return 'Toggled';
  }
}
