import type { BatchCancelOrdersResult } from '@core/api/api.types';

/**
 * Whether a successful cancel finished or was handed to the EA. The engine answers `Cancelling` when
 * the order has a broker ticket: the EA still has to cancel it at MT5 (market closed, EA offline …),
 * so the order stays working until it confirms. Older engines answer `null`; then a broker ticket
 * means the same thing (review 2026-11-17: the console said "cancelled" for both).
 */
export function cancelWasHandedToEa(
  data: string | null | undefined,
  brokerOrderId: string | null | undefined,
): boolean {
  if (data === 'Cancelling') return true;
  if (data === 'Cancelled') return false;
  return !!brokerOrderId;
}

export const CANCEL_SENT_TO_EA_MESSAGE =
  'Cancel sent to the EA. The order stays working at the broker until the EA confirms it.';

/** One-line summary of a batch cancel. `ticketed` = ids that had a broker ticket (older-engine fallback). */
export function describeBatchCancel(
  r: BatchCancelOrdersResult,
  ticketed: ReadonlySet<number>,
): { text: string; tone: 'success' | 'warning' } {
  let done = 0;
  let handed = 0;
  for (const item of r.results ?? []) {
    if (item.status === 'Failed') continue;
    const viaEa =
      item.status === 'Cancelling' || (r.cancelling === undefined && ticketed.has(item.id));
    if (viaEa) handed++;
    else done++;
  }
  const parts: string[] = [];
  if (done) parts.push(`${done} cancelled`);
  if (handed)
    parts.push(`${handed} sent to the EA (still working at the broker until it confirms)`);
  if (r.failed) parts.push(`${r.failed} failed — see the order list`);
  const text = parts.length ? `${capitalise(parts.join(', '))}.` : 'Nothing was cancelled.';
  return { text, tone: r.failed || handed ? 'warning' : 'success' };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
