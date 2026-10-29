import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@core/api/api.types';
import type { BillingSubscription, PlanOffer } from './billing.types';
import {
  billingRefusal,
  canChangePlan,
  checkoutPollOutcome,
  checkoutReturn,
  CHECKOUT_RETURN_PARAMS,
  currentPlanHint,
  freeOfferHint,
  isFollowableRedirect,
  limitPoints,
  normaliseSubscription,
  noPaidOffers,
  offerAction,
  offerPrice,
  PAYSTACK_CONFIRM_FALLBACK,
  paystackOutcome,
  paystackReference,
  periodEndLabel,
  planLimits,
  planNotices,
  planPrice,
  showManageBilling,
  statusBadge,
} from './plan-offers.logic';

function offer(over: Partial<PlanOffer> = {}): PlanOffer {
  return {
    slug: 'pro',
    name: 'Pro',
    description: null,
    priceAmount: 49,
    currency: 'usd',
    interval: 'month',
    maxTradingAccounts: 5,
    maxActiveEaInstances: 5,
    maxMembers: 10,
    maxStrategies: null,
    isDefault: false,
    isCurrent: false,
    ...over,
  };
}

const TRIAL = offer({
  slug: 'trial',
  name: 'Trial',
  priceAmount: 0,
  currency: null,
  interval: null,
  isDefault: true,
});

function sub(over: Partial<BillingSubscription> = {}): BillingSubscription {
  return {
    selfServeEnabled: true,
    currentPlan: { slug: 'trial', name: 'Trial' },
    status: 'none',
    cancelAtPeriodEnd: false,
    currentPeriodEndUtc: null,
    canManage: true,
    hasBillingAccount: false,
    offers: [{ ...TRIAL, isCurrent: true }, offer()],
    provider: null,
    checkoutProvider: null,
    canSwitchPlan: true,
    ...over,
  };
}

describe('plan prices', () => {
  it('reads free, whole and fractional prices with the interval', () => {
    expect(planPrice(0, null, null)).toBe('Free');
    expect(planPrice(0, 'usd', 'month')).toBe('Free');
    expect(planPrice(null, 'usd', 'month')).toBe('Free');
    expect(planPrice(49, 'usd', 'month')).toBe('$49 / month');
    expect(planPrice(490, 'usd', 'year')).toBe('$490 / year');
    expect(planPrice(19.5, 'usd', 'month')).toBe('$19.50 / month');
    expect(planPrice(1200, 'eur', null)).toBe('€1,200');
    expect(planPrice(49, 'gbp', 'month')).toBe('£49 / month');
  });

  it('reads naira with ₦, grouped, no ".00" on whole amounts', () => {
    expect(planPrice(73500, 'ngn', 'month')).toBe('₦73,500 / month');
    expect(planPrice(735000, 'NGN', 'year')).toBe('₦735,000 / year');
    expect(planPrice(73500, 'ngn', null)).toBe('₦73,500');
    expect(planPrice(73500.5, 'ngn', 'month')).toBe('₦73,500.50 / month');
    // Dollars are unchanged.
    expect(planPrice(49, 'usd', 'month')).toBe('$49 / month');
  });

  it('never throws on an odd currency', () => {
    expect(planPrice(49, null, 'month')).toBe('49 / month');
    expect(planPrice(49, 'not-a-code', 'month')).toBe('49 NOT-A-CODE / month');
  });

  it('formats an offer and its limits (null = unlimited)', () => {
    expect(offerPrice(offer())).toBe('$49 / month');
    expect(planLimits(offer())).toEqual([
      { label: 'Trading accounts', value: '5' },
      { label: 'Connected terminals', value: '5' },
      { label: 'Members', value: '10' },
      { label: 'Strategies', value: 'Unlimited' },
    ]);
    expect(limitPoints(offer({ maxMembers: 1 }))).toEqual([
      'Up to 5 trading accounts',
      'Up to 5 connected terminals',
      'Up to 1 member',
      'Unlimited strategies',
    ]);
  });
});

