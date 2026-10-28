import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { FAQS, PLANS, SALES_EMAIL, SECURITY } from '../landing.content';
import type { PrimaryCta } from '../landing.logic';
import { RevealDirective } from '../reveal.directive';
import { LandingIconComponent } from './landing-icon.component';

/** Security & governance, plans, and the FAQ — the sections a buyer reads last before deciding. */
@Component({
  selector: 'lp-trust',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RevealDirective, LandingIconComponent],
  template: `
    <section class="lp-section" id="security" aria-labelledby="lp-sec-title">
      <div class="lp-container">
        <header class="lp-head" lpReveal>
          <p class="lp-eyebrow">Security & governance</p>
          <h2 class="lp-h2" id="lp-sec-title">Controls your compliance team will actually like.</h2>
          <p class="lp-lede">
            Access, approvals and evidence are part of the platform, not an afterthought bolted onto
            it.
          </p>
        </header>
        <div class="sec">
          @for (s of security; track s.title; let i = $index) {
            <div class="sec__item" [lpReveal]="(i % 3) * 80">
              <span class="lp-icon-tile"><lp-icon [name]="s.icon" /></span>
              <h3>{{ s.title }}</h3>
              <p>{{ s.body }}</p>
            </div>
          }
        </div>
      </div>
    </section>

    <section class="lp-section lp-section--alt" id="plans" aria-labelledby="lp-plans-title">
      <div class="lp-container">
        <header class="lp-head" lpReveal>
          <p class="lp-eyebrow">Plans</p>
          <h2 class="lp-h2" id="lp-plans-title">Start free. Scale when you’re ready.</h2>
          <p class="lp-lede">
            Every organisation starts on the Trial. When you need more accounts, people or modules,
            we size a plan around your desk.
          </p>
        </header>
        <div class="pl">
          @for (p of plans; track p.name; let i = $index) {
            <article
              class="lp-card pl__card"
              [class.pl__card--featured]="p.featured"
              [lpReveal]="i * 90"
            >
              @if (p.featured) {
                <span class="pl__badge">For growing desks</span>
              }
              <h3>{{ p.name }}</h3>
              <p class="pl__blurb">{{ p.blurb }}</p>
              <p class="pl__price">
                <b>{{ p.price }}</b
                ><small>{{ p.priceNote }}</small>
              </p>
              @if (p.cta === 'contact' && salesEmail) {
                <a
                  class="lp-btn lp-btn--ghost pl__btn"
                  [href]="'mailto:' + salesEmail + '?subject=Lascodia%20' + p.name"
                >
                  Talk to us
                </a>
              } @else {
                <a
                  class="lp-btn pl__btn"
                  [class.lp-btn--primary]="p.cta === 'primary' || p.featured"
                  [class.lp-btn--ghost]="p.cta !== 'primary' && !p.featured"
                  [routerLink]="cta().route"
                >
                  {{
                    cta().kind !== 'signup'
                      ? 'Request access'
                      : p.cta === 'primary'
                        ? cta().label
                        : 'Start with the Trial'
                  }}
                </a>
              }
              <ul class="lp-checks">
                @for (pt of p.points; track pt) {
                  <li>{{ pt }}</li>
                }
              </ul>
            </article>
          }
        </div>
      </div>
    </section>

    <section class="lp-section" id="faq" aria-labelledby="lp-faq-title">
      <div class="lp-container faq">
        <header class="faq__head" lpReveal>
          <p class="lp-eyebrow">Questions</p>
          <h2 class="lp-h2" id="lp-faq-title">Good questions, straight answers.</h2>
        </header>
        <div class="faq__list" lpReveal="100">
          @for (f of faqs; track f.q) {
            <details class="faq__item">
              <summary>
                {{ f.q }}
                <span class="faq__plus" aria-hidden="true"></span>
              </summary>
              <p>{{ f.a }}</p>
            </details>
          }
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .sec {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 48px 40px;
      }
      .sec__item h3 {
        margin: 18px 0 8px;
        font-size: 18px;
        font-weight: 650;
        letter-spacing: -0.015em;
      }
      .sec__item p {
        margin: 0;
        font-size: 15.5px;
        line-height: 1.6;
        color: var(--lp-ink-2);
      }

      .pl {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 20px;
        align-items: stretch;
      }
      .pl__card {
        display: flex;
        flex-direction: column;
        padding: 32px;
      }
      .pl__card--featured {
        border: 1px solid transparent;
        background:
          linear-gradient(var(--lp-card), var(--lp-card)) padding-box,
          var(--lp-grad) border-box;
        box-shadow: var(--lp-shadow-lg);
      }
      .pl__badge {
        position: absolute;
        top: -13px;
        left: 32px;
        padding: 5px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        color: #fff;
        background: var(--lp-grad);
      }
      .pl__card h3 {
        margin: 0 0 8px;
        font-size: 22px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .pl__blurb {
        margin: 0 0 24px;
        min-height: 48px;
        font-size: 15px;
        line-height: 1.55;
        color: var(--lp-ink-2);
      }
      .pl__price {
        margin: 0 0 24px;
      }
      .pl__price b {
        display: block;
        font-size: 40px;
        font-weight: 700;
        letter-spacing: -0.035em;
        line-height: 1.1;
      }
      .pl__price small {
        font-size: 14px;
        color: var(--lp-ink-3);
      }
      .pl__btn {
        width: 100%;
        margin-bottom: 28px;
      }

      .faq {
        display: grid;
        grid-template-columns: 0.8fr 1.2fr;
        gap: clamp(32px, 6vw, 96px);
        align-items: start;
      }
      .faq__head {
        position: sticky;
        top: 96px;
      }
      .faq__list {
        border-top: 1px solid var(--lp-line-strong);
      }
      .faq__item {
        border-bottom: 1px solid var(--lp-line-strong);
      }
      summary {
        position: relative;
        display: flex;
        justify-content: space-between;
        gap: 24px;
        padding: 24px 0;
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.01em;
        list-style: none;
        cursor: pointer;
      }
      summary::-webkit-details-marker {
        display: none;
      }
      summary:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--lp-blue) 45%, transparent);
        outline-offset: 4px;
        border-radius: 6px;
      }
      .faq__plus {
        position: relative;
        flex: none;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--lp-bg-alt);
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .faq__plus::before,
      .faq__plus::after {
        content: '';
        position: absolute;
        left: 50%;
        top: 50%;
        width: 12px;
        height: 2px;
        border-radius: 2px;
        background: var(--lp-ink);
        transform: translate(-50%, -50%);
      }
      .faq__plus::after {
        transform: translate(-50%, -50%) rotate(90deg);
      }
      .faq__item[open] .faq__plus {
        transform: rotate(45deg);
      }
      .faq__item p {
        margin: -6px 0 26px;
        max-width: 640px;
        font-size: 16px;
        line-height: 1.65;
        color: var(--lp-ink-2);
      }

      @media (max-width: 960px) {
        .sec,
        .pl {
          grid-template-columns: 1fr 1fr;
        }
        .pl__card:last-child {
          grid-column: 1 / -1;
        }
        .faq {
          grid-template-columns: 1fr;
        }
        .faq__head {
          position: static;
        }
      }
      @media (max-width: 640px) {
        .sec,
        .pl {
          grid-template-columns: 1fr;
        }
        .pl__card {
          padding: 24px;
        }
        .pl__card:last-child {
          grid-column: auto;
        }
        summary {
          font-size: 16.5px;
          padding: 20px 0;
        }
      }
    `,
  ],
})
export class LandingTrustComponent {
  readonly cta = input.required<PrimaryCta>();

  protected readonly security = SECURITY;
  protected readonly plans = PLANS;
  protected readonly faqs = FAQS;
  protected readonly salesEmail = SALES_EMAIL;
}
