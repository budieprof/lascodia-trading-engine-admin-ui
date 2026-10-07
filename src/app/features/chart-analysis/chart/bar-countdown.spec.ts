import { describe, expect, it } from 'vitest';

import { STALE_FEED_MS, barCloseMs, countdownText, formatCountdown } from './bar-countdown';
import { axisLabelHeight } from './bar-countdown-primitive';

const at = (iso: string) => Date.parse(iso);

describe('formatCountdown', () => {
  it('mm:ss under an hour, hh:mm:ss under a day, Nd hh:mm beyond', () => {
    expect(formatCountdown(26 * 60_000 + 51_000)).toBe('26:51');
    expect(formatCountdown(59_000)).toBe('00:59');
    expect(formatCountdown(3 * 3_600_000 + 4 * 60_000 + 5_000)).toBe('03:04:05');
    expect(formatCountdown(2 * 86_400_000 + 5 * 3_600_000 + 7 * 60_000)).toBe('2d 05:07');
  });

  it('rounds partial seconds up (never shows 00:00 while time is left) and never goes negative', () => {
    expect(formatCountdown(400)).toBe('00:01');
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(-5_000)).toBe('00:00');
  });
});

describe('barCloseMs', () => {
  it('fixed widths close on the UTC grid', () => {
    expect(barCloseMs('1', at('2026-10-06T13:07:00Z'))).toBe(at('2026-10-06T13:08:00Z'));
    expect(barCloseMs('30', at('2026-10-06T13:30:00Z'))).toBe(at('2026-10-06T14:00:00Z'));
    expect(barCloseMs('60', at('2026-10-06T13:00:00Z'))).toBe(at('2026-10-06T14:00:00Z'));
  });

  it('is DST-agnostic: the hour around a European DST change is still 60 minutes', () => {
    expect(barCloseMs('60', at('2026-10-25T00:00:00Z'))).toBe(at('2026-10-25T01:00:00Z'));
  });

  it('computes no close on the session grid — those bars carry the engine’s own', () => {
    for (const r of ['120', '240', '1D', '1W', '1M']) {
      expect(barCloseMs(r, at('2026-10-05T21:00:00Z')), r).toBeNull();
    }
  });

  it('unknown resolution has no close', () => {
    expect(barCloseMs('7', 0)).toBeNull();
  });
});

describe('countdownText', () => {
  const open = at('2026-10-06T13:00:00Z');
  const now = at('2026-10-06T13:33:09Z');

  it('counts down to the forming bar’s close', () => {
    expect(countdownText('60', 'candles', open, now, now - 1_000)).toBe('26:51');
  });

  it('on the session grid, counts to the close the engine sent for the bar', () => {
    // The week of Sunday 4 Oct: opens 21:00 UTC (17:00 New York), closes Friday 9 Oct 21:00 UTC.
    const weekOpen = at('2026-10-04T21:00:00Z');
    const weekClose = at('2026-10-09T21:00:00Z');
    expect(countdownText('1W', 'candles', weekOpen, now, now, weekClose)).toBe('3d 07:26');
    // Tuesday's session opened Monday 21:00 UTC and closes Tuesday 21:00 UTC.
    const day = at('2026-10-05T21:00:00Z');
    expect(countdownText('1D', 'candles', day, now, now, at('2026-10-06T21:00:00Z'))).toBe(
      '07:26:51',
    );
    // A 4h block of the session grid: 13:00–17:00 UTC.
    expect(countdownText('240', 'candles', open, now, now, at('2026-10-06T17:00:00Z'))).toBe(
      '03:26:51',
    );
  });

  it('on the session grid, shows nothing past the close — the weekend gap — or before the open', () => {
    const friClose = at('2026-10-09T21:00:00Z');
    const saturday = at('2026-10-10T12:00:00Z');
    expect(
      countdownText('240', 'candles', at('2026-10-09T17:00:00Z'), saturday, saturday, friClose),
    ).toBeNull();
    expect(
      countdownText('240', 'candles', at('2026-10-09T17:00:00Z'), friClose, friClose, friClose),
    ).toBeNull();
    expect(countdownText('240', 'candles', open, open - 1, open, open + 4 * 3_600_000)).toBeNull();
    // Without the engine's close, a session-grid bar has no countdown at all.
    expect(countdownText('240', 'candles', open, now, now)).toBeNull();
  });

  it('hides on non-time chart types, a closed market (newest bar not current) and a silent feed', () => {
    expect(countdownText('60', 'renko', open, now, now)).toBeNull();
    expect(countdownText('60', 'candles', open - 3_600_000, now, now)).toBeNull();
    expect(countdownText('60', 'candles', open, now, now - STALE_FEED_MS - 1)).toBeNull();
    expect(countdownText('60', 'candles', open, now, null)).toBeNull();
    expect(countdownText('60', 'candles', null, now, now)).toBeNull();
  });

  it('rolls over cleanly: at the boundary the old bar shows nothing, the next bar counts a full period', () => {
    const boundary = at('2026-10-06T14:00:00Z');
    expect(countdownText('60', 'candles', open, boundary - 1, boundary)).toBe('00:01');
    expect(countdownText('60', 'candles', open, boundary, boundary)).toBeNull();
    expect(countdownText('60', 'candles', boundary, boundary, boundary)).toBe('01:00:00');
  });
});

describe('axisLabelHeight', () => {
  it('matches lightweight-charts’ label box at the default 12 px font', () => {
    expect(axisLabelHeight(12)).toBe(18);
  });
});
