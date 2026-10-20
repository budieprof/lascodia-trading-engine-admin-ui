import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import { AuthService } from '@core/auth/auth.service';
import type { BffMembership } from '@core/auth/bff.types';
import { NotificationService } from '@core/notifications/notification.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';

/** Memberships in the order the menu lists them: the active one first, then by name. */
export function orderedMemberships(
  memberships: readonly BffMembership[],
  activeTenantId: number | null,
): BffMembership[] {
  return [...memberships].sort((a, b) => {
    if (a.tenantId === activeTenantId) return -1;
    if (b.tenantId === activeTenantId) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Plain reason a membership cannot be switched to, or null when it can. */
export function unavailableReason(m: BffMembership): string | null {
  switch (m.status) {
    case 'Active':
      return null;
    case 'Invited':
      return 'Invitation not accepted yet';
    case 'Suspended':
      return 'Your membership is suspended';
    default:
      return 'Not available';
  }
}

/**
 * Header control for the organisation the console acts in (U3.2). Lists the person's memberships
 * from the BFF session; choosing one calls `POST /bff/switch-tenant` and reloads the console, so
 * nothing from the previous organisation stays in memory (see `AuthService.switchTenant`). An
 * organisation that requires a second factor sends the person through a step-up sign-in first.
 *
 * Only with `bffAuth` on: legacy sign-in is always House, and the header stays as it was.
 */
@Component({
  selector: 'app-org-switcher',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ModalA11yDirective],
  template: `
    @if (visible()) {
      <div class="org">
        <button
          type="button"
          class="org-pill"
          [attr.aria-expanded]="open()"
          aria-haspopup="menu"
          [disabled]="switching() || locked()"
          [title]="locked() ? 'End the impersonation to switch organisation' : 'Organisation: ' + (active()?.name ?? '')"
          (click)="open.set(!open())"
        >
          <span class="org-label">Org:</span>
          <span class="org-name">{{ switching() ? 'Switching…' : active()?.name }}</span>
          @if (choices().length > 1) {
            <span class="caret" aria-hidden="true">▾</span>
          }
        </button>
        @if (open()) {
          <div
            class="menu"
            role="menu"
            aria-label="Switch organisation"
            appModalA11y
            [appModalA11yTrap]="false"
            (dismiss)="open.set(false)"
          >
            @for (m of choices(); track m.tenantId) {
              @let reason = unavailable(m);
              <button
                type="button"
                role="menuitemradio"
                class="item"
                [attr.aria-checked]="m.tenantId === active()?.id"
                [disabled]="reason !== null || m.tenantId === active()?.id"
                (click)="choose(m)"
              >
                <span class="item-name">{{ m.name }}</span>
                <span class="item-meta">
                  @if (m.tenantId === active()?.id) {
                    Current
                  } @else if (reason) {
                    {{ reason }}
                  } @else {
                    {{ m.slug }}
                  }
                </span>
              </button>
            }
            <p class="hint">Switching reloads the console in the chosen organisation.</p>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .org {
        position: relative;
      }
      .org-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 32px;
        padding: 0 12px;
        border: 1px solid var(--border);
        border-radius: var(--radius-full);
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-family: inherit;
        cursor: pointer;
        max-width: 240px;
      }
      .org-pill:hover:not(:disabled) {
        border-color: var(--accent);
      }
      .org-pill:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }
      .org-label {
        color: var(--text-secondary);
      }
      .org-name {
        font-weight: var(--font-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .caret {
        color: var(--text-tertiary);
        font-size: 11px;
      }
      .menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 260px;
        max-height: 60vh;
        overflow-y: auto;
        padding: 6px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: 300;
      }
      .item {
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        padding: 8px 10px;
        border: none;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--text-primary);
        font-family: inherit;
        text-align: left;
        cursor: pointer;
      }
      .item:hover:not(:disabled) {
        background: var(--bg-tertiary);
      }
      .item:disabled {
        cursor: default;
      }
      .item[aria-checked='true'] {
        box-shadow: inset 3px 0 0 var(--accent);
      }
      .item:disabled:not([aria-checked='true']) .item-name {
        color: var(--text-tertiary);
      }
      .item-name {
        font-size: var(--text-sm);
        font-weight: var(--font-medium);
      }
      .item-meta {
        font-size: var(--text-xs);
        color: var(--text-secondary);
      }
      .hint {
        margin: 6px 10px 2px;
        font-size: var(--text-xs);
        color: var(--text-tertiary);
      }
      @media (max-width: 1279.98px) {
        .org-label {
          display: none;
        }
        .org-pill {
          max-width: 160px;
        }
      }
    `,
  ],
})
export class OrgSwitcherComponent {
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);

  readonly open = signal(false);
  readonly switching = signal(false);

  readonly active = this.auth.activeTenant;
  readonly visible = computed(() => this.auth.mode === 'bff' && this.active() !== null);
  /** The engine refuses to switch while impersonating (contract C3.1). */
  readonly locked = computed(() => this.auth.impersonation() !== null);
  readonly choices = computed(() =>
    orderedMemberships(this.auth.memberships(), this.active()?.id ?? null),
  );

  unavailable(m: BffMembership): string | null {
    return unavailableReason(m);
  }

  async choose(m: BffMembership): Promise<void> {
    if (this.switching() || unavailableReason(m) || m.tenantId === this.active()?.id) return;
    this.open.set(false);
    this.switching.set(true);
    try {
      // On success the console reloads (or leaves for a step-up sign-in): nothing to undo here.
      await this.auth.switchTenant(m.tenantId);
    } catch (err) {
      this.switching.set(false);
      const message =
        err instanceof HttpErrorResponse
          ? ((err.error as { message?: string } | null)?.message ?? null)
          : null;
      this.notify.error(message || `Could not switch to ${m.name}. Try again.`);
    }
  }
}
