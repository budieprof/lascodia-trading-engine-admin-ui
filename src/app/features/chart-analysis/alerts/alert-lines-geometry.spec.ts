import { describe, expect, it } from 'vitest';

import {
  ALERT_LINE_COLORS,
  alertLinesFor,
  dragPrice,
  grabbedLine,
  movedBounds,
  type AlertLine,
} from './alert-lines-geometry';
import type { ChartAlertDto } from './chart-alerts.types';

let nextId = 1;
function alert(over: Partial<ChartAlertDto> = {}): ChartAlertDto {
  return {
    id: nextId++,
    name: null,
    symbol: 'EURUSD',
    timeframe: '60',
    kind: 'Price',
    side: 'Bid',
    condition: 'CrossingUp',
    price: 1.085,
    upperPrice: null,
    geometry: null,
    drawingId: null,
    drawingKind: null,
    frequency: 'once',
    expiresAtUtc: null,
    channels: ['InApp'],
    messageTemplate: null,
    severity: 'Medium',
    status: 'Active',
    statusReason: null,
    createdAt: '2026-10-09T08:00:00Z',
    updatedAt: '2026-10-09T08:00:00Z',
    lastFiredAt: null,
    fireCount: 0,
    ...over,
  };
}

describe('alert lines', () => {
  it('draws the active and paused price alerts of the symbol only', () => {
    const up = alert({ condition: 'CrossingUp', price: 1.09 });
    const down = alert({ condition: 'CrossingDown', price: 1.08, name: 'Floor' });
    const either = alert({ condition: 'Crossing', price: 1.1 });
    const paused = alert({ status: 'Paused', price: 1.07 });
    const fired = alert({ status: 'Triggered', price: 1.06 });
    const expired = alert({ status: 'Expired', price: 1.05 });
    const drawing = alert({ kind: 'Drawing', price: null });
    const other = alert({ symbol: 'GBPUSD', price: 1.3 });
    const lines = alertLinesFor(
      [up, down, either, paused, fired, expired, drawing, other],
      'eurusd',
      5,
    );
    expect(lines.map((l) => [l.alertId, l.price, l.color, l.active])).toEqual([
      [up.id, 1.09, ALERT_LINE_COLORS.up, true],
      [down.id, 1.08, ALERT_LINE_COLORS.down, true],
      [either.id, 1.1, ALERT_LINE_COLORS.either, true],
      [paused.id, 1.07, ALERT_LINE_COLORS.paused, false],
    ]);
    expect(lines[0].label).toBe('⏰ 1.09000');
    expect(lines[1].label).toBe('⏰ Floor');
    expect(lines[0].title).toBe('Bid crosses above 1.09000 · only once');
  });

  it('draws both bounds of a channel alert', () => {
    const channel = alert({ condition: 'ExitingChannel', price: 1.08, upperPrice: 1.09 });
    const lines = alertLinesFor([channel], 'EURUSD', 5);
    expect(lines.map((l) => [l.bound, l.price, l.color])).toEqual([
      ['price', 1.08, ALERT_LINE_COLORS.channel],
      ['upper', 1.09, ALERT_LINE_COLORS.channel],
    ]);
  });

  it('grabs the nearest active line within the tolerance', () => {
    const lines: AlertLine[] = [
      { alertId: 1, bound: 'price', price: 100, label: '', title: '', color: '', active: true },
      { alertId: 2, bound: 'price', price: 103, label: '', title: '', color: '', active: true },
      { alertId: 3, bound: 'price', price: 101, label: '', title: '', color: '', active: false },
    ];
    const toY = (price: number) => (price > 200 ? null : price); // 1 px per unit
    expect(grabbedLine(lines, 102, toY)?.alertId).toBe(2); // 1 px from #2, 2 px from #1, #3 is paused
    expect(grabbedLine(lines, 99, toY)?.alertId).toBe(1);
    expect(grabbedLine(lines, 109, toY)).toBeNull(); // 6 px away
    expect(grabbedLine(lines, 108, toY)?.alertId).toBe(2); // exactly 5 px
    expect(grabbedLine([{ ...lines[0], price: 300 }], 300, toY)).toBeNull(); // off the scale
  });

  it('rounds a drop to the symbol’s digits and refuses one off the scale', () => {
    expect(dragPrice(10, () => 1.0855249, 5)).toBe(1.08552);
    expect(dragPrice(10, () => null, 5)).toBeNull();
    expect(dragPrice(10, () => -1, 5)).toBeNull();
  });

  it('keeps a channel the right way up when a bound moves', () => {
    const channel = { price: 1.08, upperPrice: 1.09 };
    expect(movedBounds(channel, 'price', 1.085)).toEqual({ price: 1.085, upperPrice: 1.09 });
    expect(movedBounds(channel, 'price', 1.09)).toBeNull();
    expect(movedBounds(channel, 'upper', 1.095)).toEqual({ price: 1.08, upperPrice: 1.095 });
    expect(movedBounds(channel, 'upper', 1.079)).toBeNull();
    // A single level moves freely.
    expect(movedBounds({ price: 1.08, upperPrice: null }, 'price', 1.2)).toEqual({
      price: 1.2,
      upperPrice: null,
    });
  });
});
