import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

import { DemoApiService } from './demo-api.service';
import { digitsFor, foldTicks, recordedClock, recordedWindow } from './demo.logic';
import type { DemoBar, DemoBook, DemoStatus } from './demo.types';

/**
 * The public demonstration (engine enterprise onboarding): anyone may open `/demo` without signing in
 * and watch a chart and an order book driven by RECORDED broker data replayed on a loop. The banner on
 * top says so on every screen — what was recorded, when, and that the times are the replay's, not the
 * market's — and the page has no order entry at all (the engine's demo endpoints are read-only and the
 * showcase organisation never trades). Off in the engine (`Demo:Enabled`), the page says the demo is
 * not available.
 */
@Component({
  selector: 'app-demo-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      .banner {
        position: sticky;
        top: 0;
        z-index: 2;
        padding: 10px 16px;
        background: #b45309;
        color: #fff;
        font-size: var(--text-sm);
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        align-items: center;
      }
      .banner strong {
        letter-spacing: 0.04em;
      }
      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .top {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
      }
      .top h1 {
        font-size: var(--text-xl, 20px);
        margin: 0;
      }
      .spacer {
        flex: 1;
      }
      .quote {
        font-variant-numeric: tabular-nums;
        font-size: var(--text-lg, 18px);
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 280px;
        gap: 16px;
      }
      @media (max-width: 860px) {
        .grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
      .panel {
        border: 1px solid var(--border);
        border-radius: var(--radius-md, 8px);
        background: var(--bg-secondary);
        padding: 12px;
        min-width: 0;
      }
      .chart {
        height: 460px;
      }
      table.book {
        width: 100%;
        border-collapse: collapse;
        font-variant-numeric: tabular-nums;
        font-size: var(--text-xs);
      }
      table.book td {
        padding: 2px 6px;
        text-align: right;
      }
      .ask {
        color: #ef5350;
      }
      .bid {
        color: #26a69a;
      }
      .muted {
        color: var(--text-secondary);
        font-size: var(--text-sm);
      }
      select {
        padding: 6px 8px;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--bg-secondary);
        color: inherit;
      }
      a {
        color: var(--accent);
      }
    `,
  ],
  template: `
    <div class="banner" role="note" aria-live="polite">
      <strong>RECORDED DATA, REPLAYED</strong>
      <span>{{ status()?.label || 'Not live market data. No trading.' }}</span>
      @if (status()?.recordedNowMs; as r) {
        <span>{{ clock(r) }}</span>
      }
    </div>

    <div class="wrap">
      <div class="top">
        <h1>Lascodia — live console demo</h1>
        @if (symbols().length > 1) {
          <select aria-label="Symbol" [value]="symbol()" (change)="pick($any($event.target).value)">
            @for (s of symbols(); track s) {
              <option [value]="s">{{ s }}</option>
            }
          </select>
        } @else {
          <span>{{ symbol() }}</span>
        }
        @if (quote(); as q) {
          <span class="quote"
            ><span class="bid">{{ q.bid }}</span> / <span class="ask">{{ q.ask }}</span></span
          >
        }
        <span class="spacer"></span>
        <a routerLink="/login">Sign in</a>
        <a routerLink="/signup">Create an organisation</a>
      </div>

      @if (problem(); as p) {
        <div class="panel" role="alert">{{ p }}</div>
      }

      <p class="muted">
        Recorded window: {{ window() }} · loop of {{ status()?.loopMinutes ?? '–' }} minutes
        @if (source()) {
          · source {{ source() }}
        }
        . Everything here is replayed from the market-data store; nothing is live and nothing can be
        traded. An orange marker shows where the loop starts again.
      </p>

      <div class="grid">
        <div class="panel">
          <div
            #chartHost
            class="chart"
            aria-label="Replayed price chart (bid, 1-minute bars)"
          ></div>
        </div>
        <div class="panel">
          <strong>Order book (recorded)</strong>
          @if (book(); as b) {
            @if (b.asks.length || b.bids.length) {
              <table class="book">
                <tbody>
                  @for (l of asksDesc(); track l[0]) {
                    <tr>
                      <td class="ask">{{ price(l[0]) }}</td>
                      <td>{{ l[1] }}</td>
                    </tr>
                  }
                  @for (l of b.bids; track l[0]) {
                    <tr>
                      <td class="bid">{{ price(l[0]) }}</td>
                      <td>{{ l[1] }}</td>
                    </tr>
                  }
                </tbody>
              </table>
              <p class="muted">Sizes in {{ b.sizeUnit }} · {{ clock(b.recordedT) }}</p>
            }
            @if (b.note) {
              <p class="muted">{{ b.note }}</p>
            }
          } @else {
            <p class="muted">Loading…</p>
          }
        </div>
      </div>
    </div>
  `,
})
export class DemoPageComponent {
  private readonly api = inject(DemoApiService);
  private readonly host = viewChild<ElementRef<HTMLDivElement>>('chartHost');

  readonly status = signal<DemoStatus | null>(null);
  readonly problem = signal<string | null>(null);
  readonly symbol = signal('EURUSD');
  readonly symbols = computed(() => this.status()?.symbols ?? []);
  readonly window = computed(() => (this.status() ? recordedWindow(this.status()!) : '…'));
  readonly source = signal<string | null>(null);
  readonly book = signal<DemoBook | null>(null);
  readonly asksDesc = computed(() => [...(this.book()?.asks ?? [])].reverse());
  readonly quote = signal<{ bid: string; ask: string } | null>(null);

  private chart: IChartApi | null = null;
  private series: ISeriesApi<'Candlestick'> | null = null;
  private markers: ISeriesMarkersPluginApi<Time> | null = null;
  private bars: DemoBar[] = [];
  private lastTickMs: number | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private destroyed = false;

  constructor() {
    afterNextRender(() => this.start());
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.timers.forEach(clearInterval);
      this.chart?.remove();
    });
  }

  clock(ms: number | null): string {
    return recordedClock(ms);
  }

  price(p: number): string {
    return p.toFixed(digitsFor(this.symbol()));
  }

  pick(symbol: string): void {
    if (symbol === this.symbol()) return;
    this.switchTo(symbol);
  }

  /**
   * Review O12: a new symbol starts from nothing. The previous symbol's bars and tick cursor used
   * to survive the pick, so its ticks (by timestamp) folded into the new symbol's bars until the
   * candles arrived — and a late answer for the old symbol could still land on the new chart.
   */
  private switchTo(symbol: string): void {
    this.symbol.set(symbol);
    this.bars = [];
    this.lastTickMs = null;
    this.series?.setData([]);
    this.markers?.setMarkers([]);
    this.quote.set(null);
    this.book.set(null);
    this.source.set(null);
    this.loadCandles();
    this.loadBook();
  }

  private start(): void {
    const el = this.host()?.nativeElement;
    if (el) {
      const dark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
      this.chart = createChart(el, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: dark ? '#d1d4dc' : '#131722',
        },
        grid: { vertLines: { visible: false }, horzLines: { color: dark ? '#2a2e39' : '#f0f3fa' } },
        timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6 },
      });
      this.series = this.chart.addSeries(CandlestickSeries, {
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderUpColor: '#26a69a',
        borderDownColor: '#ef5350',
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });
      this.markers = createSeriesMarkers(this.series, []);
    }
    this.loadStatus(true);
    this.timers.push(setInterval(() => this.loadStatus(false), 60_000));
    this.timers.push(setInterval(() => this.loadTicks(), 1_000));
    this.timers.push(setInterval(() => this.loadBook(), 2_000));
    this.timers.push(setInterval(() => this.loadCandles(), 5 * 60_000));
  }

  private loadStatus(first: boolean): void {
    this.api.status().subscribe({
      next: (s) => {
        this.status.set(s);
        if (!s.available) {
          this.problem.set(s.reason ?? 'The demo is not available right now.');
          return;
        }
        this.problem.set(null);
        if (first || !s.symbols.includes(this.symbol())) {
          this.switchTo(s.symbols[0] ?? 'EURUSD');
        }
      },
      error: (e) =>
        this.problem.set(
          e?.status === 404
            ? 'The demo is not available on this server.'
            : 'The demo could not be reached. Retrying…',
        ),
    });
  }

  private loadCandles(): void {
    if (this.destroyed) return;
    const symbol = this.symbol();
    this.api.candles(symbol, 180).subscribe({
      next: (c) => {
        // Answered for a symbol the operator has since left: drop it.
        if (this.destroyed || symbol !== this.symbol()) return;
        this.source.set(c.sourceName || c.sourceId);
        this.bars = [...c.bars];
        this.lastTickMs = c.nowMs;
        this.series?.setData(this.bars.map((b) => this.point(b)));
        this.drawSeams();
      },
      error: () => undefined,
    });
  }

  private loadTicks(): void {
    if (
      this.destroyed ||
      !this.series ||
      this.status()?.available !== true ||
      document.visibilityState === 'hidden'
    )
      return;
    const symbol = this.symbol();
    // No bars yet (just switched): ticks have nothing to fold into until the candles land.
    if (this.bars.length === 0) return;
    this.api.ticks(symbol, this.lastTickMs).subscribe({
      next: (t) => {
        if (this.destroyed || symbol !== this.symbol()) return;
        if (t.t.length === 0) return;
        this.lastTickMs = t.t[t.t.length - 1];
        const touched = foldTicks(this.bars, t);
        for (const b of touched) this.series?.update(this.point(b));
        if (touched.some((b) => b.loopStart)) this.drawSeams();
        const d = digitsFor(this.symbol());
        this.quote.set({
          bid: t.b[t.b.length - 1].toFixed(d),
          ask: t.a[t.a.length - 1].toFixed(d),
        });
      },
      error: () => undefined,
    });
  }

  private loadBook(): void {
    if (
      this.destroyed ||
      this.status()?.available !== true ||
      document.visibilityState === 'hidden'
    )
      return;
    const symbol = this.symbol();
    this.api.book(symbol).subscribe({
      next: (b) => {
        if (!this.destroyed && symbol === this.symbol()) this.book.set(b);
      },
      error: () => undefined,
    });
  }

  /** Marks every loop restart: the price jumps back to the recording's start there. */
  private drawSeams(): void {
    this.markers?.setMarkers(
      this.bars
        .filter((b) => b.loopStart)
        .map((b) => ({
          time: (b.t / 1000) as UTCTimestamp,
          position: 'aboveBar' as const,
          shape: 'arrowDown' as const,
          color: '#b45309',
          text: 'loop restarts',
        })),
    );
  }

  private point(b: DemoBar) {
    return { time: (b.t / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c };
  }
}
