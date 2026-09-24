import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

import type { AuthoringMode } from './authoring-mode';

/**
 * "Rules (visual builder)" | "Script (Pine v6)" — how a RuleBased strategy is authored. Fixed
 * once the strategy exists: a rule strategy and a script strategy are different things on the
 * engine side (the script's live session, bindings and emulator), so switching is a new strategy.
 */
@Component({
  selector: 'app-authoring-mode-switch',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="authoring">
      <span class="label" id="authoring-mode-label">Authoring</span>
      <div class="segmented" role="radiogroup" aria-labelledby="authoring-mode-label">
        <button
          type="button"
          role="radio"
          class="seg"
          [class.is-active]="mode() === 'rules'"
          [attr.aria-checked]="mode() === 'rules'"
          [disabled]="locked() && mode() !== 'rules'"
          (click)="choose('rules')"
        >
          Rules <span class="sub">visual builder</span>
        </button>
        <button
          type="button"
          role="radio"
          class="seg"
          [class.is-active]="mode() === 'script'"
          [attr.aria-checked]="mode() === 'script'"
          [disabled]="locked() && mode() !== 'script'"
          (click)="choose('script')"
        >
          Script <span class="sub">Pine v6</span>
        </button>
      </div>
      @if (locked()) {
        <span class="hint">Fixed for an existing strategy.</span>
      } @else if (mode() === 'script') {
        <span class="hint">Write the strategy in Pine Script v6 — compiled and run by the engine.</span>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        margin-bottom: var(--space-3, 12px);
      }
      .authoring {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px 12px;
      }
      .label {
        font-size: var(--text-sm, 13px);
        font-weight: var(--font-medium, 500);
        color: var(--text-secondary);
      }
      .segmented {
        display: inline-flex;
        padding: 2px;
        border-radius: 9px;
        background: var(--bg-tertiary);
      }
      .seg {
        height: 28px;
        padding: 0 12px;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: var(--text-secondary);
        font: inherit;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      .seg .sub {
        font-weight: 400;
        opacity: 0.75;
      }
      .seg.is-active {
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
      }
      .seg:disabled {
        cursor: not-allowed;
        opacity: 0.45;
      }
      .hint {
        font-size: 11px;
        color: var(--text-tertiary);
      }
    `,
  ],
})
export class AuthoringModeSwitchComponent {
  readonly mode = model<AuthoringMode>('rules');
  /** An existing strategy's mode cannot change. */
  readonly locked = input(false);

  choose(mode: AuthoringMode): void {
    if (this.locked()) return;
    this.mode.set(mode);
  }
}
