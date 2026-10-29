import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { type Subscription, catchError, exhaustMap, of, timer } from 'rxjs';

import { AuthService } from '@core/auth/auth.service';
import { Permission } from '@core/auth/permissions.generated';
import { BrowserLocation } from '@core/browser/browser-location';
import { SALES_EMAIL } from '@core/branding/contact';
import { reportable } from '@features/iam/iam.logic';
import { iamResource } from '@features/iam/shared/iam-resource';
import { BillingApiService } from '../billing-api.service';
import type { BillingSubscription, PlanOffer } from '../billing.types';
import {
  CHECKOUT_POLL_MS,
  CHECKOUT_RETURN_PARAMS,
  PAYSTACK_CONFIRM_FALLBACK,
  type PaystackOutcome,
  billingRefusal,
  canChangePlan,
  checkoutPollOutcome,
  checkoutReturn,
  currentPlanHint,
  freeOfferHint,
  isFollowableRedirect,
  noPaidOffers,
  offerAction,
  offerPrice,
  paystackOutcome,
  paystackReference,
  planLimits,
  planNotices,
  showManageBilling,
  statusBadge,
} from '../plan-offers.logic';

type ReturnState = 'confirming' | 'waiting' | 'done' | 'late' | 'cancelled' | null;

/**
 * "Your plan" at the top of Usage & billing (`GET tenant/billing/subscription`): the current plan and its status,
 * the plans on offer, and — for someone holding `tenant.billing.manage` while the engine says they may — Upgrade
 * (the provider's payment page: Stripe Checkout or Paystack) or Switch / Manage billing (the billing portal;
 * Paystack's manage page cannot switch plan, so no Switch there). Coming back from Stripe
 * (`?checkout=success|cancelled`) it says what happened and waits for the plan to change; coming back from
 * Paystack (`?checkout=paystack&reference=…`) it first asks the engine what became of the payment.
 */
