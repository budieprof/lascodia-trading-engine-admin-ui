import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { SIGNIN_ERROR_PARAM } from '@core/auth/auth.guard';
import { signInErrorMessage, type BffMembership } from '@core/auth/bff.types';
import { BrowserLocation } from '@core/browser/browser-location';
import { DEFAULT_POST_LOGIN_ROUTE } from '@core/auth/return-url';
import { ThemeService } from '@core/theme/theme.service';
import { SignInShellComponent } from '@shared/components/sign-in-shell/sign-in-shell.component';
import { IamApiService } from '@features/iam/iam-api.service';
import { errorText } from '@features/iam/iam.logic';
import { isPlausibleInviteToken, newlyActive } from './invite.logic';

type Stage = 'sign-in' | 'ready' | 'accepting' | 'accepted' | 'failed' | 'unsupported' | 'invalid';

/**
 * Accept an invitation (U3.7, contract C3.5). The link is `/invite/<token>`: a person who is not
 * signed in signs in first (BFF, returning here), then accepts with `POST /iam/invitations/accept
 * {token}` — the engine checks the token is unused and unexpired and that the signed-in person's
 * verified e-mail is the invited one. Afterwards the new organisation can be opened at once.
 *
 * Outside the console layout: an invited person may not belong to any organisation yet. With legacy
 * sign-in there are no invitations to accept, and the page says so.
 */
@Component({
  selector: 'app-invite-accept-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SignInShellComponent],
  template: `
    <app-sign-in-shell>
      <h1 class="si-title">Join an organisation</h1>
      <p class="si-subtitle">Accept an invitation to work in a Lascodia organisation.</p>

      <div class="si-body">
        @switch (stage()) {
          @case ('invalid') {
            <p class="si-alert si-alert--danger" role="alert">
              This invitation link is not complete. Open the link from the message you received
              again.
            </p>
          }
          @case ('unsupported') {
            <p>
              Invitations are accepted with organisation sign-in, which this console is not using
              yet. Ask the person who invited you to add you instead.
            </p>
            <a class="si-btn si-btn--secondary" routerLink="/login">Go to sign-in</a>
          }
          @case ('sign-in') {
            @if (error()) {
              <p class="si-alert si-alert--danger" role="alert">{{ error() }}</p>
            }
            <p>
              Sign in, or create your account, with the e-mail address the invitation was sent to,
              then accept it here.
            </p>
            <button type="button" class="si-btn si-btn--primary" (click)="signIn()">
              Sign in to accept
            </button>
          }
          @case ('ready') {
            <p>
              Signed in as <strong>{{ who() }}</strong
              >. Accept the invitation to join the organisation with the roles it gives you.
            </p>
            <div class="si-actions">
              <button type="button" class="si-btn si-btn--primary" (click)="accept()">
                Accept invitation
              </button>
              <a class="si-btn si-btn--secondary" [routerLink]="landing">Not now</a>
            </div>
          }
          @case ('accepting') {
            <p role="status">Accepting…</p>
          }
          @case ('accepted') {
            <p class="si-alert si-alert--success" role="status">You have joined.</p>
            <div class="si-actions">
              @for (m of joined(); track m.tenantId) {
                <button type="button" class="si-btn si-btn--primary" (click)="open(m)">
                  Open {{ m.name }}
                </button>
              }
              <a class="si-btn si-btn--secondary" [routerLink]="landing">Go to the console</a>
            </div>
          }
          @case ('failed') {
            <p class="si-alert si-alert--danger" role="alert">{{ error() }}</p>
            <a class="si-btn si-btn--secondary" [routerLink]="landing">Go to the console</a>
          }
        }
      </div>
    </app-sign-in-shell>
  `,
})
export class InviteAcceptPageComponent {
  private readonly auth = inject(AuthService);
  private readonly iam = inject(IamApiService);
  private readonly browser = inject(BrowserLocation);
  private readonly route = inject(ActivatedRoute);

  protected readonly landing = DEFAULT_POST_LOGIN_ROUTE;
  private readonly token = this.route.snapshot.paramMap.get('token');

  readonly stage = signal<Stage>(this.initialStage());
  readonly error = signal<string | null>(
    signInErrorMessage(this.route.snapshot.queryParamMap.get(SIGNIN_ERROR_PARAM)),
  );
  readonly joined = signal<BffMembership[]>([]);
  readonly who = computed(() => {
    const u = this.auth.session()?.user;
    return u ? `${u.displayName || u.username}${u.email ? ` (${u.email})` : ''}` : '';
  });

  constructor() {
    inject(ThemeService);
  }

  private initialStage(): Stage {
    if (!isPlausibleInviteToken(this.token)) return 'invalid';
    if (this.auth.mode !== 'bff') return 'unsupported';
    return this.auth.isAuthenticated() ? 'ready' : 'sign-in';
  }

  signIn(): void {
    this.auth.beginSignIn(`/invite/${this.token}`);
  }

  accept(): void {
    if (this.stage() !== 'ready' || !isPlausibleInviteToken(this.token)) return;
    const before = [...this.auth.memberships()];
    this.stage.set('accepting');
    this.iam.acceptInvitation(this.token).subscribe({
      next: async (joined) => {
        const session = await this.auth.refreshSession();
        const opened = newlyActive(before, session?.memberships ?? []);
        // The engine names the organisation joined; the membership diff covers an older answer shape.
        this.joined.set(
          joined && !opened.some((m) => m.tenantId === joined.tenantId)
            ? [
                {
                  tenantId: joined.tenantId,
                  slug: joined.slug,
                  name: joined.name,
                  status: 'Active',
                },
                ...opened,
              ]
            : opened,
        );
        this.stage.set('accepted');
      },
      error: (e) => {
        if (e instanceof HttpErrorResponse && e.status === 401) {
          // The session ended meanwhile: sign in again and come back here.
          this.stage.set('sign-in');
          return;
        }
        this.error.set(
          errorText(
            e,
            'The invitation could not be accepted. It may have expired or been used already.',
          ),
        );
        this.stage.set('failed');
      },
    });
  }

  async open(m: BffMembership): Promise<void> {
    if (this.auth.activeTenant()?.id === m.tenantId) {
      this.browser.assign(DEFAULT_POST_LOGIN_ROUTE);
      return;
    }
    try {
      await this.auth.switchTenant(m.tenantId);
    } catch (e) {
      this.error.set(errorText(e, `Could not open ${m.name}.`));
      this.stage.set('failed');
    }
  }
}
