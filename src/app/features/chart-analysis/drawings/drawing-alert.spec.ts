import { describe, expect, it } from 'vitest';
import {
  canAlertOn,
  drawingAlertDraft,
  drawingAlertGeometry,
  fibAlertLevels,
} from './drawing-alert';
import { styleFor, type Drawing, type DrawingKind } from './model';

const T = Date.UTC(2026, 9, 5, 8);
const H = 3_600_000;

function drawing(
  kind: DrawingKind,
  points: [number, number][],
  extra: Partial<Drawing> = {},
): Drawing {
  return {
    id: 'd1',
    kind,
    symbol: 'eurusd',
    resolution: '60',
    points: points.map(([h, price]) => ({ time: T + h * H, price })),
    style: styleFor(kind),
    locked: false,
    createdAt: 0,
    ...extra,
  };
}

describe('alerts on drawings (DR-I6)', () => {
  it('a trend line, ray and extended line are lines with the tools’ own extend flags', () => {
    const pts: [number, number][] = [
      [0, 1.08],
      [5, 1.09],
    ];
    expect(drawingAlertGeometry(drawing('trend-line', pts))).toEqual({
      shape: 'line',
      points: [
        { timeMs: T, price: 1.08 },
        { timeMs: T + 5 * H, price: 1.09 },
      ],
      extendLeft: false,
      extendRight: false,
    });
    expect(drawingAlertGeometry(drawing('ray', pts))).toMatchObject({
      extendLeft: false,
      extendRight: true,
    });
    expect(drawingAlertGeometry(drawing('extended-line', pts))).toMatchObject({
      extendLeft: true,
      extendRight: true,
    });
    // The drawing's own settings win over the tool's defaults.
    expect(
      drawingAlertGeometry(drawing('trend-line', pts, { options: { extendRight: true } })),
    ).toMatchObject({ extendRight: true });
  });

  it('a horizontal line covers every bar; a horizontal ray starts at its anchor', () => {
    expect(drawingAlertGeometry(drawing('horizontal-line', [[0, 1.1]]))).toMatchObject({
      shape: 'horizontal',
      extendLeft: true,
      extendRight: true,
    });
    expect(drawingAlertGeometry(drawing('horizontal-ray', [[0, 1.1]]))).toMatchObject({
      shape: 'horizontal',
      extendLeft: false,
      extendRight: true,
    });
  });

  it('a parallel channel is the base line and a parallel through its third anchor; it enters or exits', () => {
    const d = drawing('parallel-channel', [
      [0, 1.08],
      [5, 1.09],
      [0, 1.07],
    ]);
    expect(drawingAlertGeometry(d)).toMatchObject({ shape: 'channel' });
    expect(drawingAlertGeometry(d)!.points).toHaveLength(3);
    expect(drawingAlertDraft(d, { timeframe: '60' })!.condition).toBe('EnteringChannel');
  });

  it('a Fib alert watches one level the operator picks, with Reverse and log scale carried', () => {
    const d = drawing(
      'fib-retracement',
      [
        [0, 1.08],
        [5, 1.1],
      ],
      { options: { reverse: true } },
    );
    expect(fibAlertLevels(d)).toContain(0.618);
    expect(drawingAlertGeometry(d)).toBeNull(); // no level chosen
    expect(drawingAlertGeometry(d, { level: 0.618, logScale: true })).toMatchObject({
      shape: 'fib',
      level: 0.618,
      reverse: true,
      logScale: true,
    });
  });

  it('refuses what the engine cannot watch: other shapes, study panes, a vertical line', () => {
    expect(
      canAlertOn(
        drawing('rectangle', [
          [0, 1.08],
          [5, 1.09],
        ]),
      ),
    ).toBe(false);
    expect(
      canAlertOn(
        drawing(
          'trend-line',
          [
            [0, 1.08],
            [5, 1.09],
          ],
          { pane: 'rsi-1' },
        ),
      ),
    ).toBe(false);
    expect(
      drawingAlertGeometry(
        drawing('trend-line', [
          [0, 1.08],
          [0, 1.09],
        ]),
      ),
    ).toBeNull();
    expect(canAlertOn(drawing('trend-line', [[0, 1.08]]))).toBe(false);
  });

  it('drafts a new alert: crossing either way, bid, once, in app, with the drawing named', () => {
    const draft = drawingAlertDraft(
      drawing('trend-line', [
        [0, 1.08],
        [5, 1.09],
      ]),
      { timeframe: '240' },
    )!;
    expect(draft).toMatchObject({
      id: 0,
      kind: 'Drawing',
      symbol: 'EURUSD',
      timeframe: '240',
      condition: 'Crossing',
      side: 'Bid',
      frequency: 'once',
      channels: ['InApp'],
      drawingId: 'd1',
      drawingKind: 'trend-line',
      name: 'Trend line',
      price: null,
    });
  });
});
