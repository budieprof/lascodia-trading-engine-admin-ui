import { ChangeDetectionStrategy, Component } from '@angular/core';

import { GATES, SAFEGUARDS } from '../landing.content';
import { RevealDirective } from '../reveal.directive';

/**
 * The safety story, on a dark band in both themes: the seven gates the terminal checks (they tick in order when
 * the list scrolls into view) beside the safeguards that work when something goes wrong.
 */
@Component({
  selector: 'lp-safety',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RevealDirective],
  template: `
    <section class="sf" id="safety" aria-labelledby="lp-safety-title">
      <div class="sf__glow" aria-hidden="true"></div>
      <div class="lp-container sf__grid">
        <div class="sf__copy" lpReveal>
          <p class="lp-eyebrow">Safety first</p>
          <h2 class="lp-h2" id="lp-safety-title">
            Built to say <span class="sf__no">no</span> before it says yes.
          </h2>
          <p class="sf__lede">
            Before any order leaves your terminal it passes seven independent checks, in a fixed
            order. A refusal is never silent: it names the gate that stopped it, so you know whether
            to wait or to act.
          </p>

          <div class="sf__guards">
            @for (g of safeguards; track g.title; let i = $index) {
              <div class="sf__guard" [lpReveal]="120 + i * 80">
                <h3>{{ g.title }}</h3>
                <p>{{ g.body }}</p>
              </div>
            }
          </div>
        </div>

        <div class="sf__panel" lpReveal="150">
          <div class="sf__panelhead">
            <span>Order check</span>
            <span class="sf__ok">Passed · 7 of 7</span>
          </div>
          <ol class="sf__gates">
            @for (g of gates; track g.name; let i = $index) {
              <li [style.--i]="i">
                <span class="sf__num">{{ i + 1 }}</span>
                <span class="sf__gate">
                  <b>{{ g.name }}</b>
                  <small>{{ g.detail }}</small>
                </span>
                <span class="sf__tick">
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m6 12.5 4 4 8-9" />
                  </svg>
                </span>
              </li>
            }
          </ol>
          <p class="sf__foot">
            Limits are enforced by the terminal itself — not only by the server that sent the
            signal.
          </p>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .sf {
        --lp-ink: #f5f5f7;
        --lp-ink-2: #b4b4bd;
        --lp-ink-3: #7c7c86;
        --lp-blue: #4d97ff;
        position: relative;
        overflow: hidden;
        padding: clamp(80px, 11vw, 140px) 0;
        color: var(--lp-ink);
        background: #05070c;
      }
      .sf__glow {
        position: absolute;
        inset: -30% -10% auto;
        height: 120%;
        background:
          radial-gradient(40% 40% at 75% 40%, rgba(61, 139, 255, 0.22), transparent 70%),
          radial-gradient(30% 30% at 20% 70%, rgba(123, 92, 255, 0.16), transparent 70%);
        pointer-events: none;
      }
      .sf__grid {
        position: relative;
        display: grid;
        grid-template-columns: 1.05fr 1fr;
        gap: clamp(40px, 6vw, 88px);
        align-items: center;
      }
      .sf__no {
        background: linear-gradient(110deg, #ff7a6b, #ff4d8d);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .sf__lede {
        margin: 20px 0 40px;
        max-width: 540px;
        font-size: clamp(17px, 1.5vw, 19px);
        line-height: 1.6;
        color: var(--lp-ink-2);
      }
      .sf__guards {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 28px 32px;
      }
      .sf__guard {
        padding-top: 18px;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
      }
      .sf__guard h3 {
        margin: 0 0 6px;
        font-size: 16px;
        font-weight: 650;
      }
      .sf__guard p {
        margin: 0;
        font-size: 14.5px;
        line-height: 1.55;
        color: var(--lp-ink-2);
      }
      .sf__panel {
        padding: 24px;
        border-radius: 24px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
        border: 1px solid rgba(255, 255, 255, 0.1);
        box-shadow:
          0 1px 0 rgba(255, 255, 255, 0.08) inset,
          0 40px 80px -30px rgba(0, 40, 140, 0.6);
        backdrop-filter: blur(20px);
      }
      .sf__panelhead {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
        padding: 0 4px;
        font-size: 13px;
        font-weight: 600;
        color: var(--lp-ink-3);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .sf__ok {
        padding: 4px 10px;
        border-radius: 999px;
        text-transform: none;
        letter-spacing: 0;
        color: #22c983;
        background: rgba(34, 201, 131, 0.12);
        opacity: 0;
        transition: opacity 0.5s 2.3s;
      }
      .sf__gates {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .sf__gates li {
        display: grid;
        grid-template-columns: 30px 1fr 26px;
        gap: 14px;
        align-items: center;
        padding: 12px 14px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.06);
        transition:
          background-color 0.4s,
          border-color 0.4s;
        transition-delay: calc(var(--i) * 280ms + 300ms);
      }
      .sf__num {
        display: grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 9px;
        font-size: 13px;
        font-weight: 700;
        color: var(--lp-ink-2);
        background: rgba(255, 255, 255, 0.06);
      }
      .sf__gate b {
        display: block;
        font-size: 15px;
        font-weight: 600;
      }
      .sf__gate small {
        display: block;
        margin-top: 2px;
        font-size: 13px;
        line-height: 1.4;
        color: var(--lp-ink-3);
      }
      .sf__tick {
        display: grid;
        place-items: center;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        color: #04110b;
        background: #22c983;
        transform: scale(0.4);
        opacity: 0;
        transition:
          transform 0.45s cubic-bezier(0.34, 1.56, 0.64, 1),
          opacity 0.3s;
        transition-delay: calc(var(--i) * 280ms + 300ms);
      }
      .sf__panel.is-in .sf__tick {
        transform: none;
        opacity: 1;
      }
      .sf__panel.is-in li {
        background: rgba(34, 201, 131, 0.06);
        border-color: rgba(34, 201, 131, 0.18);
      }
      .sf__panel.is-in .sf__ok {
        opacity: 1;
      }
      .sf__foot {
        margin: 16px 4px 0;
        font-size: 13px;
        color: var(--lp-ink-3);
      }
      @media (prefers-reduced-motion: reduce) {
        .sf__tick,
        .sf__ok,
        .sf__gates li {
          transition: none;
        }
      }
      @media (max-width: 960px) {
        .sf__grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 520px) {
        .sf__guards {
          grid-template-columns: 1fr;
        }
        .sf__panel {
          padding: 16px;
        }
      }
    `,
  ],
})
export class LandingSafetyComponent {
  protected readonly gates = GATES;
  protected readonly safeguards = SAFEGUARDS;
}
