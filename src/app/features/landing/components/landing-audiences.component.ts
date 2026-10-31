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
                <div class="au__mock">
                  @switch (a.id) {
                    @case ('traders') {
                      <header><b>Strategy subscriptions</b><small>Account · Demo 1</small></header>
                      @for (r of subs; track r.name) {
                        <div class="au__row">
                          <span
                            ><b>{{ r.name }}</b
                            ><small>{{ r.note }}</small></span
                          >
                          <em [class]="'au__tag au__tag--' + r.tone">{{ r.state }}</em>
                        </div>
                      }
                    }
                    @case ('prop') {
                      <header><b>Evaluation · Phase 1</b><small>Day 9 of 30</small></header>
                      @for (m of rules; track m.label) {
                        <div class="au__meter">
                          <span
                            ><b>{{ m.label }}</b
                            ><small>{{ m.value }}</small></span
                          >
                          <i><s [style.width.%]="m.pct" [class]="'au__fill--' + m.tone"></s></i>
                        </div>
                      }
                      <div class="au__note">Rules enforced at the terminal on every order</div>
                    }
                    @case ('brokers') {
                      <header><b>Markout by client segment</b><small>EURUSD · 60 s</small></header>
                      <svg viewBox="0 0 300 120" class="au__chart">
                        <line x1="0" y1="60" x2="300" y2="60" class="au__zero" />
                        <path d="M0 60 C40 58 70 30 120 24 S220 18 300 16" class="au__l1" />
                        <path d="M0 60 C50 62 90 70 140 74 S240 80 300 82" class="au__l2" />
                        <path d="M0 60 C60 59 120 56 180 55 S260 54 300 54" class="au__l3" />
                      </svg>
                      <div class="au__legend">
                        <span><i class="au__l1"></i>Informed</span>
                        <span><i class="au__l2"></i>Retail</span>
                        <span><i class="au__l3"></i>Neutral</span>
                      </div>
                      <div class="au__note">Suggestions are advisory — your desk decides</div>
                    }
                    @case ('funds') {
                      <header>
                        <b>Performance statement</b><small>Q3 · Fund account group</small>
                      </header>
                      @for (r of statement; track r.label) {
                        <div class="au__row au__row--flat">
                          <span>{{ r.label }}</span
                          ><b>{{ r.value }}</b>
                        </div>
                      }
                      <div class="au__sig">
                        <span class="au__seal">✓</span>
                        <span><b>Signed download</b><small>Fingerprint 9f3a·c21e·77b0</small></span>
                      </div>
                    }
                  }
                </div>
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
      .au__mock {
        width: 100%;
        max-width: 420px;
        padding: 20px;
        border-radius: 20px;
        color: #e9eaf0;
        background:
          radial-gradient(120% 90% at 0% 0%, rgba(61, 139, 255, 0.18), transparent 60%),
          radial-gradient(90% 80% at 100% 100%, rgba(123, 92, 255, 0.16), transparent 60%), #0a0c12;
        border: 1px solid rgba(255, 255, 255, 0.08);
        box-shadow: 0 40px 80px -30px rgba(10, 40, 120, 0.55);
        font-size: 13px;
        animation: au-pop 0.6s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .au__mock header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 14px;
      }
      .au__mock b {
        font-weight: 600;
      }
      .au__mock small {
        display: block;
        font-size: 11.5px;
        color: #8d90a0;
      }
      .au__mock header small {
        display: inline;
      }
      .au__row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        margin-top: 8px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.035);
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .au__row--flat {
        margin-top: 6px;
        color: #b4b4bd;
      }
      .au__row--flat b {
        color: #f5f5f7;
        font-variant-numeric: tabular-nums;
      }
      .au__tag {
        font-style: normal;
        font-size: 11px;
        font-weight: 700;
        padding: 3px 9px;
        border-radius: 999px;
        white-space: nowrap;
      }
      .au__tag--on {
        color: #22c983;
        background: rgba(34, 201, 131, 0.14);
      }
      .au__tag--paper {
        color: #a9c8ff;
        background: rgba(61, 139, 255, 0.16);
      }
      .au__tag--test {
        color: #ffcf73;
        background: rgba(255, 184, 77, 0.14);
      }
      .au__meter {
        margin-top: 14px;
      }
      .au__meter span {
        display: flex;
        justify-content: space-between;
        margin-bottom: 7px;
      }
      .au__meter span small {
        display: inline;
      }
      .au__meter i {
        display: block;
        height: 6px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
      }
      .au__meter s {
        display: block;
        height: 100%;
        border-radius: 6px;
        animation: au-grow 1.1s cubic-bezier(0.16, 1, 0.3, 1) both 0.15s;
        transform-origin: 0 50%;
      }
      .au__fill--ok {
        background: linear-gradient(90deg, #22c983, #13c2e8);
      }
      .au__fill--warn {
        background: linear-gradient(90deg, #ffb84d, #ff6a3d);
      }
      .au__fill--goal {
        background: linear-gradient(90deg, #3d8bff, #7b5cff);
      }
      .au__note {
        margin-top: 16px;
        padding-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.07);
        font-size: 12px;
        color: #8d90a0;
      }
      .au__chart {
        width: 100%;
        height: 130px;
      }
      .au__chart path {
        fill: none;
        stroke-width: 2.5;
        stroke-linecap: round;
        stroke-dasharray: 400;
        animation: au-draw 1.6s cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      .au__zero {
        stroke: rgba(255, 255, 255, 0.12);
        stroke-dasharray: 4 4;
      }
      path.au__l1 {
        stroke: #ff5468;
      }
      path.au__l2 {
        stroke: #22c983;
        animation-delay: 0.15s;
      }
      path.au__l3 {
        stroke: #8d90a0;
        animation-delay: 0.3s;
      }
      .au__legend {
        display: flex;
        gap: 16px;
        font-size: 11.5px;
        color: #b4b4bd;
      }
      .au__legend i {
        display: inline-block;
        width: 10px;
        height: 3px;
        margin-right: 6px;
        border-radius: 2px;
        vertical-align: middle;
      }
      i.au__l1 {
        background: #ff5468;
      }
      i.au__l2 {
        background: #22c983;
      }
      i.au__l3 {
        background: #8d90a0;
      }
      .au__sig {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 16px;
        padding: 12px;
        border-radius: 12px;
        background: rgba(34, 201, 131, 0.08);
        border: 1px solid rgba(34, 201, 131, 0.25);
      }
      .au__seal {
        display: grid;
        place-items: center;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        font-weight: 800;
        color: #fff;
        background: linear-gradient(135deg, #22c983, #12a26a);
        box-shadow: 0 0 0 4px rgba(34, 201, 131, 0.15);
      }
      @keyframes au-pop {
        from {
          opacity: 0;
          transform: translateY(14px) scale(0.97);
        }
      }
      @keyframes au-grow {
        from {
          transform: scaleX(0);
        }
      }
      @keyframes au-draw {
        from {
          stroke-dashoffset: 400;
        }
        to {
          stroke-dashoffset: 0;
        }
      }
      @keyframes au-in {
        from {
          opacity: 0;
          transform: translateY(10px);
        }
      }
      @media (max-width: 860px) {
        .au__panel {
          grid-template-columns: 1fr;
        }
        .au__art {
          min-height: 0;
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

  // Illustrations for each panel — sample values, not customer data.
  protected readonly subs = [
    { name: 'RSI(2) reversion', note: 'Platform strategy', state: 'Live', tone: 'on' },
    { name: 'London breakout', note: 'Platform strategy', state: 'Paper', tone: 'paper' },
    { name: 'my_trend.pine', note: 'Your script', state: 'Backtesting', tone: 'test' },
  ];
  protected readonly rules = [
    { label: 'Daily loss', value: '1.2% of 5%', pct: 24, tone: 'ok' },
    { label: 'Max drawdown', value: '7.1% of 10%', pct: 71, tone: 'warn' },
    { label: 'Profit target', value: '5.6% of 8%', pct: 70, tone: 'goal' },
  ];
  protected readonly statement = [
    { label: 'Opening equity', value: '1,000,000.00' },
    { label: 'Net flows', value: '+250,000.00' },
    { label: 'Trades', value: '412' },
    { label: 'Best-execution report', value: 'Included' },
  ];
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
