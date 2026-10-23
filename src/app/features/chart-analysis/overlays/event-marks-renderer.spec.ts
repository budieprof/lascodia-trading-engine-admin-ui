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
function frame(marks: EventMark[], setup?: (r: EventMarksRenderer) => void): EventMarksRenderer {
  const renderer = new EventMarksRenderer(
    (ms) => 400 + ((ms - NOW) / H) * 10,
    () => NOW,
  );
  renderer.setMarks(marks, 'Low');
  setup?.(renderer);
  const view = renderer.paneViews()[0];
  view.renderer().draw(target(800, 500));
  return renderer;
}

describe('EventMarksRenderer hit testing (CC-I2, PR-6 lane)', () => {
  it('finds a flag in the lane at the bottom of the pane, not over the candles', () => {
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
    // The chip sits just above the lane, at the right edge.
    expect(r.hit(795, 500 - 22 - 10)?.id).toBe(2);
    expect(r.hit(795, 250)).toBeNull();
  });

  it('merges events at the same moment into one flag with a count, the most important first', () => {
    // Two prints in the same hour (x 300), one 0.1 h later (x 301), one five hours later (x 350).
    const low = { ...mark(2, NOW - 10 * H), impact: 'Low' as const };
    const r = frame([low, mark(1, NOW - 10 * H), mark(3, NOW - 9.9 * H), mark(4, NOW - 5 * H)]);
    expect(r.placed().map((p) => p.marks.map((m) => m.id))).toEqual([[1, 2, 3], [4]]);
    // One row: every flag in the lane at the same height.
    expect(new Set(r.placed().map((p) => p.y)).size).toBe(1);
    // The flag answers with its primary event, and the group with all of them.
    expect(r.hit(300, 489)?.id).toBe(1);
    expect(r.hitGroup(300, 489)?.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('keeps a run of nearby events as a few flags rather than one flag for the whole run', () => {
    // Events every 1.5 h (15 px apart, closer than a flag): pairs merge, the run does not collapse into one.
    const r = frame([0, 1, 2, 3, 4, 5].map((i) => mark(i + 1, NOW - 20 * H + i * 1.5 * H)));
    expect(r.placed().map((p) => p.marks.length)).toEqual([2, 2, 2]);
  });

  it('draws no flags off the lane pane, and nothing at all with the group hidden', () => {
    const lines = frame([mark(1, NOW - 10 * H)], (x) => x.setLane(false));
    expect(lines.placed()).toEqual([]);
    expect(lines.hit(300, 489)).toBeNull();
    const hidden = frame([mark(1, NOW - 10 * H)], (x) => x.setOpacity(0));
    expect(hidden.placed()).toEqual([]);
  });
});
