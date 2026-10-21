import { ChangeDetectionStrategy, Component, ViewEncapsulation, input } from '@angular/core';

import { LogoComponent } from '@shared/components/logo/logo.component';

/**
 * The frame of every page a person sees before the console: sign-in, accepting an invitation,
 * creating an organisation. A brand panel beside the page's content on wide screens, a compact
 * brand bar above it on narrow ones.
 *
 * Keycloak's sign-in pages draw the same frame (engine repo, deploy/keycloak/themes/lascodia), so
 * going from here to Keycloak and back looks like one product. Keep the copy, the art
 * (`public/sign-in-art.svg` = the theme's `brand-art.svg`) and the proportions in step with it.
 *
 * Encapsulation is off so the `.si-*` classes below style the projected page content too: every
 * page uses the same title, field, button and alert classes. All selectors carry the `si-` prefix.
 */
@Component({
  selector: 'app-sign-in-shell',
  standalone: true,
  imports: [LogoComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    <div class="si-shell">
      <aside class="si-brand" aria-label="Lascodia">
        <div class="si-brand__top">
          <app-logo [size]="36" class="si-brand__mark" />
          <span class="si-brand__name">Lascodia</span>
        </div>
        <div class="si-brand__copy">
          <p class="si-brand__eyebrow">Lascodia Trading Engine</p>
          <p class="si-brand__headline">Signals, risk and execution in one console.</p>
          <p class="si-brand__lede">
            Watch the fleet, review every signal and keep risk inside its limits, across all of your
            accounts.
          </p>
        </div>
        @if (secured()) {
          <p class="si-brand__foot">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v6A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5v-6A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm2 5H6V4.5a2 2 0 1 1 4 0V6Z"
              />
            </svg>
            Protected by multi-factor sign-in
          </p>
        }
      </aside>

      <main class="si-main">
        <div class="si-panel">
          <div class="si-compact-brand">
            <app-logo [size]="32" />
            <span>Lascodia</span>
          </div>
          <ng-content />
        </div>
      </main>
    </div>
  `,
  styles: [
    `
      .si-shell {
        display: grid;
        grid-template-columns: minmax(440px, 46%) minmax(0, 1fr);
        min-height: 100vh;
        background: var(--bg-primary);
        color: var(--text-primary);
      }

      /* ── Brand panel ─────────────────────────────────────────── */
      .si-brand {
        position: relative;
        overflow: hidden;
        isolation: isolate;
        display: flex;
        flex-direction: column;
        padding: 40px 56px 36px;
        color: #fff;
        background:
          radial-gradient(900px 520px at 88% -8%, rgba(59, 157, 255, 0.34), transparent 62%),
          radial-gradient(700px 480px at -12% 108%, rgba(0, 87, 216, 0.42), transparent 64%),
          linear-gradient(162deg, #050d22 0%, #0a1c45 52%, #0c2a6a 100%);
      }
      .si-brand::after {
        content: '';
        position: absolute;
        inset: auto 0 0 0;
        height: 58%;
        z-index: -1;
        background: url('/sign-in-art.svg') center bottom / cover no-repeat;
        pointer-events: none;
      }
      .si-brand__top {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .si-brand__mark {
        filter: drop-shadow(0 6px 14px rgba(0, 87, 216, 0.45));
      }
      .si-brand__name {
        font-size: 19px;
        font-weight: var(--font-semibold);
        letter-spacing: -0.01em;
      }
      .si-brand__copy {
        margin-top: clamp(48px, 13vh, 150px);
        max-width: 30rem;
      }
      .si-brand__eyebrow {
        margin: 0 0 14px;
        font-size: 12px;
        font-weight: var(--font-semibold);
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.62);
      }
      .si-brand__headline {
        margin: 0;
        font-size: clamp(30px, 2.6vw, 40px);
        font-weight: var(--font-semibold);
        line-height: 1.12;
        letter-spacing: -0.025em;
        text-wrap: balance;
      }
      .si-brand__lede {
        margin: 18px 0 0;
        max-width: 26rem;
        font-size: 15px;
        line-height: 1.55;
        color: rgba(255, 255, 255, 0.74);
      }
      .si-brand__foot {
        margin: auto 0 0;
        align-self: flex-start;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 12px;
        border-radius: var(--radius-full);
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(5, 13, 34, 0.45);
        backdrop-filter: blur(8px);
        font-size: 12px;
        color: rgba(255, 255, 255, 0.8);
      }

      /* ── Content column ──────────────────────────────────────── */
      .si-main {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        padding: 48px 32px;
      }
      .si-panel {
        width: 100%;
        max-width: 400px;
        display: flex;
        flex-direction: column;
      }
      .si-compact-brand {
        display: none;
        align-items: center;
        gap: 10px;
        margin-bottom: 36px;
        font-size: 18px;
        font-weight: var(--font-semibold);
        letter-spacing: -0.01em;
      }

      @media (max-width: 960px) {
        .si-shell {
          grid-template-columns: minmax(0, 1fr);
          background:
            radial-gradient(640px 320px at 50% -120px, rgba(0, 113, 227, 0.14), transparent 70%),
            var(--bg-primary);
        }
        .si-brand {
          display: none;
        }
        .si-main {
          align-items: flex-start;
          padding: 40px 20px 32px;
        }
        .si-compact-brand {
          display: flex;
        }
      }

      /* ── Page content (projected) ────────────────────────────── */
      .si-title {
        margin: 0;
        font-size: 30px;
        font-weight: var(--font-semibold);
        line-height: 1.15;
        letter-spacing: -0.022em;
        color: var(--text-primary);
      }
      @media (max-width: 960px) {
        .si-title {
          font-size: 26px;
        }
      }
      .si-subtitle {
        margin: 8px 0 0;
        font-size: 15px;
        line-height: 1.47;
        color: var(--text-secondary);
      }
      .si-body {
        display: flex;
        flex-direction: column;
        gap: 20px;
        margin-top: 28px;
        font-size: 15px;
        line-height: 1.5;
      }
      .si-body p {
        margin: 0;
      }
      .si-form {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .si-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .si-field > label,
      .si-field__label {
        font-size: 13px;
        font-weight: var(--font-medium);
        color: var(--text-secondary);
      }
      .si-field__hint {
        font-size: 12px;
        font-weight: normal;
        color: var(--text-secondary);
      }
      .si-input {
        height: 46px;
        padding: 0 14px;
        border: 1px solid var(--si-input-border, #d2d2d7);
        border-radius: 10px;
        background: var(--bg-primary);
        color: var(--text-primary);
        font: inherit;
        font-size: 15px;
        outline: none;
        transition:
          border-color var(--dur-fast) ease,
          box-shadow var(--dur-fast) ease;
      }
      [data-theme='dark'] .si-input {
        --si-input-border: #3a3a3c;
        background: var(--bg-secondary);
      }
      .si-input:hover {
        border-color: var(--text-tertiary);
      }
      .si-input:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.22);
      }
      .si-input::placeholder {
        color: var(--text-tertiary);
      }

      .si-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        width: 100%;
        min-height: 46px;
        padding: 11px 20px;
        border: 1px solid transparent;
        border-radius: var(--radius-full);
        background: transparent;
        color: var(--text-primary);
        font: inherit;
        font-size: 15px;
        font-weight: var(--font-medium);
        text-decoration: none;
        cursor: pointer;
        transition:
          background-color var(--dur-fast) ease,
          border-color var(--dur-fast) ease,
          transform 0.1s ease;
      }
      .si-btn:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .si-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .si-btn--primary {
        background: var(--accent);
        color: #fff;
        box-shadow:
          0 1px 2px rgba(0, 0, 0, 0.08),
          0 8px 20px -10px rgba(0, 113, 227, 0.7);
      }
      .si-btn--primary:hover:not(:disabled) {
        background: var(--accent-hover);
      }
      .si-btn--primary:active:not(:disabled) {
        transform: scale(0.985);
      }
      .si-btn--secondary {
        border-color: var(--si-input-border, #d2d2d7);
      }
      [data-theme='dark'] .si-btn--secondary {
        --si-input-border: #3a3a3c;
      }
      .si-btn--secondary:hover:not(:disabled) {
        background: var(--bg-secondary);
      }
      .si-actions {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .si-alert {
        margin: 0;
        padding: 12px 14px;
        border: 1px solid rgba(0, 113, 227, 0.22);
        border-radius: 12px;
        background: rgba(0, 113, 227, 0.08);
        font-size: 14px;
        line-height: 1.45;
        color: var(--text-primary);
      }
      .si-alert--danger {
        border-color: rgba(255, 59, 48, 0.28);
        background: rgba(255, 59, 48, 0.08);
      }
      .si-alert--success {
        border-color: rgba(52, 199, 89, 0.3);
        background: rgba(52, 199, 89, 0.1);
      }
      .si-alert ul {
        margin: 0;
        padding-left: 18px;
      }

      .si-note {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-secondary);
      }
      .si-note svg {
        flex: none;
        margin-top: 2px;
      }
      .si-foot {
        margin: 8px 0 0;
        padding-top: 20px;
        border-top: 1px solid var(--border);
        font-size: 14px;
        color: var(--text-secondary);
        text-align: center;
      }
      .si-link {
        color: var(--accent);
        text-decoration: none;
        font-weight: var(--font-medium);
      }
      .si-link:hover {
        text-decoration: underline;
        text-underline-offset: 3px;
      }

      .si-segmented {
        display: flex;
        gap: 4px;
        padding: 4px;
        border-radius: var(--radius-full);
        background: var(--bg-tertiary);
      }
      .si-segmented button {
        flex: 1;
        padding: 8px 16px;
        border: 0;
        border-radius: var(--radius-full);
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: 13px;
        font-weight: var(--font-medium);
        cursor: pointer;
      }
      .si-segmented button[aria-selected='true'] {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: var(--shadow-sm);
      }

      .si-spinner {
        width: 18px;
        height: 18px;
        border: 2px solid rgba(255, 255, 255, 0.35);
        border-top-color: #fff;
        border-radius: 50%;
        animation: si-spin 0.6s linear infinite;
      }
      @keyframes si-spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .si-spinner {
          animation-duration: 1.6s;
        }
      }
    `,
  ],
})
export class SignInShellComponent {
  /** Show "Protected by multi-factor sign-in": true only where sign-in really ends with a second factor. */
  readonly secured = input(true);
}
