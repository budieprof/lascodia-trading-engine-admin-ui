import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '@core/auth/auth.service';
import { PageHeaderComponent } from '@shared/components/page-header/page-header.component';
import { iamResource } from '@features/iam/shared/iam-resource';
import { OnboardingApiService } from '../onboarding-api.service';
import { progressText } from '../onboarding.logic';
import type { OnboardingItem, TenantOnboarding } from '../onboarding.types';

/**
 * Getting the organisation going (engine multi-tenancy Phase 7, LC.1, `GET /tenant/onboarding`,
 * `tenant.usage.read`): connect a terminal, choose strategies, require a second factor, invite people —
 * each worked out from what exists, with a link to the page where it is done (shown only when the person may
 * open it). A new self-served organisation lands here after sign-in until the steps are done.
 */
@Component({
  selector: 'app-onboarding-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PageHeaderComponent],
  styleUrls: ['../../iam/shared/iam-page.scss'],
  styles: [
    `
      .steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .step {
        display: grid;
        grid-template-columns: 28px 1fr auto;
        gap: var(--space-3);
        align-items: start;
        padding: var(--space-3) var(--space-4);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
      }
      .step.done {
        opacity: 0.75;
      }
      .tick {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 2px solid var(--border);
        font-size: var(--text-xs);
      }
      .step.done .tick {
        background: var(--profit);
        border-color: var(--profit);
        color: #fff;
      }
      .step h4 {
        margin: 0 0 var(--space-1);
      }
      .step p {
        margin: 0;
      }
    `,
  ],
  template: `
    <div class="page">
      <app-page-header
        title="Get started"
        subtitle="A few steps to get your organisation trading (demo accounts)."
      >
        <button
          type="button"
          class="btn btn-secondary"
          (click)="checklist.reload()"
          [disabled]="checklist.loading()"
        >
          {{ checklist.loading() ? 'Loading…' : 'Refresh' }}
        </button>
      </app-page-header>

      @if (checklist.error(); as err) {
        <section class="card">
          <p class="pad" role="alert"><span class="chip bad">Could not load</span> {{ err }}</p>
        </section>
      }

      @if (checklist.value(); as c) {
        <section class="card">
          <header class="card-head">
            <h3>{{ c.name }}</h3>
            <span class="spacer"></span>
            <span class="chip" [class.ok]="c.completed >= c.total">{{
              progress(c.completed, c.total)
            }}</span>
          </header>
          <div class="card-body">
            <ol class="steps">
              @for (item of c.items; track item.key) {
                <li class="step" [class.done]="item.done">
                  <span class="tick" aria-hidden="true">{{ item.done ? '✓' : '' }}</span>
                  <div>
                    <h4>
                      {{ item.title }}
                      <span class="sr-only">{{ item.done ? '(done)' : '(to do)' }}</span>
                    </h4>
                    <p class="small muted">{{ item.detail || item.description }}</p>
                  </div>
                  @if (canOpen(item)) {
                    <a class="btn btn-secondary btn-sm" [routerLink]="item.route">{{
                      item.done ? 'Open' : 'Start'
                    }}</a>
                  } @else if (!item.done) {
                    <span class="small muted">Ask an administrator</span>
                  }
                </li>
              }
            </ol>
          </div>
        </section>
        <p class="note">
          Your organisation is on the Trial plan and uses demo accounts only.
          <a routerLink="/iam/plan">See your plan</a>.
        </p>
      }
    </div>
  `,
})
export class OnboardingPageComponent {
  private readonly api = inject(OnboardingApiService);
  private readonly auth = inject(AuthService);

  protected readonly progress = progressText;

  readonly checklist = iamResource<TenantOnboarding | null>(
    () => this.api.onboarding(),
    null,
    'Could not load the checklist.',
  );

  constructor() {
    this.checklist.reload();
  }

  canOpen(item: OnboardingItem): boolean {
    return this.auth.canSeePath(item.route);
  }
}
