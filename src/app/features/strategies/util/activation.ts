/**
 * Activation of a strategy that is not yet Approved.
 *
 * `PUT strategy/{id}/activate` requires the Approved stage and refuses anything else with
 * "Strategy must reach Approved lifecycle stage before activation. Current stage: X". For an
 * operator-authored Draft the way forward is `POST strategy/{id}/submit-for-approval` (ADR-0027
 * DEC-10) — the auto-promotion never picks a hand-written strategy up — so the refusal must say so
 * rather than leave the operator at a dead end. The same holds for a Pine script in its paper-only
 * stage (PaperTrading, `PUT strategy/{id}/start-paper-trading`): it is submitted from there.
 */

/** What an operator is told to do with a Draft that cannot be activated. */
export const DRAFT_ACTIVATION_HINT =
  'A Draft is activated through "Submit for approval": it runs the promotion gates and, on a pass, moves the strategy to Approved (paper trading), from where it can be activated.';

/** What an operator is told to do with a paper-trading script that cannot be activated yet. */
export const PAPER_ACTIVATION_HINT =
  'A paper-trading script is activated through "Submit for approval": it runs the promotion gates and, on a pass, moves the strategy to Approved (it keeps paper-trading), from where it can be activated.';

const PAPER_REFUSAL = /current stage:\s*papertrading\b|is paper trading/i;
const DRAFT_REFUSAL = /current stage:\s*draft\b|is a draft and cannot be activated/i;

/**
 * True when an activation refusal is the engine's "must reach Approved" answer for a strategy whose
 * way forward is "Submit for approval": a Draft, or a script in its paper-only stage.
 */
export function isDraftActivationRefusal(
  message: string | null | undefined,
  stage?: string | null,
): boolean {
  if (stage === 'Draft' || stage === 'PaperTrading') return true;
  return !!message && (DRAFT_REFUSAL.test(message) || PAPER_REFUSAL.test(message));
}

/** The engine's refusal, pointed at "Submit for approval" when the strategy is a Draft or paper-trading script. */
export function activationRefusalMessage(message: string, stage?: string | null): string {
  if (!isDraftActivationRefusal(message, stage)) return message;
  const paper = stage === 'PaperTrading' || (!stage && PAPER_REFUSAL.test(message));
  return `${message} — ${paper ? PAPER_ACTIVATION_HINT : DRAFT_ACTIVATION_HINT}`;
}
