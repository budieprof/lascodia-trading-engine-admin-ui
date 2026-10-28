import { ChangeDetectionStrategy, Component } from '@angular/core';

import { FEATURES } from '../landing.content';
import { seededRandom } from '../landing.logic';
import { RevealDirective } from '../reveal.directive';
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

/** The product grid: six capability tiles; the wide chart tile and the full-width risk tile carry an illustration. */
@Component({
  selector: 'lp-features',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RevealDirective, LandingIconComponent],
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
  protected readonly meters = [
    { label: 'Daily loss', value: '38% of limit', pct: 38 },
    { label: 'Open exposure', value: '74% of limit', pct: 74 },
    { label: 'Orders this minute', value: '3 of 12', pct: 25 },
  ];
}
