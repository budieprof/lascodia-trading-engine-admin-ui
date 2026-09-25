/**
 * Activation of a strategy that is not yet Approved.
 *
 * `PUT strategy/{id}/activate` requires the Approved stage and refuses anything else with
 * "Strategy must reach Approved lifecycle stage before activation. Current stage: X". For an
 * operator-authored Draft the way forward is `POST strategy/{id}/submit-for-approval` (ADR-0027
 * DEC-10) — the auto-promotion never picks a hand-written strategy up — so the refusal must say so
 * rather than leave the operator at a dead end.
 */

/** What an operator is told to do with a Draft that cannot be activated. */
export const DRAFT_ACTIVATION_HINT =
  'A Draft is activated through "Submit for approval": it runs the promotion gates and, on a pass, moves the strategy to Approved (paper trading), from where it can be activated.';

/** True when an activation refusal is the engine's "must reach Approved" answer for a Draft. */
export function isDraftActivationRefusal(
  message: string | null | undefined,
  stage?: string | null,
): boolean {
  if (stage === 'Draft') return true;
  return !!message && /current stage:\s*draft\b/i.test(message);
}

/** The engine's refusal, pointed at "Submit for approval" when the strategy is a Draft. */
export function activationRefusalMessage(message: string, stage?: string | null): string {
  return isDraftActivationRefusal(message, stage)
    ? `${message} — ${DRAFT_ACTIVATION_HINT}`
    : message;
}
