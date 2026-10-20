import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { SIGNIN_ERROR_PARAM } from '@core/auth/auth.guard';
import { signInErrorMessage, type BffMembership } from '@core/auth/bff.types';
import { BrowserLocation } from '@core/browser/browser-location';
import { DEFAULT_POST_LOGIN_ROUTE } from '@core/auth/return-url';
import { ThemeService } from '@core/theme/theme.service';
import { LogoComponent } from '@shared/components/logo/logo.component';
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
  imports: [RouterLink, LogoComponent],
  template: `
    <div class="wrap">
      <div class="card">
        <div class="head">
          <app-logo [size]="48" />
          <h1>Join an organisation</h1>
        </div>

        @switch (stage()) {
          @case ('invalid') {
            <p class="error" role="alert">
              This invitation link is not complete. Open the link from the message you received
              again.
            </p>
          }
          @case ('unsupported') {
            <p>
              Invitations are accepted with organisation sign-in, which this console is not using
              yet. Ask the person who invited you to add you instead.
            </p>
            <a class="btn" routerLink="/login">Go to sign-in</a>
          }
          @case ('sign-in') {
            @if (error()) {
              <p class="error" role="alert">{{ error() }}</p>
            }
            <p>
              You have been invited to a Lascodia organisation. Sign in — or create your account —
              with the e-mail address the invitation was sent to, then accept it here.
            </p>
            <button type="button" class="btn primary" (click)="signIn()">Sign in to accept</button>
          }
          @case ('ready') {
            <p>
              Signed in as <strong>{{ who() }}</strong
              >. Accept the invitation to join the organisation with the roles it gives you.
            </p>
            <button type="button" class="btn primary" (click)="accept()">Accept invitation</button>
            <a class="btn" [routerLink]="landing">Not now</a>
          }
          @case ('accepting') {
            <p>Accepting…</p>
          }
          @case ('accepted') {
            <p class="ok" role="status">You have joined.</p>
            @for (m of joined(); track m.tenantId) {
              <button type="button" class="btn primary" (click)="open(m)">Open {{ m.name }}</button>
            }
            <a class="btn" [routerLink]="landing">Go to the console</a>
          }
          @case ('failed') {
            <p class="error" role="alert">{{ error() }}</p>
            <a class="btn" [routerLink]="landing">Go to the console</a>
          }
        }
      </div>
    </div>
  `,
  styles: [
    `
      .wrap {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-primary);
        padding: var(--space-4);
      }
      .card {
        width: 100%;
        max-width: 440px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: var(--radius-xl);
        padding: var(--space-8);
        box-shadow: var(--shadow-lg);
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        color: var(--text-primary);
        font-size: var(--text-sm);
        line-height: 1.5;
      }
      .head {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-3);
      }
      h1 {
        margin: 0;
        font-size: var(--text-lg);
        font-weight: var(--font-semibold);
      }
      p {
        margin: 0;
      }
      .error {
        color: var(--loss);
      }
      .ok {
        font-weight: var(--font-semibold);
      }
      .btn {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 42px;
        border-radius: var(--radius-full);
        border: 1px solid var(--border);
        background: transparent;
        color: var(--text-primary);
        font-size: var(--text-base);
        font-weight: var(--font-medium);
        font-family: inherit;
        text-decoration: none;
        cursor: pointer;
      }
      .btn.primary {
        background: var(--accent);
        border-color: var(--accent);
        color: #fff;
      }
    `,
  ],
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