describe('status', () => {
  it('badges each status', () => {
    expect(statusBadge('none')).toBeNull();
    expect(statusBadge('active')).toEqual({ label: 'Active', tone: 'ok' });
    expect(statusBadge('past_due')?.tone).toBe('warn');
    expect(statusBadge('unpaid')?.tone).toBe('bad');
  });

  it('warns about a failed payment and says when a cancelled plan ends', () => {
    expect(planNotices(sub({ status: 'past_due' }))).toEqual([
      { text: 'Your last payment failed — update your card.', tone: 'warn' },
    ]);
    expect(
      planNotices(
        sub({
          status: 'active',
          currentPlan: { slug: 'pro', name: 'Pro' },
          cancelAtPeriodEnd: true,
          currentPeriodEndUtc: '2026-11-28T00:00:00Z',
        }),
      ),
    ).toEqual([
      {
        text: 'Your Pro plan ends on 28 November 2026. After that you are on Trial.',
        tone: 'info',
      },
    ]);
    expect(planNotices(sub({ cancelAtPeriodEnd: true }))[0].text).toBe(
      'Your Trial plan ends at the end of this billing period.',
    );
    expect(periodEndLabel('garbage')).toBeNull();
    expect(planNotices(sub())).toEqual([]);
  });

  it('says where to fix a failed payment when Manage billing is shown', () => {
    expect(planNotices(sub({ status: 'past_due' }), true)[0].text).toBe(
      'Your last payment failed — update your card in Manage billing.',
    );
    expect(planNotices(sub({ status: 'unpaid' }), true)[0].text).toBe(
      'Your plan is unpaid — update your card in Manage billing to keep it.',
    );
  });

  it('explains an unfinished checkout', () => {
    expect(planNotices(sub({ status: 'incomplete' }))).toEqual([
      { text: 'Your last payment was not finished, so your plan has not changed.', tone: 'info' },
    ]);
  });

  it('knows when self-serve has no paid plan to sell', () => {
    expect(noPaidOffers(sub({ offers: [{ ...TRIAL, isCurrent: true }] }))).toBe(true);
    expect(noPaidOffers(sub())).toBe(false);
    expect(noPaidOffers(sub({ selfServeEnabled: false, offers: [TRIAL] }))).toBe(false);
  });
});

describe('which button a plan card shows', () => {
  it('Upgrade (checkout) without a subscription; nothing on the current or free plan', () => {
    const s = sub();
    expect(offerAction(offer(), s, true)).toEqual({ kind: 'checkout', label: 'Upgrade' });
    expect(offerAction(s.offers[0], s, true)).toBeNull();
    expect(offerAction(offer({ slug: 'free2', priceAmount: 0 }), s, true)).toBeNull();
  });

  it('a canceled or incomplete subscription checks out again', () => {
    for (const status of ['canceled', 'incomplete', 'unpaid'] as const)
      expect(offerAction(offer(), sub({ status }), true)?.kind).toBe('checkout');
  });

  it('Switch (portal) while a subscription is live', () => {
    for (const status of ['active', 'trialing', 'past_due'] as const) {
      const s = sub({ status, currentPlan: { slug: 'pro', name: 'Pro' } });
      expect(offerAction(offer({ slug: 'desk', name: 'Desk' }), s, true)).toEqual({
        kind: 'portal',
        label: 'Switch',
      });
      // The current plan, matched by slug even when isCurrent is missing.
      expect(offerAction(offer(), s, true)).toBeNull();
    }
  });

  it('no buttons without the key, the engine’s canManage, or self-serve', () => {
    expect(offerAction(offer(), sub(), false)).toBeNull();
    expect(offerAction(offer(), sub({ canManage: false }), true)).toBeNull();
    expect(offerAction(offer(), sub({ selfServeEnabled: false }), true)).toBeNull();
    expect(canChangePlan(sub(), true)).toBe(true);
    expect(canChangePlan(sub({ canManage: false }), true)).toBe(false);
  });

  it('no new checkout while a payment just made is still being confirmed', () => {
    expect(offerAction(offer(), sub(), true, true)).toBeNull();
    // A live subscription still switches in the portal.
    const live = sub({ status: 'active', currentPlan: { slug: 'desk', name: 'Desk' } });
    expect(offerAction(offer(), live, true, true)?.kind).toBe('portal');
  });

  it('the free plan says how to go back to it while a subscription is live', () => {
    const live = sub({
      status: 'active',
      hasBillingAccount: true,
      currentPlan: { slug: 'pro', name: 'Pro' },
      offers: [TRIAL, offer({ isCurrent: true })],
    });
    expect(freeOfferHint(TRIAL, live, true)).toBe(
      'To go back to Trial, cancel your plan in Manage billing.',
    );
    expect(freeOfferHint(TRIAL, live, false)).toBeNull();
    expect(freeOfferHint(TRIAL, { ...live, cancelAtPeriodEnd: true }, true)).toBeNull();
    expect(freeOfferHint(offer(), live, true)).toBeNull();
    expect(freeOfferHint(TRIAL, { ...live, status: 'canceled' }, true)).toBeNull();
    expect(freeOfferHint(TRIAL, sub({ hasBillingAccount: true }), true)).toBeNull();
  });

  it('Manage billing needs a billing account as well', () => {
    expect(showManageBilling(sub(), true)).toBe(false);
    expect(showManageBilling(sub({ hasBillingAccount: true }), true)).toBe(true);
    expect(showManageBilling(sub({ hasBillingAccount: true }), false)).toBe(false);
    expect(showManageBilling(sub({ hasBillingAccount: true, selfServeEnabled: false }), true)).toBe(
      false,
    );
  });
});

