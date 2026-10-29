import { ApiError } from '@core/api/api.types';
import { errorText } from '@features/iam/iam.logic';
import type {
  BillingProvider,
  BillingSubscription,
  PaystackConfirmation,
  PlanOffer,
  SubscriptionStatus,
} from './billing.types';
import { isPaid } from './plan-price';

export { isPaid, limitPoints, offerPrice, planLimits, planPrice } from './plan-price';

/**
 * Decisions for self-serve plans (Stripe Checkout + billing portal, or Paystack's payment page + manage page):
 * which button a plan card offers for the person's status and permission, what the status says, and when the wait
 * after a checkout is over. Pure.
 */

function providerOf(value: unknown): BillingProvider | null {
  return value === 'stripe' || value === 'paystack' ? value : null;
}

/**
 * The subscription as the page uses it. Engines older than Paystack support send no `provider`,
 * `checkoutProvider` or `canSwitchPlan`: the providers read as null and switching stays on (today's Stripe
 * behaviour). Only an explicit `false` turns Switch off.
 */
export function normaliseSubscription(raw: BillingSubscription): BillingSubscription {
  const r = (raw ?? {}) as Partial<BillingSubscription>;
  return {
    ...(r as BillingSubscription),
    offers: r.offers ?? [],
    provider: providerOf(r.provider),
    checkoutProvider: providerOf(r.checkoutProvider),
    canSwitchPlan: r.canSwitchPlan !== false,
  };
}

