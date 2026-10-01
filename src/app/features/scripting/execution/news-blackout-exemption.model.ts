import {
  NEWS_BLACKOUT_EXEMPT_REASON_MAX,
  NEWS_BLACKOUT_EXEMPT_REASON_MIN,
  type StrategyDto,
  type UpdateStrategyRequest,
} from '@core/api/api.types';

import type { ScriptStrategyDto, ScriptStrategyFields } from '../api/scripting-api.types';
import { isScriptStrategy } from '../shared/script-strategy';

/**
 * The per-strategy opt-out of the engine's high-impact news blackout (engine
 * `Strategy.NewsBlackoutExempt`, 2026-10-01). Live, the Tier-1 bridge refuses an entry signal within
 * the window around a High-impact release for either currency of the symbol; the script execution
 * mirror applies the same check to live and paper entries, and a script backtest leaves those
 * trades out of the account. A script strategy DESIGNED to trade around releases holds this
 * audited exemption instead — set through `PUT strategy/{id}` with a reason, recorded as a
 * `NewsBlackoutExemption` DecisionLog row.
 */

type AnyStrategy = (StrategyDto & Partial<ScriptStrategyFields>) | ScriptStrategyDto;

/**
 * True when the strategy holds the exemption AND the engine honours it: only a script strategy can
 * (the engine's `NewsBlackoutExemption.Applies` — a flag on any other row is ignored).
 */
export function isNewsBlackoutExempt(s: AnyStrategy | null | undefined): boolean {
  return !!s && s.newsBlackoutExempt === true && isScriptStrategy(s);
}

/** What the exemption does — the sentence every confirmation leads with. */
export const EXEMPTION_EFFECT =
  'This strategy’s live, paper and backtest entries are NOT blocked by the engine’s high-impact news blackout. It is meant for strategies designed around releases.';

/** The blackout itself, for the card's standing explanation. */
export const BLACKOUT_EXPLAINER =
  'The engine refuses new entries in a window around every High-impact economic release for either currency of the symbol — by default 30 minutes before to 15 minutes after. Live, paper and backtests all apply it, so a strategy’s evidence matches what live can do. The window is off while neither Viability Gates news gate is enforced; an exemption then changes nothing until it is back on.';

/** The rest of what a grant means, listed in its confirmation. */
export const GRANT_DETAILS: readonly string[] = [
  'Live: the Tier-1 bridge and the execution mirror let its entries through inside the window.',
  'Paper: entries inside the window are recorded as paper trades.',
  'Backtests queued from now on keep those trades (earlier runs are not re-run).',
  'The EA’s own news blackout lets its signals through too — each signal carries the flag.',
  'A running live or paper session picks it up within one refresh cycle, without a restart.',
  'Audited: who, why and before/after are recorded as a NewsBlackoutExemption decision. Clone, templates and import never copy it.',
];

/** What a revoke means, listed in its confirmation. */
export const REVOKE_DETAILS: readonly string[] = [
  'Live and paper entries inside the window are refused again; unexecuted signals are stopped too.',
  'Backtests queued from now on leave entries inside the window out of the account.',
  'Exits and protective stop / target changes are never blocked.',
  'Audited as a NewsBlackoutExemption decision (Revoked).',
];

/**
 * Why a reason cannot be sent, or null when it can. A grant needs at least
 * {@link NEWS_BLACKOUT_EXEMPT_REASON_MIN} characters once trimmed (the engine refuses shorter with
 * `-11`); a revoke's reason is optional. Both are capped at {@link NEWS_BLACKOUT_EXEMPT_REASON_MAX}.
 */
export function exemptionReasonProblem(grant: boolean, reason: string): string | null {
  const text = reason.trim();
  if (text.length > NEWS_BLACKOUT_EXEMPT_REASON_MAX) {
    return `At most ${NEWS_BLACKOUT_EXEMPT_REASON_MAX} characters (${text.length} now).`;
  }
  if (grant && text.length < NEWS_BLACKOUT_EXEMPT_REASON_MIN) {
    return `Say why this strategy is designed to trade around releases — at least ${NEWS_BLACKOUT_EXEMPT_REASON_MIN} characters (${text.length} now).`;
  }
  return null;
}

/**
 * The `PUT strategy/{id}` body for a grant or revoke. Every other field is omitted, so the engine
 * leaves it unchanged; `changeReason` labels the pre-edit version snapshot the engine captures.
 */
export function exemptionUpdateRequest(grant: boolean, reason: string): UpdateStrategyRequest {
  const text = reason.trim();
  return {
    newsBlackoutExempt: grant,
    newsBlackoutExemptReason: text === '' ? null : text,
    changeReason: grant ? 'News-blackout exemption granted' : 'News-blackout exemption revoked',
  };
}