describe('a subscription from an engine with or without provider fields', () => {
  it('missing fields default to today’s behaviour: no provider, Switch allowed', () => {
    const old = { ...sub() } as Partial<BillingSubscription>;
    delete old.provider;
    delete old.checkoutProvider;
    delete old.canSwitchPlan;
    delete old.offers;
    const s = normaliseSubscription(old as BillingSubscription);
    expect(s.provider).toBeNull();
    expect(s.checkoutProvider).toBeNull();
    expect(s.canSwitchPlan).toBe(true);
    expect(s.offers).toEqual([]);
    const live = normaliseSubscription({
      ...(old as BillingSubscription),
      offers: sub().offers,
      status: 'active',
      currentPlan: { slug: 'desk', name: 'Desk' },
    });
    expect(offerAction(offer(), live, true)).toEqual({ kind: 'portal', label: 'Switch' });
  });

  it('keeps known providers, drops anything else, only an explicit false stops Switch', () => {
    const s = normaliseSubscription(
      sub({ provider: 'paystack', checkoutProvider: 'stripe', canSwitchPlan: false }),
    );
    expect(s).toMatchObject({
      provider: 'paystack',
      checkoutProvider: 'stripe',
      canSwitchPlan: false,
    });
    const odd = normaliseSubscription({
      ...sub(),
      provider: 'PayPal' as never,
      checkoutProvider: '' as never,
      canSwitchPlan: null as never,
    });
    expect(odd).toMatchObject({ provider: null, checkoutProvider: null, canSwitchPlan: true });
  });
});

describe('a live subscription that cannot switch plan (Paystack)', () => {
  const paystack = (over: Partial<BillingSubscription> = {}) =>
    sub({
      status: 'active',
      hasBillingAccount: true,
      provider: 'paystack',
      checkoutProvider: 'paystack',
      canSwitchPlan: false,
      currentPlan: { slug: 'pro', name: 'Pro' },
      offers: [
        TRIAL,
        offer({ isCurrent: true }),
        offer({ slug: 'desk', name: 'Desk', priceAmount: 99 }),
      ],
      ...over,
    });

  it('offers no Switch on other paid plans', () => {
    const s = paystack();
    expect(offerAction(s.offers[2], s, true)).toBeNull();
    expect(offerAction(s.offers[1], s, true)).toBeNull();
    // Without a live subscription it is a new checkout, as before.
    expect(offerAction(s.offers[2], paystack({ status: 'canceled' }), true)?.kind).toBe('checkout');
  });

  it('says on the current plan how to move, for someone who sees Manage billing', () => {
    const s = paystack();
    expect(currentPlanHint(s.offers[1], s, true)).toMatch(
      /^To move to another plan, cancel this one in Manage billing\./,
    );
    expect(currentPlanHint(s.offers[2], s, true)).toBeNull();
    expect(currentPlanHint(s.offers[1], s, false)).toBeNull();
    expect(currentPlanHint(s.offers[1], paystack({ cancelAtPeriodEnd: true }), true)).toBeNull();
    expect(currentPlanHint(s.offers[1], paystack({ canSwitchPlan: true }), true)).toBeNull();
    expect(currentPlanHint(s.offers[1], paystack({ status: 'canceled' }), true)).toBeNull();
    // No other paid plan to move to.
    expect(
      currentPlanHint(s.offers[1], paystack({ offers: [TRIAL, offer({ isCurrent: true })] }), true),
    ).toBeNull();
  });

  it('the free plan keeps its "cancel in Manage billing" line', () => {
    expect(freeOfferHint(TRIAL, paystack(), true)).toBe(
      'To go back to Trial, cancel your plan in Manage billing.',
    );
  });
});

