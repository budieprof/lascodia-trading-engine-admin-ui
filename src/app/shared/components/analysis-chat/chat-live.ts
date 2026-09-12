import type { SpotAnalysisFollowUpTurnDto } from '@core/api/api.types';

/**
 * Rules that keep a live chat log readable while a streaming agent writes into it.
 *
 * Scrolling
 * ---------
 * A streaming agent rewrites the last turn roughly once a second and the thread grows under the
 * reader. Auto-scrolling on every one of those updates is what yanks the log out from under an
 * operator who has scrolled up to read something — so the log follows the newest turn only while
 * it is ALREADY parked at the bottom, and otherwise stays exactly where the reader put it and
 * offers a "jump to latest" affordance instead.
 *
 * Pure so the rule is testable without a DOM.
 */

/** The part of an element these rules read — so a test can pass a plain object. */
export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Within `threshold` pixels of the bottom (or not scrollable at all).
 *
 * The slack matters: a sub-pixel `scrollHeight`, a growing last line, and the browser's own
 * rounding all leave a log that LOOKS pinned a pixel or two short of it, and a strict compare
 * would unpin the reader mid-stream and pop the jump button up for no reason.
 */
export function isPinnedToBottom(box: ScrollBox, threshold = 48): boolean {
  const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (!Number.isFinite(distance)) return true;
  return distance <= threshold;
}

/** "3 new messages" / "1 new message" — the jump affordance's label while the reader is away. */
export function jumpLabel(newCount: number): string {
  if (newCount <= 0) return 'Jump to latest';
  return `${newCount} new message${newCount === 1 ? '' : 's'} ↓`;
}

/**
 * Fold a freshly fetched thread over the one on screen, keeping any message the operator has just
 * sent that the server has not echoed back yet.
 *
 * The chat shows the operator's question optimistically (a turn with a NEGATIVE id) while the ask
 * is in flight. A live refresh landing in that window used to be forbidden outright — which, now
 * that the agent narrates into the thread while it works, would mean the stream freezes for as
 * long as the request takes. So the refresh is allowed and the optimistic turn is carried across
 * instead; it disappears the moment the server's copy of it shows up.
 */
export function mergeOptimisticTurns(
  server: readonly SpotAnalysisFollowUpTurnDto[],
  current: readonly SpotAnalysisFollowUpTurnDto[],
): SpotAnalysisFollowUpTurnDto[] {
  const pending = current.filter(
    (t) => t.id < 0 && !server.some((s) => s.role === t.role && s.content === t.content),
  );
  return pending.length === 0 ? [...server] : [...server, ...pending];
}
