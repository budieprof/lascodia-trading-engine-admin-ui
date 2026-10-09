import { describe, expect, it } from 'vitest';

import {
  MAX_QUOTE_AGE_MS,
  alreadyMetReason,
  conditionFor,
  defaultChannel,
  defaultLevel,
  describeAlert,
  directionOf,
  inputOf,
  isFresh,
  pointSize,
  roundTo,
  sidePrice,
  statusLabel,
  type AlertDirection,
  type LiveQuote,
} from './chart-alert-rules';
import type { ChartAlertDto } from './chart-alerts.types';

const NOW = 1_760_000_000_000;
const quote = (bid: number, ask: number, ageMs = 0): LiveQuote => ({ bid, ask, at: NOW - ageMs });

function alert(over: Partial<ChartAlertDto> = {}): ChartAlertDto {
  return {
    id: 7,
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

describe('chart alert rules', () => {
  it('maps directions to conditions and back', () => {
    const directions: AlertDirection[] = ['above', 'below', 'either', 'enter', 'exit'];
    expect(directions.map(conditionFor)).toEqual([
      'CrossingUp',
      'CrossingDown',
      'Crossing',
      'EnteringChannel',
      'ExitingChannel',
    ]);
    expect(directions.map((d) => directionOf(conditionFor(d)))).toEqual(directions);
  });

  it('reads the price of each side', () => {
    const q = quote(1.0854, 1.0856);
    expect(sidePrice(q, 'Bid')).toBe(1.0854);
    expect(sidePrice(q, 'Ask')).toBe(1.0856);
    expect(sidePrice(q, 'Mid')).toBeCloseTo(1.0855, 10);
  });

  it('knows points and rounding per digits', () => {
    expect(pointSize(5)).toBeCloseTo(0.00001, 12);
    expect(pointSize(3)).toBeCloseTo(0.001, 12);
    expect(pointSize(-2)).toBe(1);
    expect(roundTo(1.0855249, 5)).toBe(1.08552);
    expect(roundTo(151.23456, 3)).toBe(151.235);
  });

  it('judges levels by fresh quotes only', () => {
    expect(isFresh(quote(1.1, 1.1002), NOW)).toBe(true);
    expect(isFresh(quote(1.1, 1.1002, MAX_QUOTE_AGE_MS + 1), NOW)).toBe(false);
    expect(isFresh(quote(0, 1.1), NOW)).toBe(false);
    expect(isFresh(quote(1.1002, 1.1), NOW)).toBe(false); // crossed quote
    expect(isFresh(null, NOW)).toBe(false);
  });

  describe('defaults (SP-02: never the price itself)', () => {
    it('starts 10 points beyond the live price on the side, the way it watches', () => {
      const q = { ...quote(1.08542, 1.08551), at: Date.now() };
      expect(defaultLevel(q, 1.08, 'Bid', 'above', 5)).toBe(1.08552);
      expect(defaultLevel(q, 1.08, 'Bid', 'below', 5)).toBe(1.08532);
      expect(defaultLevel(q, 1.08, 'Ask', 'above', 5)).toBe(1.08561);
      expect(defaultChannel(q, 1.08, 'Bid', 5)).toEqual({ lower: 1.08532, upper: 1.08552 });
    });

    it('falls back to the last close without a fresh quote, and to nothing without a price', () => {
      const stale = quote(1.2, 1.2001, MAX_QUOTE_AGE_MS * 10);
      expect(defaultLevel(stale, 151.234, 'Bid', 'above', 3)).toBe(151.244);
      expect(defaultLevel(null, 0, 'Bid', 'above', 5)).toBe(0);
    });
  });

  describe('already met (the engine refuses these too)', () => {
    const q = quote(1.0854, 1.0856);

    it('refuses an "above" level at or below the live side price, and a "below" level at or above it', () => {
      expect(alreadyMetReason('EURUSD', 'above', 1.0854, 'Bid', q, 5, NOW)).toBe(
        'EURUSD bid is 1.08540, already at or above 1.08540. Pick a higher level, or choose "Crosses below".',
      );
      expect(alreadyMetReason('EURUSD', 'below', 1.0856, 'Bid', q, 5, NOW)).toContain(
        'already at or below 1.08560',
      );
      // On the ask, 1.0855 is already passed; on the bid it is still ahead.
      expect(alreadyMetReason('EURUSD', 'above', 1.0855, 'Ask', q, 5, NOW)).toContain(
        'ask is 1.08560',
      );
      expect(alreadyMetReason('EURUSD', 'above', 1.0855, 'Bid', q, 5, NOW)).toBeNull();
    });

    it('says nothing for crossings either way, channels, stale quotes or no level', () => {
      expect(alreadyMetReason('EURUSD', 'either', 1.0854, 'Bid', q, 5, NOW)).toBeNull();
      expect(alreadyMetReason('EURUSD', 'enter', 1.0854, 'Bid', q, 5, NOW)).toBeNull();
      expect(
        alreadyMetReason(
          'EURUSD',
          'above',
          1.08,
          'Bid',
          quote(1.0854, 1.0856, MAX_QUOTE_AGE_MS + 1),
          5,
          NOW,
        ),
      ).toBeNull();
      expect(alreadyMetReason('EURUSD', 'above', null, 'Bid', q, 5, NOW)).toBeNull();
    });
  });

  it('describes an alert in one line', () => {
    expect(describeAlert(alert(), 5)).toBe('Bid crosses above 1.08500 · only once');
    expect(
      describeAlert(
        alert({
          condition: 'EnteringChannel',
          price: 1.08,
          upperPrice: 1.09,
          frequency: 'all',
          side: 'Mid',
        }),
        2,
      ),
    ).toBe('Mid enters channel 1.08–1.09 · every time');
    expect(
      describeAlert(
        alert({
          kind: 'Drawing',
          drawingKind: 'trend-line',
          condition: 'Crossing',
          frequency: 'once_per_bar',
        }),
        5,
      ),
    ).toBe('Bid crosses (either way) the trend line · once per bar');
  });

  it('labels statuses and turns an alert back into its input, or a copy of it', () => {
    expect(statusLabel('Triggered')).toBe('Fired');
    expect(statusLabel('Expired')).toBe('Expired');
    const a = alert({ name: 'Breakout', channels: ['InApp', 'Telegram'] });
    const input = inputOf(a);
    expect(input).toMatchObject({
      name: 'Breakout',
      symbol: 'EURUSD',
      condition: 'CrossingUp',
      price: 1.085,
    });
    expect(input).not.toHaveProperty('id');
    expect(input).not.toHaveProperty('status');
    expect(inputOf(a, true).name).toBe('Breakout (copy)');
    input.channels.push('Email');
    expect(a.channels).toEqual(['InApp', 'Telegram']); // a copy, not the alert's own list
  });
});
