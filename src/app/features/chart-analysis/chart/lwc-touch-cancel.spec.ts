import { afterEach, describe, expect, it, vi } from 'vitest';

import { endChartTouchesOnCancel } from './lwc-touch-cancel';

// jsdom has TouchEvent but no Touch constructor: plain touch-likes stand in for Touch objects.
const touchOf = (identifier: number, target: EventTarget): Touch =>
  ({ identifier, target, clientX: 40, clientY: 50 }) as unknown as Touch;

const touchEvent = (type: string, changed: Touch[], touches: Touch[] = []): TouchEvent =>
  new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    changedTouches: changed,
    touches,
    targetTouches: touches,
  });

/**
 * Lightweight Charts' bookkeeping for a chart touch, as 5.2.1 does it: a touchstart on the chart
 * adds a touchend listener on <html> that only a touchend removes; a touchend for another touch,
 * with no fingers left down, is taken for the missing one and preventDefault()ed.
 */
function chartLibrary(chart: Element): void {
  let active: number | null = null;
  const root = chart.ownerDocument.documentElement;
  const onEnd = (ev: Event): void => {
    const e = ev as TouchEvent;
    const ended = [...e.changedTouches].some((t) => t.identifier === active);
    if (!ended && e.touches.length !== 0) return;
    active = null;
    root.removeEventListener('touchend', onEnd);
    e.preventDefault();
  };
  chart.addEventListener('touchstart', (ev) => {
    if (active !== null) return;
    active = (ev as TouchEvent).changedTouches[0].identifier;
    root.addEventListener('touchend', onEnd);
  });
}

let uninstall: (() => void) | null = null;
// Listeners on <html> outlive a test's DOM; this takes them down with it.
let listeners = new AbortController();

afterEach(() => {
  uninstall?.();
  uninstall = null;
  listeners.abort();
  listeners = new AbortController();
  document.body.innerHTML = '';
});

const onRoot = (type: string, fn: (e: Event) => void): void =>
  document.documentElement.addEventListener(type, fn, { signal: listeners.signal });

function page(): { canvas: HTMLCanvasElement; button: HTMLButtonElement } {
  document.body.innerHTML =
    '<div class="tv-lightweight-charts"><canvas></canvas></div><button type="button">Pine Editor</button>';
  return {
    canvas: document.querySelector('canvas')!,
    button: document.querySelector('button')!,
  };
}

describe('a cancelled chart touch must not swallow the next tap', () => {
  it('without the fix, the first tap after a cancelled chart touch is cancelled (the bug)', () => {
    const { canvas, button } = page();
    chartLibrary(canvas);

    canvas.dispatchEvent(touchEvent('touchstart', [touchOf(1, canvas)], [touchOf(1, canvas)]));
    canvas.dispatchEvent(touchEvent('touchcancel', [touchOf(1, canvas)]));
    const tap = touchEvent('touchend', [touchOf(2, button)]);
    button.dispatchEvent(tap);

    // A cancelled touchend means no mouse events and no click for that tap.
    expect(tap.defaultPrevented).toBe(true);
  });

  it('ends the cancelled chart touch, so the next tap goes through', () => {
    const { canvas, button } = page();
    chartLibrary(canvas);
    uninstall = endChartTouchesOnCancel(document);

    canvas.dispatchEvent(touchEvent('touchstart', [touchOf(1, canvas)], [touchOf(1, canvas)]));
    canvas.dispatchEvent(touchEvent('touchcancel', [touchOf(1, canvas)]));
    const tap = touchEvent('touchend', [touchOf(2, button)]);
    button.dispatchEvent(tap);

    expect(tap.defaultPrevented).toBe(false);
  });

  it('ends it with a touchend for the same touches, on the same target, after the cancel', () => {
    const { canvas } = page();
    uninstall = endChartTouchesOnCancel(document);
    const seen: string[] = [];
    let end: TouchEvent | null = null;
    canvas.addEventListener('touchcancel', () => seen.push('cancel'));
    onRoot('touchend', (e) => {
      seen.push('end');
      end = e as TouchEvent;
    });

    const cancelled = touchOf(7, canvas);
    canvas.dispatchEvent(touchEvent('touchcancel', [cancelled]));

    expect(seen).toEqual(['cancel', 'end']);
    expect(end!.target).toBe(canvas);
    expect([...end!.changedTouches].map((t) => t.identifier)).toEqual([7]);
    expect(end!.touches.length).toBe(0);
    expect(end!.bubbles).toBe(true);
  });

  it('leaves touches cancelled outside a chart alone', () => {
    const { button } = page();
    uninstall = endChartTouchesOnCancel(document);
    let ends = 0;
    onRoot('touchend', () => ends++);

    button.dispatchEvent(touchEvent('touchcancel', [touchOf(3, button)]));

    expect(ends).toBe(0);
  });

  it('stays quiet where a TouchEvent cannot be constructed (older WebKit)', () => {
    const { canvas } = page();
    uninstall = endChartTouchesOnCancel(document);
    const cancel = touchEvent('touchcancel', [touchOf(5, canvas)]);
    let ends = 0;
    onRoot('touchend', () => ends++);
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(e.error);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    vi.stubGlobal(
      'TouchEvent',
      class {
        constructor() {
          throw new TypeError('Illegal constructor');
        }
      },
    );
    try {
      canvas.dispatchEvent(cancel);
    } finally {
      vi.unstubAllGlobals();
      window.removeEventListener('error', onError);
    }

    expect(errors).toEqual([]);
    expect(ends).toBe(0);
  });

  it('does nothing once uninstalled', () => {
    const { canvas } = page();
    endChartTouchesOnCancel(document)();
    let ends = 0;
    onRoot('touchend', () => ends++);

    canvas.dispatchEvent(touchEvent('touchcancel', [touchOf(4, canvas)]));

    expect(ends).toBe(0);
  });
});
