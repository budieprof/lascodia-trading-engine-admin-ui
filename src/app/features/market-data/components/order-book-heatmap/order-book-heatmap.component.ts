import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { catchError, finalize, map, of } from 'rxjs';
import type { EChartsOption } from 'echarts';

import { MarketDataService } from '@core/services/market-data.service';
import type { OrderBookLevels, OrderBookSnapshotDto } from '@core/api/api.types';

import { ChartCardComponent } from '@shared/components/chart-card/chart-card.component';
import { CardSkeletonComponent } from '@shared/components/feedback/card-skeleton.component';
import { ErrorStateComponent } from '@shared/components/feedback/error-state.component';
import { EmptyStateComponent } from '@shared/components/feedback/empty-state.component';

interface HeatCell {
  /** Column index — newest snapshot at column 0, older to the right. */
  col: number;
  /** Row index — highest price bin at row 0, lowest at the bottom. */
  row: number;
  /** Volume resting at this (time, price) cell. */
  volume: number;
  /** Side coding for the colour map: -1 = bid, +1 = ask. */
  side: -1 | 1;
}

interface HeatGrid {
  timestamps: string[];
  priceBins: number[];
  cells: HeatCell[];
  /** Price-bin step in price-units (e.g. 0.00001 = 1 pip on EURUSD). */
  step: number;
  maxVolume: number;
}

/**
 * Time × price liquidity heatmap (PRD §5.5 FR-5.6). Fetches the recent depth
 * snapshots via /market-data/order-book/recent, bins each snapshot's levels
 * onto a shared price ladder (auto-derived from observed step granularity),
 * and renders an echarts heatmap — bids in green, asks in red, intensity
 * driven by volume. Older snapshots scroll off the right; newest on the left.
 */
@Component({
  selector: 'app-order-book-heatmap',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartCardComponent, CardSkeletonComponent, ErrorStateComponent, EmptyStateComponent],
  template: `
    <section class="heatmap-wrap">
      @if (loading()) {
        <app-card-skeleton [lines]="6" />
      } @else if (error()) {
        <app-error-state
          title="Could not load DOB history"
          message="Engine returned an error fetching recent order-book snapshots."
          (retry)="load()"
        />
      } @else if (!grid()) {
        <app-empty-state
          title="No recent depth snapshots"
          description="No depth snapshots returned for this symbol. The EA may not be streaming DOB or the broker only exposes top-of-book."
        />
      } @else {
        <app-chart-card
          title="Liquidity heatmap — time × price"
          [subtitle]="
            grid()!.timestamps.length +
            ' snapshots · ' +
            grid()!.priceBins.length +
            ' price bins · bids green, asks red'
          "
          [options]="chartOptions()"
          height="380px"
        />
      }
    </section>
  `,
  styles: [
    `
      .heatmap-wrap {
        display: block;
      }
    `,
  ],
})
export class OrderBookHeatmapComponent {
  private readonly marketData = inject(MarketDataService);

  readonly symbol = input.required<string>();
  /** Number of snapshots to pull. Engine caps at 500; UI default 60. */
  readonly limit = input<number>(60);

  protected readonly loading = signal(false);
  protected readonly error = signal(false);
  protected readonly snapshots = signal<OrderBookSnapshotDto[]>([]);

  constructor() {
    effect(() => {
      const s = this.symbol();
      if (s) this.load();
    });
  }

  protected load(): void {
    const sym = this.symbol();
    if (!sym) return;
    this.loading.set(true);
    this.error.set(false);
    this.marketData
      .getRecentOrderBooks(sym, this.limit())
      .pipe(
        map((res) => (res.status ? (res.data ?? []) : null)),
        catchError(() => of(null)),
        finalize(() => this.loading.set(false)),
      )
      .subscribe((rows) => {
        if (rows === null) this.error.set(true);
        else this.snapshots.set(rows);
      });
  }

  protected readonly grid = computed<HeatGrid | null>(() => {
    const arr = this.snapshots();
    if (arr.length === 0) return null;
    return buildHeatGrid(arr);
  });

