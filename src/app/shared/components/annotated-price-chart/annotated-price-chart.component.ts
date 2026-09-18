import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import { catchError, of } from 'rxjs';

import { MarketDataService } from '@core/services/market-data.service';
import { ThemeService } from '@core/theme/theme.service';
import { Timeframe } from '@core/api/api.types';

import {
  chartHeight,
  toPriceChartOption,
  windowFor,
  type PriceBar,
  type PriceChartSpec,
} from './price-annotations';

/**
 * Renders one analyst-authored `price_chart` turn: the engine-validated annotation layer drawn over
 * a candle window this component fetches itself.
 *
 * <p>The candles are deliberately NOT carried in the tool payload. They would be the largest thing
 * in the conversation, they would be re-sent into the prompt on every later turn, and they would be
 * a second copy of a series the market-data endpoint already serves — one that goes stale the
 * moment it is written. What the analyst sends is the argument; the bars stay live.</p>
 */
@Component({
  selector: 'app-annotated-price-chart',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, NgxEchartsDirective],
  template: `
    @if (spec(); as s) {
      <figure class="pc">
        <figcaption class="pc-head">
          <span class="pc-title">{{ s.title || s.symbol + ' · ' + s.timeframe }}</span>
          <span class="pc-sym">{{ s.symbol }} · {{ s.timeframe }}</span>
          @if (s.estimated) {
            <span class="pc-est" title="Part of this chart is inferred, not measured."
              >ESTIMATED</span
            >
          }
        </figcaption>

        @if (legend().length) {
          <!-- Identity is never colour-alone: every drawn layer is named here with its swatch. -->
          <div class="pc-legend">
            @for (item of legend(); track item.label) {
              <span class="pc-legend-item">
                <span class="pc-swatch" [style.background]="item.color"></span>{{ item.label }}
              </span>
            }
          </div>
        }

        @if (loading()) {
          <div class="pc-empty">Loading candles…</div>
        } @else if (options(); as opts) {
          <div
            echarts
            [options]="opts"
            [theme]="echartsTheme()"
            [autoResize]="true"
            class="pc-canvas"
            [style.height.px]="height()"
          ></div>
        } @else {
          <div class="pc-empty">No candles available for this window.</div>
        }

        @if (s.caption) {
          <p class="pc-caption">{{ s.caption }}</p>
        }
      </figure>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .pc {
        margin: 0;
        padding: 0.7rem 0.8rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 8px);
        background: var(--bg-primary);
      }
      .pc-head {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      .pc-title {
        font-size: 0.86rem;
        font-weight: 650;
        color: var(--text-primary);
      }
      .pc-sym {
        font-size: 0.72rem;
        color: var(--text-secondary);
        font-family: 'SF Mono', 'Fira Code', monospace;
      }
      .pc-est {
        margin-left: auto;
        font-size: 0.62rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        padding: 2px 6px;
        border-radius: 3px;
        color: var(--warning, #b45309);
        border: 1px solid currentColor;
        cursor: help;
      }
      .pc-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 0.9rem;
        margin: 0.4rem 0 0.1rem;
        padding-bottom: 0.45rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.72rem;
        color: var(--text-secondary);
      }
      .pc-legend-item {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
      }
      .pc-swatch {
        width: 9px;
        height: 9px;
        border-radius: 2px;
        display: inline-block;
      }
      .pc-canvas {
        width: 100%;
      }
      .pc-caption {
        margin: 0.45rem 0 0;
        font-size: 0.76rem;
        line-height: 1.45;
        color: var(--text-secondary);
      }
      .pc-empty {
        padding: 1.6rem;
        text-align: center;
        font-size: 0.78rem;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class AnnotatedPriceChartComponent {
  private readonly marketData = inject(MarketDataService);
  private readonly theme = inject(ThemeService);

  readonly spec = input.required<PriceChartSpec>();

  protected readonly bars = signal<PriceBar[]>([]);
  protected readonly loading = signal(false);

  protected readonly echartsTheme = computed(() =>
    this.theme.theme() === 'dark' ? 'dark' : 'default',
  );
  protected readonly height = computed(() => chartHeight(this.spec()));

  protected readonly options = computed(() =>
    toPriceChartOption(this.spec(), this.bars(), this.theme.theme() === 'dark' ? 'dark' : 'light'),
  );

  /**
   * One named row per drawn layer. A chart whose levels are distinguished only by hue is a chart
   * whose levels some readers cannot distinguish at all, and colour-coding by type was the point of
   * the levels in the first place.
   */
  protected readonly legend = computed(() => {
    const s = this.spec();
    const dark = this.theme.theme() === 'dark';
    const items: { label: string; color: string }[] = [];
    const seen = new Set<string>();
    const add = (label: string, color: string) => {
      if (seen.has(label)) return;
      seen.add(label);
      items.push({ label, color });
    };

    for (const l of s.levels ?? []) add(LEVEL_LABEL[l.kind] ?? l.kind, LEVEL_SWATCH(dark)[l.kind]);
    for (const z of s.zones ?? []) add(`${z.label} (zone)`, ZONE_SWATCH(dark)[z.kind]);
    if (s.vwap) add('VWAP ±1σ', dark ? '#3d9bff' : '#0071e3');
    if (s.volumeProfile) add('Volume profile / POC', dark ? '#9085e9' : '#4a3aa7');
    for (const seg of s.segments ?? [])
      add(`${seg.outcome ?? 'open'} trade`, OUTCOME_SWATCH(dark)[seg.outcome ?? 'open']);
    for (const setup of s.setups ?? [])
      add(`${setup.label}${setup.rr ? ` · ${setup.rr}R` : ''}`, dark ? '#3d9bff' : '#0071e3');
    return items;
  });

  private lastKey: string | null = null;

  constructor() {
    effect(() => {
      const s = this.spec();
      if (!s?.symbol) return;
      const key = JSON.stringify([
        s.symbol,
        s.timeframe,
        s.bars,
        s.asOfUtc ?? null,
        annotationTimes(s),
      ]);
      if (this.lastKey === key) return;
      this.lastKey = key;
      this.fetch(s);
    });
  }

  /**
   * Pull the window the annotations actually need.
   *
   * <p>`windowFor` widens the requested bar count backwards when the analyst references an instant
   * older than it — the FOMC bar two days behind a 60-bar H1 chart is precisely the kind of marker
   * that gets drawn, and clamping it to the left edge would put the event on the wrong bar while
   * still looking like a chart.</p>
   */
  private fetch(spec: PriceChartSpec): void {
    this.loading.set(true);
    const { itemCount, to } = windowFor(spec, Date.now());

    this.marketData
      .listCandles({
        currentPage: 1,
        itemCountPerPage: itemCount,
        filter: { symbol: spec.symbol, timeframe: spec.timeframe as unknown as Timeframe, to },
      })
      .pipe(catchError(() => of(null)))
      .subscribe((res) => {
        this.loading.set(false);
        const rows = res?.status && res.data ? (res.data.data ?? []) : [];
        this.bars.set(
          rows
            .slice()
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
            .map((r) => ({
              timestamp: r.timestamp,
              open: r.open,
              high: r.high,
              low: r.low,
              close: r.close,
            })),
        );
      });
  }
}

/** Every instant the spec references, so a change in the annotations re-fetches the window. */
function annotationTimes(s: PriceChartSpec): string[] {
  return [
    ...(s.markers ?? []).map((m) => m.time),
    ...(s.trendlines ?? []).flatMap((t) => [t.from.time, t.to.time]),
    ...(s.segments ?? []).flatMap((g) => [g.from.time, g.to.time]),
  ];
}

const LEVEL_LABEL: Record<string, string> = {
  structure: 'Structure',
  value: 'Value area',
  round: 'Round number',
  pool: 'Stop pool',
  pivot: 'Pivot',
  live: 'Live',
};

const LEVEL_SWATCH = (dark: boolean): Record<string, string> => ({
  structure: dark ? '#9a9a9f' : '#6e6e73',
  value: dark ? '#9085e9' : '#4a3aa7',
  round: dark ? '#6e6e73' : '#9a9a9f',
  pool: dark ? '#d98a2b' : '#b45309',
  pivot: dark ? '#d95926' : '#eb6834',
  live: dark ? '#3d9bff' : '#0071e3',
});

const ZONE_SWATCH = (dark: boolean): Record<string, string> => ({
  balance: dark ? '#3d9bff' : '#0071e3',
  value: dark ? '#9085e9' : '#4a3aa7',
  supply: dark ? '#e35a3c' : '#c4290a',
  demand: dark ? '#3fb562' : '#1f8a3d',
  pool: dark ? '#d98a2b' : '#b45309',
  neutral: dark ? '#9a9a9f' : '#6e6e73',
});

const OUTCOME_SWATCH = (dark: boolean): Record<string, string> => ({
  win: dark ? '#3fb562' : '#1f8a3d',
  loss: dark ? '#e35a3c' : '#c4290a',
  expired: dark ? '#d98a2b' : '#b45309',
  scratch: dark ? '#6e6e73' : '#9a9a9f',
  open: dark ? '#3d9bff' : '#0071e3',
});
