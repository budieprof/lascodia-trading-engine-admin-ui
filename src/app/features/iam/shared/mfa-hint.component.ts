import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { AuthService } from '@core/auth/auth.service';
import { permissionDefinition } from '@core/auth/permissions.generated';
import { StepUpService, mfaIsFresh } from '@core/auth/step-up.service';

/**
 * The "confirm with MFA" affordance next to an action whose permission is a StepUp key (catalog
 * flag, contract C3.2). Without a recent second-factor sign-in it offers to do that first — the
 * person comes back to this page and then acts; with one it says the action will go straight
 * through. The engine enforces it either way: an action sent without a fresh factor is refused
 * with a step-up challenge, which the console also turns into a sign-in.
 */
@Component({
  selector: 'app-mfa-hint',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (required()) {
      @if (fresh()) {
        <span class="hint ok" title="Your last sign-in used a second factor less than five minutes ago.">
          Second factor confirmed
        </span>
      } @else {
        <button type="button" class="hint ask" (click)="confirm()">Confirm with MFA first</button>
      }
    }
  `,
  styles: [
    `
      .hint {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: var(--text-xs);
        font-weight: var(--font-semibold);
        border-radius: var(--radius-full);
        padding: 3px 10px;
        white-space: nowrap;
      }
      .ok {
        background: rgba(52, 199, 89, 0.14);
        color: var(--profit, #1f9d55);
      }
      .ask {
        border: 1px solid var(--accent);
        background: transparent;
        color: var(--accent);
        cursor: pointer;
        font-family: inherit;
      }
      .ask:hover {
        background: rgba(10, 132, 255, 0.08);
      }
    `,
  ],
})
export class MfaHintComponent {
  private readonly auth = inject(AuthService);
  private readonly stepUp = inject(StepUpService);

  /** The permission the action needs. */
  readonly permission = input.required<string>();

  /** Shown only with BFF sign-in, for StepUp keys. */
  readonly required = computed(
    () => this.auth.mode === 'bff' && permissionDefinition(this.permission())?.stepUp === true,
  );
  readonly fresh = computed(() => mfaIsFresh(this.auth.session()?.mfa));

  confirm(): void {
    this.stepUp.confirmWithMfa();
  }
}
