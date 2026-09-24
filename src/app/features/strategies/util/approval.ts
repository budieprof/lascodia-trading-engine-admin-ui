import type {
  ResponseData,
  StrategyApprovalGateDto,
  StrategyApprovalResultDto,
} from '@core/api/api.types';

/**
 * How a `submit-for-approval` answer reads:
 * - `approved` — every gate passed; the strategy is Approved (paper trading);
 * - `rejected` — the gates ran and at least one failed;
 * - `not-judged` — the evaluation ran out of budget or errored (an `evaluation` gate row says why);
 * - `refused` — nothing ran: not a Draft, not Paused, or an evaluation is already running.
 */
export type ApprovalVerdict = 'approved' | 'rejected' | 'not-judged' | 'refused';

/** The engine's answer, whatever envelope it came in. */
export interface ApprovalOutcome {
  verdict: ApprovalVerdict;
  /** Lifecycle stage after the call (the engine's spelling). */
  stage: string | null;
  gates: StrategyApprovalGateDto[];
  /** The engine's own sentence about it. */
  message: string | null;
}

/**
 * Reads a `POST strategy/{id}/submit-for-approval` response. The engine puts the result in `data`
 * on every path — approved and rejected come as `status: true`; a timed-out or failed evaluation
 * (`-12`, with an `evaluation` gate row), a non-Draft and a concurrent submission (`-11`, no gates)
 * as `status: false` — so the verdict is read from `data` and the gates, never from `status`
 * alone. Null when the envelope carries no result.
 */
export function readApprovalOutcome(
  res: ResponseData<StrategyApprovalResultDto> | null | undefined,
): ApprovalOutcome | null {
  if (!res?.data || typeof res.data !== 'object') return null;
  const data = res.data;
  const gates = Array.isArray(data.gates) ? data.gates : [];
  let verdict: ApprovalVerdict;
  if (!res.status && gates.length === 0) verdict = 'refused';
  else if (res.status && data.approved) verdict = 'approved';
  else if (!res.status || gates.some((g) => g.name === 'evaluation' && !g.passed)) {
    verdict = 'not-judged';
  } else verdict = 'rejected';
  return {
    verdict,
    stage: typeof data.stage === 'string' && data.stage ? data.stage : null,
    gates,
    message: res.message && res.message.toLowerCase() !== 'successful' ? res.message : null,
  };
}
