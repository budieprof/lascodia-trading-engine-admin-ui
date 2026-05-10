import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, map, of } from 'rxjs';

import { MLModelsService } from '@core/services/ml-models.service';
import type { V6OrderBookFeatureUtilizationDto } from '@core/api/api.types';
import { createPolledResource } from '@core/polling/polled-resource';

import { RelativeTimePipe } from '@shared/pipes/relative-time.pipe';

/**
 * V6 OrderBook feature-utilization card (PRD §5.2 FR-2.6). Diagnoses
 * whether feature slots 52–56 (DOM-based microstructure features) are
 * actually being used by trained ML models — the "should we invest more
 * in microstructure infrastructure before adding new V6+ features"
 * decision support card. Embeddable on any ML-related page; currently
 * dropped on the Overfit Watchlist as part of the ML-health diagnostics
 * cluster.
 */
@Component({
  selector: 'app-v6-orderbook-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, RelativeTimePipe],
  template: `
    @if (data(); as d) {
      <section class="card" [attr.data-verdict]="d.verdict">
        <header>
          <div class="head-row">
            <h3>V6 OrderBook Feature Utilization</h3>
            <span class="verdict-pill" [attr.data-verdict]="d.verdict">{{
              verdictLabel(d.verdict)
            }}</span>
          </div>
          <p class="verdict-reason">{{ d.verdictReason }}</p>
          <p class="meta">
            Examined <strong>{{ d.modelsExamined }}</strong> models ·
            <strong>{{ d.modelsWithV6Schema }}</strong> with V6 schema ·
            <strong>{{ d.modelsWithUsableImportance }}</strong> usable importance · threshold
            <strong>{{ d.importanceThreshold | number: '1.0-2' }}</strong>
            @if (d.computedAtUtc) {
              ·
              <span [title]="d.computedAtUtc | date: 'yyyy-MM-dd HH:mm:ss UTC'">
                {{ d.computedAtUtc | relativeTime }}
              </span>
            }
          </p>
        </header>

        @if (d.slotStats.length > 0) {
          <table class="slots-table">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Feature</th>
                <th class="num">Above threshold</th>
                <th class="num">Mean</th>
                <th class="num">Max</th>
                <th class="num">Frac</th>
              </tr>
            </thead>
            <tbody>
              @for (slot of d.slotStats; track slot.slotIndex) {
                <tr>
                  <td class="mono">{{ slot.slotIndex }}</td>
                  <td class="mono small">{{ slot.semanticName }}</td>
                  <td class="num mono">
                    {{ slot.modelsAboveThreshold }} / {{ slot.modelsWithFeature }}
                  </td>
                  <td class="num mono">{{ slot.meanImportance | number: '1.0-3' }}</td>
                  <td class="num mono">{{ slot.maxImportance | number: '1.0-3' }}</td>
                  <td class="num">
                    <span
                      class="bar-track"
                      [title]="(slot.fractionAboveThreshold * 100 | number: '1.0-1') + '%'"
                    >
                      <span
                        class="bar-fill"
                        [style.width.%]="slot.fractionAboveThreshold * 100"
                        [attr.data-tier]="fractionTier(slot.fractionAboveThreshold)"
                      ></span>
                    </span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </section>
    }
  `,
  styles: [
    `
      .card {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--card-padding);
        box-shadow: var(--shadow-sm);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      header {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .head-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      h3 {
        margin: 0;
        font-size: var(--text-base);
        font-weight: var(--font-semibold);
      }
      .verdict-pill {
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        padding: 4px 10px;
        border-radius: var(--radius-full);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .verdict-pill[data-verdict='ImportancesHigh'] {
        background: rgba(52, 199, 89, 0.12);
        color: #248a3d;
      }
      .verdict-pill[data-verdict='ImportancesMixed'] {
        background: rgba(255, 149, 0, 0.12);
        color: #c93400;
      }
      .verdict-pill[data-verdict='ImportancesLow'] {
        background: rgba(255, 59, 48, 0.12);
        color: #d70015;
      }
      .verdict-pill[data-verdict='InsufficientData'] {
        background: rgba(142, 142, 147, 0.16);
        color: #636366;
      }
      .verdict-reason {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--text-primary);
      }
      .meta {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .meta strong {
        color: var(--text-primary);
        font-variant-numeric: tabular-nums;
      }
      .slots-table {
        width: 100%;
        border-collapse: collapse;
        font-size: var(--text-sm);
      }
      .slots-table th,
      .slots-table td {
        padding: 6px 10px;
        text-align: left;
        border-bottom: 1px solid var(--border);
      }
      .slots-table th {
        color: var(--text-secondary);
        font-weight: var(--font-medium);
        font-size: var(--text-xs);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .slots-table td.num,
      .slots-table th.num {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: var(--font-mono);
      }
      .small {
        font-size: var(--text-xs);
      }
      .bar-track {
        display: inline-block;
        width: 80px;
        height: 8px;
        background: var(--bg-primary);
        border-radius: var(--radius-full);
        overflow: hidden;
        vertical-align: middle;
      }
      .bar-fill {
        display: block;
        height: 100%;
        border-radius: var(--radius-full);
      }
      .bar-fill[data-tier='high'] {
        background: #34c759;
      }
      .bar-fill[data-tier='mid'] {
        background: #ff9500;
      }
      .bar-fill[data-tier='low'] {
        background: #ff3b30;
      }
    `,
  ],
})
export class V6OrderBookCardComponent {
  private readonly ml = inject(MLModelsService);

  protected readonly resource = createPolledResource(
    () =>
      this.ml.getV6OrderBookFeatureUtilization().pipe(
        map((res) => (res.status ? (res.data ?? null) : null)),
        catchError(() => of<V6OrderBookFeatureUtilizationDto | null>(null)),
      ),
    // 5 minutes — verdict barely moves cycle-to-cycle; this is a passive audit.
    { intervalMs: 300_000 },
  );

  protected readonly data = computed(() => this.resource.value());

  protected verdictLabel(v: string): string {
    switch (v) {
      case 'ImportancesHigh':
        return 'High';
      case 'ImportancesMixed':
        return 'Mixed';
      case 'ImportancesLow':
        return 'Low';
      case 'InsufficientData':
        return 'Insufficient data';
      default:
        return v;
    }
  }

  protected fractionTier(f: number): 'high' | 'mid' | 'low' {
    if (f >= 0.6) return 'high';
    if (f >= 0.2) return 'mid';
    return 'low';
  }
}
