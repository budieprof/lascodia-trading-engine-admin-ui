import { ChangeDetectionStrategy, Component } from '@angular/core';

import { FEATURES } from '../landing.content';
import { seededRandom } from '../landing.logic';
import { RevealDirective } from '../reveal.directive';
import { SpotlightDirective } from '../spotlight.directive';
import { LandingIconComponent } from './landing-icon.component';

/** A 28 × 9 grid of liquidity intensities for the decorative heatmap: a few bands of resting size. */
function heatCells(): number[] {
  const rnd = seededRandom(91);
  const bands = [1, 4, 6];
  const out: number[] = [];
  for (let r = 0; r < 9; r++)
    for (let c = 0; c < 28; c++) {
      const band = bands.includes(r) ? 0.55 : 0.08;
      out.push(Math.min(1, band + rnd() * 0.35 + (c > 18 && r === 4 ? 0.4 : 0)));
    }
  return out;
}

/** A seeded upward walk drawn as an SVG path in a 240 × 60 box. */
function equityPath(): string {
  const rnd = seededRandom(1065);
  const pts: string[] = [];
  let v = 48;
  for (let i = 0; i <= 40; i++) {
    v = Math.max(6, Math.min(56, v - 1 + (rnd() - 0.42) * 6));
    pts.push(`${(i * 6).toFixed(0)},${v.toFixed(1)}`);
  }
  return `M${pts.join(' L')}`;
}

