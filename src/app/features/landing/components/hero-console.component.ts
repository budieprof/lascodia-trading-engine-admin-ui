import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';

import {
  ORDER_STAGES,
  chartGeometry,
  formatPrice,
  illustrationCid,
  ladder,
  nextCandle,
  nextStage,
  seedCandles,
  seededRandom,
  tickCandle,
  type Candle,
} from '../landing.logic';

const W = 640;
const H = 280;
const BARS = 46;
const TICK_MS = 420;
const TICKS_PER_BAR = 7;
const STAGE_MS = 1150;

/**
 * The hero's illustrated console: a candle chart, an order-book ladder and one order walking through the
 * pipeline. Fed by a seeded random walk — it is decoration, says so beneath the frame, and never touches the
 * engine. Animation stops while the frame is off screen, while the tab is hidden, and entirely under
 * `prefers-reduced-motion`.
 */
@Component({
  selector: 'lp-hero-console',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="hc"
      role="img"
      aria-label="Illustration of the Lascodia console: a live chart, the order book and an order passing the risk gates"
    >
      <div class="hc__bar" aria-hidden="true">
        <span class="hc__dots"><i></i><i></i><i></i></span>
        <span class="hc__tabs">
          <b class="is-on">Chart</b><b>Positions</b><b>Signals</b><b class="hc__opt">Risk</b>
        </span>
        <span class="hc__live"><i></i> Live</span>
      </div>

      <div class="hc__body" aria-hidden="true">
        <div class="hc__chart">
          <div class="hc__quote">
            <span class="hc__sym">EURUSD <em>H1</em></span>
            <span class="hc__px" [class.is-down]="!up()">{{ price() }}</span>
            <span class="hc__chg" [class.is-down]="!up()">{{ change() }}</span>
          </div>
          <div class="hc__plot">
            <svg [attr.viewBox]="'0 0 ' + w + ' ' + h" preserveAspectRatio="none" class="hc__svg">
              <defs>
                <linearGradient id="lp-hc-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#3d8bff" stop-opacity=".28" />
                  <stop offset="1" stop-color="#3d8bff" stop-opacity="0" />
                </linearGradient>
              </defs>
              @for (g of gridY; track g) {
                <line x1="0" [attr.x2]="w" [attr.y1]="g" [attr.y2]="g" class="hc__grid" />
              }
              <path [attr.d]="geo().areaPath" fill="url(#lp-hc-area)" />
              @for (k of geo().wicks; track $index) {
                <line
                  [attr.x1]="k.x"
                  [attr.x2]="k.x"
                  [attr.y1]="k.y1"
                  [attr.y2]="k.y2"
                  [class]="k.up ? 'hc__w up' : 'hc__w dn'"
                />
              }
              @for (b of geo().bodies; track $index) {
                <rect
                  [attr.x]="b.x"
                  [attr.y]="b.y"
                  [attr.width]="b.w"
                  [attr.height]="b.h"
                  rx="1"
                  [class]="b.up ? 'hc__b up' : 'hc__b dn'"
                />
              }
              <path [attr.d]="geo().emaPath" class="hc__ema" />
              <line
                x1="0"
                [attr.x2]="w"
                [attr.y1]="geo().lastY * h"
                [attr.y2]="geo().lastY * h"
                class="hc__last"
              />
            </svg>
            <span class="hc__tag" [class.is-down]="!up()" [style.top.%]="geo().lastY * 100">{{
              price()
            }}</span>
            <div class="hc__entry" [class.is-on]="stage() >= 3" [style.top.%]="entryY() * 100">
              <span>BUY 0.50 · filled</span>
            </div>
          </div>
        </div>

        <div class="hc__book">
          <div class="hc__bookhead"><span>Price</span><span>Size</span></div>
          @for (r of book(); track $index) {
            @if ($index === 5) {
              <div class="hc__spread">Spread 0.5</div>
            }
            <div class="hc__row" [class.ask]="r.side === 'ask'" [class.bid]="r.side === 'bid'">
              <i [style.width.%]="(r.size / 20) * 100"></i>
              <span>{{ fmt(r.price) }}</span
              ><span>{{ r.size.toFixed(1) }}</span>
            </div>
          }
        </div>
      </div>

      <div class="hc__pipe" aria-hidden="true">
        <span class="hc__cid">cid {{ cid() }}</span>
        <ol>
          @for (s of stages; track s; let i = $index) {
            <li [class.is-done]="stage() > i" [class.is-now]="stage() === i + 1">
              <i></i><span>{{ s }}</span>
            </li>
          }
        </ol>
      </div>
    </div>

    <div class="hc-float hc-float--gates" aria-hidden="true">
      <span class="hc-float__ic">
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" />
          <path d="m8.5 12 2.5 2.5 4.5-5" />
        </svg>
      </span>
      <span><b>7 of 7 gates passed</b><small>checked at the terminal</small></span>
    </div>
    <div class="hc-float hc-float--beat" aria-hidden="true">
      <span class="hc-float__pulse"></span>
      <span><b>Heartbeat</b><small>every second · 4 terminals</small></span>
    </div>
    <p class="hc-note">Illustration — not live market data.</p>
  `,
  styleUrl: './hero-console.component.scss',
})
export class HeroConsoleComponent {
  protected readonly w = W;
  protected readonly h = H;
  protected readonly gridY = [56, 112, 168, 224];
  protected readonly stages = ORDER_STAGES;

  private readonly rnd = seededRandom(20261028);
  private readonly candles = signal<Candle[]>(seedCandles(BARS, 1.0842, this.rnd));
  private readonly openOfDay = this.candles()[0].o;
  private ticks = 0;
  private readonly entryPrice = signal<number | null>(null);

  protected readonly stage = signal(0);
  protected readonly cid = signal(illustrationCid(this.rnd));
  protected readonly geo = computed(() => chartGeometry(this.candles(), W, H, 18));
  protected readonly last = computed(() => this.candles()[this.candles().length - 1].c);
  protected readonly up = computed(() => this.last() >= this.openOfDay);
  protected readonly price = computed(() => formatPrice(this.last()));
  protected readonly change = computed(() => {
    const pct = ((this.last() - this.openOfDay) / this.openOfDay) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  });
  protected readonly book = signal(ladder(this.last(), this.rnd));
  protected readonly entryY = computed(() => {
    const bars = this.candles();
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of bars) {
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
    }
    const p = this.entryPrice() ?? this.last();
    const pad = 18 / H;
    return pad + (1 - (p - lo) / (hi - lo || 1)) * (1 - pad * 2);
  });

  protected fmt = formatPrice;

  constructor() {
    const host = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this.stage.set(ORDER_STAGES.length);
      return;
    }

    let visible = true;
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((e) => (visible = e.some((x) => x.isIntersecting)))
        : null;
    io?.observe(host);
    const running = () => visible && !document.hidden;

    const tick = setInterval(() => running() && this.tick(), TICK_MS);
    const stage = setInterval(() => running() && this.advanceStage(), STAGE_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(tick);
      clearInterval(stage);
      io?.disconnect();
    });
  }

  private tick(): void {
    this.ticks++;
    this.candles.update((bars) => {
      const next = bars.slice();
      if (this.ticks % TICKS_PER_BAR === 0) {
        next.push(nextCandle(next[next.length - 1].c, this.rnd));
        next.shift();
      } else {
        next[next.length - 1] = tickCandle(next[next.length - 1], this.rnd);
      }
      return next;
    });
    this.book.set(ladder(this.last(), this.rnd));
  }

  private advanceStage(): void {
    const s = nextStage(this.stage());
    if (s === 0) {
      this.cid.set(illustrationCid(this.rnd));
      this.entryPrice.set(null);
    }
    if (s === 3) this.entryPrice.set(this.last());
    this.stage.set(s);
  }
}