@Component({
  selector: 'app-billing-your-plan',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['../../iam/shared/iam-page.scss'],
  styles: [
    `
      .now {
        font-weight: var(--font-semibold);
      }
      .plans {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
        gap: var(--space-3);
      }
      .plan {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-primary);
      }
      .plan.current {
        border-color: var(--accent);
      }
      .plan h4 {
        margin: 0;
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .price {
        margin: 0;
        font-size: var(--text-lg, 18px);
        font-weight: var(--font-semibold);
      }
      .plan p {
        margin: 0;
      }
      dl {
        margin: 0;
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 2px var(--space-2);
        font-size: var(--text-xs);
      }
      dt {
        color: var(--text-secondary);
      }
      dd {
        margin: 0;
        text-align: right;
      }
      .plan .btn {
        margin-top: auto;
        align-self: flex-start;
      }
      .note.ok {
        background: rgba(52, 199, 89, 0.12);
        color: var(--text-primary);
      }
      .note.bad {
        background: rgba(255, 59, 48, 0.1);
        color: var(--text-primary);
      }
    `,
  ],
  template: `
    <section class="card" aria-labelledby="your-plan-title">
      <header class="card-head">
        <h3 id="your-plan-title">Your plan</h3>
        @if (sub.value(); as s) {
          <span class="now">{{ s.currentPlan?.name ?? 'No plan' }}</span>
          @if (badge(); as b) {
            <span class="chip" [class]="b.tone">{{ b.label }}</span>
          }
          <span class="spacer"></span>
          @if (manageBilling()) {
            <button
              type="button"
              class="btn btn-sm btn-secondary"
              (click)="openPortal()"
              [disabled]="busy() !== null"
            >
              {{ busy() === 'portal' ? 'Opening…' : 'Manage billing' }}
            </button>
          }
        }
      </header>
      <div class="card-body">
        @switch (returned()) {
          @case ('confirming') {
            <p class="note" role="status">Checking your payment…</p>
          }
          @case ('waiting') {
            <p class="note ok" role="status">
              Payment received — your plan updates in a few seconds.
            </p>
          }
          @case ('done') {
            <p class="note ok" role="status">
              Payment received — you're on {{ sub.value()?.currentPlan?.name ?? 'your new plan' }}.
            </p>
          }
          @case ('late') {
            <p class="note warn" role="status">
              Payment received, but your plan has not updated yet. Refresh this page in a minute.
              @if (salesEmail) {
                If it still shows the old plan, write to
                <a [href]="'mailto:' + salesEmail">{{ salesEmail }}</a
                >.
              }
            </p>
          }
          @case ('cancelled') {
            <p class="note" role="status">Payment cancelled — nothing was charged.</p>
          }
        }

        @if (sub.error(); as err) {
          <p class="note bad" role="alert">{{ err }}</p>
        }
        @if (actionError(); as err) {
          <p class="note bad" role="alert">{{ err }}</p>
        }

        @if (sub.value(); as s) {
          @for (n of notices(); track n.text) {
            <p class="note" [class.warn]="n.tone === 'warn'">{{ n.text }}</p>
          }

          @if (shownOffers().length > 0) {
            <div class="plans">
              @for (o of shownOffers(); track o.slug) {
                <article class="plan" [class.current]="isCurrent(o, s)">
                  <h4>
                    {{ o.name }}
                    @if (isCurrent(o, s)) {
                      <span class="chip ok">Current plan</span>
                    }
                  </h4>
                  <p class="price">{{ price(o) }}</p>
                  @if (o.description) {
                    <p class="small muted">{{ o.description }}</p>
                  }
                  <dl>
                    @for (l of limits(o); track l.label) {
                      <dt>{{ l.label }}</dt>
                      <dd>{{ l.value }}</dd>
                    }
                  </dl>
                  @if (freeHint(o, s); as hint) {
                    <p class="small muted">{{ hint }}</p>
                  }
                  @if (currentHint(o, s); as hint) {
                    <p class="small muted">{{ hint }}</p>
                  }
                  @if (action(o, s); as a) {
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      (click)="choose(o, s)"
                      [disabled]="busy() !== null"
                      [attr.aria-label]="a.label + ' to ' + o.name"
                    >
                      {{ busy() === o.slug ? 'Opening…' : a.label }}
                    </button>
                  }
                </article>
              }
            </div>
          }

          @if (noPaid() && canChange()) {
            <p class="small muted">
              There are no paid plans to choose from yet.
              @if (salesEmail) {
                To change your plan, write to
                <a [href]="'mailto:' + salesEmail">{{ salesEmail }}</a
                >.
              }
            </p>
          }

          @if (!s.selfServeEnabled) {
            @if (salesEmail) {
              <p class="small muted">
                Plan changes are handled by Lascodia — contact
                <a [href]="'mailto:' + salesEmail">{{ salesEmail }}</a
                >.
              </p>
            } @else {
              <p class="small muted">Plan changes are handled by Lascodia.</p>
            }
          } @else if (!canChange()) {
            <p class="small muted">Ask an Owner of your organisation to change the plan.</p>
          }
        } @else if (!sub.error()) {
          <p class="small muted">Loading…</p>
        }
      </div>
    </section>
  `,
})
export class YourPlanComponent {
  private readonly api = inject(BillingApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(BrowserLocation);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly salesEmail = SALES_EMAIL;
  protected readonly price = offerPrice;
  protected readonly limits = planLimits;

  /** The console's own check of the write key; the engine's `canManage` is the other half. */
  readonly holdsManageKey = computed(() => this.auth.hasPermission(Permission.TenantBillingManage));

  readonly sub = iamResource<BillingSubscription | null>(
    () => this.api.subscription(),
    null,
    'Could not load your plan.',
  );
  /** The plan slug (or 'portal') whose button is opening; every button waits meanwhile. */
  readonly busy = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly returned = signal<ReturnState>(null);

  readonly badge = computed(() => {
    const s = this.sub.value();
    return s ? statusBadge(s.status) : null;
  });
  readonly notices = computed(() => {
    const s = this.sub.value();
    return s ? planNotices(s, this.manageBilling()) : [];
  });
  readonly canChange = computed(() => {
    const s = this.sub.value();
    return !!s && canChangePlan(s, this.holdsManageKey());
  });
  readonly manageBilling = computed(() => {
    const s = this.sub.value();
    return !!s && showManageBilling(s, this.holdsManageKey());
  });
  readonly noPaid = computed(() => {
    const s = this.sub.value();
    return !!s && noPaidOffers(s);
  });
  /**
   * Just paid (or checking a Paystack payment) and the plan has not caught up: no new checkout (it would be a
   * second subscription).
   */
  readonly paymentPending = computed(() => {
    const r = this.returned();
    return r === 'confirming' || r === 'waiting' || r === 'late';
  });
  /** Self-serve off: the current plan only. */
  readonly shownOffers = computed<PlanOffer[]>(() => {
    const s = this.sub.value();
    if (!s) return [];
    return s.selfServeEnabled ? s.offers : s.offers.filter((o) => this.isCurrent(o, s));
  });

  private poll: Subscription | null = null;

  constructor() {
    const params = this.route.snapshot.queryParamMap;
    const ret = checkoutReturn(params.get('checkout'));
    if (ret) this.stripReturnParams();
    if (ret === 'cancelled') this.returned.set('cancelled');
    if (ret === 'success') this.waitForPlanChange();
    else if (ret === 'paystack')
      this.confirmPaystack(paystackReference(params.get('reference'), params.get('trxref')));
    else this.sub.reload();
  }

  isCurrent(offer: PlanOffer, s: BillingSubscription): boolean {
    return offer.isCurrent || (!!s.currentPlan && offer.slug === s.currentPlan.slug);
  }

  action(offer: PlanOffer, s: BillingSubscription) {
    return offerAction(offer, s, this.holdsManageKey(), this.paymentPending());
  }

  freeHint(offer: PlanOffer, s: BillingSubscription): string | null {
    return freeOfferHint(offer, s, this.holdsManageKey());
  }

  currentHint(offer: PlanOffer, s: BillingSubscription): string | null {
    return currentPlanHint(offer, s, this.holdsManageKey());
  }

  choose(offer: PlanOffer, s: BillingSubscription): void {
    const a = this.action(offer, s);
    if (!a || this.busy()) return;
    if (a.kind === 'portal') this.openPortal(offer.slug);
    else this.go(offer.slug, this.api.checkout(offer.slug), 'Could not open the payment page.');
  }

  openPortal(busyKey = 'portal'): void {
    if (this.busy()) return;
    this.go(busyKey, this.api.portal(), 'Could not open billing.');
  }

  /** Re-reads the plan (used after a refresh of the page's other parts). */
  reload(): void {
    this.sub.reload();
  }

  private go(
    busyKey: string,
    call: ReturnType<BillingApiService['portal']>,
    fallback: string,
  ): void {
    this.busy.set(busyKey);
    this.actionError.set(null);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        if (isFollowableRedirect(r?.url)) {
          // Leaving the console: the button stays busy until the browser goes.
          this.location.assign(r.url);
        } else {
          this.busy.set(null);
          this.actionError.set(fallback);
        }
      },
      error: (e: unknown) => {
        this.busy.set(null);
        if (reportable(e)) this.actionError.set(billingRefusal(e, fallback));
      },
    });
  }

  /** Back from Paystack: the engine checks the payment with Paystack, then the page acts on its answer. */
  private confirmPaystack(reference: string | null): void {
    this.sub.reload();
    if (!reference) {
      this.actionError.set(PAYSTACK_CONFIRM_FALLBACK);
      return;
    }
    this.returned.set('confirming');
    this.api
      .confirmPaystack(reference)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => this.applyPaystack(paystackOutcome(r)),
        error: (e: unknown) => {
          this.returned.set(null);
          if (reportable(e)) this.actionError.set(billingRefusal(e, PAYSTACK_CONFIRM_FALLBACK));
        },
      });
  }

  private applyPaystack(outcome: PaystackOutcome): void {
    switch (outcome.kind) {
      case 'done':
        this.returned.set('done');
        this.sub.reload();
        return;
      case 'wait':
        this.waitForPlanChange();
        return;
      case 'cancelled':
        this.returned.set('cancelled');
        return;
      case 'error':
        this.returned.set(null);
        this.actionError.set(outcome.text);
        return;
    }
  }

  /** After a paid checkout: read the plan every 2 s (up to 30 s) until the engine has the new plan. */
  private waitForPlanChange(): void {
    this.returned.set('waiting');
    const started = Date.now();
    let startSlug: string | null | undefined;
    this.poll = timer(0, CHECKOUT_POLL_MS)
      .pipe(
        exhaustMap(() => this.api.subscription().pipe(catchError(() => of(null)))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((s) => {
        if (s) {
          this.sub.value.set(s);
          this.sub.error.set(null);
          if (startSlug === undefined) startSlug = s.currentPlan?.slug ?? null;
        } else if (!this.sub.value()) {
          this.sub.error.set('Could not load your plan.');
        }
        this.sub.loaded.set(true);
        const outcome = checkoutPollOutcome(startSlug ?? null, s, Date.now() - started);
        if (outcome === 'waiting') return;
        this.returned.set(outcome === 'done' ? 'done' : 'late');
        this.poll?.unsubscribe();
        this.poll = null;
      });
  }

  private stripReturnParams(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: Object.fromEntries(CHECKOUT_RETURN_PARAMS.map((k) => [k, null])),
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