/** The product grid: six capability tiles; the wide chart tile and the full-width risk tile carry an illustration. */
@Component({
  selector: 'lp-features',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RevealDirective, SpotlightDirective, LandingIconComponent],
  template: `
    <section class="lp-section lp-section--alt" id="product" aria-labelledby="lp-features-title">
      <div class="lp-container">
        <header class="lp-head" lpReveal>
          <p class="lp-eyebrow">The platform</p>
          <h2 class="lp-h2" id="lp-features-title">
            Research, analysis and execution. <span class="lp-grad-text">One console.</span>
          </h2>
          <p class="lp-lede">
            Everything between an idea and a reconciled fill lives in one place — so your team works
            from the same numbers, the same risk limits and the same history.
          </p>
        </header>

        <div class="fx">
          @for (f of features; track f.title; let i = $index) {
            <article
              class="lp-card fx__tile"
              [class.fx__tile--wide]="f.wide || f.full"
              [class.fx__tile--full]="f.full"
              [lpReveal]="(i % 3) * 90"
              lpSpot
            >
              <div class="fx__text">
                <span class="lp-icon-tile"><lp-icon [name]="f.icon" /></span>
                <h3>{{ f.title }}</h3>
                <p>{{ f.body }}</p>
                <ul class="lp-checks">
                  @for (p of f.points; track p) {
                    <li>{{ p }}</li>
                  }
                </ul>
              </div>

              @if (f.icon === 'chart') {
                <div class="fx__art fx__heat" aria-hidden="true">
                  <div class="fx__heatgrid">
                    @for (v of heat; track $index) {
                      <i [style.opacity]="v"></i>
                    }
                  </div>
                  <svg viewBox="0 0 280 90" preserveAspectRatio="none" class="fx__heatline">
                    <path
                      d="M0 62 C30 58 40 40 70 44 S120 70 150 52 S200 22 230 30 S265 18 280 14"
                    />
                  </svg>
                  <span class="fx__chip fx__chip--a">Resting size 2.4M</span>
                  <span class="fx__chip fx__chip--b">CVD ▲</span>
                </div>
              }
              @if (f.icon === 'code') {
                <div class="fx__mini fx__pine" aria-hidden="true">
                  <pre><code><i class="k">strategy</i>(<i class="s">"RSI(2) reversion"</i>)
r = ta.<i class="f">rsi</i>(close, <i class="n">2</i>)
<i class="k">if</i> r &lt; <i class="n">10</i> <i class="k">and</i> close &gt; ta.<i class="f">sma</i>(close, <i class="n">200</i>)
    strategy.<i class="f">entry</i>(<i class="s">"L"</i>, strategy.long)</code></pre>
                  <div class="fx__equity">
                    <svg viewBox="0 0 240 60" preserveAspectRatio="none">
                      <defs>
                        <linearGradient id="lp-fx-eq" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0" stop-color="#22c983" stop-opacity=".35" />
                          <stop offset="1" stop-color="#22c983" stop-opacity="0" />
                        </linearGradient>
                      </defs>
                      <path class="fx__eqarea" [attr.d]="equity + ' L240,60 L0,60 Z'" />
                      <path class="fx__eqline" [attr.d]="equity" />
                    </svg>
                    <span class="fx__eqtag">Equity · costs included</span>
                  </div>
                </div>
              }
              @if (f.icon === 'spark') {
                <div class="fx__mini fx__ai" aria-hidden="true">
                  <div class="fx__verdict">
                    <span class="fx__pill fx__pill--amber">Stand aside</span>
                    <small>EURUSD · H1</small>
                  </div>
                  <p>
                    Trend is up, but US CPI prints in 40 minutes. I would wait for the release and
                    re-check the 1.0820 support before buying.
                  </p>
                  <div class="fx__watch">
                    <span class="fx__dot"></span> Watch armed: close above 1.0860 after the release
                  </div>
                </div>
              }
              @if (f.icon === 'fleet') {
                <div class="fx__mini fx__fleet" aria-hidden="true">
                  @for (t of terminals; track t.name) {
                    <div class="fx__term">
                      <span class="fx__beat" [style.animation-delay.ms]="t.delay"></span>
                      <b>{{ t.name }}</b>
                      <small>{{ t.broker }}</small>
                      <em>{{ t.state }}</em>
                    </div>
                  }
                </div>
              }
              @if (f.icon === 'team') {
                <div class="fx__mini fx__team" aria-hidden="true">
                  @for (m of members; track m.initials) {
                    <div class="fx__member">
                      <span class="fx__avatar" [style.background]="m.color">{{ m.initials }}</span>
                      <b>{{ m.role }}</b>
                      <small>{{ m.can }}</small>
                    </div>
                  }
                </div>
              }
              @if (f.icon === 'shield') {
                <div class="fx__art fx__risk" aria-hidden="true">
                  <div class="fx__switch">
                    <span><b>Kill switch</b><small>Organisation</small></span>
                    <span class="fx__toggle"><i></i></span>
                  </div>
                  @for (m of meters; track m.label) {
                    <div class="fx__meter">
                      <span class="fx__meterhead"
                        ><b>{{ m.label }}</b
                        ><small>{{ m.value }}</small></span
                      >
                      <span class="fx__bar"
                        ><i [style.width.%]="m.pct" [class.is-warn]="m.pct > 70"></i
                      ></span>
                    </div>
                  }
                </div>
              }
            </article>
          }
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .fx {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
      }
      .fx__tile {
        display: flex;
        flex-direction: column;
        gap: 28px;
        padding: 32px;
        overflow: hidden;
        transition:
          transform 0.35s cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 0.35s;
      }
      .fx__tile:hover {
        transform: translateY(-4px);
        box-shadow: var(--lp-shadow-lg);
      }
      .fx__tile--wide {
        grid-column: span 2;
        flex-direction: row;
        align-items: center;
      }
      .fx__tile--full {
        grid-column: 1 / -1;
      }
      .fx__tile--wide .fx__text {
        flex: 1 1 46%;
      }
      h3 {
        margin: 20px 0 8px;
        font-size: 22px;
        font-weight: 650;
        letter-spacing: -0.02em;
      }
      .fx__text > p {
        margin: 0 0 20px;
        font-size: 16px;
        line-height: 1.5;
        color: var(--lp-ink-2);
      }
      .fx__art {
        position: relative;
        flex: 1 1 54%;
        align-self: stretch;
        min-height: 220px;
        border-radius: 18px;
        overflow: hidden;
        background: #0a0c12;
        border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .fx__heatgrid {
        position: absolute;
        inset: 14px;
        display: grid;
        grid-template-columns: repeat(28, 1fr);
        grid-template-rows: repeat(9, 1fr);
        gap: 3px;
      }
      .fx__heatgrid i {
        border-radius: 2px;
        background: linear-gradient(180deg, #ffb84d, #ff6a3d);
      }
      .fx__heatgrid i:nth-child(n + 85):nth-child(-n + 168) {
        background: linear-gradient(180deg, #3d8bff, #7b5cff);
      }
      .fx__heatline {
        position: absolute;
        inset: 14px;
        width: calc(100% - 28px);
        height: calc(100% - 28px);
      }
      .fx__heatline path {
        fill: none;
        stroke: #fff;
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.7));
      }
      .fx__chip {
        position: absolute;
        padding: 5px 10px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 600;
        color: #fff;
        background: rgba(10, 12, 18, 0.72);
        border: 1px solid rgba(255, 255, 255, 0.14);
        backdrop-filter: blur(8px);
      }
      .fx__chip--a {
        left: 22px;
        top: 22px;
      }
      .fx__chip--b {
        right: 22px;
        bottom: 22px;
        color: #22c983;
      }
      .fx__risk {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 14px;
        padding: 22px;
        color: #e9eaf0;
      }
      .fx__switch {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-radius: 14px;
        background: rgba(255, 84, 104, 0.1);
        border: 1px solid rgba(255, 84, 104, 0.3);
      }
      .fx__switch b,
      .fx__meterhead b {
        display: block;
        font-size: 14px;
        font-weight: 600;
      }
      .fx__switch small,
      .fx__meterhead small {
        font-size: 12px;
        color: #8d90a0;
      }
      .fx__toggle {
        position: relative;
        width: 44px;
        height: 26px;
        border-radius: 999px;
        background: #ff5468;
      }
      .fx__toggle i {
        position: absolute;
        top: 3px;
        right: 3px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
      }
      .fx__meterhead {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 8px;
      }
      .fx__bar {
        display: block;
        height: 6px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
      }
      .fx__bar i {
        display: block;
        height: 100%;
        border-radius: 6px;
        background: linear-gradient(90deg, #22c983, #13c2e8);
      }
      .fx__bar i.is-warn {
        background: linear-gradient(90deg, #ffb84d, #ff6a3d);
      }
      .fx__tile:not(.fx__tile--wide) .fx__text {
        flex: 1;
      }
      .fx__mini {
        position: relative;
        margin: 0 -8px -8px;
        padding: 16px;
        border-radius: 16px;
        color: #e9eaf0;
        background:
          radial-gradient(120% 90% at 0% 0%, rgba(61, 139, 255, 0.14), transparent 60%), #0a0c12;
        border: 1px solid rgba(255, 255, 255, 0.08);
        font-size: 12.5px;
      }
      .fx__pine pre {
        margin: 0 0 12px;
        font:
          500 11.5px/1.65 ui-monospace,
          'SF Mono',
          Menlo,
          monospace;
        white-space: pre;
        overflow: hidden;
        color: #c9cbd6;
      }
      .fx__pine i {
        font-style: normal;
      }
      .fx__pine .k {
        color: #c792ff;
      }
      .fx__pine .s {
        color: #9be38b;
      }
      .fx__pine .f {
        color: #6fb0ff;
      }
      .fx__pine .n {
        color: #ffb86b;
      }
      .fx__equity {
        position: relative;
        height: 64px;
        border-top: 1px solid rgba(255, 255, 255, 0.07);
        padding-top: 8px;
      }
      .fx__equity svg {
        width: 100%;
        height: 100%;
        overflow: visible;
      }
      .fx__eqarea {
        fill: url(#lp-fx-eq);
      }
      .fx__eqline {
        fill: none;
        stroke: #22c983;
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
        stroke-dasharray: 600;
        stroke-dashoffset: 600;
        transition: stroke-dashoffset 2.2s cubic-bezier(0.16, 1, 0.3, 1) 0.3s;
      }
      .is-in .fx__eqline {
        stroke-dashoffset: 0;
      }
      .fx__eqtag {
        position: absolute;
        right: 0;
        top: 10px;
        font-size: 11px;
        color: #8d90a0;
      }
      .fx__verdict {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .fx__verdict small,
      .fx__term small,
      .fx__member small {
        color: #8d90a0;
        font-size: 11.5px;
      }
      .fx__pill {
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11.5px;
        font-weight: 700;
        letter-spacing: 0.02em;
        text-transform: uppercase;
      }
      .fx__pill--amber {
        color: #ffcf73;
        background: rgba(255, 184, 77, 0.14);
        border: 1px solid rgba(255, 184, 77, 0.3);
      }
      .fx__ai p {
        margin: 0 0 12px;
        font-size: 13px;
        line-height: 1.55;
        color: #d5d7e0;
      }
      .fx__watch {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 10px;
        font-size: 12px;
        color: #a9c8ff;
        background: rgba(61, 139, 255, 0.1);
        border: 1px solid rgba(61, 139, 255, 0.22);
      }
      .fx__dot {
        flex: none;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #3d8bff;
        box-shadow: 0 0 0 0 rgba(61, 139, 255, 0.6);
        animation: fx-ping 1.6s ease-out infinite;
      }
      .fx__fleet,
      .fx__team {
        display: grid;
        gap: 8px;
      }
      .fx__term,
      .fx__member {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        column-gap: 10px;
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.05);
      }
      .fx__term b,
      .fx__member b {
        font-size: 12.5px;
        font-weight: 600;
      }
      .fx__term small {
        grid-column: 2;
        grid-row: 2;
      }
      .fx__term em {
        grid-column: 3;
        grid-row: 1 / span 2;
        font-style: normal;
        font-size: 11px;
        font-weight: 600;
        color: #22c983;
      }
      .fx__beat {
        grid-row: 1 / span 2;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22c983;
        animation: fx-beat 1s ease-out infinite;
      }
      .fx__member small {
        text-align: right;
      }
      .fx__avatar {
        display: grid;
        place-items: center;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        font-size: 10.5px;
        font-weight: 700;
        color: #fff;
      }
      @keyframes fx-beat {
        0% {
          box-shadow: 0 0 0 0 rgba(34, 201, 131, 0.7);
        }
        100% {
          box-shadow: 0 0 0 8px rgba(34, 201, 131, 0);
        }
      }
      @keyframes fx-ping {
        0% {
          box-shadow: 0 0 0 0 rgba(61, 139, 255, 0.6);
        }
        100% {
          box-shadow: 0 0 0 8px rgba(61, 139, 255, 0);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .fx__eqline {
          stroke-dashoffset: 0;
          transition: none;
        }
      }
      @media (max-width: 1000px) {
        .fx {
          grid-template-columns: 1fr 1fr;
        }
      }
      @media (max-width: 760px) {
        .fx {
          grid-template-columns: 1fr;
        }
        .fx__tile,
        .fx__tile--wide,
        .fx__tile--full {
          grid-column: auto;
          flex-direction: column;
          align-items: stretch;
          padding: 24px;
        }
      }
    `,
  ],
})
export class LandingFeaturesComponent {
  protected readonly features = FEATURES;
  protected readonly heat = heatCells();
  /** A gently rising equity curve for the Pine tile — decoration, like every number on this page. */
  protected readonly equity = equityPath();
  protected readonly terminals = [
    { name: 'Desk A · EURUSD', broker: 'MT5 · broker one', state: 'Running', delay: 0 },
    { name: 'Desk A · XAUUSD', broker: 'MT5 · broker one', state: 'Running', delay: 330 },
    { name: 'Prop #14 · GBPUSD', broker: 'MT5 · broker two', state: 'Running', delay: 660 },
  ];
  protected readonly members = [
    {
      initials: 'AO',
      role: 'Owner',
      can: 'Everything',
      color: 'linear-gradient(135deg,#3d8bff,#7b5cff)',
    },
    {
      initials: 'TK',
      role: 'Trader',
      can: 'Trade & watch',
      color: 'linear-gradient(135deg,#13c2e8,#3d8bff)',
    },
    {
      initials: 'RM',
      role: 'RiskManager',
      can: 'Limits & kill switch',
      color: 'linear-gradient(135deg,#ff8a4d,#ff4d5e)',
    },
  ];
  protected readonly meters = [
    { label: 'Daily loss', value: '38% of limit', pct: 38 },
    { label: 'Open exposure', value: '74% of limit', pct: 74 },
    { label: 'Orders this minute', value: '3 of 12', pct: 25 },
  ];
}