describe('coming back from checkout', () => {
  it('reads the query value', () => {
    expect(checkoutReturn('success')).toBe('success');
    expect(checkoutReturn('cancelled')).toBe('cancelled');
    expect(checkoutReturn('paystack')).toBe('paystack');
    expect(checkoutReturn('PAYSTACK')).toBeNull();
    expect(checkoutReturn('other')).toBeNull();
    expect(checkoutReturn(null)).toBeNull();
  });

  it('reads the Paystack reference, preferring reference over trxref', () => {
    expect(paystackReference('ref_1', 'ref_2')).toBe('ref_1');
    expect(paystackReference(null, 'ref_2')).toBe('ref_2');
    expect(paystackReference('  ', ' ref_2 ')).toBe('ref_2');
    expect(paystackReference(null, undefined)).toBeNull();
    expect(CHECKOUT_RETURN_PARAMS).toEqual(['checkout', 'session_id', 'reference', 'trxref']);
  });

  it('maps the engine’s Paystack answer to what the page does', () => {
    expect(paystackOutcome({ state: 'active', message: 'ok' })).toEqual({ kind: 'done' });
    expect(paystackOutcome({ state: 'processing', message: '' })).toEqual({ kind: 'wait' });
    expect(paystackOutcome({ state: 'not_paid', message: 'x' })).toEqual({ kind: 'cancelled' });
    expect(paystackOutcome({ state: 'failed', message: 'Your card was declined.' })).toEqual({
      kind: 'error',
      text: 'Your card was declined.',
    });
    expect(paystackOutcome({ state: 'failed', message: '' })).toEqual({
      kind: 'error',
      text: 'Your payment did not go through.',
    });
    expect(paystackOutcome({ state: 'weird' as never, message: '' })).toEqual({
      kind: 'error',
      text: PAYSTACK_CONFIRM_FALLBACK,
    });
    expect(paystackOutcome(null)).toEqual({ kind: 'error', text: PAYSTACK_CONFIRM_FALLBACK });
  });

  it('waits until the plan changes or a subscription is live, up to 30 s', () => {
    const before = sub();
    expect(checkoutPollOutcome('trial', before, 0)).toBe('waiting');
    expect(checkoutPollOutcome('trial', before, 28_000)).toBe('waiting');
    expect(checkoutPollOutcome('trial', before, 30_000)).toBe('timeout');
    expect(checkoutPollOutcome('trial', null, 30_000)).toBe('timeout');
    expect(checkoutPollOutcome('trial', null, 2_000)).toBe('waiting');
    expect(
      checkoutPollOutcome('trial', sub({ currentPlan: { slug: 'pro', name: 'Pro' } }), 4_000),
    ).toBe('done');
    // The same plan bought again after a cancellation: done once the subscription is live.
    expect(
      checkoutPollOutcome(
        'pro',
        sub({ currentPlan: { slug: 'pro', name: 'Pro' }, status: 'active' }),
        2_000,
      ),
    ).toBe('done');
    // Already live on the first read (the webhook beat the page).
    expect(checkoutPollOutcome(null, sub({ status: 'trialing' }), 0)).toBe('done');
  });
});

describe('redirects and refusals', () => {
  it('follows https, same-origin paths and local http only', () => {
    expect(isFollowableRedirect('https://checkout.stripe.com/c/pay/cs_test_1')).toBe(true);
    expect(isFollowableRedirect('https://checkout.paystack.com/0peioxfhpn')).toBe(true);
    expect(isFollowableRedirect('/organisation/billing?checkout=success')).toBe(true);
    expect(isFollowableRedirect('http://localhost:5081/test-checkout')).toBe(true);
    expect(isFollowableRedirect('http://evil.example.com/')).toBe(false);
    expect(isFollowableRedirect('//evil.example.com/')).toBe(false);
    expect(isFollowableRedirect('javascript:alert(1)')).toBe(false);
    expect(isFollowableRedirect('')).toBe(false);
    expect(isFollowableRedirect(null)).toBe(false);
  });

  it('prefers the engine’s sentence, with plain fallbacks per code', () => {
    const own = new ApiError('-11', 'Already subscribed — use Manage billing.', {} as never);
    expect(billingRefusal(own, 'x')).toBe('Already subscribed — use Manage billing.');
    const bare11 = new ApiError('-11', 'Request failed', {} as never);
    expect(billingRefusal(bare11, 'x')).toMatch(/already has a subscription/);
    const bare14 = new ApiError('-14', '', {} as never);
    expect(billingRefusal(bare14, 'x')).toMatch(/could not be found/);
    expect(billingRefusal({ status: 0, message: 'Http failure response' }, 'Could not open.')).toBe(
      'Could not open.',
    );
  });

  it('reads the envelope of an HTTP error answer (how the engine refuses)', () => {
    const http = (status: number, responseCode: string, message: string) =>
      new HttpErrorResponse({
        status,
        error: { status: false, data: null, responseCode, message },
        url: '/api/v1/lascodia-trading-engine/tenant/billing/checkout',
      });
    expect(billingRefusal(http(400, '-11', 'Request failed'), 'x')).toMatch(
      /already has a subscription/,
    );
    expect(billingRefusal(http(404, '-14', ''), 'x')).toMatch(/could not be found/);
    expect(billingRefusal(http(503, '-503', ''), 'x')).toMatch(/not available just now/);
    expect(billingRefusal(http(503, '-503', 'Paying by card is not available.'), 'x')).toBe(
      'Paying by card is not available.',
    );
    expect(billingRefusal(http(400, '-99', 'Request failed'), 'Could not open.')).toBe(
      'Could not open.',
    );
  });
});
