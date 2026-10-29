import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { map } from 'rxjs';

import { CompositeMLService } from '@core/services/composite-ml.service';
import { unwrapResponse } from '@core/api/api.service';
import type { CompositeMLLayerHealthDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';
import { refetchOnChange } from '@core/polling/refetch-on-change';

import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';
import { CompositeMlNavComponent } from '../../components/composite-ml-nav/composite-ml-nav.component';
import { CompositeMlPipelineStateComponent } from '../../components/pipeline-state/pipeline-state.component';
import { LAYER_DESCRIPTIONS, nextWiderLookback } from '../../composite-ml-pipeline.logic';

type LookbackDays = 1 | 7 | 30 | 90;

/** A fetch result tagged with the window it covers, so a pill switch never shows the old window's rows. */
interface LayerHealthResult {
  lookback: LookbackDays;
  rows: CompositeMLLayerHealthDto[];
}

@Component({
  selector: 'app-layer-health-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DatePipe,
    DecimalPipe,
    FormsModule,
    PageHeaderComponent,
    CompositeMlNavComponent,
    CompositeMlPipelineStateComponent,
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
      />
      <app-composite-ml-nav
        [showRefresh]="true"
        [refreshing]="resource.refreshing()"
        (refresh)="resource.refresh()"
      />

      <div class="controls">
        <span class="control-label">Lookback</span>
        <div class="lookback-pills">
          @for (option of LOOKBACK_OPTIONS; track option) {
            <button
              type="button"
              [class.active]="lookback() === option"
              (click)="pickLookback(option)"
            >
              {{ option }}d
            </button>
          }
        </div>
        @if (widenedFrom(); as from) {
          <span class="widened" role="status">
            No layer state in the last {{ from }} days — widened to {{ lookback() }} days to show
            the most recent cycles.
          </span>
        }
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
          @if (lookback() < 90) {
            <app-empty-state
              title="No layer state in this window"
              [description]="
                'No generator cycle recorded layer state in the last ' +
                lookback() +
                ' days. Pick a wider window; the pipeline card below says when the last cycle ran.'
              "
            />
          }
          <app-composite-ml-pipeline-state
            variant="full"
            [focus]="['layerStates']"
            pageSummary="Every CompositeML generator cycle records which of its 15 scoring layers were switched on. This tab rolls those records up per layer, so a layer that was turned off, or whose settings kept changing, stands out. Rows older than the engine's 90-day window are not shown."
          />
        } @else {
          <app-composite-ml-pipeline-state variant="compact" [focus]="['layerStates']" />
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
                    <td>
                      <span class="mono">{{ layer.layerName }}</span>
                      @if (describe(layer.layerName); as d) {
                        <span class="layer-desc">{{ d }}</span>
                      }
                    </td>
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
      /* Pill/text tones. The light-theme hexes these replace (#0040dd blue at
         ~2.2:1, #c93400 amber, #d70015 red ~3:1) were used on the dark theme
         too, where they were barely readable; dark gets the system tints. */
      :host {
        --tone-green: #248a3d;
        --tone-amber: #c93400;
        --tone-red: #d70015;
        --tone-blue: #0040dd;
        --tone-grey: #636366;
        --tone-purple: #8e44ad;
      }
      :host-context([data-theme='dark']) {
        --tone-green: #30d158;
        --tone-amber: #ff9f0a;
        --tone-red: #ff6961;
        --tone-blue: #64d2ff;
        --tone-grey: #a1a1a6;
        --tone-purple: #bf5af2;
      }
      .page {
        padding: var(--space-2) 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
      }
      .controls {
        display: flex;
        flex-wrap: wrap;
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
        overflow-x: auto;
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
        color: var(--tone-amber);
      }
      .layers-table td.bad {
        color: var(--tone-red);
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
        white-space: nowrap;
        padding: 2px 8px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        border-radius: var(--radius-full);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .status-pill[data-status='on'] {
        background: rgba(52, 199, 89, 0.12);
        color: var(--tone-green);
      }
      .status-pill[data-status='partial'] {
        background: rgba(255, 149, 0, 0.12);
        color: var(--tone-amber);
      }
      .status-pill[data-status='off'] {
        background: rgba(255, 59, 48, 0.12);
        color: var(--tone-red);
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
      .layer-desc {
        display: block;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
        margin-top: 2px;
      }
      .widened {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        padding: 4px 10px;
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
        border: 1px solid var(--border);
      }
    `,
  ],
})
export class LayerHealthPageComponent {
  private readonly compositeMl = inject(CompositeMLService);

  protected readonly LOOKBACK_OPTIONS: readonly LookbackDays[] = [1, 7, 30, 90] as const;

  protected readonly lookback = signal<LookbackDays>(7);
  /** Set when the page widened the window by itself because the opening one was empty. */
  protected readonly widenedFrom = signal<LookbackDays | null>(null);
  /** Once the operator picks a window, the page never widens it again. */
  private userPicked = false;

  protected readonly resource = createPolledResource<LayerHealthResult>(
    () => {
      const lookback = this.lookback();
      // Errors propagate to resource.error() — they used to become [] and read
      // as "no layer state in this window".
      return this.compositeMl.getLayerHealth(lookback).pipe(
        map(unwrapResponse),
        map((rows) => ({ lookback, rows })),
      );
    },
    // Health rolls forward continuously, so a model activation/retirement push
    // is what makes this move; the interval only heals a missed push.
    {
      // Push-driven: the interval is only a fallback for a missed
      // push or a reconnect gap.
      intervalMs: 120_000,
      refreshOn: ['compositeMLCatalogueDriftDropAlert', 'mlModelActivated', 'mlModelRetired'],
    },
  );

  constructor() {
    // Refetch when the lookback pill changes (not on start-up: the resource's
    // own first fetch covers that).
    refetchOnChange(
      () => this.lookback(),
      () => this.resource.refresh(),
    );
    // The default window is empty while the generator is off: step to the next wider window
    // (7 → 30 → 90 days, the engine's limit) until rows appear, and say so on screen.
    effect(() => {
      const cur = this.current();
      if (!cur || cur.rows.length > 0 || this.userPicked) return;
      const next = nextWiderLookback(cur.lookback, this.LOOKBACK_OPTIONS) as LookbackDays | null;
      if (next === null) return;
      untracked(() => {
        if (this.widenedFrom() === null) this.widenedFrom.set(cur.lookback);
        this.lookback.set(next);
      });
    });
  }

  protected pickLookback(option: LookbackDays): void {
    this.userPicked = true;
    this.widenedFrom.set(null);
    this.lookback.set(option);
  }

  protected describe(layer: string): string | null {
    return LAYER_DESCRIPTIONS[layer] ?? null;
  }

  /** The loaded result, or null while the picked window has not arrived yet. */
  private readonly current = computed(() => {
    const v = this.resource.value();
    return v && v.lookback === this.lookback() ? v : null;
  });
  protected readonly layers = computed(() => this.current()?.rows ?? []);
  /** First paint, or a lookback switch still in flight — never the previous window's numbers. */
  protected readonly loading = computed(
    () =>
      this.resource.loading() ||
      (this.current() === null && this.resource.value() !== null && !this.resource.error()),
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
