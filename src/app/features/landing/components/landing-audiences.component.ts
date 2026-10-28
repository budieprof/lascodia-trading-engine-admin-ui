import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';

import { AUDIENCES } from '../landing.content';
import { RevealDirective } from '../reveal.directive';
import { LandingIconComponent } from './landing-icon.component';

/** "Who it's for": WAI-ARIA tabs (arrow keys, Home / End, roving tabindex) over the four audiences. */
@Component({
  selector: 'lp-audiences',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RevealDirective, LandingIconComponent],
  template: `
    <section class="lp-section" id="solutions" aria-labelledby="lp-aud-title">
      <div class="lp-container">
        <header class="lp-head" lpReveal>
          <p class="lp-eyebrow">Who it’s for</p>
          <h2 class="lp-h2" id="lp-aud-title">One platform, shaped to how you trade.</h2>
          <p class="lp-lede">
            Start as a single trader. Grow into a desk, a prop programme, a dealing desk or a fund —
            on the same engine, with modules switched on as you need them.
          </p>
        </header>

        <div class="au" lpReveal="100">
          <div class="au__tabs" role="tablist" aria-label="Audiences">
            @for (a of audiences; track a.id; let i = $index) {
              <button
                type="button"
                role="tab"
                class="au__tab"
                [id]="'lp-tab-' + a.id"
                [attr.aria-selected]="active() === i"
                [attr.aria-controls]="'lp-panel-' + a.id"
                [attr.tabindex]="active() === i ? 0 : -1"
                (click)="active.set(i)"
                (keydown)="onKey($event)"
              >
                <lp-icon [name]="a.icon" [size]="18" />
                {{ a.label }}
              </button>
            }
          </div>

          <!-- Keyed on the tab so the panel is re-created and its entry animation replays. -->
          @for (a of [current()]; track a.id) {
            <div
              class="lp-card au__panel"
              role="tabpanel"
              [id]="'lp-panel-' + a.id"
              [attr.aria-labelledby]="'lp-tab-' + a.id"
              tabindex="0"
            >
              <div class="au__copy">
                <h3>{{ a.headline }}</h3>
                <p>{{ a.body }}</p>
                <ul class="lp-checks">
                  @for (p of a.points; track p) {
                    <li>{{ p }}</li>
                  }
                </ul>
              </div>
              <div class="au__art" aria-hidden="true">
                <span class="au__orb"><lp-icon [name]="a.icon" [size]="44" /></span>
                <span class="au__ring au__ring--1"></span>
                <span class="au__ring au__ring--2"></span>
                <span class="au__ring au__ring--3"></span>
              </div>
            </div>
          }
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .au__tabs {
        display: flex;
        justify-content: center;
        gap: 6px;
        width: fit-content;
        max-width: 100%;
        margin: 0 auto 28px;
        padding: 6px;
        border-radius: 999px;
        background: var(--lp-bg-alt);
        border: 1px solid var(--lp-line);
        overflow-x: auto;
        scrollbar-width: none;
      }
      .au__tab {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 42px;
        padding: 0 18px;
        border: 0;
        border-radius: 999px;
        font: inherit;
        font-size: 15px;
        font-weight: 600;
        white-space: nowrap;
        color: var(--lp-ink-2);
        background: transparent;
        cursor: pointer;
        transition:
          background-color 0.25s,
          color 0.25s,
          box-shadow 0.25s;
      }
      .au__tab:hover {
        color: var(--lp-ink);
      }
      .au__tab[aria-selected='true'] {
        color: var(--lp-ink);
        background: var(--lp-card);
        box-shadow: var(--lp-shadow);
      }
      .au__tab:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--lp-blue) 45%, transparent);
        outline-offset: 2px;
      }
      .au__panel {
        display: grid;
        grid-template-columns: 1.2fr 1fr;
        gap: 40px;
        align-items: center;
        padding: clamp(28px, 4vw, 56px);
        animation: au-in 0.45s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .au__panel:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--lp-blue) 45%, transparent);
        outline-offset: 3px;
      }
      h3 {
        margin: 0 0 14px;
        font-size: clamp(24px, 2.6vw, 32px);
        line-height: 1.15;
        font-weight: 700;
        letter-spacing: -0.025em;
      }
      .au__copy > p {
        margin: 0 0 24px;
        font-size: 17px;
        line-height: 1.6;
        color: var(--lp-ink-2);
      }
      .au__art {
        position: relative;
        display: grid;
        place-items: center;
        min-height: 260px;
      }
      .au__orb {
        position: relative;
        z-index: 1;
        display: grid;
        place-items: center;
        width: 112px;
        height: 112px;
        border-radius: 32px;
        color: #fff;
        background: var(--lp-grad);
        box-shadow: 0 30px 60px -20px color-mix(in srgb, var(--lp-blue) 70%, transparent);
      }
      .au__ring {
        position: absolute;
        border-radius: 50%;
        border: 1px solid var(--lp-line-strong);
        animation: au-breathe 6s ease-in-out infinite;
      }
      .au__ring--1 {
        width: 180px;
        height: 180px;
      }
      .au__ring--2 {
        width: 250px;
        height: 250px;
        animation-delay: -2s;
        opacity: 0.7;
      }
      .au__ring--3 {
        width: 320px;
        height: 320px;
        animation-delay: -4s;
        opacity: 0.4;
      }
      @keyframes au-in {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
      }
      @keyframes au-breathe {
        50% {
          transform: scale(1.05);
        }
      }
      @media (max-width: 860px) {
        .au__panel {
          grid-template-columns: 1fr;
        }
        .au__art {
          display: none;
        }
        .au__tabs {
          justify-content: flex-start;
        }
      }
    `,
  ],
})
export class LandingAudiencesComponent {
  protected readonly audiences = AUDIENCES;
  protected readonly active = signal(0);
  protected readonly current = computed(() => this.audiences[this.active()]);

  protected onKey(e: KeyboardEvent): void {
    const n = this.audiences.length;
    const moves: Record<string, number> = {
      ArrowRight: (this.active() + 1) % n,
      ArrowLeft: (this.active() - 1 + n) % n,
      Home: 0,
      End: n - 1,
    };
    const next = moves[e.key];
    if (next === undefined) return;
    e.preventDefault();
    this.active.set(next);
    const id = `lp-tab-${this.audiences[next].id}`;
    (e.currentTarget as HTMLElement).parentElement?.querySelector<HTMLElement>(`#${id}`)?.focus();
  }
}
