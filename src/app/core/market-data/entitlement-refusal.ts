/**
 * Market-data entitlement refusals (engine market-data program C6, `docs/api/marketdata-entitlements.md`). A read made of
 * a feed the organisation is not entitled to (the chart-flow heatmap and tick bars, the order-book reads, the CME tape
 * analytics) answers HTTP 403 with `responseCode: "-403-entitlement"` and the reason in `message` — e.g. "Your
 * organisation is not entitled to the 'cme-l2' feed (CME futures depth (MBP-10 book))." It is not a permission problem:
 * show it as a "not entitled" state of the layer, never as "you do not have permission".
 */

export const ENTITLEMENT_RESPONSE_CODE = '-403-entitlement';

type Envelope = { responseCode?: unknown; message?: unknown };

/** The envelope inside an `HttpErrorResponse` (`.error`), an `ApiError` (`.response`) or the envelope itself. */
function envelopeOf(err: unknown): Envelope | null {
  if (!err || typeof err !== 'object') return null;
  const o = err as { error?: unknown; response?: unknown; responseCode?: unknown };
  if (typeof o.responseCode === 'string') return o as Envelope;
  for (const inner of [o.error, o.response]) {
    if (inner && typeof inner === 'object' && typeof (inner as Envelope).responseCode === 'string')
      return inner as Envelope;
  }
  return null;
}

/** True when the error (or envelope) is an entitlement refusal. */
export function isEntitlementRefusal(err: unknown): boolean {
  return envelopeOf(err)?.responseCode === ENTITLEMENT_RESPONSE_CODE;
}

/** The engine's reason for an entitlement refusal, or null when the error is something else. */
export function entitlementRefusalMessage(err: unknown): string | null {
  const env = envelopeOf(err);
  if (env?.responseCode !== ENTITLEMENT_RESPONSE_CODE) return null;
  return typeof env.message === 'string' && env.message.trim()
    ? env.message.trim()
    : 'Your organisation is not entitled to this market-data feed.';
}
