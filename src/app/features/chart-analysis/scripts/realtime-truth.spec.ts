import { describe, expect, it } from 'vitest';

import type { PineLabelOutput, PineLineOutput, PineScriptOutputs } from '@shared/pine-chart/model/pine-outputs.types';
import { PROVISIONAL_NOTE, detectRepaint, fadePineColor, markUnconfirmed, repaintText } from './realtime-truth';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 9, 0);

function outputs(values: (number | null)[], over: Partial<PineScriptOutputs> = {}, first = 0): PineScriptOutputs {
  return {
    schemaVersion: 1,
    bars: { firstIndex: first, times: values.map((_, i) => T0 + (first + i) * H), timeframe: '60' },
    plots: [
      {
        id: 0,
        title: 'Fast',
        plotNumber: 0,
        style: 'line',
        lineStyle: 'solid',
        lineWidth: 1,
        offset: 0,
        display: ['all'],
        forceOverlay: false,
        trackPrice: false,
        histBase: 0,
        join: false,
        color: '#2962FFFF',
        colors: null,
        values,
      },
    ],
    markers: [],
    candles: [],
    backgrounds: [],
    barColors: [],
    hlines: [],
    fills: [],
    labels: [],
    lines: [],
    boxes: [],
    polylines: [],
    linefills: [],
    tables: [],
    alertConditions: [],
    alerts: [],
    droppedAlerts: 0,
    logs: [],
    droppedLogs: 0,
    ...over,
  };
}

function label(id: number, barIndex: number, createdBar: number, tooltip: string | null = null): PineLabelOutput {
  return {
    id,
    x: { value: barIndex, barIndex, time: T0 + barIndex * H },
    y: 1.08,
    xloc: 'bar_index',
    yloc: 'price',
    text: 'L',
    color: '#FF0000FF',
    style: 'label_down',
    textColor: '#FFFFFFFF',
    size: 'normal',
    sizePoints: 0,
    textAlign: 'center',
    tooltip,
    fontFamily: 'default',
    bold: false,
    italic: false,
    forceOverlay: false,
    createdBar,
  };
}

function line(id: number, x1: number, x2: number, createdBar: number): PineLineOutput {
  return {
    id,
    x1: { barIndex: x1 },
    y1: 1,
    x2: { barIndex: x2 },
    y2: 2,
    xloc: 'bar_index',
    extend: 'none',
    color: '#00FF00FF',
    style: 'solid',
    width: 1,
    forceOverlay: false,
    createdBar,
  };
}

describe('fadePineColor', () => {
  it('multiplies the alpha and keeps the hex form the renderer reads', () => {
    expect(fadePineColor('#2962FFFF', 0.5)).toBe('#2962FF80');
    expect(fadePineColor('#2962FF80', 0.5)).toBe('#2962FF40');
    expect(fadePineColor(null)).toBeNull();
    expect(fadePineColor('not a colour')).toBe('not a colour');
  });
});

describe('markUnconfirmed (PC-I9)', () => {
  it('fades the forming bar of every plot, leaving the closed bars as they were', () => {
    const out = markUnconfirmed(outputs([1, 2, 3]), 2);
    const p = out.plots[0];
    expect(p.color).toBeNull();
    expect(p.colors![0]).toBe('#2962FFFF');
    expect(p.colors![1]).toBe('#2962FFFF');
    expect(p.colors![2]).toBe(fadePineColor('#2962FFFF'));
    expect(p.values).toEqual([1, 2, 3]);
  });

  it('marks drawings made or moved on the forming bar provisional, with a tooltip saying so', () => {
    const out = markUnconfirmed(
      outputs([1, 2, 3], {
        labels: [label(1, 1, 1), label(2, 2, 2, 'Entry'), label(3, 1, 2)],
        lines: [line(4, 0, 1, 0), line(5, 0, 2, 0)],
      }),
      2,
    );
    expect(out.labels[0].tooltip).toBeNull();
    expect(out.labels[0].color).toBe('#FF0000FF');
    expect(out.labels[1].tooltip).toBe(`Entry\n${PROVISIONAL_NOTE}`);
    expect(out.labels[1].color).toBe(fadePineColor('#FF0000FF'));
    expect(out.labels[2].tooltip).toBe(PROVISIONAL_NOTE); // created on the forming bar
    expect(out.lines[0].color).toBe('#00FF00FF');
    expect(out.lines[1].color).toBe(fadePineColor('#00FF00FF')); // its end moves with the forming bar
  });

  it('fades only the forming bar of markers and background colours', () => {
    const out = markUnconfirmed(
      outputs([1, 2], {
        markers: [
          {
            id: 9,
            plotNumber: 1,
            kind: 'shape',
            offset: 0,
            display: ['all'],
            forceOverlay: false,
            points: [
              { barIndex: 0, time: T0, color: '#FF0000FF' },
              { barIndex: 1, time: T0 + H, color: '#FF0000FF' },
            ],
          },
        ],
        backgrounds: [{ id: 7, offset: 0, display: ['all'], forceOverlay: false, colors: ['#00000020', '#00000020'] }],
      }),
      1,
    );
    expect(out.markers[0].points[0].color).toBe('#FF0000FF');
    expect(out.markers[0].points[1].color).toBe(fadePineColor('#FF0000FF'));
    expect(out.backgrounds[0].colors).toEqual(['#00000020', fadePineColor('#00000020')]);
  });

  it('nothing forming, or a forming bar outside the window: unchanged', () => {
    const o = outputs([1, 2, 3]);
    expect(markUnconfirmed(o, null)).toBe(o);
    expect(markUnconfirmed(o, 7)).toBe(o);
  });
});

describe('detectRepaint (PC-I9)', () => {
  it('finds a plot whose value moved on a bar that was already closed', () => {
    const f = detectRepaint(outputs([1, 2, 3]), outputs([1, 2.5, 3.1, 4]), 2)!;
    expect(f).toEqual({ plotTitle: 'Fast', barTime: T0 + H, barIndex: 1, before: 2, after: 2.5 });
    expect(repaintText(f, () => '01:00')).toBe('Repaints: Fast changed on a closed bar (01:00) from 2 to 2.5');
  });

  it('the forming bar moving is not a repaint, nor is a value equal within rounding', () => {
    expect(detectRepaint(outputs([1, 2, 3]), outputs([1, 2 + 1e-12, 3.7]), 2)).toBeNull();
  });

  it('runs on different windows are not compared (warm-up values differ, which is not a repaint)', () => {
    expect(detectRepaint(outputs([1, 2, 3]), outputs([2, 9, 3], {}, 1), 2)).toBeNull();
  });

  it('na on both sides is the same value; na against a number is a change', () => {
    expect(detectRepaint(outputs([null, 2, 3]), outputs([null, 2, 3]), 2)).toBeNull();
    expect(detectRepaint(outputs([null, 2, 3]), outputs([1, 2, 3]), 2)?.barIndex).toBe(0);
  });
});
