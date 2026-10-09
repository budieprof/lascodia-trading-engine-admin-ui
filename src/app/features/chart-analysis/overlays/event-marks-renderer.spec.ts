import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { describe, expect, it } from 'vitest';
import type { UpcomingEconomicEvent } from '@core/services/economic-calendar.service';
import type { EventMark } from './chart-events';
import { EventMarksRenderer } from './event-marks-renderer';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const H = 3_600_000;

function mark(id: number, time: number): EventMark {
  return {
    id,
    time,
    title: `Event ${id}`,
    currency: 'USD',
    impact: 'High',
    event: {} as UpcomingEconomicEvent,
  };
}

/** A canvas that records nothing but answers what the renderer asks of it. */
function target(width: number, height: number): CanvasRenderingTarget2D {
  const context = new Proxy(
    { measureText: (text: string) => ({ width: text.length * 5 }) },
    {
      get: (t, prop) => (prop in t ? t[prop as keyof typeof t] : () => undefined),
      set: () => true,
    },
  );
  return {
    useMediaCoordinateSpace: (draw: (scope: unknown) => void) =>
      draw({ context, mediaSize: { width, height } }),
  } as unknown as CanvasRenderingTarget2D;
}

/** Draws one frame: `xAt` maps an hour from NOW to 10 px per hour, the pane 800 × 500. */
function frame(marks: EventMark[]): EventMarksRenderer {
  const renderer = new EventMarksRenderer(
    (ms) => 400 + ((ms - NOW) / H) * 10,
    () => NOW,
  );
  renderer.setMarks(marks, 'Low');
  const view = renderer.paneViews()[0];
  view.renderer().draw(target(800, 500));
  return renderer;
}

describe('EventMarksRenderer hit testing (CC-I2)', () => {
  it('finds a flag in the strip at the bottom of the pane, not over the candles', () => {
    const r = frame([mark(1, NOW - 10 * H)]);
    expect(r.placed().map((p) => p.x)).toEqual([300]);
    expect(r.hit(302, 490)?.id).toBe(1);
    expect(r.hit(302, 250)).toBeNull();
    expect(r.hit(320, 490)).toBeNull();
  });

  it('keeps a flag near the right edge hittable under the next-event chip', () => {
    // Event 1 lands at x = 790, inside the right edge; event 2 is past it and becomes the chip.
    const r = frame([mark(1, NOW + 39 * H), mark(2, NOW + 100 * H)]);
    expect(r.placed().map((p) => p.mark.id)).toEqual([1]);
    expect(r.hit(790, 490)?.id).toBe(1);
    // The chip sits just above the flag strip, at the right edge.
    expect(r.hit(795, 500 - 26 - 10)?.id).toBe(2);
    expect(r.hit(795, 250)).toBeNull();
  });
});
