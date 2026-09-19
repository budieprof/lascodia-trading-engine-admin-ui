import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { CurrencyPairsService } from '@core/services/currency-pairs.service';
import { RealtimeService } from '@core/realtime/realtime.service';
import type { CurrencyPairDto } from '@core/api/api.types';
import { CandleFeedService, type Bar } from '../../datafeed/candle-feed.service';
import { SUPPORTED_RESOLUTIONS, resolutionMs, type TvResolution } from '../../datafeed/resolution';
import { priceScaleFor } from '../../datafeed/symbol-info';
import {
  INDICATORS,
  defaultParams,
  indicatorById,
  indicatorLabel,
} from '../../indicators/registry';
import {
  ChartHostComponent,
  type ActiveIndicator,
  type ChartStyle,
  type LegendSnapshot,
} from '../../chart/chart-host.component';

/** Labels for the timeframe bar, in TradingView's shorthand. */
const RESOLUTION_LABELS: Record<TvResolution, string> = {
  '1': '1m',
  '5': '5m',
  '15': '15m',
  '30': '30m',
  '60': '1h',
  '240': '4h',
  '1D': '1D',
  '1W': '1W',
  '1M': '1M',
};

const CHART_STYLES: Array<{ id: ChartStyle; label: string }> = [
  { id: 'candles', label: 'Candles' },
  { id: 'hollow', label: 'Hollow candles' },
  { id: 'heikin-ashi', label: 'Heikin Ashi' },
  { id: 'bars', label: 'Bars' },
  { id: 'line', label: 'Line' },
  { id: 'area', label: 'Area' },
  { id: 'baseline', label: 'Baseline' },
];

/** How many bars to pull per request / per scroll-back page. */
const PAGE_BARS = 1500;

