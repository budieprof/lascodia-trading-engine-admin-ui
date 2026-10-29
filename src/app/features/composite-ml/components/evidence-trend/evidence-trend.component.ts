import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { catchError, forkJoin, map, of, switchMap } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { CompositeMLService } from '@core/services/composite-ml.service';
import { createPolledResource } from '@core/polling/polled-resource';
import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { MetricCardComponent } from '@shared/components/metric-card/metric-card.component';

import { summariseTrends, toTrendSeries, type TrendSeries } from '../../drift-trend.logic';

/**
 * Every tracked cold-start gate's evidence over the last year, as a percentage of what it needs to
 * turn warm (100 % = warm), from the drift monitor's daily snapshots — `catalogue-drift/summary`
 * names the tracked entries, `catalogue-drift/history` gives each one's series. Shown above the
 * drift tables so the page carries its history, not just today's row.
 */
@Component({
  selector: 'app-composite-ml-evidence-trend',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, ChartCardComponent, MetricCardComponent],
  template: `
    @if (series(); as all) {
      @if (all.length) {
        <div class="kpis">
          <app-metric-card label="Gates tracked" [value]="sum().gates" dotColor="#0071E3" />
          <app-metric-card
            label="Warm now"
            [value]="sum().warm"
            [dotColor]="sum().warm > 0 ? '#34C759' : '#8E8E93'"
          />
          <app-metric-card
            label="Cold now"
            [value]="sum().cold"
            [dotColor]="sum().cold > 0 ? '#FF9500' : '#34C759'"
          />
          <app-metric-card
            [label]="
              sum().nearest ? 'Closest to warm: ' + sum().nearest!.layerKey : 'Closest to warm'
            "
            [value]="sum().nearest?.pct ?? null"
            [displayValue]="
              sum().nearest ? null : sum().cold > 0 ? 'none — cold gates at 0 %' : 'all warm'
            "
            format="percent"
            dotColor="#AF52DE"
          />
          <app-metric-card
            [label]="
              'Daily samples since ' +
              (sum().firstSampleUtc ? (sum().firstSampleUtc | date: 'd MMM y') : '—')
            "
            [value]="sum().samples"
            dotColor="#8E8E93"
          />
        </div>
        <app-chart-card
          title="Evidence over the last year"
          subtitle="Each gate's evidence as % of what it needs to turn warm (dashed line = warm). From the drift monitor's daily snapshots; capped at 200 %."
          [options]="chart()"
          height="300px"
        />
        @if (warmStreaks().length) {
          <p class="streaks">
            @for (s of warmStreaks(); track s.layerKey; let last = $last) {
              <strong>{{ s.layerKey }}</strong> warm since
              {{ s.warmSinceUtc | date: 'd MMM y' }} ({{ s.latestPct | number: '1.0-0' }} %){{
                last ? '.' : ' · '
              }}
            }
          </p>
        }
      }
    }
  `,
  styles: [
    `
      :host {
        display: grid;
        gap: var(--space-3);
      }
      .kpis {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
        gap: var(--space-3);
      }
      .streaks {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
    `,
  ],
})
export class CompositeMlEvidenceTrendComponent {
  private readonly compositeMl = inject(CompositeMLService);

  /** Gate to draw thicker (the one a history page is showing). */
  readonly highlight = input<string | null>(null);

  private readonly resource = createPolledResource(
    () =>
      this.compositeMl.getCatalogueDriftSummary().pipe(
        map((r) => r.data?.rows ?? []),
        switchMap((rows) =>
          rows.length === 0
            ? of([] as TrendSeries[])
            : forkJoin(
                rows.map((row) =>
                  this.compositeMl
                    .getCatalogueDriftHistory({
                      layerKey: row.layerKey,
                      symbol: row.symbol,
                      timeframe: row.timeframe,
                      lookbackDays: 365,
                    })
                    .pipe(
                      map((h) => (h.data ? toTrendSeries(h.data) : null)),
                      catchError(() => of(null)),
                    ),
                ),
              ).pipe(map((all) => all.filter((s): s is TrendSeries => s !== null))),
        ),
        catchError(() => of(null)),
      ),
    { intervalMs: 600_000 },
  );

  protected readonly series = computed(() => this.resource.value() ?? null);
  protected readonly sum = computed(() => summariseTrends(this.series() ?? []));
  protected readonly warmStreaks = computed(() =>
    (this.series() ?? []).filter((s) => s.warmSinceUtc !== null),
  );

  protected readonly chart = computed<EChartsOption>(() => {
    const hl = this.highlight();
    const all = this.series() ?? [];
    return {
      grid: { left: 48, right: 24, top: 56, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v) => `${v} %`,
      },
      legend: { type: 'scroll', top: 0, textStyle: { fontSize: 11 } },
      xAxis: { type: 'time', axisLabel: { fontSize: 10 }, splitLine: { show: false } },
      yAxis: {
        type: 'value',
        min: 0,
        max: 200,
        axisLabel: { fontSize: 10, formatter: '{value} %' },
        splitLine: { lineStyle: { type: 'dashed', opacity: 0.4 } },
      },
      series: all.map((s, i) => ({
        name: s.scope === 'global' ? s.layerKey : `${s.layerKey} (${s.scope})`,
        type: 'line' as const,
        showSymbol: false,
        lineStyle: { width: hl && hl === s.layerKey ? 3 : 1.5 },
        data: s.points.map((p) => [p.t, p.pct]),
        ...(i === 0
          ? {
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { type: 'dashed' as const, color: '#8e8e93' },
                label: { formatter: 'warm', fontSize: 10 },
                data: [{ yAxis: 100 }],
              },
            }
          : {}),
      })),
    };
  });
}
