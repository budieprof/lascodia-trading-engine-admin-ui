import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import { AuthService } from '@core/auth/auth.service';
import type { BffMembership } from '@core/auth/bff.types';
import { NotificationService } from '@core/notifications/notification.service';
import { ModalA11yDirective } from '@shared/directives/modal-a11y.directive';
import { LucideDynamicIcon } from '@lucide/angular';
import { navIcon } from '../sidebar/nav-icons';

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

/** Up to two initials for an organisation's tile: "Lascodia House" → "LH", "acme" → "AC". */
export function orgInitials(name: string | null | undefined): string {
  const words = (name ?? '')
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
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
  imports: [ModalA11yDirective, LucideDynamicIcon],
  host: { '(document:click)': 'onDocumentClick($event)' },
  template: `
    @if (visible()) {
      <div class="org">
        <button
          type="button"
          class="lx-pill org-pill"
          [attr.aria-expanded]="open()"
          aria-haspopup="menu"
          [disabled]="switching() || locked()"
          [title]="
            locked()
              ? 'End the impersonation to switch organisation'
              : 'Organisation: ' + (active()?.name ?? '')
          "
          (click)="open.set(!open())"
        >
          <span class="lx-tile" aria-hidden="true">{{ initials(active()?.name) }}</span>
          <span class="lx-pill-value org-name">{{
            switching() ? 'Switching…' : active()?.name
          }}</span>
          @if (choices().length > 1) {
            <svg
              class="lx-pill-caret"
              [lucideIcon]="icons.ChevronDown"
              [size]="14"
              [strokeWidth]="2.25"
              aria-hidden="true"
            ></svg>
          }
        </button>
        @if (open()) {
          <div
            class="lx-menu"
            role="menu"
            aria-label="Switch organisation"
            appModalA11y
            [appModalA11yTrap]="false"
            (dismiss)="open.set(false)"
          >
            <div class="lx-menu-heading" aria-hidden="true">Organisations</div>
            @for (m of choices(); track m.tenantId) {
              @let reason = unavailable(m);
              @let current = m.tenantId === active()?.id;
              <button
                type="button"
                role="menuitemradio"
                class="lx-menu-item"
                [attr.aria-checked]="current"
                [disabled]="reason !== null || current"
                (click)="choose(m)"
              >
                <span
                  class="lx-tile lx-tile-lg"
                  [class.lx-tile-muted]="!current"
                  aria-hidden="true"
                  >{{ initials(m.name) }}</span
                >
                <span class="lx-menu-text">
                  <span class="lx-menu-title">
                    {{ m.name }}
                    @if (m.status === 'Invited') {
                      <span class="lx-badge lx-badge-warn">Invited</span>
                    } @else if (m.status === 'Suspended') {
                      <span class="lx-badge">Suspended</span>
                    }
                  </span>
                  <span class="lx-menu-meta">
                    @if (current) {
                      Current organisation
                    } @else if (reason) {
                      {{ reason }}
                    } @else {
                      {{ m.slug }}
                    }
                  </span>
                </span>
                @if (current) {
                  <svg
                    class="lx-menu-check"
                    [lucideIcon]="icons.Check"
                    [size]="16"
                    [strokeWidth]="2.5"
                    aria-hidden="true"
                  ></svg>
                }
              </button>
            }
            <p class="lx-menu-footnote">
              Switching reloads the console in the chosen organisation.
            </p>
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
        max-width: 240px;
      }
      @media (max-width: 1279.98px) {
        .org-pill {
          max-width: 170px;
        }
      }
      @media (max-width: 600px) {
        .org-pill {
          max-width: 7rem;
          padding-right: 8px;
        }
        .org-pill .lx-tile {
          display: none;
        }
      }
    `,
  ],
})
export class OrgSwitcherComponent {
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly host: HTMLElement = inject(ElementRef<HTMLElement>).nativeElement;

  // Named one by one: scripts/generate-nav-icons.mjs bundles only the `navIcon.<Name>` it can see.
  protected readonly icons = { ChevronDown: navIcon.ChevronDown, Check: navIcon.Check };

  readonly open = signal(false);
  readonly switching = signal(false);

  readonly active = this.auth.activeTenant;
  readonly visible = computed(() => this.auth.mode === 'bff' && this.active() !== null);
  /** The engine refuses to switch while impersonating (contract C3.1). */
  readonly locked = computed(() => this.auth.impersonation() !== null);
  readonly choices = computed(() =>
    orderedMemberships(this.auth.memberships(), this.active()?.id ?? null),
  );

  initials(name: string | null | undefined): string {
    return orgInitials(name);
  }

  /** A click anywhere outside the switcher closes its menu, as every drop-down does. */
  onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.contains(event.target as Node)) this.open.set(false);
  }

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
