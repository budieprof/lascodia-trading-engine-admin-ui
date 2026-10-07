/**
 * Lightweight Charts (5.2.1, the latest release) follows every touch that starts on a chart with
 * non-passive `touchmove`/`touchend` listeners on `<html>`, and only that touch's `touchend`
 * removes them: on `touchcancel` it just clears its long-tap timer. After a chart touch the browser
 * CANCELS — palm rejection, a system or browser gesture taking the finger — they stay registered,
 * and the next `touchend` anywhere on the page is taken for the missing one and
 * `preventDefault()`ed, which cancels that tap's click. So the first tap on any button afterwards
 * (Pine Editor, Strategy Tester, a tester row…) did nothing. A mouse never goes this way.
 *
 * Ending a cancelled chart touch the way the library expects — a `touchend` for the same touches,
 * once the cancel has reached it — closes it out before the next tap.
 *
 * Installed on the document, so it covers every chart on the page; returns the uninstaller.
 */
export function endChartTouchesOnCancel(doc: Document): () => void {
  const onCancel = (ev: TouchEvent): void => {
    const target = ev.target;
    if (!(target instanceof Element) || !target.closest('.tv-lightweight-charts')) return;
    target.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: [...ev.touches],
        targetTouches: [...ev.targetTouches],
        changedTouches: [...ev.changedTouches],
      }),
    );
  };
  // Bubble phase: the chart sees the cancel itself first, then its end.
  doc.addEventListener('touchcancel', onCancel, { passive: true });
  return () => doc.removeEventListener('touchcancel', onCancel);
}
