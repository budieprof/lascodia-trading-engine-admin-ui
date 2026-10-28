import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { STEPS } from '../landing.content';
import type { PrimaryCta } from '../landing.logic';
import { RevealDirective } from '../reveal.directive';

/**
 * Onboarding: the four steps of the console's Get started checklist, beside an illustration of the guided
 * terminal connection following a terminal from token to first heartbeat (the wizard's real stages).
 */
@Component({
  selector: 'lp-onboarding',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RevealDirective],
  template: `
    <section class="lp-section lp-section--alt" id="get-started" aria-labelledby="lp-ob-title">
      <div class="lp-container">
        <header class="lp-head" lpReveal>
          <p class="lp-eyebrow">Get started</p>
          <h2 class="lp-h2" id="lp-ob-title">
            From sign-up to a live chart in <span class="lp-grad-text">four steps</span>.
          </h2>
          <p class="lp-lede">
            No installers to chase and no tickets to raise. The console walks you through every step
            and ticks each one off as you finish it.
          </p>
        </header>

        <div class="ob">
          <ol class="ob__steps">
            @for (s of steps; track s.title; let i = $index) {
              <li class="ob__step" [lpReveal]="i * 90">
                <span class="ob__n" aria-hidden="true">{{ i + 1 }}</span>
                <div>
                  <h3>{{ s.title }}</h3>
                  <p>{{ s.body }}</p>
                  <span class="ob__detail">{{ s.detail }}</span>
                </div>
              </li>
            }
          </ol>

          <div class="ob__wiz lp-card" lpReveal="160" aria-hidden="true">
            <div class="ob__wizhead">
              <span class="ob__wiztitle">Connect a terminal</span>
              <span class="ob__wizstep">Step 4 of 4</span>
            </div>
            <div class="ob__token">
              <small>Enrollment token · shown once</small>
              <code>••••-••••-••••-7Q2F</code>
            </div>
            <ul class="ob__prog">
              @for (p of progress; track p; let i = $index) {
                <li [style.--i]="i"><i></i>{{ p }}</li>
              }
            </ul>
            <div class="ob__done">
              <span class="ob__dot"></span>
              <span><b>Connected</b><small>First heartbeat received</small></span>
            </div>
          </div>
        </div>

        <div class="ob__cta" lpReveal>
          <a class="lp-btn lp-btn--primary" [routerLink]="cta().route">
            {{ cta().kind === 'signup' ? 'Create your organisation' : cta().label }}
            <span class="lp-arrow" aria-hidden="true">→</span>
          </a>
          @if (demoAvailable()) {
            <a class="lp-btn lp-btn--ghost" routerLink="/demo">Explore the demo first</a>
          }
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .ob {
        display: grid;
        grid-template-columns: 1.1fr 1fr;
        gap: clamp(32px, 5vw, 72px);
        align-items: center;
      }
      .ob__steps {
        position: relative;
        display: grid;
        gap: 12px;
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .ob__step {
        display: grid;
        grid-template-columns: 44px 1fr;
        gap: 18px;
        padding: 20px;
        border-radius: 20px;
        transition: background-color 0.3s;
      }
      .ob__step:hover {
        background: var(--lp-card);
      }
      .ob__n {
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        border-radius: 14px;
        font-size: 17px;
        font-weight: 700;
        color: var(--lp-blue);
        background: var(--lp-card);
        border: 1px solid var(--lp-line-strong);
        box-shadow: var(--lp-shadow);
      }
      h3 {
        margin: 2px 0 6px;
        font-size: 19px;
        font-weight: 650;
        letter-spacing: -0.015em;
      }
      .ob__step p {
        margin: 0 0 10px;
        font-size: 15.5px;
        line-height: 1.55;
        color: var(--lp-ink-2);
      }
      .ob__detail {
        display: inline-block;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 12.5px;
        font-weight: 600;
        color: var(--lp-ink-2);
        background: color-mix(in srgb, var(--lp-ink) 6%, transparent);
      }
      .ob__wiz {
        padding: 28px;
        border-radius: 28px;
        box-shadow: var(--lp-shadow-lg);
      }
      .ob__wizhead {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
      }
      .ob__wiztitle {
        font-size: 18px;
        font-weight: 650;
      }
      .ob__wizstep {
        font-size: 13px;
        color: var(--lp-ink-3);
      }
      .ob__token {
        padding: 14px 16px;
        margin-bottom: 20px;
        border-radius: 14px;
        background: var(--lp-bg-alt);
        border: 1px dashed var(--lp-line-strong);
      }
      .ob__token small {
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        color: var(--lp-ink-3);
      }
      .ob__token code {
        font-family: ui-monospace, 'SF Mono', Menlo, monospace;
        font-size: 14px;
      }
      .ob__prog {
        display: grid;
        gap: 12px;
        margin: 0 0 22px;
        padding: 0;
        list-style: none;
      }
      .ob__prog li {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 15px;
        color: var(--lp-ink-3);
        transition: color 0.4s;
        transition-delay: calc(var(--i) * 450ms + 300ms);
      }
      .ob__prog i {
        position: relative;
        flex: none;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        border: 2px solid var(--lp-line-strong);
        transition:
          background-color 0.4s,
          border-color 0.4s;
        transition-delay: inherit;
      }
      .ob__prog i::after {
        content: '';
        position: absolute;
        inset: 0;
        background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 12.5 4 4 8-9'/%3E%3C/svg%3E")
          center / 12px no-repeat;
        opacity: 0;
        transition: opacity 0.3s;
        transition-delay: inherit;
      }
      .ob__wiz.is-in .ob__prog li {
        color: var(--lp-ink);
      }
      .ob__wiz.is-in .ob__prog i {
        background: var(--lp-green);
        border-color: var(--lp-green);
      }
      .ob__wiz.is-in .ob__prog i::after {
        opacity: 1;
      }
      .ob__done {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 16px;
        border-radius: 16px;
        background: color-mix(in srgb, var(--lp-green) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--lp-green) 30%, transparent);
        opacity: 0.35;
        transition: opacity 0.5s 2.2s;
      }
      .ob__wiz.is-in .ob__done {
        opacity: 1;
      }
      .ob__done b {
        display: block;
        font-size: 15px;
      }
      .ob__done small {
        font-size: 13px;
        color: var(--lp-ink-2);
      }
      .ob__dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--lp-green);
        box-shadow: 0 0 0 6px color-mix(in srgb, var(--lp-green) 20%, transparent);
      }
      .ob__cta {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 12px;
        margin-top: 56px;
      }
      @media (max-width: 900px) {
        .ob {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 520px) {
        .ob__step {
          padding: 14px 4px;
          gap: 14px;
        }
        .ob__wiz {
          padding: 20px;
        }
      }
    `,
  ],
})
export class LandingOnboardingComponent {
  readonly cta = input.required<PrimaryCta>();
  readonly demoAvailable = input(false);

  protected readonly steps = STEPS;
  protected readonly progress = ['Token used', 'Signed in', 'Registered', 'First heartbeat'];
}
