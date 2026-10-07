import {
  DOCUMENT,
  DestroyRef,
  inject,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';

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
 * However many callers install it, a document gets ONE listener — two would end every cancelled
 * touch twice — and keeps it until the last of them uninstalls.
 */
export function endChartTouchesOnCancel(doc: Document): () => void {
  let install = installs.get(doc);
  if (!install) {
    const onCancel = (ev: TouchEvent): void => {
      const target = ev.target;
      if (!(target instanceof Element) || !target.closest('.tv-lightweight-charts')) return;
      let end: TouchEvent;
      try {
        end = new TouchEvent('touchend', {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: [...ev.touches],
          targetTouches: [...ev.targetTouches],
          changedTouches: [...ev.changedTouches],
        });
      } catch {
        // No TouchEvent constructor (older WebKit): the library's own behaviour stands.
        return;
      }
      target.dispatchEvent(end);
    };
    // Bubble phase: the chart sees the cancel itself first, then its end.
    doc.addEventListener('touchcancel', onCancel, { passive: true });
    install = { users: 0, remove: () => doc.removeEventListener('touchcancel', onCancel) };
    installs.set(doc, install);
  }
  const own = install;
  own.users++;
  let uninstalled = false;
  return () => {
    if (uninstalled) return;
    uninstalled = true;
    if (--own.users > 0) return;
    own.remove();
    installs.delete(doc);
  };
}

/** The one listener per document, and how many installers still want it. */
const installs = new WeakMap<Document, { users: number; remove: () => void }>();

/**
 * The shim for the whole app, installed once at bootstrap (`app.config.ts`). Lightweight Charts
 * draws more than the chart workstation — Pine charts, backtest and run charts — and a cancelled
 * touch on any of them swallows the next tap wherever it lands; installed by the workstation, the
 * shim covered only the workstation, and only while it was open.
 */
export function provideChartTouchCancel(): EnvironmentProviders {
  return provideAppInitializer(() => {
    inject(DestroyRef).onDestroy(endChartTouchesOnCancel(inject(DOCUMENT)));
  });
}