@Component({
  selector: 'app-chart-analysis-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DecimalPipe, ChartHostComponent],
  templateUrl: './chart-analysis-page.component.html',
  styleUrl: './chart-analysis-page.component.scss',
})
export class ChartAnalysisPageComponent {
  private readonly pairs = inject(CurrencyPairsService);
  private readonly feed = inject(CandleFeedService);
  private readonly realtime = inject(RealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  private readonly host = viewChild<ChartHostComponent>('host');

  readonly resolutions = SUPPORTED_RESOLUTIONS;
  readonly resolutionLabel = (r: TvResolution) => RESOLUTION_LABELS[r] ?? r;
  readonly chartStyles = CHART_STYLES;
  readonly catalogue = INDICATORS;

  readonly symbols = signal<CurrencyPairDto[]>([]);
  readonly symbol = signal<string>('EURUSD');
  readonly resolution = signal<TvResolution>('60');
  readonly style = signal<ChartStyle>('candles');
  readonly showVolume = signal(true);
  readonly bars = signal<Bar[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly active = signal<ActiveIndicator[]>([]);
  readonly legend = signal<LegendSnapshot | null>(null);
  readonly indicatorMenuOpen = signal(false);
  readonly symbolMenuOpen = signal(false);
  readonly symbolQuery = signal('');

  readonly precision = computed(() => {
    const pair = this.symbols().find((p) => p.symbol === this.symbol());
    return pair ? Math.trunc(pair.decimalPlaces) || 5 : 5;
  });

  readonly priceScale = computed(() => priceScaleFor(this.precision()));

  readonly filteredSymbols = computed(() => {
    const q = this.symbolQuery().trim().toUpperCase();
    const all = this.symbols();
    return q ? all.filter((p) => (p.symbol ?? '').toUpperCase().includes(q)) : all;
  });

  /** Legend colour follows the bar's direction, as on TradingView. */
  readonly legendUp = computed(() => {
    const l = this.legend();
    return l?.close != null && l?.open != null ? l.close >= l.open : true;
  });

  constructor() {
    this.loadSymbols();

    // Deep link: /chart-analysis/EURUSD?tf=60 so a chart can be linked to from
    // a position or a signal without the operator re-selecting anything.
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const s = params.get('symbol');
      if (s) this.symbol.set(s.toUpperCase());
      const tf = this.route.snapshot.queryParamMap.get('tf') as TvResolution | null;
      if (tf && (SUPPORTED_RESOLUTIONS as readonly string[]).includes(tf)) this.resolution.set(tf);
      void this.reload();
    });

    // Live price → update the forming bar. The engine throttles these, so this
    // is a repaint of the last candle rather than a tick stream.
    this.realtime
      .on<{ symbol?: string; bid?: number; ask?: number; price?: number }>('priceUpdated')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tick) => this.applyTick(tick));
  }

  private loadSymbols(): void {
    this.pairs
      .list({ currentPage: 1, itemCountPerPage: 200, filter: {} })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.status || !res.data) return;
        const rows = (res.data.data ?? []).filter((p) => p.isActive && p.symbol);
        this.symbols.set(rows);
      });
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.feed.invalidate(this.symbol(), this.resolution());
    const now = Date.now();
    try {
      const { bars } = await this.feed.getBars(this.symbol(), this.resolution(), 0, now, PAGE_BARS);
      this.bars.set(bars);
      if (bars.length === 0) {
        this.error.set(
          `No ${this.resolutionLabel(this.resolution())} candles stored for ${this.symbol()}.`,
        );
      }
    } catch {
      this.error.set('Could not load candles.');
    } finally {
      this.loading.set(false);
      this.host()?.historyLoaded();
    }
  }

  /**
   * Scroll-back paging: fetch the window ENDING at the oldest bar we hold and
   * prepend it. Asking by `to` rather than by `from` matches how the engine
   * pages (newest-first from a cutoff), so each page is a clean extension
   * backwards with no gap and no overlap to reconcile.
   */
  async loadOlder(): Promise<void> {
    const current = this.bars();
    if (current.length === 0 || this.loading()) {
      this.host()?.historyLoaded();
      return;
    }
    const oldest = current[0].time;
    const step = resolutionMs(this.resolution()) ?? 60_000;
    this.loading.set(true);
    try {
      const { bars } = await this.feed.getBars(
        this.symbol(),
        this.resolution(),
        0,
        oldest - step,
        PAGE_BARS,
      );
      if (bars.length > 0) {
        const merged = new Map<number, Bar>();
        for (const b of bars) merged.set(b.time, b);
        for (const b of current) merged.set(b.time, b);
        this.bars.set([...merged.values()].sort((a, b) => a.time - b.time));
      }
    } finally {
      this.loading.set(false);
      this.host()?.historyLoaded();
    }
  }

  private applyTick(tick: { symbol?: string; bid?: number; ask?: number; price?: number }): void {
    if (!tick?.symbol || tick.symbol.toUpperCase() !== this.symbol().toUpperCase()) return;
    const price = tick.bid ?? tick.price ?? tick.ask;
    if (typeof price !== 'number' || !Number.isFinite(price)) return;

    const current = this.bars();
    if (current.length === 0) return;
    const step = resolutionMs(this.resolution());
    if (!step) return;

    const last = current[current.length - 1];
    const bucket = Math.floor(Date.now() / step) * step;

    if (bucket > last.time) {
      // A new bar opened. Seed it from the tick rather than waiting for the
      // next history fetch, so the chart does not stall a whole timeframe
      // behind the market.
      this.bars.set([
        ...current,
        { time: bucket, open: price, high: price, low: price, close: price, volume: 0 },
      ]);
      return;
    }
    if (bucket < last.time) return;

    const updated: Bar = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
    this.bars.set([...current.slice(0, -1), updated]);
  }

  // ── Toolbar actions ──────────────────────────────────────────────────────

  selectSymbol(symbol: string): void {
    this.symbolMenuOpen.set(false);
    this.symbolQuery.set('');
    if (symbol === this.symbol()) return;
    this.symbol.set(symbol);
    void this.router.navigate(['/chart-analysis', symbol], {
      queryParams: { tf: this.resolution() },
      replaceUrl: true,
    });
    void this.reload();
  }

  selectResolution(r: TvResolution): void {
    if (r === this.resolution()) return;
    this.resolution.set(r);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tf: r },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    void this.reload();
  }

  addIndicator(defId: string): void {
    const def = indicatorById(defId);
    if (!def) return;
    this.active.update((list) => [
      ...list,
      {
        uid: `${defId}-${Date.now().toString(36)}-${list.length}`,
        defId,
        params: defaultParams(def),
        visible: true,
      },
    ]);
    this.indicatorMenuOpen.set(false);
  }

  removeIndicator(uid: string): void {
    this.active.update((list) => list.filter((i) => i.uid !== uid));
  }

  toggleIndicator(uid: string): void {
    this.active.update((list) =>
      list.map((i) => (i.uid === uid ? { ...i, visible: !i.visible } : i)),
    );
  }

  setParam(uid: string, key: string, raw: string): void {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    this.active.update((list) =>
      list.map((i) => (i.uid === uid ? { ...i, params: { ...i.params, [key]: value } } : i)),
    );
  }

  labelFor(item: ActiveIndicator): string {
    const def = indicatorById(item.defId);
    return def ? indicatorLabel(def, item.params) : item.defId;
  }

  inputsFor(item: ActiveIndicator) {
    return indicatorById(item.defId)?.inputs.filter((i) => i.type === 'number') ?? [];
  }

  onLegend(snapshot: LegendSnapshot): void {
    this.legend.set(snapshot);
  }

  formatTime(ms: number | null): string {
    if (ms === null) return '';
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}
