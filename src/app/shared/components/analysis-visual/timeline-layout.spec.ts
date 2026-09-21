import { MARKER_GAP_PX, MAX_LANES, layoutTimeline } from './timeline-layout';
import type { VisualSpec } from './visual-spec';

/** The spec the assistant drew in conversation #33534 — the one that rendered unreadably. */
const scheduledRisk: VisualSpec = {
  kind: 'chart',
  type: 'timeline',
  title: 'Scheduled risk, 22–25 Sep',
  events: [
    { at: '2026-09-22T12:15:00Z', label: 'USD ADP Employment Weekly', impact: 'medium' },
    { at: '2026-09-22T14:00:00Z', label: 'EUR Consumer Confidence Flash', impact: 'medium' },
    { at: '2026-09-22T14:05:00Z', label: 'Fed Williams speech', impact: 'medium' },
    { at: '2026-09-22T14:20:00Z', label: 'Fed Jefferson speech', impact: 'medium' },
    { at: '2026-09-22T17:00:00Z', label: 'Fed Barkin speech', impact: 'medium' },
    { at: '2026-09-23T08:00:00Z', label: 'EUR flash PMIs', impact: 'medium' },
    { at: '2026-09-23T13:45:00Z', label: 'USD flash PMIs', impact: 'medium' },
    { at: '2026-09-23T14:05:00Z', label: 'Fed Barr speech', impact: 'medium' },
    { at: '2026-09-24T00:00:00Z', label: 'Trump–Xi Summit', impact: 'high' },
    { at: '2026-09-25T12:30:00Z', label: 'USD Durable Goods MoM', impact: 'high' },
  ],
  windows: [
    {
      from: '2026-09-21T20:30:00Z',
      to: '2026-09-22T20:04:00Z',
      label: 'Monitor #730 life',
      kind: 'session',
    },
    {
      from: '2026-09-22T20:04:00Z',
      to: '2026-09-24T00:00:00Z',
      label: 'No High-impact risk',
      kind: 'quiet',
    },
  ],
};

describe('layoutTimeline', () => {
  it('never puts two markers in one lane closer than a marker width', () => {
    const width = 900;
    const tl = layoutTimeline(scheduledRisk, width);
    const gapPct = (MARKER_GAP_PX / width) * 100;
    for (let lane = 0; lane < tl.lanes; lane++) {
      const xs = tl.events.filter((e) => e.lane === lane).map((e) => e.leftPct);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(gapPct);
    }
    // The 14:00 / 14:05 / 14:20 cluster needs its own lanes.
    expect(tl.lanes).toBeGreaterThanOrEqual(3);
    expect(tl.lanes).toBeLessThanOrEqual(MAX_LANES);
  });

  it('numbers events in time order and groups the agenda by UTC day', () => {
    const tl = layoutTimeline(scheduledRisk, 900);
    expect(tl.events.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(tl.agenda.map((d) => d.day)).toEqual([
      'Tue 22 Sep',
      'Wed 23 Sep',
      'Thu 24 Sep',
      'Fri 25 Sep',
    ]);
    expect(tl.agenda[0].events.map((e) => e.time)).toEqual([
      '12:15Z',
      '14:00Z',
      '14:05Z',
      '14:20Z',
      '17:00Z',
    ]);
  });

  it('draws a gridline per UTC midnight and labels each day', () => {
    const tl = layoutTimeline(scheduledRisk, 900);
    expect(tl.midnights).toHaveLength(4); // 22, 23, 24, 25 Sep
    expect(tl.days.map((d) => d.label)).toContain('Wed 23');
  });

  it('keeps markers off the strip edge', () => {
    const tl = layoutTimeline(scheduledRisk, 900);
    expect(tl.events[tl.events.length - 1].leftPct).toBeLessThan(100);
    expect(tl.windows[0].leftPct).toBeGreaterThan(0);
  });

  it('survives an empty or single-instant spec', () => {
    expect(layoutTimeline({ kind: 'chart', type: 'timeline', title: 't' }, 600).events).toEqual([]);
    const one = layoutTimeline(
      {
        kind: 'chart',
        type: 'timeline',
        title: 't',
        events: [{ at: '2026-09-22T12:00:00Z', label: 'x' }],
      },
      600,
    );
    expect(one.events[0].leftPct).toBeCloseTo(50, 0);
  });
});
