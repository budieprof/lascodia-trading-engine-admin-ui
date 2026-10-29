import type { PlanOffer } from './billing.types';

/**
 * How a plan's price and limits read — shared by Usage & billing and the public landing page. Nothing imported
 * beyond the DTO type, so the landing bundle stays small.
 */

/** Currencies written with their own sign rather than en-US's code ("NGN 73,500"): ₦ for Paystack's naira prices. */
const NARROW_SIGN: ReadonlySet<string> = new Set(['NGN']);

/**
 * "Free" for the free plan; otherwise the price in its currency with the billing interval: "$49 / month",
 * "₦73,500 / month". Whole amounts carry no ".00".
 */
export function planPrice(
  amount: number | null | undefined,
  currency: string | null | undefined,
  interval: string | null | undefined,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0)
    return 'Free';
  const digits = Number.isInteger(amount) ? 0 : 2;
  const plain = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const code = (currency ?? '').trim().toUpperCase();
  let text: string;
  try {
    text = code
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: code,
          // Only listed codes take the narrow sign: for others it is ambiguous (CAD and AUD would both read "$").
          currencyDisplay: NARROW_SIGN.has(code) ? 'narrowSymbol' : 'symbol',
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        }).format(amount)
      : plain(amount);
  } catch {
    // An unknown currency code: the number and the code as the engine sent it.
    text = `${plain(amount)} ${code}`;
  }
  return interval === 'month' || interval === 'year' ? `${text} / ${interval}` : text;
}

export function offerPrice(offer: PlanOffer): string {
  return planPrice(offer.priceAmount, offer.currency, offer.interval);
}

export function isPaid(offer: PlanOffer): boolean {
  return Number.isFinite(offer.priceAmount) && offer.priceAmount > 0;
}

/** The plan's limits in words, null = unlimited. */
export function planLimits(offer: PlanOffer): { label: string; value: string }[] {
  const v = (n: number | null | undefined) =>
    n === null || n === undefined ? 'Unlimited' : n.toLocaleString('en-US');
  return [
    { label: 'Trading accounts', value: v(offer.maxTradingAccounts) },
    { label: 'Connected terminals', value: v(offer.maxActiveEaInstances) },
    { label: 'Members', value: v(offer.maxMembers) },
    { label: 'Strategies', value: v(offer.maxStrategies) },
  ];
}

/** "Up to 5 trading accounts" lines for a plan card that has no copy of its own. */
export function limitPoints(offer: PlanOffer): string[] {
  const line = (n: number | null | undefined, one: string, many: string) =>
    n === null || n === undefined
      ? `Unlimited ${many}`
      : `Up to ${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  return [
    line(offer.maxTradingAccounts, 'trading account', 'trading accounts'),
    line(offer.maxActiveEaInstances, 'connected terminal', 'connected terminals'),
    line(offer.maxMembers, 'member', 'members'),
    line(offer.maxStrategies, 'strategy', 'strategies'),
  ];
}