/** A paid subscription exists: changing plan happens in the billing portal, not a new checkout. */
export function hasLiveSubscription(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'info';

/** The status chip beside the current plan; null when there is nothing to say (the free plan). */
export function statusBadge(status: SubscriptionStatus): { label: string; tone: BadgeTone } | null {
  switch (status) {
    case 'active':
      return { label: 'Active', tone: 'ok' };
    case 'trialing':
      return { label: 'Trial period', tone: 'info' };
    case 'past_due':
      return { label: 'Payment failed', tone: 'warn' };
    case 'incomplete':
      return { label: 'Payment not finished', tone: 'warn' };
    case 'unpaid':
      return { label: 'Unpaid', tone: 'bad' };
    case 'canceled':
      return { label: 'Cancelled', tone: 'info' };
    default:
      return null;
  }
}

/** "28 November 2026" (UTC); null for a missing or unreadable date. */
export function periodEndLabel(utc: string | null | undefined): string | null {
  if (!utc) return null;
  const d = new Date(utc);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
}

/**
 * Sentences shown under the current plan: a failed payment, an unfinished checkout, a plan that is ending.
 * `mayManageBilling` = the person sees Manage billing, so the sentence can say where to fix it.
 */
export function planNotices(
  sub: BillingSubscription,
  mayManageBilling = false,
): { text: string; tone: 'warn' | 'info' }[] {
  const out: { text: string; tone: 'warn' | 'info' }[] = [];
  const fix = mayManageBilling ? 'update your card in Manage billing' : 'update your card';
  if (sub.status === 'past_due')
    out.push({ text: `Your last payment failed — ${fix}.`, tone: 'warn' });
  if (sub.status === 'unpaid')
    out.push({ text: `Your plan is unpaid — ${fix} to keep it.`, tone: 'warn' });
  if (sub.status === 'incomplete')
    out.push({
      text: 'Your last payment was not finished, so your plan has not changed.',
      tone: 'info',
    });
  if (sub.cancelAtPeriodEnd) {
    const end = periodEndLabel(sub.currentPeriodEndUtc);
    const name = sub.currentPlan?.name;
    const what = name ? `Your ${name} plan ends` : 'Your plan ends';
    const fallback = sub.offers.find((o) => o.isDefault && o.slug !== sub.currentPlan?.slug);
    out.push({
      text:
        (end ? `${what} on ${end}.` : `${what} at the end of this billing period.`) +
        (fallback ? ` After that you are on ${fallback.name}.` : ''),
      tone: 'info',
    });
  }
  return out;
}

/** Self-serve is on but the engine offers no paid plan to buy (no provider prices set up yet). */
export function noPaidOffers(sub: BillingSubscription): boolean {
  return sub.selfServeEnabled && !sub.offers.some(isPaid);
}

/**
 * The line on the free plan's card while a paid subscription is live: going back to it is a cancellation in
 * the billing portal, so say so instead of leaving the card without a way there. Null otherwise.
 */
export function freeOfferHint(
  offer: PlanOffer,
  sub: BillingSubscription,
  holdsManageKey: boolean,
): string | null {
  if (!showManageBilling(sub, holdsManageKey) || !hasLiveSubscription(sub.status)) return null;
  // Already cancelled: the plan notice says when it ends and that the free plan follows.
  if (sub.cancelAtPeriodEnd) return null;
  if (isPaid(offer) || offer.isCurrent || offer.slug === sub.currentPlan?.slug) return null;
  return `To go back to ${offer.name}, cancel your plan in Manage billing.`;
}

/** The person may change the plan here: self-serve is on, the engine says so and they hold the key. */
export function canChangePlan(sub: BillingSubscription, holdsManageKey: boolean): boolean {
  return sub.selfServeEnabled && sub.canManage && holdsManageKey;
}

/**
 * The line on the current plan's card when a live subscription cannot change plan in Manage billing (Paystack):
 * moving is a cancellation there, then a new checkout here once the paid period is over. Null otherwise — also
 * once the plan is already cancelled (the plan notice says when it ends) or there is no other paid plan.
 */
export function currentPlanHint(
  offer: PlanOffer,
  sub: BillingSubscription,
  holdsManageKey: boolean,
): string | null {
  if (sub.canSwitchPlan !== false || sub.cancelAtPeriodEnd) return null;
  if (!showManageBilling(sub, holdsManageKey) || !hasLiveSubscription(sub.status)) return null;
  if (!offer.isCurrent && offer.slug !== sub.currentPlan?.slug) return null;
  const other = sub.offers.some(
    (o) => isPaid(o) && !o.isCurrent && o.slug !== sub.currentPlan?.slug,
  );
  if (!other) return null;
  return 'To move to another plan, cancel this one in Manage billing. It stays on until the paid period ends; then choose the new plan here.';
}

export type OfferAction = { kind: 'checkout' | 'portal'; label: string };

/**
 * The button on one plan card, or null: none on the current plan, the free plan (leaving a paid plan is a
 * cancellation, in the portal) or for someone who may not change the plan. With a live subscription the
 * switch happens in the billing portal; without one it is a new checkout. A live subscription whose provider
 * cannot switch plan there (`canSwitchPlan: false`, Paystack) gets no button: the current plan's card says how.
 *
 * `paymentPending`: the person has just paid at the payment page and the engine has not heard from the provider yet (the
 * page is waiting, or gave up waiting). The plan still reads as the old one, so a new checkout would be a
 * second subscription — no Upgrade then.
 */
export function offerAction(
  offer: PlanOffer,
  sub: BillingSubscription,
  holdsManageKey: boolean,
  paymentPending = false,
): OfferAction | null {
  if (!canChangePlan(sub, holdsManageKey)) return null;
  if (offer.isCurrent || offer.slug === sub.currentPlan?.slug || !isPaid(offer)) return null;
  if (hasLiveSubscription(sub.status))
    return sub.canSwitchPlan === false ? null : { kind: 'portal', label: 'Switch' };
  return paymentPending ? null : { kind: 'checkout', label: 'Upgrade' };
}

/** "Manage billing" (the portal) needs a billing account at the provider. */
export function showManageBilling(sub: BillingSubscription, holdsManageKey: boolean): boolean {
  return canChangePlan(sub, holdsManageKey) && sub.hasBillingAccount;
}

export type CheckoutReturn = 'success' | 'cancelled' | 'paystack';

/**
 * Where the payment page sent the person back to: Stripe's `?checkout=success|cancelled`, or Paystack's
 * `?checkout=paystack&reference=…` (paid or not — the engine is asked which).
 */
export function checkoutReturn(value: string | null | undefined): CheckoutReturn | null {
  return value === 'success' || value === 'cancelled' || value === 'paystack' ? value : null;
}

/** The Paystack transaction reference from the return URL (`reference`, else `trxref`); null when neither. */
export function paystackReference(
  reference: string | null | undefined,
  trxref: string | null | undefined,
): string | null {
  const r = (reference ?? '').trim() || (trxref ?? '').trim();
  return r || null;
}

/** Query parameters the payment pages add on the way back; stripped once the page has read them. */
export const CHECKOUT_RETURN_PARAMS = ['checkout', 'session_id', 'reference', 'trxref'] as const;

/**
 * What the page does with the engine's answer about a Paystack payment:
 * `done` — the plan is on; `wait` — paid, still being set up (the same wait as Stripe's `checkout=success`);
 * `cancelled` — not paid (the same notice as Stripe's `checkout=cancelled`); `error` — say `text`.
 */
export type PaystackOutcome =
  | { kind: 'done' }
  | { kind: 'wait' }
  | { kind: 'cancelled' }
  | { kind: 'error'; text: string };

export const PAYSTACK_CONFIRM_FALLBACK =
  'We could not confirm your payment. If you paid, refresh this page in a minute.';

export function paystackOutcome(res: PaystackConfirmation | null | undefined): PaystackOutcome {
  const message = typeof res?.message === 'string' ? res.message.trim() : '';
  switch (res?.state) {
    case 'active':
      return { kind: 'done' };
    case 'processing':
      return { kind: 'wait' };
    case 'not_paid':
      return { kind: 'cancelled' };
    case 'failed':
      return { kind: 'error', text: message || 'Your payment did not go through.' };
    default:
      return { kind: 'error', text: message || PAYSTACK_CONFIRM_FALLBACK };
  }
}

export const CHECKOUT_POLL_MS = 2_000;
export const CHECKOUT_POLL_LIMIT_MS = 30_000;

/**
 * After a successful checkout the engine learns of the payment from the provider a moment later. Done once the plan
 * differs from the one the page started with or a subscription is live; out of time after `limitMs`.
 */
export function checkoutPollOutcome(
  startSlug: string | null,
  sub: BillingSubscription | null,
  elapsedMs: number,
  limitMs = CHECKOUT_POLL_LIMIT_MS,
): 'done' | 'waiting' | 'timeout' {
  if (sub) {
    const slug = sub.currentPlan?.slug ?? null;
    if (
      (startSlug !== null && slug !== null && slug !== startSlug) ||
      hasLiveSubscription(sub.status)
    )
      return 'done';
  }
  return elapsedMs >= limitMs ? 'timeout' : 'waiting';
}

/**
 * Only follow a checkout / portal link that is https (the payment provider), a same-origin path, or plain http
 * on this machine (the engine's local test double). Anything else is not followed.
 */
export function isFollowableRedirect(url: string | null | undefined): url is string {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * A refused checkout or portal call in plain words, preferring the engine's own sentence. The engine answers
 * these refusals with an HTTP error status (400 / 404 / 503) and the envelope as the body, so the code and
 * sentence are read from there as well as from an `ApiError` (an HTTP 200 envelope with `status: false`).
 */
export function billingRefusal(err: unknown, fallback: string): string {
  const body =
    err instanceof ApiError
      ? { code: err.code, message: err.message }
      : envelopeOf((err as { error?: unknown } | null)?.error);
  const own = !!body?.message && body.message !== 'Request failed';
  if (!own) {
    if (body?.code === '-11')
      return 'This organisation already has a subscription — use Manage billing to change it.';
    if (body?.code === '-14') return 'That plan or billing account could not be found.';
    if (body?.code === '-503')
      return 'Card payment is not available just now. Please try again later.';
    // The generic envelope sentence says nothing; never show it.
    if (body?.message === 'Request failed') return fallback;
  }
  return errorText(err, fallback);
}

function envelopeOf(body: unknown): { code: string | null; message: string | null } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { responseCode?: unknown; message?: unknown };
  return {
    code: typeof b.responseCode === 'string' ? b.responseCode : null,
    message: typeof b.message === 'string' ? b.message : null,
  };
}
