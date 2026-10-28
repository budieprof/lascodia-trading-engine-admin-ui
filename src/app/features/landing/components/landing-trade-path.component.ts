import { ChangeDetectionStrategy, Component } from '@angular/core';

import { RevealDirective } from '../reveal.directive';

interface Hop {
  n: string;
  title: string;
  body: string;
  where: string;
}

const HOPS: Hop[] = [
  {
    n: '01',
    title: 'Signal',
    body: 'A strategy, a script or the analyst proposes a trade.',
    where: 'Engine',
  },
  {
    n: '02',
    title: 'Engine checks',
    body: 'Risk profile, exposure and viability are checked first.',
    where: 'Engine',
  },
  {
    n: '03',
    title: 'Seven gates',
    body: 'Your terminal re-checks every limit before it acts.',
    where: 'Your MT5',
  },
  {
    n: '04',
    title: 'Broker fill',
    body: 'The order is placed on your own account.',
    where: 'Your broker',
  },
  {
    n: '05',
    title: 'Reconciled',
    body: 'The fill is reported, matched and traced end to end.',
    where: 'Engine',
  },
];

/** "How a trade travels": five hops with a packet running along the line between them. */
@Component({
  selector: 'lp-trade-path',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RevealDirective],
  template: `
    <section class="lp-section" id="how-it-works" aria-labelledby="lp-path-title">
      <div class="lp-container">
        <header class="lp-head" lpReveal>
          <p class="lp-eyebrow">How it works</p>
          <h2 class="lp-h2" id="lp-path-title">
            Every trade travels the same <span class="lp-grad-text">careful path</span>.
          </h2>
          <p class="lp-lede">
            The engine decides; your own terminal executes. Risk is checked twice — once centrally
            and once at the terminal — so no single failure can push an order through.
          </p>
        </header>

        <div class="tp" lpReveal="120">
          <span class="tp__track" aria-hidden="true"><span class="tp__packet"></span></span>
          <ol class="tp__list">
            @for (h of hops; track h.n; let i = $index) {
              <li class="tp__hop" [class.tp__hop--key]="i === 2">
                <span class="tp__node" aria-hidden="true">{{ h.n }}</span>
                <span class="tp__where">{{ h.where }}</span>
                <h3>{{ h.title }}</h3>
                <p>{{ h.body }}</p>
              </li>
            }
          </ol>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .tp {
        position: relative;
      }
      .tp__list {
        position: relative;
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 16px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .tp__track {
        position: absolute;
        top: 27px;
        left: 10%;
        right: 10%;
        height: 2px;
        border-radius: 2px;
        background: linear-gradient(90deg, var(--lp-line-strong), var(--lp-line-strong));
        overflow: hidden;
      }
      .tp__packet {
        position: absolute;
        top: 0;
        left: -20%;
        width: 20%;
        height: 100%;
        background: linear-gradient(
          90deg,
          transparent,
          var(--lp-blue),
          var(--lp-cyan),
          transparent
        );
        animation: tp-run 3.6s cubic-bezier(0.65, 0, 0.35, 1) infinite;
      }
      .tp__hop {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 0 4px;
      }
      .tp__node {
        position: relative;
        z-index: 1;
        display: grid;
        place-items: center;
        width: 56px;
        height: 56px;
        margin-bottom: 18px;
        border-radius: 18px;
        font-size: 14px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--lp-ink);
        background: var(--lp-card);
        border: 1px solid var(--lp-line-strong);
        box-shadow: var(--lp-shadow);
      }
      .tp__hop--key .tp__node {
        color: #fff;
        border-color: transparent;
        background: var(--lp-grad);
        box-shadow: 0 14px 30px -10px color-mix(in srgb, var(--lp-blue) 70%, transparent);
      }
      .tp__where {
        margin-bottom: 6px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--lp-ink-3);
      }
      .tp__hop h3 {
        margin: 0 0 6px;
        font-size: 18px;
        font-weight: 650;
        letter-spacing: -0.015em;
      }
      .tp__hop p {
        margin: 0;
        max-width: 200px;
        font-size: 14.5px;
        line-height: 1.5;
        color: var(--lp-ink-2);
      }
      @keyframes tp-run {
        0% {
          left: -20%;
        }
        100% {
          left: 100%;
        }
      }
      @keyframes tp-run-y {
        0% {
          top: -20%;
        }
        100% {
          top: 100%;
        }
      }
      @media (max-width: 860px) {
        .tp__list {
          grid-template-columns: 1fr;
          gap: 28px;
        }
        .tp__track {
          top: 28px;
          bottom: 90px;
          left: 27px;
          right: auto;
          width: 2px;
          height: auto;
        }
        .tp__packet {
          left: 0;
          top: -20%;
          width: 100%;
          height: 20%;
          background: linear-gradient(
            180deg,
            transparent,
            var(--lp-blue),
            var(--lp-cyan),
            transparent
          );
          animation-name: tp-run-y;
        }
        .tp__hop {
          display: grid;
          grid-template-columns: 56px 1fr;
          column-gap: 18px;
          align-items: start;
          text-align: left;
          padding: 0;
        }
        .tp__node {
          grid-row: span 3;
          margin: 0;
        }
        .tp__where {
          margin: 4px 0 2px;
        }
        .tp__hop p {
          max-width: none;
        }
      }
    `,
  ],
})
export class LandingTradePathComponent {
  protected readonly hops = HOPS;
}
