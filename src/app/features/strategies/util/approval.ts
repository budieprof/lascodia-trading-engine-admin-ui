import type {
  ResponseData,
  StrategyApprovalGateDto,
  StrategyApprovalJobDto,
  StrategyApprovalResultDto,
} from '@core/api/api.types';

/**
 * How a Submit-for-approval answer reads:
 * - `approved` — every gate passed; the strategy is Approved (paper trading);
 * - `rejected` — the gates ran and at least one failed;
 * - `not-judged` — the evaluation ran out of budget, errored or was interrupted (an `evaluation`
 *   gate row, or the engine's message, says why);
 * - `refused` — nothing ran: not a Draft, not Paused, or an evaluation is already running elsewhere.
 */
export type ApprovalVerdict = 'approved' | 'rejected' | 'not-judged' | 'refused';

/** The engine's answer, whatever envelope it came in. */
export interface ApprovalOutcome {
  verdict: ApprovalVerdict;
  /** Lifecycle stage after the evaluation (the engine's spelling). */
  stage: string | null;
  gates: StrategyApprovalGateDto[];
  /** The engine's own sentence about it. */
  message: string | null;
}

/**
 * Reads a verdict envelope — `{ status, message, data: { approved, stage, gates } }`, the shape the
 * engine's verdict has always had. Approved and rejected come as `status: true`; a timed-out or
 * failed evaluation (`-12`, with an `evaluation` gate row) and a refusal (`-11`, no gates) as
 * `status: false` — so the verdict is read from `data` and the gates, never from `status` alone.
 * Null when the envelope carries no result.
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

/**
 * Reads a finished Submit-for-approval job (`done` or `failed`); null while it runs. A `done` job
 * is a verdict (approved / rejected). A `failed` one reached none: `-12` — timed out, errored or
 * interrupted by an engine restart — reads as not judged even when no gate ran; `-11`/`-14` — the
 * strategy could no longer be evaluated — as refused.
 */
export function readApprovalJob(
  job: StrategyApprovalJobDto | null | undefined,
): ApprovalOutcome | null {
  if (!job || job.status === 'running') return null;
  const result = job.result ?? null;
  const gates = Array.isArray(result?.gates) ? result.gates : [];
  const stage = typeof result?.stage === 'string' && result.stage ? result.stage : null;
  const message = job.message ?? null;
  if (job.status === 'done') {
    return readApprovalOutcome({
      status: true,
      responseCode: job.responseCode ?? '00',
      message: message ?? '',
      data: { approved: !!result?.approved, stage: stage ?? '', gates },
    } as ResponseData<StrategyApprovalResultDto>);
  }
  const refused = job.responseCode === '-11' || job.responseCode === '-14';
  return { verdict: refused ? 'refused' : 'not-judged', stage, gates, message };
}