  protected readonly chartOptions = computed<EChartsOption>(() => {
    const g = this.grid();
    if (!g) return {};
    // Side-coloured heatmap: pieces split into bid (negative) and ask
    // (positive) ranges so bids and asks share the colour scale magnitude.
    const seriesData = g.cells.map((c) => [c.col, c.row, c.volume * c.side]);
    return {
      grid: { left: 80, right: 40, top: 32, bottom: 60 },
      tooltip: {
        position: 'top',
        formatter: (p: unknown) => {
          // echarts callback signature is ambiguous to ts; cast loosely.
          const params = p as { data: [number, number, number] };
          const [col, row, signedVol] = params.data;
          const ts = g.timestamps[col];
          const price = g.priceBins[row];
          const vol = Math.abs(signedVol);
          const side = signedVol < 0 ? 'BID' : 'ASK';
          return `<strong>${side}</strong> @ ${price.toFixed(5)}<br/>${vol.toFixed(2)} @ ${new Date(ts).toLocaleTimeString()}`;
        },
      },
      xAxis: {
        type: 'category',
        data: g.timestamps.map((t) => new Date(t).toLocaleTimeString()),
        splitArea: { show: true },
        axisLabel: { fontSize: 9, rotate: 45 },
        name: 'Capture (newest left)',
        nameLocation: 'middle',
        nameGap: 42,
      },
      yAxis: {
        type: 'category',
        data: g.priceBins.map((p) => p.toFixed(5)),
        splitArea: { show: true },
        axisLabel: { fontSize: 10 },
        name: 'Price',
        nameLocation: 'middle',
        nameGap: 60,
      },
      visualMap: {
        type: 'continuous',
        min: -g.maxVolume,
        max: g.maxVolume,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        textStyle: { fontSize: 10 },
        inRange: {
          // Diverging palette: deep red for ask-heavy, deep green for bid-heavy,
          // neutral grey near zero (no volume / sparse cell).
          color: ['#248a3d', '#7bc97e', '#cce7d2', '#f0f0f0', '#f7c2bf', '#e57975', '#d70015'],
        },
      },
      series: [
        {
          name: 'Liquidity',
          type: 'heatmap',
          data: seriesData,
          emphasis: { itemStyle: { borderColor: '#0071e3', borderWidth: 2 } },
          progressive: 1000,
        },
      ],
    };
  });
}

// ── Pure aggregation, exposed for future unit tests ─────────────────────

export function buildHeatGrid(snapshots: OrderBookSnapshotDto[]): HeatGrid | null {
  if (snapshots.length === 0) return null;
  // Sort by captured-at descending so newest is column 0.
  const sorted = [...snapshots].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));

  // First pass: parse each snapshot's depth and collect every price observed.
  type Parsed = {
    snapshot: OrderBookSnapshotDto;
    bids: { price: number; volume: number }[];
    asks: { price: number; volume: number }[];
  };
  const parsed: Parsed[] = [];
  const priceSet = new Set<number>();
  for (const snap of sorted) {
    const levels = parseLevels(snap.levelsJson);
    if (!levels) {
      // Top-of-book fallback: synthesize a single bid and ask from the
      // scalar fields so the snapshot still shows up on the heatmap.
      const bids = snap.bidVolume > 0 ? [{ price: snap.bidPrice, volume: snap.bidVolume }] : [];
      const asks = snap.askVolume > 0 ? [{ price: snap.askPrice, volume: snap.askVolume }] : [];
      parsed.push({ snapshot: snap, bids, asks });
      bids.forEach((l) => priceSet.add(l.price));
      asks.forEach((l) => priceSet.add(l.price));
      continue;
    }
    const bids = levels.bids.map((l) => ({ price: l.P, volume: l.V }));
    const asks = levels.asks.map((l) => ({ price: l.P, volume: l.V }));
    parsed.push({ snapshot: snap, bids, asks });
    bids.forEach((l) => priceSet.add(l.price));
    asks.forEach((l) => priceSet.add(l.price));
  }

  if (priceSet.size === 0) return null;

  // Build price ladder, highest first (chart Y-axis goes top→bottom by default).
  const priceBins = [...priceSet].sort((a, b) => b - a);
  // Derive step from observed gaps (median to avoid outliers); fallback 0.00001.
  const gaps: number[] = [];
  for (let i = 1; i < priceBins.length; i++) gaps.push(priceBins[i - 1] - priceBins[i]);
  const step = median(gaps) || 0.00001;

  // Price → row index map (priceBins is already sorted desc).
  const priceToRow = new Map<number, number>();
  priceBins.forEach((p, i) => priceToRow.set(p, i));

  // Second pass: emit cells with sign per side.
  const cells: HeatCell[] = [];
  let maxVolume = 0;
  parsed.forEach((p, col) => {
    for (const lvl of p.bids) {
      const row = priceToRow.get(lvl.price);
      if (row === undefined) continue;
      cells.push({ col, row, volume: lvl.volume, side: -1 });
      if (lvl.volume > maxVolume) maxVolume = lvl.volume;
    }
    for (const lvl of p.asks) {
      const row = priceToRow.get(lvl.price);
      if (row === undefined) continue;
      cells.push({ col, row, volume: lvl.volume, side: 1 });
      if (lvl.volume > maxVolume) maxVolume = lvl.volume;
    }
  });

  return {
    timestamps: sorted.map((s) => s.capturedAt),
    priceBins,
    cells,
    step,
    maxVolume,
  };
}

function parseLevels(json: string | null): OrderBookLevels | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as OrderBookLevels;
    if (!parsed || !Array.isArray(parsed.bids) || !Array.isArray(parsed.asks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
